const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BUCKETS, feedTrace, sealTrace, timeAt, createTracker } = require('../src/main/lap-traces.js');

// Delta propio: en vez de pedirle el delta a iRacing --que lo apaga apenas la
// vuelta se invalida, o sea justo cuando despistas-- guardamos el tiempo de la
// vuelta de referencia en cada punto de pista y restamos. Ver DeltaBar.

// Vuelta sintetica de `lapTime` segundos a ritmo parejo.
function vueltaPareja(lapTime, pasos = BUCKETS) {
  const buf = [];
  for (let i = 0; i < pasos; i++) feedTrace(buf, i / pasos, (i / pasos) * lapTime);
  return sealTrace(buf, lapTime);
}

test('timeAt devuelve el tiempo de la referencia en ese punto de pista', () => {
  const t = vueltaPareja(100);
  assert.ok(Math.abs(timeAt(t, 0.5) - 50) < 0.5);
  assert.ok(Math.abs(timeAt(t, 0.25) - 25) < 0.5);
});

test('sealTrace escala la traza al tiempo oficial de la vuelta', () => {
  // El buffer se llena con LapCurrentLapTime, que puede diferir del oficial.
  const buf = [];
  for (let i = 0; i < BUCKETS; i++) feedTrace(buf, i / BUCKETS, (i / BUCKETS) * 99.5);
  const t = sealTrace(buf, 100);
  assert.equal(t.lapTime, 100);
  // Ojo: pct 1 es la linea de meta, o sea el arranque de la vuelta siguiente
  // (timeAt lo normaliza a 0). El final de la traza se mira justo antes.
  assert.ok(Math.abs(timeAt(t, 0.9999) - 100) < 0.6, 'el final tiene que dar el tiempo oficial');
  assert.equal(timeAt(t, 1), timeAt(t, 0), 'meta y arranque son el mismo punto');
});

test('una vuelta parcial no sirve de referencia', () => {
  // Salis de boxes a mitad de vuelta: esa vuelta no puede ser la referencia.
  const buf = [];
  for (let i = BUCKETS / 2; i < BUCKETS; i++) feedTrace(buf, i / BUCKETS, i / BUCKETS * 100);
  assert.equal(sealTrace(buf, 100), null);
});

test('cada bucket se queda con el primer tiempo visto', () => {
  const buf = [];
  feedTrace(buf, 0.5, 40);
  feedTrace(buf, 0.5, 41); // segundo sample del mismo bucket: se ignora
  const b = Math.floor(0.5 * BUCKETS);
  assert.equal(buf[b], 40);
});

test('ignora muestras invalidas', () => {
  const buf = [];
  feedTrace(buf, -0.1, 10);
  feedTrace(buf, 1.5, 10);
  feedTrace(buf, 0.5, 0);
  feedTrace(buf, 0.5, -3);
  assert.equal(buf.filter((v) => v != null).length, 0);
});

// ── Tracker de la sesion ──

test('sin vueltas cerradas todavia no hay ninguna referencia', () => {
  const tr = createTracker();
  assert.deepEqual(tr.deltas(0.5, 50), { sessionBest: null, lastLap: null });
});

test('la primera vuelta cerrada queda como ultima Y como mejor', () => {
  const tr = createTracker();
  for (let i = 0; i < BUCKETS; i++) tr.feed(i / BUCKETS, (i / BUCKETS) * 100);
  tr.completeLap(100);
  const d = tr.deltas(0.5, 52); // vas 2s peor a mitad de vuelta
  assert.ok(Math.abs(d.sessionBest - 2) < 0.5);
  assert.ok(Math.abs(d.lastLap - 2) < 0.5);
});

test('una vuelta mas lenta cambia la ultima pero no la mejor', () => {
  const tr = createTracker();
  for (let i = 0; i < BUCKETS; i++) tr.feed(i / BUCKETS, (i / BUCKETS) * 100);
  tr.completeLap(100);
  for (let i = 0; i < BUCKETS; i++) tr.feed(i / BUCKETS, (i / BUCKETS) * 104);
  tr.completeLap(104);
  const d = tr.deltas(0.5, 50);
  assert.ok(Math.abs(d.sessionBest - 0) < 0.5, 'contra la mejor (100) vas parejo');
  assert.ok(Math.abs(d.lastLap - (-2)) < 0.5, 'contra la ultima (104) vas 2s mejor');
});

test('el delta sigue contando aunque la vuelta sea invalida', () => {
  // El caso que motiva todo esto: iRacing apaga sus deltas al despistar.
  // El nuestro no depende de eso: si perdiste 5s, se ven.
  const tr = createTracker();
  for (let i = 0; i < BUCKETS; i++) tr.feed(i / BUCKETS, (i / BUCKETS) * 100);
  tr.completeLap(100);
  const d = tr.deltas(0.5, 55);
  assert.ok(Math.abs(d.sessionBest - 5) < 0.5);
});

test('una vuelta invalida no se guarda como referencia', () => {
  // iRacing manda lastLapTime -1 cuando la vuelta no cuenta.
  const tr = createTracker();
  for (let i = 0; i < BUCKETS; i++) tr.feed(i / BUCKETS, (i / BUCKETS) * 100);
  tr.completeLap(100);
  for (let i = 0; i < BUCKETS; i++) tr.feed(i / BUCKETS, (i / BUCKETS) * 80);
  tr.completeLap(-1);
  const d = tr.deltas(0.5, 50);
  assert.ok(Math.abs(d.sessionBest - 0) < 0.5, 'la referencia sigue siendo la de 100s');
});

test('el tiempo restante proyectado sale de la mejor vuelta', () => {
  // Proyectado = lo que llevas + lo que falta al ritmo de la referencia. No
  // depende de cual referencia estes mirando en la barra.
  const tr = createTracker();
  for (let i = 0; i < BUCKETS; i++) tr.feed(i / BUCKETS, (i / BUCKETS) * 100);
  tr.completeLap(100);
  const p = tr.predict(0.5, 52); // mitad de vuelta, 2s perdidos
  assert.ok(Math.abs(p - 102) < 0.6);
});

test('sin referencia no hay proyeccion', () => {
  const tr = createTracker();
  assert.equal(tr.predict(0.5, 50), null);
});

test('reset borra todo al cambiar de sesion', () => {
  const tr = createTracker();
  for (let i = 0; i < BUCKETS; i++) tr.feed(i / BUCKETS, (i / BUCKETS) * 100);
  tr.completeLap(100);
  tr.reset();
  assert.deepEqual(tr.deltas(0.5, 50), { sessionBest: null, lastLap: null });
});

test('el cruce de meta no genera un delta absurdo', () => {
  // Medido en telemetria real: en el frame del cruce, LapDistPct ya volvio a 0
  // pero LapCurrentLapTime todavia trae el cronometro de la vuelta que termina.
  // Restar eso contra el arranque de la referencia daba picos de -43s.
  const tr = createTracker();
  for (let i = 0; i < BUCKETS; i++) tr.feed(i / BUCKETS, (i / BUCKETS) * 100);
  tr.completeLap(100);
  assert.equal(tr.deltas(0.001, 99.8).sessionBest, null, 'cronometro viejo con pct reseteado');
  assert.equal(tr.predict(0.001, 99.8), null);
  // Ya sincronizado: arranque de vuelta de verdad.
  assert.ok(tr.deltas(0.001, 0.1).sessionBest != null);
});
