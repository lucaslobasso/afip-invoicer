// Configuración del usuario: CUIT, certificado y clave privada, guardados en `userData`.
const { promises: fs } = require('node:fs');
const path = require('node:path');
const { isValidCuit } = require('../arca/rules');
const { checkCredentials } = require('../arca/wsaa');

const CERT_FILE = 'cert.crt';
const KEY_FILE = 'key.key';
const CUIT_FILE = 'cuit.txt';
const MAX_PEM_SIZE = 64 * 1024;

class ConfigStore {
  /** @param {string} dir Carpeta de datos de la aplicación. */
  constructor(dir) {
    this.dir = dir;
  }

  file(name) {
    return path.join(this.dir, name);
  }

  async read(name) {
    try {
      return (await fs.readFile(this.file(name), 'utf8')).trim();
    } catch (e) {
      return '';
    }
  }

  /** Credenciales completas o `null` si falta algo. */
  async credentials() {
    const [cuit, certPem, keyPem] = await Promise.all([
      this.read(CUIT_FILE),
      this.read(CERT_FILE),
      this.read(KEY_FILE),
    ]);

    return isValidCuit(cuit) && certPem && keyPem ? { cuit, certPem, keyPem } : null;
  }

  async isConfigured() {
    return (await this.credentials()) !== null;
  }

  /** Estado para mostrar en la pantalla de configuración. */
  async status() {
    const [cuit, certPem, keyPem] = await Promise.all([
      this.read(CUIT_FILE),
      this.read(CERT_FILE),
      this.read(KEY_FILE),
    ]);

    return { cuit, hasCert: Boolean(certPem), hasKey: Boolean(keyPem) };
  }

  /**
   * Importa certificados y/o claves. El tipo se detecta por el contenido,
   * así que no importa cómo se llamen los archivos.
   * @returns {Promise<{ cert: boolean, key: boolean, rejected: string[] }>}
   */
  async importFiles(filePaths) {
    const result = { cert: false, key: false, rejected: [] };

    await fs.mkdir(this.dir, { recursive: true });

    for (const filePath of filePaths) {
      let content = '';

      try {
        const stat = await fs.stat(filePath);
        if (stat.isFile() && stat.size <= MAX_PEM_SIZE) {
          content = await fs.readFile(filePath, 'utf8');
        }
      } catch (e) {
        // Se informa como rechazado.
      }

      if (/-----BEGIN CERTIFICATE-----/.test(content)) {
        await fs.writeFile(this.file(CERT_FILE), content);
        result.cert = true;
      } else if (/-----BEGIN (RSA |ENCRYPTED )?PRIVATE KEY-----/.test(content)) {
        await fs.writeFile(this.file(KEY_FILE), content, { mode: 0o600 });
        result.key = true;
      } else {
        result.rejected.push(path.basename(filePath));
      }
    }

    return result;
  }

  /**
   * Valida y guarda el CUIT, y revisa que el certificado y la clave sean coherentes.
   * @returns {Promise<{ ok: boolean, errors: { cuit?: string, files?: string } }>}
   */
  async save(cuitInput) {
    const cuit = String(cuitInput || '').replace(/\D/g, '');
    const errors = {};

    if (!isValidCuit(cuit)) {
      errors.cuit = 'CUIT/CUIL inválido.';
    } else {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(this.file(CUIT_FILE), cuit);
    }

    const [certPem, keyPem] = await Promise.all([this.read(CERT_FILE), this.read(KEY_FILE)]);

    if (!certPem) {
      errors.files = 'Falta cargar el certificado.';
    } else if (!keyPem) {
      errors.files = 'Falta cargar la clave privada.';
    } else {
      const check = checkCredentials(certPem, keyPem);
      if (!check.ok) errors.files = check.reason;
    }

    return { ok: Object.keys(errors).length === 0, errors };
  }

  /** Borra CUIT, certificado, clave y tickets de acceso guardados. */
  async clear() {
    let names = [];

    try {
      names = await fs.readdir(this.dir);
    } catch (e) {
      return;
    }

    const own = names.filter(
      (name) => [CERT_FILE, KEY_FILE, CUIT_FILE].includes(name) || /^ta-.*\.json$/.test(name)
    );

    await Promise.all(own.map((name) => fs.rm(this.file(name), { force: true })));
  }
}

module.exports = { ConfigStore };
