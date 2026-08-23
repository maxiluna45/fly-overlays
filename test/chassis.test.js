const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/renderer/lib/chassis.js');

// Vuelta sintética de `n` bins con los canales de chasis en valores neutros.
function lap(n = 100, fill = {}) {
  return new Array(n).fill(null).map(() => ({
    sp: 40, br: 0, def: [0.1, 0.1, 0.1, 0.1], sv: 0.02, bpF: 0, bpR: 0, pit: 0, rol: 0, ...fill,
  }));
}

test('hasChassisData distingue vueltas con y sin canales de chasis', async () => {
  const { hasChassisData } = await load();
  assert.equal(hasChassisData(lap()), true);
  assert.equal(hasChassisData([{ sp: 40, br: 0 }, null]), false);
  assert.equal(hasChassisData(null), false);
});

test('findLockups agrupa bins vecinos en un evento y ordena por severidad', async () => {
  const { findLockups } = await load();
  const s = lap(100);
  // Bloqueo largo en 20-23 (pico 0.30 en el 22) y uno corto y más leve en 60.
  s[20].sl = 0.14; s[20].slW = 0;
  s[21].sl = 0.22; s[21].slW = 0;
  s[22].sl = 0.30; s[22].slW = 1;
  s[23].sl = 0.18; s[23].slW = 1;
  s[60].sl = 0.16; s[60].slW = 2;
  const ev = findLockups(s);
  assert.equal(ev.length, 2);
  assert.equal(ev[0].peak, 0.30);
  assert.equal(ev[0].wheel, 1);
  assert.equal(ev[0].pct, 0.22);
  assert.equal(ev[1].peak, 0.16);
});

test('findLockups no parte un evento por un bin vacío en el medio', async () => {
  const { findLockups } = await load();
  const s = lap(100);
  s[30].sl = 0.20; s[30].slW = 0;
  s[33].sl = 0.25; s[33].slW = 0; // hueco de 2 bins: mismo evento
  assert.equal(findLockups(s).length, 1);
  const t = lap(100);
  t[30].sl = 0.20; t[30].slW = 0;
  t[40].sl = 0.25; t[40].slW = 0; // hueco de 9 bins: eventos distintos
  assert.equal(findLockups(t).length, 2);
});

test('findImpacts ignora una vuelta lisa y detecta el golpe fuerte', async () => {
  const { findImpacts } = await load();
  assert.deepEqual(findImpacts(lap(200)), []); // todo en 0.02 m/s: sin golpes
  const s = lap(200);
  s[50].sv = 1.3; s[50].svW = 2;
  const ev = findImpacts(s);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].wheel, 2);
  assert.equal(ev[0].pct, 0.25);
});

test('brakeBalance promedia sólo las frenadas fuertes', async () => {
  const { brakeBalance } = await load();
  const s = lap(100);
  // Frenada fuerte 65% delantera.
  for (let i = 10; i < 20; i++) { s[i].bpF = 65; s[i].bpR = 35; }
  // Roce del pedal con reparto raro: no debe contaminar el promedio.
  s[50].bpF = 1; s[50].bpR = 9;
  const b = brakeBalance(s);
  assert.equal(Math.round(b.front * 100), 65);
  assert.equal(b.samples, 10);
  assert.equal(b.peakFront, 65);
  assert.equal(b.flat, false);
  assert.equal(brakeBalance(lap(10)), null); // sin presión en toda la vuelta
});

test('brakeBalance marca flat cuando el auto informa la misma presión en ambos ejes', async () => {
  const { brakeBalance } = await load();
  const s = lap(100);
  for (let i = 10; i < 20; i++) { s[i].bpF = 80; s[i].bpR = 80; }
  const b = brakeBalance(s);
  assert.equal(b.flat, true);
  assert.equal(b.front, 0.5);
});

test('travelRange mide el recorrido usado por cada amortiguador', async () => {
  const { travelRange } = await load();
  const s = lap(50);
  s[10].def = [0.08, 0.1, 0.1, 0.1];
  s[20].def = [0.16, 0.1, 0.1, 0.1];
  const t = travelRange(s);
  assert.equal(Math.round(t[0].range * 1000), 80);
  assert.equal(t[1].range, 0);
});

test('chassisSeries deja null donde no hay muestra y calcula el reparto por bin', async () => {
  const { chassisSeries } = await load();
  const s = lap(10);
  s[3] = null;
  s[4].bpF = 60; s[4].bpR = 40;
  const c = chassisSeries(s);
  assert.equal(c.n, 10);
  assert.equal(c.pressF[3], null);
  assert.equal(c.bias[4], 0.6);
  assert.equal(c.bias[0], null); // sin presión: sin reparto
  assert.equal(c.defl.length, 4);
});
