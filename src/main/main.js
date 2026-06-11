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
let sendUpdate = () => {};
let updateCheckInterval = null;
let isQuitting = false;
let pendingUpdateMessages = [];
let previewShowAll = false;
let previewSelectedId = null;

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

  // Cuando el dashboard termine de cargar, drenamos los mensajes encolados del updater
  dashboardWindow.webContents.on('did-finish-load', () => {
    if (pendingUpdateMessages.length > 0) {
      for (const { channel, payload } of pendingUpdateMessages) {
        dashboardWindow.webContents.send('updater:' + channel, payload);
      }
      pendingUpdateMessages = [];
    }
  });

  // Interceptar el evento close: cuando el usuario cierra el dashboard,
  // cerramos toda la app (incluyendo los overlays).
  dashboardWindow.on('close', () => {
    if (!isQuitting) {
      isQuitting = true;
      // Cerrar todas las ventanas de overlays
      for (const [id, win] of overlayManager.windows.entries()) {
        if (win && !win.isDestroyed()) {
          win.destroy();
        }
      }
      app.quit();
    }
  });

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
    sectors: irsdk.getSectors(),
    lapTimes: irsdk.getLapTimes(),
    tyres: irsdk.getTyres(),
    relative: irsdk.getRelative(),
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
    sendUpdate = (channel, payload = {}) => {
      if (dashboardWindow && !dashboardWindow.isDestroyed()) {
        // Si el dashboard ya cargó, enviamos directo
        if (dashboardWindow.webContents.isLoading()) {
          pendingUpdateMessages.push({ channel, payload });
        } else {
          dashboardWindow.webContents.send('updater:' + channel, payload);
        }
      } else {
        // Dashboard aún no existe, encolamos
        pendingUpdateMessages.push({ channel, payload });
      }
    };

    // Chequear al iniciar (silencioso si no hay update)
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[updater] error checking:', err.message);
    });

    // Chequeo periódico cada 1 hora mientras la app está abierta
    updateCheckInterval = setInterval(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        console.error('[updater] error checking:', err.message);
      });
    }, 60 * 60 * 1000); // 1 hora

    autoUpdater.on('checking-for-update', () => {
      sendUpdate('checking');
    });

    autoUpdater.on('update-available', (info) => {
      console.log('[updater] update available:', info.version);
      sendUpdate('available', { version: info.version });
    });

    autoUpdater.on('update-not-available', (info) => {
      console.log('[updater] no update available. current:', info.version);
    });

    autoUpdater.on('download-progress', (progress) => {
      sendUpdate('progress', {
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      });
    });

    autoUpdater.on('update-downloaded', (info) => {
      sendUpdate('downloaded', { version: info.version });
    });

    autoUpdater.on('error', (err) => {
      sendUpdate('error', { message: err.message });
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
  globalShortcut.register('F6', () => {
    const n = overlayManager.forceShowAll();
    console.log(`[main] F6: forzando aparición de ${n} overlay(s)`);
  });
  globalShortcut.register('F9', () => {
    const enabled = irsdk.togglePreview();
    console.log(`[main] preview mode: ${enabled ? 'ON' : 'OFF'}`);
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  // Cerrar todos los overlays que sigan abiertos
  for (const [id, win] of overlayManager.windows.entries()) {
    if (win && !win.isDestroyed()) {
      win.destroy();
    }
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (broadcastInterval) clearInterval(broadcastInterval);
  if (updateCheckInterval) clearInterval(updateCheckInterval);
  if (irsdk) irsdk.stop();
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('config:get', () => configStore.get());
ipcMain.handle('config:toggle-overlay', (_e, id) => {
  const enabled = overlayManager.toggle(id);
  applyPreviewMode();
  return enabled;
});
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

ipcMain.handle('sectors:get', () => {
  if (!irsdk || typeof irsdk.getSectors !== 'function') {
    return {
      current: new Array(9).fill(null),
      last: new Array(9).fill(null),
      best: new Array(9).fill(null),
    };
  }
  return irsdk.getSectors();
});

ipcMain.handle('preview:toggle', () => {
  const enabled = irsdk.togglePreview();
  applyPreviewMode();
  return enabled;
});
ipcMain.handle('preview:get', () => irsdk.isPreview());
ipcMain.handle('preview:set', (_e, enabled) => {
  if (enabled) irsdk.enablePreview();
  else irsdk.disablePreview();
  return irsdk.isPreview();
});
ipcMain.handle('preview:configure', (_e, { showAll, selectedId }) => {
  previewShowAll = !!showAll;
  previewSelectedId = selectedId || null;
  applyPreviewMode();
  return { showAll: previewShowAll, selectedId: previewSelectedId };
});

function applyPreviewMode() {
  // Si preview está OFF, los overlays siguen su config (enabled normal)
  // Si preview está ON:
  //   - showAll=false: solo el overlay seleccionado se muestra
  //   - showAll=true: todos los overlays activos se muestran
  const preview = irsdk.isPreview();
  if (!preview) {
    // Restaurar estado normal: solo los enabled
    for (const [id, ov] of Object.entries(configStore.get().overlays)) {
      if (ov.enabled) overlayManager.show(id);
      else overlayManager.hide(id);
    }
    return;
  }
  // Modo preview
  if (previewShowAll) {
    for (const [id, ov] of Object.entries(configStore.get().overlays)) {
      if (ov.enabled) overlayManager.show(id);
      else overlayManager.hide(id);
    }
  } else if (previewSelectedId) {
    for (const [id, ov] of Object.entries(configStore.get().overlays)) {
      if (id === previewSelectedId) overlayManager.show(id);
      else overlayManager.hide(id);
    }
  }
}

ipcMain.handle('updater:install', () => {
  autoUpdater.quitAndInstall();
});
ipcMain.handle('updater:check', () => {
  autoUpdater.checkForUpdates();
});
