const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const forge = require('node-forge');

const { ArcaError, toXml } = require('../src/arca/soap');
const wsaa = require('../src/arca/wsaa');
const { ArcaService } = require('../src/arca/service');
const { ConfigStore } = require('../src/main/config');
const { selfSigned, soapEnvelope, loginResponse, wsfeResponse, fakeTransport } = require('./helpers');

const credentials = selfSigned();
const CUIT = '20111111112';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'croessant-test-'));
}

function service(routes, dir = tempDir()) {
  const transport = fakeTransport({
    loginCms: () => loginResponse(),
    FEDummy: () => wsfeResponse('FEDummy', '<AppServer>OK</AppServer><DbServer>OK</DbServer><AuthServer>OK</AuthServer>'),
    ...routes,
  });
  const arca = new ArcaService({
    environment: 'homologation',
    ticketDir: dir,
    transport,
    loadCredentials: async () => ({ cuit: CUIT, ...credentials }),
  });

  return { arca, transport, dir };
}

const voucher = (number, date, total = '100.50') =>
  wsfeResponse(
    'FECompConsultar',
    `<ResultGet><Concepto>2</Concepto><DocTipo>99</DocTipo><DocNro>0</DocNro><CbteDesde>${number}</CbteDesde>` +
      `<CbteHasta>${number}</CbteHasta><CbteFch>${date}</CbteFch><ImpTotal>${total}</ImpTotal>` +
      '<Resultado>A</Resultado><CodAutorizacion>76461234567890</CodAutorizacion><PtoVta>3</PtoVta><CbteTipo>11</CbteTipo></ResultGet>'
  );

test('toXml respeta el orden, omite nulos y escapa', () => {
  assert.equal(toXml({ b: 1, a: null, c: { d: 'x & <y>' }, e: [1, 2] }), '<b>1</b><c><d>x &amp; &lt;y&gt;</d></c><e>1</e><e>2</e>');
});

test('signTra genera un CMS firmado que contiene el TRA', () => {
  const tra = wsaa.buildTra('wsfe', new Date('2026-11-12T12:00:00Z'));
  const cms = wsaa.signTra(tra, credentials.certPem, credentials.keyPem);
  const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(forge.util.decode64(cms)));

  assert.match(tra, /<generationTime>2026-11-12T11:50:00Z<\/generationTime>/);
  assert.match(tra, /<expirationTime>2026-11-12T12:10:00Z<\/expirationTime>/);
  assert.match(tra, /<service>wsfe<\/service>/);
  assert.equal(p7.certificates.length, 1);
  assert.equal(p7.rawCapture.content.value[0].value, tra);
});

test('checkCredentials detecta claves que no corresponden y certificados vencidos', () => {
  const other = selfSigned();
  const expired = selfSigned({ notAfter: new Date(Date.now() - 1000) });

  assert.equal(wsaa.checkCredentials(credentials.certPem, credentials.keyPem).ok, true);
  assert.match(wsaa.checkCredentials(credentials.certPem, other.keyPem).reason, /no corresponde/);
  assert.match(wsaa.checkCredentials(expired.certPem, expired.keyPem).reason, /venció/);
  assert.equal(wsaa.checkCredentials('basura', credentials.keyPem).ok, false);
});

test('login traduce los SOAP Fault del WSAA', async () => {
  const transport = fakeTransport({
    loginCms: () => ({
      status: 500,
      text: soapEnvelope(
        '<soap:Fault><faultcode xmlns:ns1="http://xml.apache.org/axis/">ns1:cms.cert.untrusted</faultcode>' +
          '<faultstring>Certificado no emitido por AC de confianza</faultstring></soap:Fault>'
      ),
    }),
  });

  await assert.rejects(
    wsaa.login({ ...credentials, environment: 'homologation', transport }),
    (e) => e instanceof ArcaError && e.code === 'cms.cert.untrusted' && /no reconoce el certificado/.test(e.message)
  );
});

