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
const logger = require('./logger');
const log = logger.createLogger('main');

const isDev = process.env.NODE_ENV === 'development';

let irsdk = null;
let recorder = null;
let configStore = null;
let overlayManager = null;
let dashboardWindow = null;
let _recPrevConnected = false;
let _lastSessionCtxKey = null;
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

// Los handlers globales de uncaughtException/unhandledRejection se registran
// dentro de logger.initLogger() (en app.whenReady), para que salgan con el
// formato del contrato y sean visibles en la pestaña Diagnóstico.

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
      // El dashboard es quien escucha el botón del volante (Gamepad API) para
      // ciclar la referencia del delta: sin esto, al ocultarlo (F8) Chromium
      // frena los timers a 1 Hz y se pierden las pulsaciones.
      backgroundThrottling: false,
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
  logger.initLogger({ getDiagnosticMode: () => configStore.getDiagnosticMode() });
  logger.setBroadcast((line) => {
    const { BrowserWindow } = require('electron');
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('log:line', line);
    }
  });
  log.info('app iniciada', { version: app.getVersion() });
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

  // Frame REAL de ejemplo para los previews: cargamos el persistido (si existe) y
  // persistimos los nuevos que capture el SDK. Así los previews se ven como una
  // carrera de verdad, con tu último dato real.
  const previewSampleFile = path.join(app.getPath('userData'), 'preview-sample.json');
  try { if (fs.existsSync(previewSampleFile)) irsdk.setPreviewSample(JSON.parse(fs.readFileSync(previewSampleFile, 'utf-8'))); } catch (_) {}
  irsdk.onSample((s) => { try { fs.writeFileSync(previewSampleFile, JSON.stringify(s)); } catch (_) {} });

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

    // Filtro de overlays por tipo de sesión: notificar al manager sólo cuando
    // cambia el contexto (sessionType/connected/preview), no en cada tick.
    const sessionCtxKey = `${data.sessionType}|${!!data.connected}|${!!data.preview}`;
    if (sessionCtxKey !== _lastSessionCtxKey) {
      _lastSessionCtxKey = sessionCtxKey;
      overlayManager.setSessionContext({
        sessionType: data.sessionType,
        connected: data.connected,
        preview: data.preview,
      });
    }

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

  registerHotkeys();
});

// Acciones de cada hotkey configurable. El nombre es la key en config.hotkeys.
const HOTKEY_ACTIONS = {
  toggleLock: () => {
    // Estado uniforme para todos (evita que queden desincronizados: unos
    // movibles y otros no).
    overlayManager.toggleAllUnlocked();
  },
  openPanel: () => toggleDashboard(),
  forceShow: () => {
    const n = overlayManager.forceShowAll();
    log.info(`forzando aparición de ${n} overlay(s)`);
  },
  preview: () => {
    const enabled = irsdk.togglePreview();
    // Re-aplicar visibilidad: en preview los overlays se muestran aunque el
    // filtro por sesión los oculte; al salir, se restaura el filtro.
    applyPreviewMode();
    log.info(`preview mode: ${enabled ? 'ON' : 'OFF'}`);
  },
  cycleDeltaRef: () => {
    const next = cycleDeltaReference();
    console.log(`[main] delta ref → ${next}`);
  },
};

// (Re)registra TODOS los atajos globales desde config. Se llama al iniciar y
// cada vez que el usuario re-bindea uno desde el apartado Hotkeys.
function registerHotkeys() {
  globalShortcut.unregisterAll();
  const hk = configStore.get().hotkeys || {};
  for (const [name, action] of Object.entries(HOTKEY_ACTIONS)) {
    const acc = hk[name];
    if (!acc) continue;
    try {
      globalShortcut.register(acc, action);
    } catch (err) {
      log.error(`no se pudo registrar hotkey ${name}=${acc}`, { error: err.message });
    }
  }
}

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

