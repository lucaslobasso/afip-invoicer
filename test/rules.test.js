const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../src/arca/rules');

test('isValidCuit valida el dígito verificador', () => {
  assert.equal(rules.isValidCuit('20111111112'), true);
  assert.equal(rules.isValidCuit('33693450239'), true); // CUIT de ARCA
  assert.equal(rules.isValidCuit('20111111113'), false);
  assert.equal(rules.isValidCuit('2011111111'), false);
  assert.equal(rules.isValidCuit('20-11111111-2'), false);
  assert.equal(rules.isValidCuit(''), false);
});

test('las fechas se convierten en hora local, sin corrimientos por UTC', () => {
  const lateNight = new Date(2026, 10, 12, 23, 30);

  assert.equal(rules.toArcaDate(lateNight), 20261112);
  assert.equal(rules.toArcaDate(rules.fromArcaDate('20260301')), 20260301);
  assert.equal(rules.isArcaDate('20260230'), false);
  assert.equal(rules.isArcaDate(20261112), true);
  assert.equal(rules.isArcaDate('2026-11-12'), false);
});

test('invoiceDateRange: servicios permite ±10 días', () => {
  const today = new Date(2026, 10, 12);

  assert.deepEqual(rules.invoiceDateRange(2, null, today), { min: 20261102, max: 20261122 });
  assert.deepEqual(rules.invoiceDateRange(3, null, today), { min: 20261102, max: 20261122 });
});

test('invoiceDateRange: productos permite ±5 días sin pasar de mes', () => {
  assert.deepEqual(rules.invoiceDateRange(1, null, new Date(2026, 10, 12)), { min: 20261107, max: 20261117 });
  assert.deepEqual(rules.invoiceDateRange(1, null, new Date(2026, 10, 28)), { min: 20261123, max: 20261130 });
});

test('invoiceDateRange: nunca antes del último comprobante', () => {
  const today = new Date(2026, 10, 12);

  assert.equal(rules.invoiceDateRange(2, 20261110, today).min, 20261110);
  assert.equal(rules.invoiceDateRange(2, 20260101, today).min, 20261102);
});

test('isValidAmount respeta el tope para consumidor final sin identificar', () => {
  assert.equal(rules.isValidAmount(0), false);
  assert.equal(rules.isValidAmount(-1), false);
  assert.equal(rules.isValidAmount('abc'), false);
  assert.equal(rules.isValidAmount(0.01), true);
  assert.equal(rules.isValidAmount(150000), true); // el tope viejo de $7.600 ya no aplica
  assert.equal(rules.isValidAmount(9999999.99), true);
  assert.equal(rules.isValidAmount(10000000), false);
});

test('buildInvoiceDetail arma una Factura C a consumidor final', () => {
  const detail = rules.buildInvoiceDetail({ number: 300, concept: 2, date: 20261112, amount: 1234.565 });

  assert.equal(detail.CbteDesde, 300);
  assert.equal(detail.CbteHasta, 300);
  assert.equal(detail.ImpTotal, '1234.57');
  assert.equal(detail.ImpNeto, '1234.57');
  assert.equal(detail.DocTipo, 99);
  assert.equal(detail.CondicionIVAReceptorId, 5);
  assert.equal(detail.FchServDesde, 20261112);
  assert.equal(detail.FchVtoPago, 20261112);

  // El orden importa: es la secuencia del WSDL.
  assert.deepEqual(Object.keys(detail), [
    'Concepto', 'DocTipo', 'DocNro', 'CbteDesde', 'CbteHasta', 'CbteFch',
    'ImpTotal', 'ImpTotConc', 'ImpNeto', 'ImpOpEx', 'ImpTrib', 'ImpIVA',
    'FchServDesde', 'FchServHasta', 'FchVtoPago', 'MonId', 'MonCotiz', 'CondicionIVAReceptorId',
  ]);
});

test('buildInvoiceDetail no informa fechas de servicio para productos', () => {
  const detail = rules.buildInvoiceDetail({ number: 1, concept: 1, date: 20261112, amount: 10 });

  assert.equal(detail.FchServDesde, null);
  assert.equal(detail.FchServHasta, null);
  assert.equal(detail.FchVtoPago, null);
});

test('firstInvoiceOnOrAfter funciona con más de 255 comprobantes', async () => {
  // Comprobante n -> fecha: 3 comprobantes por día a partir del 01/01/2026.
  const dateOf = (n) => rules.toArcaDate(rules.addDays(new Date(2026, 0, 1), Math.floor((n - 1) / 3)));
  const last = 1000;
  let lookups = 0;
  const getDate = async (n) => {
    lookups++;
    return dateOf(n);
  };

  const target = rules.toArcaDate(rules.addDays(new Date(2026, 0, 1), 200)); // día 200 -> comprobante 601
  assert.equal(await rules.firstInvoiceOnOrAfter(last, target, getDate), 601);
  assert.ok(lookups <= 11, `búsqueda binaria: ${lookups} consultas`);

  assert.equal(await rules.firstInvoiceOnOrAfter(last, 20250101, getDate), 1);
  assert.equal(await rules.firstInvoiceOnOrAfter(last, 20300101, getDate), last + 1);
  assert.equal(await rules.firstInvoiceOnOrAfter(0, 20260101, getDate), 1);
});
