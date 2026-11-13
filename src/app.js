const { app, shell, BrowserWindow } = require('electron');
const path = require('node:path');
const { ConfigStore } = require('./main/config');
const { registerIpc } = require('./main/ipc');
const { ArcaService } = require('./arca/service');

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

const viewsPath = path.join(__dirname, 'views');
// CROESSANT_ENV=homologation usa los servidores de prueba de ARCA (requiere un certificado de homologación).
const environment = process.env.CROESSANT_ENV === 'homologation' ? 'homologation' : 'production';
const dataPath = app.getPath('userData');
const config = new ConfigStore(dataPath);
const arca = new ArcaService({
  environment,
  ticketDir: dataPath,
  loadCredentials: () => config.credentials(),
});

const createWindow = async () => {
  const mainWindow = new BrowserWindow({
    width: 500,
    height: 900,
    icon: path.join(app.getAppPath(), 'assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'main/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Los links externos se abren en el navegador; la ventana solo muestra las vistas locales.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  const view = (await config.isConfigured()) ? 'generate_invoice.html' : 'configurate.html';
  // La vista puede navegar (p. ej. a una pantalla de error) antes de terminar de cargar.
  mainWindow.loadFile(path.join(viewsPath, view)).catch(() => {});
};

app.whenReady().then(() => {
  registerIpc({ config, arca, environment });
  createWindow();

  app.on('activate', () => {
    // On macOS it's common to re-create a window when the dock icon is clicked.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed, except on macOS.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
