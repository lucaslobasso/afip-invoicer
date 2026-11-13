// Reglas de negocio de ARCA que usa la aplicación. Todo acá es puro (sin red ni disco).

const INVOICE_TYPE_C = 11; // Factura C

const DOC_TYPE_FINAL_CONSUMER = 99; // "Doc. (Otro)": consumidor final sin identificar
const VAT_CONDITION_FINAL_CONSUMER = 5; // FEParamGetCondicionIvaReceptor: 5 = Consumidor Final

// RG 5700/2025: a partir de este importe hay que identificar al consumidor final,
// cosa que esta aplicación no soporta (siempre emite con DocTipo 99).
const FINAL_CONSUMER_ID_THRESHOLD = 10000000;

const CONCEPTS = { 1: 'Productos', 2: 'Servicios', 3: 'Productos y Servicios' };

/** Días de tolerancia para la fecha del comprobante según el concepto (validación 10016 de WSFEv1). */
function dateToleranceDays(concept) {
  return Number(concept) === 1 ? 5 : 10;
}

function isValidCuit(value) {
  const cuit = String(value);

  if (!/^\d{11}$/.test(cuit)) return false;

  const digits = cuit.split('').map(Number);
  const checkDigit = digits.pop();
  const total = digits.reverse().reduce((acc, digit, i) => acc + digit * (2 + (i % 6)), 0);
  const mod11 = 11 - (total % 11);

  if (mod11 === 11) return checkDigit === 0;
  if (mod11 === 10) return false;
  return checkDigit === mod11;
}

/** Date local -> entero yyyymmdd. */
function toArcaDate(date) {
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

/** yyyymmdd (texto o número) -> Date local. */
function fromArcaDate(value) {
  const text = String(value);

  return new Date(Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8)));
}

function isArcaDate(value) {
  if (!/^\d{8}$/.test(String(value))) return false;
  return toArcaDate(fromArcaDate(value)) === Number(value);
}

function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/**
 * Rango de fechas válido para emitir hoy un comprobante.
 * @param {number} concept
 * @param {number|null} lastInvoiceDate Fecha (yyyymmdd) del último comprobante del punto de venta.
 * @param {Date} [today]
 * @returns {{ min: number, max: number }} Fechas yyyymmdd, ambas inclusive.
 */
function invoiceDateRange(concept, lastInvoiceDate, today = new Date()) {
  const days = dateToleranceDays(concept);
  let min = toArcaDate(addDays(today, -days));
  let max = toArcaDate(addDays(today, days));

  // Para productos la fecha no puede exceder el mes de presentación.
  if (Number(concept) === 1) {
    const endOfMonth = toArcaDate(new Date(today.getFullYear(), today.getMonth() + 1, 0));
    max = Math.min(max, endOfMonth);
  }
  // No puede ser anterior al último comprobante emitido.
  if (lastInvoiceDate) {
    min = Math.max(min, Number(lastInvoiceDate));
  }

  return { min, max };
}

function roundAmount(amount) {
  return Math.round(Number(amount) * 100) / 100;
}

function isValidAmount(amount) {
  const value = Number(amount);

  return Number.isFinite(value) && value > 0 && roundAmount(value) < FINAL_CONSUMER_ID_THRESHOLD;
}

/**
 * Arma el `FECAEDetRequest` de una Factura C a consumidor final.
 * El orden de las claves es el de la secuencia del WSDL y no debe cambiarse.
 */
function buildInvoiceDetail({ number, concept, date, amount }) {
  const total = roundAmount(amount).toFixed(2);
  const hasServices = Number(concept) > 1;

  return {
    Concepto: Number(concept),
    DocTipo: DOC_TYPE_FINAL_CONSUMER,
    DocNro: 0,
    CbteDesde: number,
    CbteHasta: number,
    CbteFch: date,
    ImpTotal: total,
    ImpTotConc: 0,
    ImpNeto: total, // En comprobantes C el neto es el subtotal.
    ImpOpEx: 0,
    ImpTrib: 0,
    ImpIVA: 0,
    // Obligatorias solo para servicios (conceptos 2 y 3).
    FchServDesde: hasServices ? date : null,
    FchServHasta: hasServices ? date : null,
    FchVtoPago: hasServices ? date : null,
    MonId: 'PES',
    MonCotiz: 1,
    // Obligatorio por RG 5616/2024.
    CondicionIVAReceptorId: VAT_CONDITION_FINAL_CONSUMER,
  };
}

/**
 * Primer número de comprobante (entre 1 y `last`) cuya fecha es >= `date`,
 * o `last + 1` si no hay ninguno. Las fechas son no decrecientes respecto del número.
 * @param {number} last Último número de comprobante emitido.
 * @param {number} date yyyymmdd
 * @param {(number: number) => Promise<number>} getDate Fecha (yyyymmdd) del comprobante `number`.
 */
async function firstInvoiceOnOrAfter(last, date, getDate) {
  let low = 1;
  let high = last + 1;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);

    if ((await getDate(mid)) < date) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

module.exports = {
  INVOICE_TYPE_C,
  FINAL_CONSUMER_ID_THRESHOLD,
  VAT_CONDITION_FINAL_CONSUMER,
  CONCEPTS,
  dateToleranceDays,
  isValidCuit,
  toArcaDate,
  fromArcaDate,
  isArcaDate,
  addDays,
  invoiceDateRange,
  roundAmount,
  isValidAmount,
  buildInvoiceDetail,
  firstInvoiceOnOrAfter,
};
