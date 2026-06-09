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
  getRegistry: () => ipcRenderer.invoke('config:registry'),
  togglePreview: () => ipcRenderer.invoke('preview:toggle'),
  getPreview: () => ipcRenderer.invoke('preview:get'),
  setPreview: (enabled) => ipcRenderer.invoke('preview:set', enabled),
});
