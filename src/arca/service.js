// Orquesta credenciales, tickets de acceso y WSFEv1 para la aplicación.
const { promises: fs } = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { ArcaError } = require('./soap');
const wsaa = require('./wsaa');
const { Wsfe } = require('./wsfe');
const rules = require('./rules');

const TICKET_MARGIN_MS = 5 * 60 * 1000;
const LIST_CONCURRENCY = 4;

class ArcaService {
  /**
   * @param {object} options
   * @param {() => Promise<{cuit: string, certPem: string, keyPem: string} | null>} options.loadCredentials
   * @param {string} options.ticketDir Carpeta donde se guardan los tickets de acceso.
   * @param {'production'|'homologation'} [options.environment]
   * @param {Function} [options.transport]
   */
  constructor({ loadCredentials, ticketDir, environment = 'production', transport }) {
    this.loadCredentials = loadCredentials;
    this.ticketDir = ticketDir;
    this.environment = environment;
    this.transport = transport;
    this.ticket = null;
    this.ticketFile = null;
  }

  async credentials() {
    const credentials = await this.loadCredentials();

    if (!credentials) {
      throw new ArcaError('Falta configurar el CUIT, el certificado o la clave.', 'not-configured');
    }

    return credentials;
  }

  /**
   * Ticket de Acceso vigente. Se guarda en disco porque el WSAA no entrega uno
   * nuevo mientras el anterior siga vigente (dura 12 horas).
   */
  async getTicket() {
    const { certPem, keyPem } = await this.credentials();
    const fingerprint = crypto.createHash('sha256').update(certPem).digest('hex').slice(0, 16);
    const file = path.join(this.ticketDir, `ta-${this.environment}-${fingerprint}.json`);

    if (this.ticketFile !== file) {
      this.ticket = null;
      this.ticketFile = file;

      try {
        this.ticket = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch (e) {
        // Sin ticket guardado (o ilegible): se pide uno nuevo.
      }
    }

    const expires = this.ticket ? new Date(this.ticket.expiration).getTime() : 0;

    if (!(expires - TICKET_MARGIN_MS > Date.now())) {
      this.ticket = await wsaa.login({
        service: 'wsfe',
        certPem,
        keyPem,
        environment: this.environment,
        transport: this.transport,
      });
      await fs.writeFile(file, JSON.stringify(this.ticket), { mode: 0o600 });
    }

    return this.ticket;
  }

  async wsfe() {
    const { cuit } = await this.credentials();

    return new Wsfe({
      environment: this.environment,
      cuit,
      getTicket: () => this.getTicket(),
      transport: this.transport,
    });
  }

  /**
   * Verifica configuración, servidores, autenticación y puntos de venta.
   * @returns {Promise<{status: 'ok', pointsOfSale: object[]} | {status: 'not-configured'|'offline'|'auth'|'no-points-of-sale', message?: string}>}
   */
  async connect() {
    let credentials;

    try {
      credentials = await this.credentials();
    } catch (e) {
      return { status: 'not-configured', message: e.message };
    }

    const check = wsaa.checkCredentials(credentials.certPem, credentials.keyPem);
    if (!check.ok) {
      return { status: 'auth', message: check.reason };
    }

    const wsfe = await this.wsfe();

    try {
      if (!(await wsfe.serverStatus()).online) {
        return { status: 'offline' };
      }
    } catch (e) {
      return { status: 'offline', message: e.message };
    }

    try {
      await this.getTicket();
    } catch (e) {
      return { status: e.code === 'network' ? 'offline' : 'auth', message: e.message };
    }

    let pointsOfSale;
    try {
      pointsOfSale = await wsfe.salesPoints();
    } catch (e) {
      if (e.code === 'network') return { status: 'offline', message: e.message };
      // Por ejemplo 600: el certificado no representa al CUIT configurado.
      return { status: 'auth', message: e.message };
    }

    if (!pointsOfSale.length) {
      return { status: 'no-points-of-sale' };
    }

    return { status: 'ok', pointsOfSale };
  }

  /** Número y fecha (yyyymmdd) del último comprobante del punto de venta. */
  async lastInvoice(pointOfSale) {
    const wsfe = await this.wsfe();
    const number = await wsfe.lastVoucher(pointOfSale, rules.INVOICE_TYPE_C);

    if (!number) return { number: 0, date: null };

    const info = await wsfe.voucherInfo(number, pointOfSale, rules.INVOICE_TYPE_C);
    return { number, date: info ? Number(info.CbteFch) : null };
  }

  async createInvoice({ pointOfSale, concept, date, amount }) {
    if (!Number.isInteger(pointOfSale) || pointOfSale <= 0) {
      throw new ArcaError('Punto de venta inválido.', 'validation');
    }
    if (!rules.CONCEPTS[concept]) {
      throw new ArcaError('Concepto inválido.', 'validation');
    }
    if (!rules.isArcaDate(date)) {
      throw new ArcaError('Fecha inválida.', 'validation');
    }
    if (!rules.isValidAmount(amount)) {
      throw new ArcaError('Monto inválido.', 'validation');
    }

    const wsfe = await this.wsfe();
    const number = (await wsfe.lastVoucher(pointOfSale, rules.INVOICE_TYPE_C)) + 1;
    const result = await wsfe.createVoucher(
      { PtoVta: pointOfSale, CbteTipo: rules.INVOICE_TYPE_C },
      rules.buildInvoiceDetail({ number, concept, date: Number(date), amount })
    );

    return { number, date: Number(date), ...result };
  }

  /** Comprobantes del punto de venta con fecha entre `from` y `to` (yyyymmdd, inclusive). */
  async listInvoices({ pointOfSale, from, to }) {
    if (!rules.isArcaDate(from) || !rules.isArcaDate(to) || Number(from) > Number(to)) {
      throw new ArcaError('Rango de fechas inválido.', 'validation');
    }

    const wsfe = await this.wsfe();
    const last = await wsfe.lastVoucher(pointOfSale, rules.INVOICE_TYPE_C);
    const cache = new Map();

    const getInfo = (number) => {
      if (!cache.has(number)) {
        cache.set(number, wsfe.voucherInfo(number, pointOfSale, rules.INVOICE_TYPE_C));
      }
      return cache.get(number);
    };
    const getDate = async (number) => {
      const info = await getInfo(number);
      return info ? Number(info.CbteFch) : 0;
    };

    const dayAfterTo = rules.toArcaDate(rules.addDays(rules.fromArcaDate(to), 1));
    const first = await rules.firstInvoiceOnOrAfter(last, Number(from), getDate);
    const end = await rules.firstInvoiceOnOrAfter(last, dayAfterTo, getDate);
    const invoices = [];

    for (let start = first; start < end; start += LIST_CONCURRENCY) {
      const numbers = [];
      for (let n = start; n < Math.min(start + LIST_CONCURRENCY, end); n++) numbers.push(n);

      const infos = await Promise.all(numbers.map(getInfo));

      infos.forEach((info, i) => {
        if (!info) return;
        invoices.push({
          number: numbers[i],
          date: Number(info.CbteFch),
          concept: Number(info.Concepto),
          total: Number(info.ImpTotal),
          cae: info.CodAutorizacion || '',
        });
      });
    }

    return invoices;
  }
}

module.exports = { ArcaService };
