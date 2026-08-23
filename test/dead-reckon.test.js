const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deadReckonDelta } = require('../src/main/irsdk-client.js');

const round = (v) => Math.round(v * 1e6) / 1e6;

// iRacing no publica la posición del auto en vivo, así que la trazada se
// reconstruye integrando velocidad + rumbo. La convención de signos se validó
// contra el Lat/Lon real de .ibt propios (error medio < 1 m por vuelta), y es
// justo lo que estas pruebas fijan: si alguien invierte un signo, la trazada
// sale espejada y esto lo atrapa.

test('apuntando al norte, avanzar mueve hacia el norte', () => {
  const d = deadReckonDelta(10, 0, 0, 1);
  assert.equal(round(d.n), 10);
  assert.equal(round(d.e), 0);
});

test('apuntando al este, avanzar mueve hacia el este', () => {
  const d = deadReckonDelta(10, 0, Math.PI / 2, 1);
  assert.equal(round(d.n), 0);
  assert.equal(round(d.e), 10);
});

test('apuntando al sur y al oeste', () => {
  const s = deadReckonDelta(10, 0, Math.PI, 1);
  assert.equal(round(s.n), -10);
  const o = deadReckonDelta(10, 0, (3 * Math.PI) / 2, 1);
  assert.equal(round(o.e), -10);
});

test('la velocidad lateral desplaza perpendicular al rumbo', () => {
  // Mirando al norte, VelocityY positiva mueve al oeste (este negativo).
  const d = deadReckonDelta(0, 4, 0, 1);
  assert.equal(round(d.n), 0);
  assert.equal(round(d.e), -4);
});

test('el desplazamiento escala con el tiempo', () => {
  const a = deadReckonDelta(20, 3, 1.2, 0.5);
  const b = deadReckonDelta(20, 3, 1.2, 1);
  assert.equal(round(a.n * 2), round(b.n));
  assert.equal(round(a.e * 2), round(b.e));
});

test('una vuelta a un cuadrado vuelve al punto de partida', () => {
  // 100 m al norte, 100 al este, 100 al sur, 100 al oeste.
  let n = 0, e = 0;
  for (const yaw of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
    const d = deadReckonDelta(10, 0, yaw, 10);
    n += d.n; e += d.e;
  }
  assert.ok(Math.abs(n) < 1e-9);
  assert.ok(Math.abs(e) < 1e-9);
});
