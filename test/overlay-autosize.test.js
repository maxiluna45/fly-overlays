// El Standings pide su propio alto: en vista reducida muestra 10 filas y en la
// completa 25, y con un alto fijo o sobraba espacio en blanco o se cortaban las
// últimas. El overlay mide lo que necesita y el main ajusta la ventana.
//
// Acá se testea el lado del main: los topes y las guardas. El alto pedido llega
// del renderer y no se puede confiar en él a ciegas.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const electronPath = require.resolve('electron');
let bounds;

function fakeWebContents() {
  return { on: () => {}, once: () => {}, send: () => {}, isLoading: () => false, executeJavaScript: () => Promise.resolve() };
}

class FakeBrowserWindow {
  constructor() { this.webContents = fakeWebContents(); }
  setAlwaysOnTop() {}
  setIgnoreMouseEvents() {}
  setResizable() {}
  setOpacity() {}
  setBounds(b) { bounds = { ...bounds, ...b }; }
  getBounds() { return { ...bounds }; }
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

function manager() {
  bounds = { x: 18, y: 100, width: 471, height: 388 };
  const overlay = {
    enabled: true, x: 18, y: 100, width: 471, height: 388, opacity: 1,
    sessions: { race: true, qualify: true, practice: true }, settings: {},
  };
  const store = {
    get: () => ({ overlays: { standings: overlay } }),
    getOverlay: () => overlay,
    setOverlay: () => {},
    setBounds: () => {},
  };
  const mgr = new OverlayManager(store);
  mgr._create('standings');
  return mgr;
}

test('ajusta el alto y no toca posicion ni ancho', () => {
  const mgr = manager();
  mgr.setAutoHeight('standings', 220);
  assert.equal(bounds.height, 220);
  assert.equal(bounds.x, 18);
  assert.equal(bounds.y, 100);
  assert.equal(bounds.width, 471, 'el ancho lo elige el usuario, no el contenido');
});

test('no achica por debajo del minimo de ventana', () => {
  const mgr = manager();
  mgr.setAutoHeight('standings', 10);
  assert.ok(bounds.height >= 80, `quedo en ${bounds.height}`);
});

test('no crece mas alla de lo que queda de pantalla', () => {
  const mgr = manager();
  // y=100 sobre un area de 1080: no puede pedir 1500 de alto.
  mgr.setAutoHeight('standings', 1500);
  assert.ok(bounds.height <= 1080 - 100, `quedo en ${bounds.height}, se sale de la pantalla`);
});

test('ignora diferencias de un par de pixeles', () => {
  const mgr = manager();
  mgr.setAutoHeight('standings', 389);
  assert.equal(bounds.height, 388, 'un pixel no justifica redimensionar: es como se arma un bucle');
});

test('en edit mode no toca el alto', () => {
  const mgr = manager();
  mgr.setUnlocked('standings', true);
  mgr.setAutoHeight('standings', 200);
  assert.equal(bounds.height, 388, 'si estas dimensionando con F7, el overlay no te pelea');
});

test('ignora alturas invalidas', () => {
  const mgr = manager();
  for (const v of [0, -5, NaN, null, undefined, 'alto']) {
    mgr.setAutoHeight('standings', v);
    assert.equal(bounds.height, 388, `acepto ${JSON.stringify(v)}`);
  }
});

test('un overlay que no existe no rompe', () => {
  const mgr = manager();
  assert.doesNotThrow(() => mgr.setAutoHeight('noexiste', 200));
});
