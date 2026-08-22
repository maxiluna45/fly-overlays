// Regresión de rendimiento: los overlays bloqueados NO deben pedirle a Electron
// que reenvíe mouse move messages.
//
// En Windows, `setIgnoreMouseEvents(ignore, { forward: true })` hace que Electron
// instale un hook global de mouse de bajo nivel en el main process: todo evento
// de mouse del sistema se serializa por el message loop de iFly y además se
// despacha al renderer del overlay que está bajo el cursor. Medido: 175-278
// mousemove/s por overlay, 25-32% de CPU en el main sólo por mover el mouse, y
// los tirones del cursor (>20ms entre updates) pasan de 0.019% a 0.135%. El
// cursor se ve trabado en TODO el escritorio.
//
// Ningún componente de overlay escucha hover ni eventos de mouse, así que el
// forwarding se pagaba sin recibir nada a cambio. En modo edición (F7) se usa
// setIgnoreMouseEvents(false), que no depende de forward.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Stub de 'electron' antes de cargar overlay-manager (que lo requiere al tope).
const electronPath = require.resolve('electron');
const calls = [];

function fakeWebContents() {
  return {
    on: () => {},
    once: () => {},
    send: () => {},
    isLoading: () => false,
    executeJavaScript: () => Promise.resolve(),
  };
}

class FakeBrowserWindow {
  constructor(opts) {
    this.opts = opts;
    this.webContents = fakeWebContents();
  }
  setAlwaysOnTop() {}
  setIgnoreMouseEvents(...args) { calls.push(args); }
  setResizable() {}
  setOpacity() {}
  setBounds() {}
  getBounds() { return { x: 0, y: 0, width: 100, height: 100 }; }
  focus() {}
  show() {}
  hide() {}
  moveTop() {}
  loadURL() {}
  loadFile() {}
  on() {}
  isDestroyed() { return false; }
}

require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    BrowserWindow: FakeBrowserWindow,
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
  },
};

const { OverlayManager } = require('../src/main/overlay-manager');

function fakeConfigStore() {
  const overlay = {
    enabled: true, x: 10, y: 10, width: 600, height: 120, opacity: 1,
    sessions: { race: true, qualify: true, practice: true }, settings: {},
  };
  return {
    get: () => ({ overlays: { delta: overlay } }),
    getOverlay: () => overlay,
    setOverlay: () => {},
    setBounds: () => {},
  };
}

test('un overlay bloqueado ignora el mouse SIN pedir forwarding', () => {
  calls.length = 0;
  const mgr = new OverlayManager(fakeConfigStore());
  mgr._create('delta');

  assert.ok(calls.length > 0, 'se esperaba una llamada a setIgnoreMouseEvents');
  const [ignore, opts] = calls[0];
  assert.equal(ignore, true, 'un overlay bloqueado debe ignorar el mouse');
  assert.ok(
    !opts || opts.forward !== true,
    'no debe pedir { forward: true }: instala un hook global de mouse que ' +
    'traba el cursor en todo el escritorio'
  );
});

test('desbloquear un overlay lo vuelve interactivo', () => {
  calls.length = 0;
  const mgr = new OverlayManager(fakeConfigStore());
  mgr._create('delta');
  calls.length = 0;
  mgr.setUnlocked('delta', true);

  assert.ok(calls.length > 0, 'se esperaba una llamada a setIgnoreMouseEvents');
  assert.equal(calls[calls.length - 1][0], false, 'desbloqueado debe recibir el mouse');
});
