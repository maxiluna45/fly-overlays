const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rememberProgress, positionsByClass } = require('../src/main/race-order.js');

// Orden de carrera con memoria: el que se va al garage o se desconecta deja de
// aparecer en la memoria compartida de iRacing, pero sigue clasificado. Sin
// memoria, el standings repartia 1..N entre los que quedaban y la posicion del
// jugador mejoraba sola cada vez que alguien abandonaba o terminaba y salia.

const P = (carIdx, prog, cls = 1) => ({ carIdx, cls, prog });

test('registra el progreso de los autos que se ven', () => {
  const m = rememberProgress({}, [P(1, 5.5), P(2, 5.2)], 1000);
  assert.equal(m[1].prog, 5.5);
  assert.equal(m[2].prog, 5.2);
});

test('el progreso nunca retrocede', () => {
  // iRacing resetea lapDistPct a 0 al cruzar meta y el auto que vuelve a boxes
  // puede reportar cualquier cosa: nos quedamos con el maximo visto.
  let m = rememberProgress({}, [P(1, 5.9)], 1000);
  m = rememberProgress(m, [P(1, 5.1)], 1100);
  assert.equal(m[1].prog, 5.9);
});

test('el auto que desaparece sigue contando en las posiciones', () => {
  // El caso del reporte: vas 3ro, el 2do se desconecta y no queres pasar a 2do
  // si el ya completo mas vueltas que vos.
  let m = rememberProgress({}, [P(1, 9.5), P(2, 9.2), P(3, 9.0)], 1000);
  m = rememberProgress(m, [P(1, 9.7), P(3, 9.1)], 1100); // el 2 se fue en 9.2
  const pos = positionsByClass(m);
  assert.equal(pos[1], 1);
  assert.equal(pos[2], 2, 'el desconectado conserva su lugar');
  assert.equal(pos[3], 3, 'el de atras NO hereda el lugar sin haberlo pasado');

  // Lo que hacia antes: contar solo los autos visibles en el frame. El 3
  // pasaba a 2do sin adelantar a nadie. Este es el bug que el test cuida.
  const soloVisibles = rememberProgress({}, [P(1, 9.7), P(3, 9.1)], 1100);
  assert.equal(positionsByClass(soloVisibles)[3], 2);
});

test('el que abandona con menos vueltas queda detras del que sigue', () => {
  let m = rememberProgress({}, [P(1, 9.5), P(2, 9.2)], 1000);
  m = rememberProgress(m, [P(2, 10.4)], 1100); // el 1 abandono en la 9
  const pos = positionsByClass(m);
  assert.equal(pos[2], 1, 'pasarlo es legitimo: completo mas vueltas');
  assert.equal(pos[1], 2);
});

test('con bandera a cuadros, cruzar la meta marca terminado', () => {
  let m = rememberProgress({}, [P(1, 19.9)], 1000);
  m = rememberProgress(m, [P(1, 20.01)], 1010, { checkered: true });
  assert.equal(m[1].finished, true);
  assert.equal(m[1].finishedAt, 1010);
});

test('el que termina congela su progreso: la vuelta de enfriamiento no suma', () => {
  // Sin esto, el que sigue rodando despues de la bandera acumula progreso y
  // pasa por arriba a los que ya terminaron.
  let m = rememberProgress({}, [P(1, 19.9)], 1000);
  m = rememberProgress(m, [P(1, 20.01)], 1010, { checkered: true });
  m = rememberProgress(m, [P(1, 20.8)], 1100, { checkered: true });
  assert.equal(m[1].prog, 20.01);
});

test('entre dos que terminan manda el orden de llegada, no el progreso', () => {
  // Los dos terminan con 20 vueltas. El que cruzo primero va primero, aunque
  // el otro despues acumule mas fraccion de vuelta rodando.
  let m = rememberProgress({}, [P(1, 19.8), P(2, 19.9)], 1000);
  m = rememberProgress(m, [P(2, 20.01)], 1010, { checkered: true }); // cruza el 2
  m = rememberProgress(m, [P(1, 20.02)], 1020, { checkered: true }); // cruza el 1
  const pos = positionsByClass(m);
  assert.equal(pos[2], 1);
  assert.equal(pos[1], 2);
});

test('el que va una vuelta abajo no se cuela adelante por terminar', () => {
  let m = rememberProgress({}, [P(1, 19.5), P(2, 18.5)], 1000);
  m = rememberProgress(m, [P(2, 19.01)], 1010, { checkered: true }); // cruza el rezagado
  m = rememberProgress(m, [P(1, 20.01)], 1030, { checkered: true }); // cruza el lider
  const pos = positionsByClass(m);
  assert.equal(pos[1], 1, 'mas vueltas manda sobre llegar antes');
  assert.equal(pos[2], 2);
});

test('el que termina le gana al que abandono en la misma vuelta', () => {
  let m = rememberProgress({}, [P(1, 19.7), P(2, 19.5)], 1000);
  m = rememberProgress(m, [P(2, 20.01)], 1010, { checkered: true }); // el 2 termina
  const pos = positionsByClass(m);
  assert.equal(pos[2], 1);
  assert.equal(pos[1], 2, 'el 1 se quedo en la vuelta 19');
});

test('las clases se numeran por separado', () => {
  const m = rememberProgress({}, [P(1, 9.5, 10), P(2, 9.2, 20), P(3, 9.0, 10)], 1000);
  const pos = positionsByClass(m);
  assert.equal(pos[1], 1);
  assert.equal(pos[3], 2);
  assert.equal(pos[2], 1, 'primero de la otra clase');
});

test('ignora progresos invalidos', () => {
  const m = rememberProgress({}, [P(1, null), P(2, NaN), P(3, -1), P(4, 2.5)], 1000);
  assert.deepEqual(Object.keys(m), ['4']);
});
