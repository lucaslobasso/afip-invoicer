// Handlers IPC: única puerta de entrada de las vistas al disco y a ARCA.
const { ipcMain, dialog, BrowserWindow } = require('electron');
const rules = require('../arca/rules');

/**
 * @param {object} deps
 * @param {import('./config').ConfigStore} deps.config
 * @param {import('../arca/service').ArcaService} deps.arca
 * @param {'production'|'homologation'} deps.environment
 */
function registerIpc({ config, arca, environment }) {
  // Los errores viajan como datos: `ipcRenderer.invoke` deforma los mensajes de las excepciones.
  const handle = (channel, handler) => {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return { ok: true, data: await handler(event, ...args) };
      } catch (e) {
        if (e.name !== 'ArcaError') console.error(`[${channel}]`, e);
        return { ok: false, error: { message: e.message || 'Error inesperado.', code: e.code } };
      }
    });
  };

  handle('app:info', () => ({
    environment,
    maxAmount: rules.FINAL_CONSUMER_ID_THRESHOLD,
  }));
  handle('app:invoice-date-range', (_event, concept, lastInvoiceDate) =>
    rules.invoiceDateRange(Number(concept), lastInvoiceDate ? Number(lastInvoiceDate) : null)
  );

  handle('config:get', () => config.status());
  handle('config:save', (_event, cuit) => config.save(cuit));
  handle('config:clear', () => config.clear());
  handle('config:import-files', (_event, filePaths) =>
    config.importFiles((Array.isArray(filePaths) ? filePaths : []).filter((p) => typeof p === 'string' && p))
  );
  handle('config:pick-files', async (event) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: 'Seleccioná el certificado y la clave privada',
      buttonLabel: 'Cargar',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Certificado y clave', extensions: ['crt', 'key', 'pem', 'cer'] },
        { name: 'Todos los archivos', extensions: ['*'] },
      ],
    });

    return canceled ? null : config.importFiles(filePaths);
  });

  handle('arca:connect', () => arca.connect());
  handle('arca:last-invoice', (_event, pointOfSale) => arca.lastInvoice(Number(pointOfSale)));
  handle('arca:create-invoice', (_event, invoice = {}) =>
    arca.createInvoice({
      pointOfSale: Number(invoice.pointOfSale),
      concept: Number(invoice.concept),
      date: invoice.date,
      amount: Number(invoice.amount),
    })
  );
  handle('arca:list-invoices', (_event, query = {}) =>
    arca.listInvoices({ pointOfSale: Number(query.pointOfSale), from: query.from, to: query.to })
  );
}

module.exports = { registerIpc };
