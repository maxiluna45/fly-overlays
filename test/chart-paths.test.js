const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/renderer/lib/chart-paths.js');

// stepPath dibuja una serie que cambia de a saltos (la marcha) como escalera:
// se mantiene horizontal mientras el valor no cambia y sube o baja en vertical
// justo en el bin del cambio. seriesPath no sirve porque interpola en diagonal,
// y una caja de cambios no pasa por 3.5.

test('stepPath: sin datos devuelve string vacio', async () => {
  const { stepPath } = await load();
  assert.equal(stepPath([], 0, 1, 6, 1000, 100), '');
  assert.equal(stepPath([null, null], 2, 1, 6, 1000, 100), '');
});

test('stepPath: un valor constante es una sola horizontal', async () => {
  const { stepPath } = await load();
  const d = stepPath([3, 3, 3, 3], 4, 1, 6, 1000, 100);
  // Un M inicial y ninguna vertical: todos los puntos a la misma altura.
  assert.equal((d.match(/M/g) || []).length, 1);
  const ys = [...d.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((m) => m[2]);
  assert.equal(new Set(ys).size, 1);
});

test('stepPath: el cambio de marcha es vertical, no diagonal', async () => {
  const { stepPath } = await load();
  // 2 → 3 en el bin 2 de 4.
  const d = stepPath([2, 2, 3, 3], 4, 1, 6, 1000, 100);
  const pts = [...d.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((m) => ({ x: +m[1], y: +m[2] }));
  // Tiene que existir un par consecutivo con la MISMA x y distinta y: el salto.
  let vertical = false;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].x === pts[i - 1].x && pts[i].y !== pts[i - 1].y) vertical = true;
  }
  assert.ok(vertical, 'el salto de marcha tiene que ser una linea vertical');
  // Y ningun segmento puede ser diagonal (x distinta E y distinta).
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x !== pts[i - 1].x, dy = pts[i].y !== pts[i - 1].y;
    assert.ok(!(dx && dy), `segmento diagonal en el indice ${i}`);
  }
});

test('stepPath: la marcha mas alta queda arriba', async () => {
  const { stepPath } = await load();
  const d = stepPath([1, 6], 2, 1, 6, 1000, 100);
  const pts = [...d.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((m) => +m[2]);
  // En SVG y crece hacia abajo: la 6a marcha tiene que dar y menor que la 1a.
  assert.ok(Math.min(...pts) < Math.max(...pts));
  assert.equal(Math.max(...pts), 100); // marcha 1 = piso del grafico
  assert.equal(Math.min(...pts), 0);   // marcha 6 = techo
});

test('stepPath: un hueco de datos corta el trazo', async () => {
  const { stepPath } = await load();
  // El neutral / los bins sin dato no se inventan: cortan y arrancan otro M.
  const d = stepPath([2, 2, null, 4, 4], 5, 1, 6, 1000, 100);
  assert.equal((d.match(/M/g) || []).length, 2);
});

test('stepPath: respeta el zoom de tramo', async () => {
  const { stepPath } = await load();
  // range [0.5, 1] = segunda mitad expandida a todo el ancho.
  const d = stepPath([2, 2, 5, 5], 4, 1, 6, 1000, 100, [0.5, 1]);
  const xs = [...d.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((m) => +m[1]);
  assert.ok(Math.max(...xs) > 900, 'el tramo tiene que ocupar todo el ancho');
});
