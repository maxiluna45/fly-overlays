const { app, BrowserWindow, ipcMain, globalShortcut, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { IrsdkClient } = require('./irsdk-client');
const { ConfigStore } = require('./config-store');
const { OverlayManager, REGISTRY } = require('./overlay-manager');
const { SessionRecorder } = require('./session-recorder');
const { parseIbtMeta, parseIbtSession } = require('./ibt-parser');
const { parseCsvMeta, parseCsvSession } = require('./csv-parser');
const trackmapStore = require('./trackmap-store');

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
  // Etiquetas de pilotos: sincronizar al iniciar y ante cambios de config.
  try { irsdk.setDriverTags(configStore.getDriverTags()); } catch (_) {}
  configStore.onChange((data) => {
    try { irsdk.setDriverTags((data && data.driverTags) || []); } catch (_) {}
  });

  // Grabador de sesiones: recibe frames del SDK real y persiste por vuelta.
  // Se puede desactivar (config.recordingEnabled) para no duplicar sesiones si
  // el usuario ya loguea la telemetría desde iRacing (.ibt).
  recorder = new SessionRecorder(path.join(app.getPath('userData'), 'recordings'));
  irsdk.setFrameSink((frame) => { if (configStore.isRecordingEnabled()) recorder.handleFrame(frame); });
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
    // Estado uniforme para todos (evita que queden desincronizados: unos
    // movibles y otros no).
    overlayManager.toggleAllUnlocked();
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
  const next = overlayManager.toggleAllUnlocked();
  const results = {};
  for (const id of overlayManager.windows.keys()) results[id] = next;
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

// === Mapas de pista (SVG dejados manualmente por el usuario) ===
ipcMain.handle('trackmap:get', (_e, trackName) => trackmapStore.getForTrack(trackName));
ipcMain.handle('trackmap:dir', () => ({ dir: trackmapStore.dir() }));
ipcMain.handle('trackmap:open', () => { shell.openPath(trackmapStore.dir()); return true; });

ipcMain.handle('tags:get', () => (configStore ? configStore.getDriverTags() : []));
ipcMain.handle('tags:set', (_e, tags) => (configStore ? configStore.setDriverTags(tags) : []));

// Geometría real de circuitos (OpenStreetMap) para el mapa de análisis.
ipcMain.handle('osm:track', async (_e, req) => {
  try { const osm = require('./osm-track'); return await osm.getForBBox(req || {}); }
  catch (err) { return { error: 'FETCH_FAILED', message: String(err && err.message || err) }; }
});

ipcMain.handle('recording:get', () => (configStore ? configStore.isRecordingEnabled() : true));
ipcMain.handle('recording:set', (_e, v) => {
  if (!configStore) return true;
  const on = configStore.setRecordingEnabled(v);
  // Al apagar, cerramos la sesión en curso para no dejar una parcial abierta.
  if (!on && recorder) recorder.endSession();
  return on;
});

ipcMain.handle('sessions:labels', () => (configStore ? configStore.get().sessionLabels || {} : {}));
ipcMain.handle('sessions:set-label', (_e, { id, label }) => (configStore ? configStore.setSessionLabel(id, label) : {}));

ipcMain.handle('recordings:list', () => (recorder ? recorder.listSessions() : []));
ipcMain.handle('recordings:get', (_e, id) => (recorder ? recorder.getSession(id) : null));
ipcMain.handle('recordings:delete', (_e, id) => (recorder ? recorder.deleteSession(id) : false));

// === Sesiones .ibt de iRacing (escaneo de la carpeta de telemetría) ===
function defaultTelemetryDir() {
  return path.join(app.getPath('documents'), 'iRacing', 'telemetry');
}
function iracingTelemetryDir() {
  const custom = configStore && configStore.get() && configStore.get().telemetryDir;
  return custom || defaultTelemetryDir();
}

ipcMain.handle('ibt:telemetry-dir', () => {
  const custom = configStore && configStore.get() ? configStore.get().telemetryDir : null;
  return { dir: iracingTelemetryDir(), custom: !!custom, default: defaultTelemetryDir() };
});

ipcMain.handle('ibt:pick-folder', async () => {
  try {
    const parent = dashboardWindow && !dashboardWindow.isDestroyed() ? dashboardWindow : null;
    const res = await dialog.showOpenDialog(parent, {
      title: 'Elegí la carpeta de telemetría de iRacing',
      defaultPath: iracingTelemetryDir(),
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    configStore.setTelemetryDir(res.filePaths[0]);
    return { dir: iracingTelemetryDir(), custom: true, default: defaultTelemetryDir() };
  } catch (err) {
    console.error('[ibt] pick-folder error:', err.message);
    return null;
  }
});

ipcMain.handle('ibt:reset-folder', () => {
  configStore.setTelemetryDir(null);
  return { dir: iracingTelemetryDir(), custom: false, default: defaultTelemetryDir() };
});

ipcMain.handle('ibt:import', async () => {
  try {
    const parent = dashboardWindow && !dashboardWindow.isDestroyed() ? dashboardWindow : null;
    const res = await dialog.showOpenDialog(parent, {
      title: 'Importar telemetría (.ibt de iRacing o .csv)',
      filters: [
        { name: 'Telemetría (.ibt, .csv)', extensions: ['ibt', 'csv'] },
        { name: 'iRacing telemetry (.ibt)', extensions: ['ibt'] },
        { name: 'CSV', extensions: ['csv'] },
      ],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const full = res.filePaths[0];
    if (full.toLowerCase().endsWith('.csv')) {
      const meta = parseCsvMeta(full);
      if (!meta) return null;
      return { id: `csvpath:${full}`, source: 'csv', imported: true, file: path.basename(full), ...meta };
    }
    const meta = parseIbtMeta(full);
    if (!meta) return null;
    return { id: `ibtpath:${full}`, source: 'ibt', imported: true, file: path.basename(full), ...meta };
  } catch (err) {
    console.error('[ibt] import error:', err.message);
    return null;
  }
});

// Caché de metadatos por archivo, con clave path+mtime+size. Los .ibt/.csv son
// inmutables una vez escritos, así que el parseo pesado (YAML + sampleo de mejor
// vuelta) se hace UNA sola vez por archivo; los listados posteriores son casi
// instantáneos. Sin esto, cada `ibt:list` (al abrir y en cada `recordings:changed`
// durante una sesión en vivo) re-parseaba todo, bloqueando el proceso principal.
const ibtMetaCache = new Map();
const yieldToLoop = () => new Promise((r) => setImmediate(r));

ipcMain.handle('ibt:list', async () => {
  const dir = iracingTelemetryDir();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => {
      const l = f.toLowerCase();
      return l.endsWith('.ibt') || l.endsWith('.csv');
    });
  } catch (_) {
    return []; // carpeta inexistente (logging apagado o iRacing no instalado)
  }
  const out = [];
  for (const f of files) {
    const full = path.join(dir, f);
    let st;
    try { st = fs.statSync(full); } catch (_) { continue; }
    const key = `${full}|${st.mtimeMs}|${st.size}`;
    let entry = ibtMetaCache.get(key);
    if (entry === undefined) {
      const isCsv = f.toLowerCase().endsWith('.csv');
      const meta = isCsv ? parseCsvMeta(full) : parseIbtMeta(full);
      entry = meta
        ? (isCsv ? { id: `csv:${f}`, source: 'csv', file: f, ...meta } : { id: `ibt:${f}`, source: 'ibt', file: f, ...meta })
        : null; // cacheamos también el fallo para no reintentar cada vez
      ibtMetaCache.set(key, entry);
      // Cedemos el hilo entre archivos nuevos para que la UI y los overlays no se
      // congelen durante el primer escaneo (o al aparecer archivos nuevos).
      await yieldToLoop();
    }
    if (entry) out.push(entry);
  }
  out.sort((a, b) => b.startedAt - a.startedAt);
  return out;
});

ipcMain.handle('ibt:get', (_e, id) => {
  if (typeof id !== 'string') return null;
  let full = null;
  let kind = 'ibt';
  if (id.startsWith('csvpath:')) {
    const p = id.slice(8);
    if (p.toLowerCase().endsWith('.csv') && fs.existsSync(p)) { full = p; kind = 'csv'; }
  } else if (id.startsWith('ibtpath:')) {
    // Archivo importado manualmente: ruta absoluta (elegida por el usuario en
    // un diálogo, así que es de confianza). Validamos extensión y existencia.
    const p = id.slice(8);
    if (p.toLowerCase().endsWith('.ibt') && fs.existsSync(p)) full = p;
  } else if (id.startsWith('csv:')) {
    // CSV del escaneo automático: basename dentro de la carpeta de telemetría.
    const file = id.slice(4);
    if (!file.includes('/') && !file.includes('\\') && !file.includes('..')) {
      full = path.join(iracingTelemetryDir(), file);
      kind = 'csv';
    }
  } else if (id.startsWith('ibt:')) {
    // Archivo del escaneo automático: solo un basename dentro de la carpeta.
    const file = id.slice(4);
    if (!file.includes('/') && !file.includes('\\') && !file.includes('..')) {
      full = path.join(iracingTelemetryDir(), file);
    }
  }
  if (!full) return null;
  try {
    const session = kind === 'csv' ? parseCsvSession(full) : parseIbtSession(full);
    return { id, source: kind, ...session };
  } catch (err) {
    console.error('[ibt] error parseando:', err.message);
    return null;
  }
});

// === Garage 61: mapear circuito/auto de iRacing a la URL de laps ===
let _g61ids = null;
function garage61Ids() {
  if (_g61ids === null) {
    try { _g61ids = require('./data/garage61-ids.json'); } catch (_) { _g61ids = { tracks: {}, cars: {} }; }
  }
  return _g61ids;
}
ipcMain.handle('garage61:url', (_e, trackIdIr, carIdIr) => {
  const g = garage61Ids();
  const t = trackIdIr != null ? g.tracks[String(trackIdIr)] : null;
  const c = carIdIr != null ? g.cars[String(carIdIr)] : null;
  if (t == null || c == null) return null;
  return `https://garage61.net/app/laps/${t}/${c};a=-1;bw=0,;bp=,0`;
});
// Abrir una URL externa (solo https). Usado para los botones de Garage 61.
ipcMain.handle('shell:open-external', (_e, url) => {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return false;
  shell.openExternal(url);
  return true;
});

// Borra un .ibt/.csv (escaneado o importado). Va a la papelera del SO para que
// sea recuperable — estamos borrando archivos reales del usuario.
ipcMain.handle('ibt:delete', async (_e, id) => {
  if (typeof id !== 'string') return false;
  let full = null;
  const safeInDir = (file) => (!file.includes('/') && !file.includes('\\') && !file.includes('..'))
    ? path.join(iracingTelemetryDir(), file) : null;
  if (id.startsWith('csvpath:') || id.startsWith('ibtpath:')) full = id.slice(8);
  else if (id.startsWith('csv:')) full = safeInDir(id.slice(4));
  else if (id.startsWith('ibt:')) full = safeInDir(id.slice(4));
  if (!full || !fs.existsSync(full)) return false;
  try { await shell.trashItem(full); return true; }
  catch (err) { console.error('[ibt] delete error:', err.message); return false; }
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
