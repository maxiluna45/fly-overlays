const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/renderer/lib/tiles.js');

const mk = (tx, ty) => ({ url: `t/${tx}/${ty}` });

test('tileBounds cubre el cuadrado visible', async () => {
  const { tileBounds } = await load();
  // Centro en 1000,1000 con 300 de radio → de 700 a 1300 → tiles 2 y 5
  const b = tileBounds(1000, 1000, 300);
  assert.deepEqual(b, { x0: 2, x1: 5, y0: 2, y1: 5 });
});

test('syncTiles agrega los tiles de la zona visible', async () => {
  const { syncTiles } = await load();
  const map = new Map();
  const changed = syncTiles(map, { cx: 1000, cy: 1000, half: 256, makeTile: mk });
  assert.equal(changed, true);
  assert.ok(map.size > 0);
  assert.ok(map.has('3/3'));
  // Sin moverse no hay nada nuevo que pedir.
  assert.equal(syncTiles(map, { cx: 1000, cy: 1000, half: 256, makeTile: mk }), false);
});

// Regresión: antes los tiles se descartaban por antigüedad pero quedaba
// registrado que ya se habían pedido, así que al volver a esa zona no se
// volvían a pedir y el mapa quedaba con agujeros negros permanentes.
test('un tile descartado por lejanía se vuelve a pedir al volver', async () => {
  const { syncTiles } = await load();
  const map = new Map();
  syncTiles(map, { cx: 1000, cy: 1000, half: 256, keepFactor: 2, makeTile: mk });
  assert.ok(map.has('3/3'));

  // Nos vamos muy lejos: el tile de la zona vieja se suelta.
  syncTiles(map, { cx: 100000, cy: 100000, half: 256, keepFactor: 2, makeTile: mk });
  assert.equal(map.has('3/3'), false);

  // Y al volver, se vuelve a pedir (con attempt en 0, listo para cargar).
  syncTiles(map, { cx: 1000, cy: 1000, half: 256, keepFactor: 2, makeTile: mk });
  assert.ok(map.has('3/3'));
  assert.equal(map.get('3/3').attempt, 0);
});

test('los tiles del borde no se sueltan y vuelven a pedir en cada frame', async () => {
  const { syncTiles } = await load();
  const map = new Map();
  syncTiles(map, { cx: 1000, cy: 1000, half: 256, keepFactor: 3, makeTile: mk });
  const size = map.size;
  // Un movimiento chico no debería soltar nada de lo ya cargado.
  syncTiles(map, { cx: 1020, cy: 1010, half: 256, keepFactor: 3, makeTile: mk });
  assert.ok(map.size >= size);
  assert.ok(map.has('3/3'));
});

test('syncTiles respeta el tope y suelta primero los más lejanos', async () => {
  const { syncTiles } = await load();
  const map = new Map();
  syncTiles(map, { cx: 5000, cy: 5000, half: 2000, keepFactor: 99, makeTile: mk, maxTiles: 9 });
  assert.ok(map.size <= 9);
  // El tile del centro tiene que seguir estando.
  assert.ok(map.has('19/19') || map.has('20/20'));
});

test('tileUrl sólo agrega el parámetro en los reintentos', async () => {
  const { tileUrl } = await load();
  assert.equal(tileUrl('https://x/1/2/3', 0), 'https://x/1/2/3');
  assert.equal(tileUrl('https://x/1/2/3', 2), 'https://x/1/2/3?r=2');
  assert.equal(tileUrl('https://x/a?b=1', 1), 'https://x/a?b=1&r=1');
});
