// Cliente SOAP 1.1 mínimo para los web services de ARCA (ex AFIP).
const https = require('node:https');
const { XMLParser } = require('fast-xml-parser');

const TIMEOUT_MS = 30000;

class ArcaError extends Error {
  /**
   * @param {string} message Mensaje legible para el usuario.
   * @param {string|number} [code] Código de ARCA (o un identificador propio).
   */
  constructor(message, code) {
    super(message);
    this.name = 'ArcaError';
    this.code = code === undefined ? undefined : String(code);
  }
}

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  // Tokens, CAE y fechas tienen que quedar como texto: nada de conversiones automáticas.
  parseTagValue: false,
  trimValues: true,
});

function parseXml(xml) {
  return parser.parse(xml);
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Serializa un objeto plano a XML respetando el orden de las claves
 * (los servicios .asmx de ARCA ignoran elementos fuera de secuencia).
 * Los valores `null`/`undefined` se omiten.
 */
function toXml(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return escapeXml(value);

  return Object.entries(value)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([tag, v]) =>
      Array.isArray(v)
        ? v.map((item) => `<${tag}>${toXml(item)}</${tag}>`).join('')
        : `<${tag}>${toXml(v)}</${tag}>`
    )
    .join('');
}

function envelope(body) {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
    `<soap:Body>${body}</soap:Body>` +
    '</soap:Envelope>'
  );
}

/** Transporte para el proceso principal de Electron (stack de red de Chromium, respeta proxies). */
async function electronTransport(url, { headers, body }) {
  const { net } = require('electron');
  const res = await net.fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { status: res.status, text: await res.text() };
}

/**
 * Transporte para Node "puro" (tests, scripts).
 * Los servidores de ARCA ofrecen DHE con claves de 1024 bits que OpenSSL 3 rechaza
 * ("dh key too small"), por eso se excluyen esos cifrados.
 */
function nodeTransport(url, { headers, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'POST',
        ciphers: 'DEFAULT:!DHE',
        timeout: TIMEOUT_MS,
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

function defaultTransport() {
  return process.versions.electron ? electronTransport : nodeTransport;
}

/**
 * Envía un request SOAP y devuelve el contenido de `<Body>` ya parseado.
 * Lanza `ArcaError` ante errores de red (`code: 'network'`) o SOAP Faults.
 */
async function soapRequest({ url, action, body, transport = defaultTransport() }) {
  let response;

  try {
    response = await transport(url, {
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: `"${action}"`,
      },
      body: envelope(body),
    });
  } catch (e) {
    throw new ArcaError(`No se pudo conectar con ARCA (${e.message}).`, 'network');
  }

  let parsed;
  try {
    parsed = parseXml(response.text);
  } catch (e) {
    parsed = null;
  }

  const soapBody = parsed && parsed.Envelope && parsed.Envelope.Body;

  if (soapBody && soapBody.Fault) {
    const { faultcode, faultstring } = soapBody.Fault;
    throw new ArcaError(String(faultstring || 'Error de ARCA'), String(faultcode || 'fault'));
  }
  if (!soapBody || response.status < 200 || response.status >= 300) {
    throw new ArcaError(`Respuesta inesperada de ARCA (HTTP ${response.status}).`, 'network');
  }

  return soapBody;
}

module.exports = { ArcaError, soapRequest, toXml, escapeXml, parseXml, nodeTransport };
