const { app, BrowserWindow, ipcMain, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { IrsdkClient } = require('./irsdk-client');
const { ConfigStore } = require('./config-store');
const { OverlayManager, REGISTRY } = require('./overlay-manager');
const { SessionRecorder } = require('./session-recorder');

const isDev = process.env.NODE_ENV === 'development';

let irsdk = null;
let recorder = null;
let configStore = null;
let overlayManager = null;
let dashboardWindow = null;
let _recPrevConnected = false;
let sendUpdate = () => {};
let updateCheckInterval = null;
let isQuitting = false;
let pendingUpdateMessages = [];
let previewShowAll = false;
let previewSelectedId = null;

// === Rebranding a "iFly": migración de datos ===
// Con el nuevo productName "iFly", Electron usaría %APPDATA%/iFly como userData,
// dejando atrás la config y las grabaciones del nombre viejo. Para no perder
// nada, fijamos userData a una carpeta estable ("iFly") y, si está vacía,
// copiamos config.json + recordings desde las ubicaciones anteriores.
// Fijar la carpeta también nos independiza de futuros cambios de nombre.
function migrateUserData() {
  try {
    const appData = app.getPath('appData');
    const targetDir = path.join(appData, 'iFly');
    const alreadyMigrated = fs.existsSync(path.join(targetDir, 'config.json'));

    if (!alreadyMigrated) {
      // Ubicaciones históricas posibles (productName viejo / name npm).
      const candidates = ['Fly Overlays', 'fly-overlays'];
      for (const name of candidates) {
        const oldDir = path.join(appData, name);
        if (oldDir === targetDir) continue;
        const hasConfig = fs.existsSync(path.join(oldDir, 'config.json'));
        const hasRecordings = fs.existsSync(path.join(oldDir, 'recordings'));
        if (hasConfig || hasRecordings) {
          fs.mkdirSync(targetDir, { recursive: true });
          if (hasConfig) {
            fs.copyFileSync(path.join(oldDir, 'config.json'), path.join(targetDir, 'config.json'));
          }
          if (hasRecordings) {
            fs.cpSync(path.join(oldDir, 'recordings'), path.join(targetDir, 'recordings'), { recursive: true });
          }
          console.log(`[migrate] datos copiados desde "${name}" a "iFly"`);
          break;
        }
      }
    }

    app.setPath('userData', targetDir);
  } catch (err) {
    console.error('[migrate] error migrando userData:', err.message);
  }
}
migrateUserData();

function createDashboardWindow() {
  dashboardWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: 'iFly',
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

  // Grabador de sesiones: recibe frames del SDK real y persiste por vuelta.
  recorder = new SessionRecorder(path.join(app.getPath('userData'), 'recordings'));
  irsdk.setFrameSink((frame) => recorder.handleFrame(frame));
  recorder.onChange(() => {
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send('recordings:changed');
    }
  });

  irsdk.start();

  // Canal rápido (60 Hz): delta, lap, onTrack, connected, preview, sectors.
  // Lo consume el DeltaBar y el SectorTimes (necesita sectors al cruzar splits).
  irsdk.onUpdate((data) => {
    // Cerrar la sesión de grabación al desconectar iRacing (transición conectado→no).
    if (_recPrevConnected && !data.connected) {
      recorder.endSession();
    }
    _recPrevConnected = !!data.connected;

    for (const [id, win] of overlayManager.windows.entries()) {
      if (overlayManager.isUnlocked(id)) continue;
      if (win.isDestroyed()) continue;
      win.webContents.send('telemetry:update', data);
    }
  });

  // Canal pesado (~1 Hz): lapTimes, tyres, relative.
  // Se emite sólo cuando algún campo pesado cambió (gracias al dirty flag
  // interno de IrsdkClient). Reduce ~60× el IPC payload de relative/tyres.
  irsdk.onHeavyUpdate((data) => {
    for (const [id, win] of overlayManager.windows.entries()) {
      if (overlayManager.isUnlocked(id)) continue;
      if (win.isDestroyed()) continue;
      win.webContents.send('telemetry:heavy', data);
    }
  });

  overlayManager.createAll();

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
  if (updateCheckInterval) clearInterval(updateCheckInterval);
  if (recorder) recorder.endSession();
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

ipcMain.handle('recordings:list', () => (recorder ? recorder.listSessions() : []));
ipcMain.handle('recordings:get', (_e, id) => (recorder ? recorder.getSession(id) : null));
ipcMain.handle('recordings:delete', (_e, id) => (recorder ? recorder.deleteSession(id) : false));

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