// Cicla la referencia del DeltaBar entre TODAS las referencias disponibles.
// Si estaba en un valor viejo/desconocido (ej. 'auto'), arranca desde la primera.
const DELTA_REF_CYCLE = ['sessionBest', 'fieldBest', 'lastLap', 'personalBest', 'optimal'];
function cycleDeltaReference() {
  const ov = configStore.getOverlay('delta');
  if (!ov) return null;
  const cur = (ov.settings || {}).deltaReference || 'auto';
  const idx = DELTA_REF_CYCLE.indexOf(cur);
  const next = DELTA_REF_CYCLE[(idx + 1) % DELTA_REF_CYCLE.length];
  overlayManager.applyOverlayUpdate('delta', { settings: { ...(ov.settings || {}), deltaReference: next } });
  return next;
}
ipcMain.handle('delta:cycle-ref', () => cycleDeltaReference());

// Re-bindear un atajo global desde el apartado Hotkeys. Valida nombre,
// rechaza duplicados contra los demás atajos y revierte si Electron no puede
// registrar el accelerator (inválido u ocupado por otra app).
ipcMain.handle('hotkeys:set', (_e, name, accelerator) => {
  const validNames = Object.keys(HOTKEY_ACTIONS);
  const fail = (error) => ({ ok: false, error, hotkeys: configStore.get().hotkeys });
  if (!validNames.includes(name)) return fail('hotkey desconocido');
  if (typeof accelerator !== 'string' || !accelerator.trim()) return fail('accelerator inválido');
  const acc = accelerator.trim();
  const hk = configStore.get().hotkeys || {};
  const dup = validNames.find((k) => k !== name && hk[k] === acc);
  if (dup) return fail(`esa tecla ya está asignada a "${dup}"`);
  const prev = hk[name];
  configStore.setHotkey(name, acc);
  registerHotkeys();
  if (!globalShortcut.isRegistered(acc)) {
    configStore.setHotkey(name, prev);
    registerHotkeys();
    return fail('no se pudo registrar (tecla inválida u ocupada por otra aplicación)');
  }
  return { ok: true, hotkeys: configStore.get().hotkeys };
});
ipcMain.handle('config:registry', () => REGISTRY);

ipcMain.handle('overlay:toggle-lock', () => {
  const next = overlayManager.toggleAllUnlocked();
  const results = {};
  for (const id of overlayManager.windows.keys()) results[id] = next;
  return results;
});

// Estado de lock actual de UN overlay (pull al montar el componente). Cubre la
// carrera en la que el push 'overlay:lock-state' se emitió antes de que el
// renderer terminara de cargar (F7 puede crear la ventana en ese instante).
ipcMain.handle('overlay:get-lock-state', (_e, id) => ({
  unlocked: !!(overlayManager && id && overlayManager.isUnlocked(id)),
}));

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

// === Logs / diagnóstico ===
ipcMain.handle('log:write', (_e, entry) => {
  if (!entry || typeof entry !== 'object') return false;
  const scope = typeof entry.scope === 'string' ? entry.scope : 'renderer';
  const level = entry.level || 'info';
  const text = typeof entry.text === 'string' ? entry.text : String(entry.text ?? '');
  logger.emit(scope, level, text);
  return true;
});
ipcMain.handle('log:tail', (_e, opts) => logger.getLogs(opts || {}));
ipcMain.handle('log:open-folder', () => { shell.openPath(logger.getLogDir()); return true; });
ipcMain.handle('diag:get', () => (configStore ? configStore.getDiagnosticMode() : false));
ipcMain.handle('diag:set', (_e, v) => {
  const next = configStore.setDiagnosticMode(v);
  logger.applyDiagnosticLevel(next);
  logger.emit('main', 'info', `modo diagnóstico ${next ? 'ON' : 'OFF'}`);
  return next;
});

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
ipcMain.handle('preview:sample', () => (irsdk ? irsdk.getPreviewSample() : null));
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
    // Restaurar estado normal: los enabled, respetando el filtro por sesión
    overlayManager.applySessionVisibility();
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
  } else {
    // Preview vía F9 sin pasar por el dashboard: mostrar todos los enabled
    // (en preview el filtro por sesión no aplica, para poder verlos todos).
    for (const [id, ov] of Object.entries(configStore.get().overlays)) {
      if (ov.enabled) overlayManager.show(id);
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
