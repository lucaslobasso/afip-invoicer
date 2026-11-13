// WSAA: Web Service de Autenticación y Autorización de ARCA.
// Especificación: https://www.arca.gob.ar/ws/documentacion/wsaa.asp
const forge = require('node-forge');
const { ArcaError, soapRequest, escapeXml, parseXml } = require('./soap');

const WSAA_URLS = {
  production: 'https://wsaa.afip.gov.ar/ws/services/LoginCms',
  homologation: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
};

const TRA_WINDOW_MS = 10 * 60 * 1000;

const FAULT_MESSAGES = {
  'cms.cert.untrusted': 'ARCA no reconoce el certificado. Verificá que sea el emitido por ARCA para este ambiente.',
  'cms.cert.expired': 'El certificado está vencido. Generá uno nuevo desde ARCA.',
  'cms.cert.invalid': 'El certificado no es válido.',
  'cms.cert.blacklist': 'ARCA bloqueó este certificado. Generá uno nuevo.',
  'cms.sign.invalid': 'La clave privada no corresponde al certificado.',
  'cms.bad': 'ARCA no pudo leer la firma generada con el certificado y la clave.',
  'cms.bad.base64': 'ARCA no pudo leer la firma generada con el certificado y la clave.',
  'cms.cert.notFound': 'No se encontró el certificado en la firma.',
  'coe.notAuthorized': 'El certificado no está autorizado a usar el servicio de Facturación Electrónica (wsfe). Asocialo desde el "Administrador de Relaciones de Clave Fiscal".',
  'coe.alreadyAuthenticated': 'ARCA ya emitió un ticket de acceso vigente para este certificado. Volvé a intentar en unos minutos.',
  'wsn.unavailable': 'El servicio de Facturación Electrónica no está disponible. Intentá más tarde.',
  'wsaa.unavailable': 'El servicio de autenticación de ARCA no está disponible. Intentá más tarde.',
  'wsaa.internalError': 'El servicio de autenticación de ARCA tuvo un error interno. Intentá más tarde.',
};

function isoSeconds(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Ticket de Requerimiento de Acceso. */
function buildTra(service, now = new Date()) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<loginTicketRequest version="1.0">' +
    '<header>' +
    `<uniqueId>${Math.floor(now.getTime() / 1000)}</uniqueId>` +
    `<generationTime>${isoSeconds(new Date(now.getTime() - TRA_WINDOW_MS))}</generationTime>` +
    `<expirationTime>${isoSeconds(new Date(now.getTime() + TRA_WINDOW_MS))}</expirationTime>` +
    '</header>' +
    `<service>${escapeXml(service)}</service>` +
    '</loginTicketRequest>'
  );
}

/** Firma el TRA como CMS (PKCS#7 SignedData, contenido incluido) y lo devuelve en base64. */
function signTra(tra, certPem, keyPem) {
  const p7 = forge.pkcs7.createSignedData();

  p7.content = forge.util.createBuffer(tra, 'utf8');
  p7.addCertificate(certPem);
  p7.addSigner({
    key: forge.pki.privateKeyFromPem(keyPem),
    certificate: forge.pki.certificateFromPem(certPem),
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign();

  return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes());
}

/**
 * Revisa localmente el par certificado/clave antes de molestar a ARCA.
 * @returns {{ ok: true, expires: Date, subject: string } | { ok: false, reason: string }}
 */
function checkCredentials(certPem, keyPem, now = new Date()) {
  let cert, key;

  try {
    cert = forge.pki.certificateFromPem(certPem);
  } catch (e) {
    return { ok: false, reason: 'El certificado no es un archivo PEM válido.' };
  }
  try {
    key = forge.pki.privateKeyFromPem(keyPem);
  } catch (e) {
    return { ok: false, reason: 'La clave privada no es un archivo PEM válido (o está protegida con contraseña).' };
  }

  if (cert.publicKey.n.compareTo(key.n) !== 0) {
    return { ok: false, reason: 'La clave privada no corresponde al certificado.' };
  }
  if (cert.validity.notAfter < now) {
    return {
      ok: false,
      reason: `El certificado venció el ${cert.validity.notAfter.toLocaleDateString('es-AR')}. Generá uno nuevo desde ARCA.`,
    };
  }

  const cn = cert.subject.getField('CN');
  return { ok: true, expires: cert.validity.notAfter, subject: cn ? cn.value : '' };
}

/**
 * Pide un Ticket de Acceso para `service`.
 * @returns {Promise<{ token: string, sign: string, expiration: string }>}
 */
async function login({ service = 'wsfe', certPem, keyPem, environment = 'production', transport, now }) {
  let cms;

  try {
    cms = signTra(buildTra(service, now), certPem, keyPem);
  } catch (e) {
    throw new ArcaError('No se pudo firmar el pedido de acceso con el certificado y la clave cargados.', 'cms.local');
  }

  let body;
  try {
    body = await soapRequest({
      url: WSAA_URLS[environment],
      action: '',
      body:
        '<loginCms xmlns="http://wsaa.view.sua.dvadac.desein.afip.gov">' +
        `<in0>${cms}</in0>` +
        '</loginCms>',
      transport,
    });
  } catch (e) {
    if (e instanceof ArcaError && e.code !== 'network') {
      // faultcode llega como "ns1:cms.cert.untrusted"
      const code = e.code.split(':').pop();
      throw new ArcaError(FAULT_MESSAGES[code] || e.message, code);
    }
    throw e;
  }

  const ticketXml = body.loginCmsResponse && body.loginCmsResponse.loginCmsReturn;
  const ticket = ticketXml && parseXml(ticketXml).loginTicketResponse;

  if (!ticket || !ticket.credentials || !ticket.credentials.token) {
    throw new ArcaError('ARCA devolvió un ticket de acceso inválido.', 'wsaa.badResponse');
  }

  return {
    token: ticket.credentials.token,
    sign: ticket.credentials.sign,
    expiration: ticket.header.expirationTime,
  };
}

module.exports = { WSAA_URLS, buildTra, signTra, checkCredentials, login };
