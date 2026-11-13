// Puente entre las vistas (sin acceso a Node) y el proceso principal.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function invoke(channel, ...args) {
  const response = await ipcRenderer.invoke(channel, ...args);

  if (!response.ok) {
    const error = new Error(response.error.message);
    error.code = response.error.code;
    throw error;
  }

  return response.data;
}

contextBridge.exposeInMainWorld('croessant', {
  info: () => invoke('app:info'),
  invoiceDateRange: (concept, lastInvoiceDate) => invoke('app:invoice-date-range', concept, lastInvoiceDate),

  getConfig: () => invoke('config:get'),
  saveConfig: (cuit) => invoke('config:save', cuit),
  clearConfig: () => invoke('config:clear'),
  pickFiles: () => invoke('config:pick-files'),
  // Recibe los `File` de un drag & drop.
  importFiles: (files) =>
    invoke('config:import-files', Array.from(files, (file) => webUtils.getPathForFile(file))),

  connect: () => invoke('arca:connect'),
  lastInvoice: (pointOfSale) => invoke('arca:last-invoice', pointOfSale),
  createInvoice: (invoice) => invoke('arca:create-invoice', invoice),
  listInvoices: (query) => invoke('arca:list-invoices', query),
});
