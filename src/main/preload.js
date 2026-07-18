const { contextBridge, ipcRenderer } = require('electron');

const overlayId = (() => {
  const arg = process.argv.find((a) => a.startsWith('--overlay-id='));
  return arg ? arg.split('=')[1] : null;
})();

contextBridge.exposeInMainWorld('fly', {
  overlayId,
  isPanel: overlayId === null && process.argv.some((a) => a.includes('panel.html')),

  onTelemetry: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('telemetry:update', listener);
    return () => ipcRenderer.removeListener('telemetry:update', listener);
  },
  onTelemetryHeavy: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('telemetry:heavy', listener);
    return () => ipcRenderer.removeListener('telemetry:heavy', listener);
  },
  onLockState: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('overlay:lock-state', listener);
    return () => ipcRenderer.removeListener('overlay:lock-state', listener);
  },
  onConfigChange: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('config:changed', listener);
    return () => ipcRenderer.removeListener('config:changed', listener);
  },
  toggleLock: () => ipcRenderer.invoke('overlay:toggle-lock'),
  openPanel: () => ipcRenderer.invoke('overlay:open-panel'),

  // Panel only
  getConfig: () => ipcRenderer.invoke('config:get'),
  toggleOverlay: (id) => ipcRenderer.invoke('config:toggle-overlay', id),
  setOverlay: (id, updates) => ipcRenderer.invoke('config:set-overlay', id, updates),
  cycleDeltaRef: () => ipcRenderer.invoke('delta:cycle-ref'),
  setHotkey: (name, accelerator) => ipcRenderer.invoke('hotkeys:set', name, accelerator),
  getRegistry: () => ipcRenderer.invoke('config:registry'),
  togglePreview: () => ipcRenderer.invoke('preview:toggle'),
  getPreview: () => ipcRenderer.invoke('preview:get'),
  getPreviewSample: () => ipcRenderer.invoke('preview:sample'),
  setPreview: (enabled) => ipcRenderer.invoke('preview:set', enabled),
  configurePreview: (options) => ipcRenderer.invoke('preview:configure', options),

  // Grabaciones / análisis post-sesión
  getRecordings: () => ipcRenderer.invoke('recordings:list'),
  getRecording: (id) => ipcRenderer.invoke('recordings:get', id),
  deleteRecording: (id) => ipcRenderer.invoke('recordings:delete', id),
  getIbtSessions: () => ipcRenderer.invoke('ibt:list'),
  getIbtSession: (id) => ipcRenderer.invoke('ibt:get', id),
  deleteTelemetry: (id) => ipcRenderer.invoke('ibt:delete', id),
  importIbt: () => ipcRenderer.invoke('ibt:import'),
  getSessionLabels: () => ipcRenderer.invoke('sessions:labels'),
  setSessionLabel: (id, label) => ipcRenderer.invoke('sessions:set-label', { id, label }),
  // Driver tags
  getDriverTags: () => ipcRenderer.invoke('tags:get'),
  setDriverTags: (tags) => ipcRenderer.invoke('tags:set', tags),
  // Grabación de sesiones en vivo (on/off global)
  getRecordingEnabled: () => ipcRenderer.invoke('recording:get'),
  setRecordingEnabled: (v) => ipcRenderer.invoke('recording:set', v),
  // Garage 61
  getOsmTrack: (req) => ipcRenderer.invoke('osm:track', req),
  getGarage61Url: (trackIdIr, carIdIr) => ipcRenderer.invoke('garage61:url', trackIdIr, carIdIr),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  // Mapas de pista (SVG manual)
  getTrackMap: (trackName) => ipcRenderer.invoke('trackmap:get', trackName),
  getTrackmapDir: () => ipcRenderer.invoke('trackmap:dir'),
  openTrackmapFolder: () => ipcRenderer.invoke('trackmap:open'),
  getTelemetryDir: () => ipcRenderer.invoke('ibt:telemetry-dir'),
  pickTelemetryDir: () => ipcRenderer.invoke('ibt:pick-folder'),
  resetTelemetryDir: () => ipcRenderer.invoke('ibt:reset-folder'),
  onRecordingsChange: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('recordings:changed', listener);
    return () => ipcRenderer.removeListener('recordings:changed', listener);
  },

  onUpdater: (channel, callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('updater:' + channel, listener);
    return () => ipcRenderer.removeListener('updater:' + channel, listener);
  },
  // Logs / diagnóstico
  log: (entry) => ipcRenderer.invoke('log:write', entry),
  getLogs: (opts) => ipcRenderer.invoke('log:tail', opts),
  onLogLine: (callback) => {
    const listener = (_event, line) => callback(line);
    ipcRenderer.on('log:line', listener);
    return () => ipcRenderer.removeListener('log:line', listener);
  },
  openLogsFolder: () => ipcRenderer.invoke('log:open-folder'),
  getDiagnosticMode: () => ipcRenderer.invoke('diag:get'),
  setDiagnosticMode: (v) => ipcRenderer.invoke('diag:set', v),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  checkUpdate: () => ipcRenderer.invoke('updater:check'),

});

// Captura global de errores del renderer → log al main. Se ejecuta en cada
// ventana (overlays y panel). El scope lleva el overlayId para saber cuál falló.
(() => {
  const scope = overlayId ? `overlay:${overlayId}` : 'panel';
  const send = (level, text) => {
    try { ipcRenderer.invoke('log:write', { scope, level, text }); } catch (_) {}
  };
  window.addEventListener('error', (e) => {
    send('error', `window.onerror: ${e.message} @ ${e.filename}:${e.lineno}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    send('error', `unhandledrejection: ${(r && r.stack) || r}`);
  });
})();
