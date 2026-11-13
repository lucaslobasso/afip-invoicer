const forge = require('node-forge');

/** Par certificado/clave autofirmado para tests (ARCA no lo reconoce, obviamente). */
function selfSigned({ notAfter } = {}) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  const attrs = [
    { name: 'commonName', value: 'croessant-test' },
    { name: 'serialNumber', value: 'CUIT 20111111112' },
  ];

  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = notAfter || new Date(Date.now() + 24 * 3600 * 1000);
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

function soapEnvelope(body) {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
    `<soap:Body>${body}</soap:Body></soap:Envelope>`
  );
}

function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Respuesta del WSAA con un ticket de acceso válido por 12 horas. */
function loginResponse({ token = 'VE9LRU4=', sign = 'U0lHTg==' } = {}) {
  const expiration = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
  const ticket =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<loginTicketResponse version="1.0"><header>' +
    '<source>CN=wsaa, O=AFIP, C=AR, SERIALNUMBER=CUIT 33693450239</source>' +
    '<destination>SERIALNUMBER=CUIT 20111111112, CN=croessant-test</destination>' +
    '<uniqueId>123456</uniqueId>' +
    `<generationTime>${new Date().toISOString()}</generationTime>` +
    `<expirationTime>${expiration}</expirationTime>` +
    `</header><credentials><token>${token}</token><sign>${sign}</sign></credentials>` +
    '</loginTicketResponse>';

  return soapEnvelope(
    '<loginCmsResponse xmlns="http://wsaa.view.sua.dvadac.desein.afip.gov">' +
      `<loginCmsReturn>${escapeXml(ticket)}</loginCmsReturn></loginCmsResponse>`
  );
}

function wsfeResponse(method, resultXml) {
  return soapEnvelope(
    `<${method}Response xmlns="http://ar.gov.afip.dif.FEV1/"><${method}Result>${resultXml}</${method}Result></${method}Response>`
  );
}

/**
 * Transporte falso: `routes` mapea el nombre del método (o 'loginCms') a una función
 * `(requestBody) => xml` o `{ status, text }`. Registra cada request en `calls`.
 */
function fakeTransport(routes) {
  const calls = [];

  const transport = async (url, { headers, body }) => {
    const method = /LoginCms$/.test(url) ? 'loginCms' : headers.SOAPAction.replace(/"/g, '').split('/').pop();
    calls.push({ url, method, body });

    if (!routes[method]) throw new Error(`Sin ruta para ${method}`);

    const response = routes[method](body);
    return typeof response === 'string' ? { status: 200, text: response } : response;
  };

  transport.calls = calls;
  return transport;
}

module.exports = { selfSigned, soapEnvelope, loginResponse, wsfeResponse, fakeTransport };
