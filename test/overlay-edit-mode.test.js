// Regresión: con F7 (edit mode) los overlays quedaban clavados, a veces todos y
// a veces todos menos uno, sin patrón fijo.
//
// La causa es el orden de operaciones de setUnlocked:
//
//   setUnlocked(id) {
//     unlockedState.set(id, value);
//     applySessionVisibility();   // ← show() sobre TODOS los overlays
//     _applyLockState(id);        // ← setIgnoreMouseEvents(false) sólo de ESTE
//   }
//
// y toggleAllUnlocked lo llama en un bucle, uno por overlay. En cada vuelta, el
// show() vuelve a pasar por overlays a los que ya se les había devuelto el
// mouse. En Windows, mostrar una ventana reaplica sus estilos extendidos, que
// es donde vive el "ignorar mouse", así que el overlay se quedaba otra vez
// atravesable aunque su vista siguiera dibujando el modo edición: se veían las
// esquinas celestes pero la ventana no se podía agarrar.
//
// La invariante que se testea es la que importa: cuando termina el toggle,
// ningún overlay puede tener un show() POSTERIOR a la última vez que se le
// configuró el mouse.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const electronPath = require.resolve('electron');
const ops = []; // secuencia global: { id, op, value }

function fakeWebContents() {
  return { on: () => {}, once: () => {}, send: () => {}, isLoading: () => false, executeJavaScript: () => Promise.resolve() };
}

class FakeBrowserWindow {
  constructor(opts) {
    this.opts = opts;
    this.id = FakeBrowserWindow.nextId;
    this.webContents = fakeWebContents();
  }
  setAlwaysOnTop() {}
  setIgnoreMouseEvents(ignore) { ops.push({ id: this.id, op: 'mouse', value: ignore }); }
  setResizable() {}
  setOpacity() {}
  setBounds() {}
  getBounds() { return { x: 0, y: 0, width: 100, height: 100 }; }
  focus() {}
  show() { ops.push({ id: this.id, op: 'show' }); }
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

const IDS = ['delta', 'sectors', 'relative', 'standings', 'radar'];

function fakeConfigStore() {
  const mk = () => ({
    enabled: true, x: 10, y: 10, width: 600, height: 120, opacity: 1,
    sessions: { race: true, qualify: true, practice: true }, settings: {},
  });
  const overlays = Object.fromEntries(IDS.map((id) => [id, mk()]));
  return {
    get: () => ({ overlays }),
    getOverlay: (id) => overlays[id],
    setOverlay: () => {},
    setBounds: () => {},
  };
}

function crearManager() {
  ops.length = 0;
  const mgr = new OverlayManager(fakeConfigStore());
  for (const id of IDS) {
    FakeBrowserWindow.nextId = id;
    mgr._create(id);
  }
  ops.length = 0;
  return mgr;
}

test('con el edit mode puesto, TODOS los overlays terminan recibiendo el mouse', () => {
  const mgr = crearManager();
  mgr.toggleAllUnlocked();

  for (const id of IDS) {
    const suyas = ops.filter((o) => o.id === id && o.op === 'mouse');
    assert.ok(suyas.length > 0, `${id}: nunca se le configuró el mouse`);
    assert.equal(suyas[suyas.length - 1].value, false, `${id} quedó ignorando el mouse: no se puede agarrar`);
  }
});

test('ningún show() queda después de haberle devuelto el mouse a un overlay', () => {
  const mgr = crearManager();
  mgr.toggleAllUnlocked();

  for (const id of IDS) {
    const propias = ops.map((o, i) => ({ ...o, i })).filter((o) => o.id === id);
    const ultimoMouse = propias.filter((o) => o.op === 'mouse').pop();
    const ultimoShow = propias.filter((o) => o.op === 'show').pop();
    if (!ultimoShow) continue;
    assert.ok(
      ultimoShow.i < ultimoMouse.i,
      `${id}: se lo mostró después de configurarle el mouse (show en ${ultimoShow.i}, mouse en ${ultimoMouse.i}); ` +
      'mostrar la ventana reaplica sus estilos y la vuelve atravesable'
    );
  }
});

test('salir del edit mode vuelve a dejar los overlays atravesables', () => {
  const mgr = crearManager();
  mgr.toggleAllUnlocked();
  ops.length = 0;
  mgr.toggleAllUnlocked();

  for (const id of IDS) {
    const suyas = ops.filter((o) => o.id === id && o.op === 'mouse');
    assert.ok(suyas.length > 0, `${id}: nunca se le configuró el mouse`);
    assert.equal(suyas[suyas.length - 1].value, true, `${id} siguió capturando el mouse con el edit mode apagado`);
  }
});