test('connect: autentica, reutiliza el ticket guardado y filtra puntos de venta', async () => {
  const routes = {
    FEParamGetPtosVenta: () =>
      wsfeResponse(
        'FEParamGetPtosVenta',
        '<ResultGet>' +
          '<PtoVenta><Nro>3</Nro><EmisionTipo>CAE</EmisionTipo><Bloqueado>N</Bloqueado><FchBaja>NULL</FchBaja></PtoVenta>' +
          '<PtoVenta><Nro>4</Nro><EmisionTipo>CAE</EmisionTipo><Bloqueado>S</Bloqueado><FchBaja>NULL</FchBaja></PtoVenta>' +
          '<PtoVenta><Nro>5</Nro><EmisionTipo>CAE</EmisionTipo><Bloqueado>N</Bloqueado><FchBaja>20240101</FchBaja></PtoVenta>' +
          '</ResultGet>'
      ),
  };
  const first = service(routes);

  assert.deepEqual(await first.arca.connect(), { status: 'ok', pointsOfSale: [{ number: 3, type: 'CAE' }] });

  const request = first.transport.calls.find((c) => c.method === 'FEParamGetPtosVenta').body;
  assert.match(request, /<Auth><Token>VE9LRU4=<\/Token><Sign>U0lHTg==<\/Sign><Cuit>20111111112<\/Cuit><\/Auth>/);

  // Una segunda instancia (otra ejecución de la app) no vuelve a pedir ticket.
  const second = service(routes, first.dir);
  await second.arca.connect();
  assert.equal(second.transport.calls.filter((c) => c.method === 'loginCms').length, 0);
});

test('connect: informa cada tipo de problema por separado', async () => {
  const noPoints = service({
    FEParamGetPtosVenta: () => wsfeResponse('FEParamGetPtosVenta', '<Errors><Err><Code>602</Code><Msg>Sin Resultados</Msg></Err></Errors>'),
  });
  assert.equal((await noPoints.arca.connect()).status, 'no-points-of-sale');

  const offline = service({
    FEDummy: () => {
      throw new Error('ENOTFOUND');
    },
  });
  assert.equal((await offline.arca.connect()).status, 'offline');

  const wrongCuit = service({
    FEParamGetPtosVenta: () =>
      wsfeResponse('FEParamGetPtosVenta', '<Errors><Err><Code>600</Code><Msg>ValidacionDeToken: No apareció CUIT en lista de relaciones</Msg></Err></Errors>'),
  });
  const result = await wrongCuit.arca.connect();
  assert.equal(result.status, 'auth');
  assert.match(result.message, /600/);

  const unconfigured = new ArcaService({ ticketDir: tempDir(), loadCredentials: async () => null });
  assert.equal((await unconfigured.connect()).status, 'not-configured');
});

test('createInvoice: numera, envía la condición de IVA y devuelve el CAE', async () => {
  const { arca, transport } = service({
    FECompUltimoAutorizado: () => wsfeResponse('FECompUltimoAutorizado', '<PtoVta>3</PtoVta><CbteTipo>11</CbteTipo><CbteNro>299</CbteNro>'),
    FECAESolicitar: () =>
      wsfeResponse(
        'FECAESolicitar',
        '<FeCabResp><Resultado>A</Resultado></FeCabResp><FeDetResp><FECAEDetResponse>' +
          '<Concepto>2</Concepto><CbteDesde>300</CbteDesde><Resultado>A</Resultado>' +
          '<CAE>76461234567890</CAE><CAEFchVto>20261122</CAEFchVto></FECAEDetResponse></FeDetResp>'
      ),
  });

  const invoice = await arca.createInvoice({ pointOfSale: 3, concept: 2, date: '20261112', amount: 15000.5 });

  assert.deepEqual(invoice, { number: 300, date: 20261112, cae: '76461234567890', caeExpiration: '20261122', observations: '' });

  const request = transport.calls.find((c) => c.method === 'FECAESolicitar').body;
  assert.match(request, /<FeCabReq><CantReg>1<\/CantReg><PtoVta>3<\/PtoVta><CbteTipo>11<\/CbteTipo><\/FeCabReq>/);
  assert.match(request, /<CbteDesde>300<\/CbteDesde><CbteHasta>300<\/CbteHasta><CbteFch>20261112<\/CbteFch><ImpTotal>15000.50<\/ImpTotal>/);
  assert.match(request, /<MonCotiz>1<\/MonCotiz><CondicionIVAReceptorId>5<\/CondicionIVAReceptorId><\/FECAEDetRequest>/);
});

