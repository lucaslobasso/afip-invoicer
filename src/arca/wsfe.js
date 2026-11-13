// WSFEv1: Web Service de Factura Electrónica (RG 4291).
// Manual: https://www.arca.gob.ar/ws/documentacion/ws-factura-electronica.asp
const { ArcaError, soapRequest, toXml } = require('./soap');

const WSFE_URLS = {
  production: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx',
  homologation: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx',
};

const NAMESPACE = 'http://ar.gov.afip.dif.FEV1/';
const NO_RESULTS = '602';

function asArray(value) {
  if (value === null || value === undefined || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

function describe(items) {
  return items.map((item) => `(${item.Code}) ${item.Msg}`).join(' ');
}

class Wsfe {
  /**
   * @param {object} options
   * @param {'production'|'homologation'} options.environment
   * @param {string} options.cuit
   * @param {() => Promise<{token: string, sign: string}>} options.getTicket Devuelve un Ticket de Acceso vigente.
   * @param {Function} [options.transport]
   */
  constructor({ environment = 'production', cuit, getTicket, transport }) {
    this.url = WSFE_URLS[environment];
    this.cuit = cuit;
    this.getTicket = getTicket;
    this.transport = transport;
  }

  async call(method, params = {}, { auth = true } = {}) {
    let request = params;

    if (auth) {
      const { token, sign } = await this.getTicket();
      request = { Auth: { Token: token, Sign: sign, Cuit: this.cuit }, ...params };
    }

    const body = await soapRequest({
      url: this.url,
      action: NAMESPACE + method,
      body: `<${method} xmlns="${NAMESPACE}">${toXml(request)}</${method}>`,
      transport: this.transport,
    });

    const result = body[`${method}Response`] && body[`${method}Response`][`${method}Result`];

    if (!result) {
      throw new ArcaError('Respuesta inesperada de ARCA.', 'wsfe.badResponse');
    }

    return result;
  }

  static errors(result) {
    return asArray(result.Errors && result.Errors.Err);
  }

  static throwOnErrors(result) {
    const errors = Wsfe.errors(result);

    if (errors.length) {
      throw new ArcaError(describe(errors), errors[0].Code);
    }
  }

  /** Estado de los servidores de ARCA. No requiere autenticación. */
  async serverStatus() {
    const result = await this.call('FEDummy', {}, { auth: false });

    return {
      online: result.AppServer === 'OK' && result.DbServer === 'OK' && result.AuthServer === 'OK',
      ...result,
    };
  }

  /** Puntos de venta habilitados para factura electrónica por web service. */
  async salesPoints() {
    const result = await this.call('FEParamGetPtosVenta');
    const errors = Wsfe.errors(result);

    // ARCA informa "sin resultados" como un error.
    if (errors.some((e) => e.Code === NO_RESULTS)) return [];
    Wsfe.throwOnErrors(result);

    return asArray(result.ResultGet && result.ResultGet.PtoVenta)
      .filter((p) => p.Bloqueado !== 'S' && (!p.FchBaja || p.FchBaja === 'NULL'))
      .map((p) => ({ number: Number(p.Nro), type: p.EmisionTipo }));
  }

  /** Número del último comprobante autorizado (0 si todavía no hay ninguno). */
  async lastVoucher(salesPoint, voucherType) {
    const result = await this.call('FECompUltimoAutorizado', {
      PtoVta: salesPoint,
      CbteTipo: voucherType,
    });

    Wsfe.throwOnErrors(result);
    return Number(result.CbteNro);
  }

  /** Datos de un comprobante emitido, o `null` si no existe. */
  async voucherInfo(number, salesPoint, voucherType) {
    const result = await this.call('FECompConsultar', {
      FeCompConsReq: { CbteTipo: voucherType, CbteNro: number, PtoVta: salesPoint },
    });
    const errors = Wsfe.errors(result);

    if (errors.some((e) => e.Code === NO_RESULTS)) return null;
    Wsfe.throwOnErrors(result);

    return result.ResultGet || null;
  }

  /**
   * Solicita el CAE para un comprobante.
   * @param {{PtoVta: number, CbteTipo: number}} header
   * @param {object} detail Campos de `FECAEDetRequest`, en el orden del WSDL.
   * @returns {Promise<{ cae: string, caeExpiration: string, observations: string }>}
   */
  async createVoucher(header, detail) {
    const result = await this.call('FECAESolicitar', {
      FeCAEReq: {
        FeCabReq: { CantReg: 1, PtoVta: header.PtoVta, CbteTipo: header.CbteTipo },
        FeDetReq: { FECAEDetRequest: detail },
      },
    });

    const response = asArray(result.FeDetResp && result.FeDetResp.FECAEDetResponse)[0];
    const observations = asArray(response && response.Observaciones && response.Observaciones.Obs);
    const errors = Wsfe.errors(result);

    // Un rechazo puede venir solo con observaciones y sin `Errors`.
    if (!response || response.Resultado !== 'A' || !response.CAE) {
      const problems = [...errors, ...observations];

      throw new ArcaError(
        problems.length ? describe(problems) : 'ARCA rechazó el comprobante.',
        problems.length ? problems[0].Code : 'rejected'
      );
    }

    return {
      cae: response.CAE,
      caeExpiration: response.CAEFchVto,
      observations: describe(observations),
    };
  }
}

module.exports = { Wsfe, WSFE_URLS };
