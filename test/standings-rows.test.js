const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/renderer/lib/standings-rows.js');

// Recorte de la tabla: antes se cortaba en maxRows y, si el jugador no entraba,
// se le pisaba la ultima fila. O sea que veias del 1 al 10 y despues vos,
// sueltos, sin los que te rodean. Ahora: los 5 primeros de tu clase, un corte,
// y tu entorno (3 arriba / 3 abajo). De las otras clases, solo el podio.

// Pilotos sinteticos de una clase: posiciones 1..n.
const clase = (cid, n, desde = 1) =>
  Array.from({ length: n }, (_, i) => ({ carIdx: cid * 100 + desde + i, _classId: String(cid), classPosition: desde + i }));

const posiciones = (filas) => filas.map((f) => (f._separator ? '---' : f._classHeader ? 'H:' + f.classId : f.classPosition));

test('sin recorte devuelve todas las filas', async () => {
  const { compactRows } = await load();
  const rows = clase(1, 12);
  const out = compactRows(rows, { playerIdx: 105, compact: false });
  assert.equal(out.filter((f) => !f._classHeader).length, 12);
});

test('compacto: 5 primeros, corte, y el entorno del jugador', async () => {
  const { compactRows } = await load();
  const rows = clase(1, 20);
  const out = compactRows(rows, { playerIdx: 112, compact: true }); // vas 12mo
  assert.deepEqual(posiciones(out.filter((f) => !f._classHeader)), [1, 2, 3, 4, 5, '---', 9, 10, 11, 12, 13, 14, 15]);
});

test('compacto: sin duplicados ni corte cuando el entorno toca el top 5', async () => {
  const { compactRows } = await load();
  const rows = clase(1, 20);
  const out = compactRows(rows, { playerIdx: 107, compact: true }); // vas 7mo
  const p = posiciones(out.filter((f) => !f._classHeader));
  assert.deepEqual(p, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(!p.includes('---'), 'los bloques se tocan: no va separador');
});

test('compacto: yendo primero no se repite a si mismo', async () => {
  const { compactRows } = await load();
  const rows = clase(1, 20);
  const out = compactRows(rows, { playerIdx: 101, compact: true });
  const p = posiciones(out.filter((f) => !f._classHeader));
  // Yendo 1ro, el top 5 ya incluye a los que te persiguen: no hace falta mas.
  assert.deepEqual(p, [1, 2, 3, 4, 5]);
});

test('compacto: al final de la tabla no inventa filas', async () => {
  const { compactRows } = await load();
  const rows = clase(1, 12);
  const out = compactRows(rows, { playerIdx: 112, compact: true }); // ultimo
  assert.deepEqual(posiciones(out.filter((f) => !f._classHeader)), [1, 2, 3, 4, 5, '---', 9, 10, 11, 12]);
});

test('una clase mas chica que el recorte se muestra entera', async () => {
  const { compactRows } = await load();
  const rows = clase(1, 4);
  const out = compactRows(rows, { playerIdx: 103, compact: true });
  assert.deepEqual(posiciones(out.filter((f) => !f._classHeader)), [1, 2, 3, 4]);
});

test('multiclase: tu clase con la regla, las otras solo el podio', async () => {
  const { compactRows } = await load();
  const rows = [...clase(1, 10), ...clase(2, 12)];
  const out = compactRows(rows, { playerIdx: 209, compact: true }); // 9no de la clase 2
  const c1 = out.filter((f) => !f._classHeader && !f._separator && f._classId === '1');
  const c2 = out.filter((f) => !f._classHeader && !f._separator && f._classId === '2');
  assert.deepEqual(c1.map((f) => f.classPosition), [1, 2, 3], 'la otra clase, solo el podio');
  assert.deepEqual(c2.map((f) => f.classPosition), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].filter((p) => p <= 5 || (p >= 6 && p <= 12)));
});

test('multiclase: cada clase abre con su cabecera', async () => {
  const { compactRows } = await load();
  const rows = [...clase(1, 10), ...clase(2, 12)];
  const out = compactRows(rows, { playerIdx: 209, compact: true });
  const heads = out.filter((f) => f._classHeader);
  assert.equal(heads.length, 2);
  assert.equal(heads[0].classId, '1');
  assert.ok(heads[0].count === 10, 'la cabecera cuenta TODOS los de la clase, no los visibles');
  assert.equal(heads[1].count, 12);
});

test('en una sola clase no se dibuja cabecera', async () => {
  const { compactRows } = await load();
  const out = compactRows(clase(1, 10), { playerIdx: 105, compact: true });
  assert.equal(out.filter((f) => f._classHeader).length, 0);
});

test('sin jugador identificado muestra los primeros y nada mas', async () => {
  const { compactRows } = await load();
  const out = compactRows(clase(1, 20), { playerIdx: -1, compact: true });
  assert.deepEqual(posiciones(out.filter((f) => !f._classHeader)), [1, 2, 3, 4, 5]);
});

test('lista vacia no rompe', async () => {
  const { compactRows } = await load();
  assert.deepEqual(compactRows([], { playerIdx: 1, compact: true }), []);
});