test('createInvoice: un rechazo solo con observaciones es un error', async () => {
  const { arca } = service({
    FECompUltimoAutorizado: () => wsfeResponse('FECompUltimoAutorizado', '<CbteNro>0</CbteNro>'),
    FECAESolicitar: () =>
      wsfeResponse(
        'FECAESolicitar',
        '<FeCabResp><Resultado>R</Resultado></FeCabResp><FeDetResp><FECAEDetResponse><Resultado>R</Resultado><CAE></CAE>' +
          '<Observaciones><Obs><Code>10016</Code><Msg>El campo CbteFch no es valido</Msg></Obs></Observaciones>' +
          '</FECAEDetResponse></FeDetResp>'
      ),
  });

  await assert.rejects(
    arca.createInvoice({ pointOfSale: 3, concept: 1, date: '20261112', amount: 10 }),
    (e) => e instanceof ArcaError && e.code === '10016' && /CbteFch/.test(e.message)
  );
});

test('createInvoice: valida antes de llamar a ARCA', async () => {
  const { arca, transport } = service({});

  await assert.rejects(arca.createInvoice({ pointOfSale: 3, concept: 2, date: '20261112', amount: 10000000 }), /Monto/);
  await assert.rejects(arca.createInvoice({ pointOfSale: 3, concept: 9, date: '20261112', amount: 10 }), /Concepto/);
  await assert.rejects(arca.createInvoice({ pointOfSale: 3, concept: 2, date: '20261340', amount: 10 }), /Fecha/);
  assert.equal(transport.calls.length, 0);
});

test('listInvoices: devuelve el rango pedido aun con más de 255 comprobantes', async () => {
  // 400 comprobantes, uno por día desde el 01/01/2025.
  const dateOf = (n) => {
    const d = new Date(2025, 0, n);
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  };
  const { arca, transport } = service({
    FECompUltimoAutorizado: () => wsfeResponse('FECompUltimoAutorizado', '<CbteNro>400</CbteNro>'),
    FECompConsultar: (body) => {
      const number = Number(/<CbteNro>(\d+)<\/CbteNro>/.exec(body)[1]);
      return voucher(number, dateOf(number));
    },
  });

  const invoices = await arca.listInvoices({ pointOfSale: 3, from: String(dateOf(298)), to: String(dateOf(300)) });

  assert.deepEqual(invoices.map((i) => i.number), [298, 299, 300]);
  assert.deepEqual(invoices[0], { number: 298, date: dateOf(298), concept: 2, total: 100.5, cae: '76461234567890' });
  assert.ok(transport.calls.filter((c) => c.method === 'FECompConsultar').length < 25);
});

test('ConfigStore: detecta certificado y clave por contenido y valida al guardar', async () => {
  const source = tempDir();
  const store = new ConfigStore(path.join(tempDir(), 'userData'));

  fs.writeFileSync(path.join(source, 'mi_certificado_arca.pem'), credentials.certPem);
  fs.writeFileSync(path.join(source, 'privada'), credentials.keyPem);
  fs.writeFileSync(path.join(source, 'notas.txt'), 'hola');

  assert.equal(await store.isConfigured(), false);
  assert.deepEqual(await store.status(), { cuit: '', hasCert: false, hasKey: false });

  const imported = await store.importFiles(fs.readdirSync(source).map((name) => path.join(source, name)));
  assert.deepEqual(imported, { cert: true, key: true, rejected: ['notas.txt'] });

  assert.deepEqual((await store.save('20-11111111-3')).errors, { cuit: 'CUIT/CUIL inválido.' });
  assert.deepEqual(await store.save('20-11111111-2'), { ok: true, errors: {} });
  assert.equal((await store.credentials()).cuit, CUIT);

  await store.clear();
  assert.equal(await store.isConfigured(), false);
  assert.deepEqual(await store.status(), { cuit: '', hasCert: false, hasKey: false });
});
