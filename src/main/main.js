const { app, BrowserWindow, ipcMain, globalShortcut } = require('electron');
const path = require('path');
const { IrsdkClient } = require('./irsdk-client');
const { ConfigStore } = require('./config-store');
const { OverlayManager, REGISTRY } = require('./overlay-manager');

const isDev = process.env.NODE_ENV === 'development';

let irsdk = null;
let configStore = null;
let overlayManager = null;
let dashboardWindow = null;
let broadcastInterval = null;

function createDashboardWindow() {
  dashboardWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: 'Fly Overlays',
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: isDev,
    },
  });

  if (isDev) {
    dashboardWindow.loadURL('http://localhost:5173/dashboard.html');
  } else {
    dashboardWindow.loadFile(path.join(__dirname, '../../dist/dashboard.html'));
  }

  dashboardWindow.once('ready-to-show', () => dashboardWindow.show());
  dashboardWindow.on('closed', () => { dashboardWindow = null; });

  if (!isDev) {
    dashboardWindow.setMenuBarVisibility(false);
  }
}

function toggleDashboard() {
  if (!dashboardWindow || dashboardWindow.isDestroyed()) {
    createDashboardWindow();
  } else if (dashboardWindow.isVisible()) {
    dashboardWindow.hide();
  } else {
    dashboardWindow.show();
    dashboardWindow.focus();
  }
}

function broadcastTelemetry() {
  if (!irsdk) return;
  const data = {
    connected: irsdk.isConnected(),
    delta: irsdk.getDeltaBest(),
    lap: irsdk.getSession().lap,
    onTrack: irsdk.isOnTrack(),
    preview: irsdk.isPreview(),
  };
  for (const [id, win] of overlayManager.windows.entries()) {
    if (overlayManager.isUnlocked(id)) continue;
    if (win.isDestroyed()) continue;
    win.webContents.send('telemetry:update', data);
  }
}

const { autoUpdater } = require('electron-updater');

app.whenReady().then(() => {
  configStore = new ConfigStore();
  overlayManager = new OverlayManager(configStore);

  // Auto-update (solo en build empaquetado)
  if (!isDev) {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.error('[updater] error:', err.message);
    });

    autoUpdater.on('update-available', () => {
      console.log('[updater] nueva versión disponible, descargando...');
    });
    autoUpdater.on('update-downloaded', () => {
      console.log('[updater] update descargado, se instalará al cerrar');
    });
  }

  irsdk = new IrsdkClient();
  irsdk.start();

  irsdk.onUpdate((data) => {
    for (const [id, win] of overlayManager.windows.entries()) {
      if (overlayManager.isUnlocked(id)) continue;
      if (win.isDestroyed()) continue;
      win.webContents.send('telemetry:update', data);
    }
  });

  overlayManager.createAll();
  broadcastInterval = setInterval(broadcastTelemetry, 1000 / 60);

  createDashboardWindow();

  const config = configStore.get();
  globalShortcut.register(config.hotkeys.toggleLock, () => {
    for (const id of overlayManager.windows.keys()) {
      overlayManager.toggleUnlocked(id);
    }
  });
  globalShortcut.register(config.hotkeys.openPanel, toggleDashboard);
  globalShortcut.register('F9', () => {
    const enabled = irsdk.togglePreview();
    console.log(`[main] preview mode: ${enabled ? 'ON' : 'OFF'}`);
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (broadcastInterval) clearInterval(broadcastInterval);
  if (irsdk) irsdk.stop();
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('config:get', () => configStore.get());
ipcMain.handle('config:toggle-overlay', (_e, id) => overlayManager.toggle(id));
ipcMain.handle('config:set-overlay', (_e, id, updates) => {
  return overlayManager.applyOverlayUpdate(id, updates);
});
ipcMain.handle('config:registry', () => REGISTRY);

ipcMain.handle('overlay:toggle-lock', () => {
  const results = {};
  for (const id of overlayManager.windows.keys()) {
    results[id] = overlayManager.toggleUnlocked(id);
  }
  return results;
});

ipcMain.handle('preview:toggle', () => irsdk.togglePreview());
ipcMain.handle('preview:get', () => irsdk.isPreview());
ipcMain.handle('preview:set', (_e, enabled) => {
  if (enabled) irsdk.enablePreview();
  else irsdk.disablePreview();
  return irsdk.isPreview();
});
