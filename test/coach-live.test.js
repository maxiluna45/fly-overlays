const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/renderer/lib/coach-live.js');

// Vuelta sintética: recta, curva, recta. `bins` es el largo total.
function synthLap({ bins = 200, corner = [60, 100], brakeAt = 45, throttleAt = 105, gear = 3, apexSpeed = 20, topSpeed = 60 } = {}) {
  const out = new Array(bins).fill(null).map((_, i) => {
    const inCorner = i >= corner[0] && i <= corner[1];
    return {
      st: inCorner ? 0.5 : 0.01,
      br: i >= brakeAt && i < corner[0] + 5 ? 0.8 : 0,
      th: i >= throttleAt ? 1 : 0,
      g: inCorner ? gear : gear + 2,
      sp: inCorner ? apexSpeed : topSpeed,
    };
  });
  // Punto de velocidad mínima en el medio de la curva (el ápice).
  const apex = Math.floor((corner[0] + corner[1]) / 2);
  out[apex].sp = apexSpeed - 1;
  return out;
}

test('detectCorners encuentra la curva y su ápice', async () => {
  const { detectCorners } = await load();
  const c = detectCorners(synthLap());
  assert.equal(c.length, 1);
  assert.equal(c[0].i0, 60);
  assert.equal(c[0].i1, 100);
  assert.equal(c[0].apex, 80); // el bin de velocidad mínima, no el de más volante
  assert.equal(c[0].pctStart, 0.3);
});

test('detectCorners ignora correcciones cortas y une tramos vecinos', async () => {
  const { detectCorners } = await load();
  const s = synthLap();
  s[10].st = 0.5; s[11].st = 0.5; // corrección de 2 bins: no es curva
  assert.equal(detectCorners(s).length, 1);
  const t = synthLap();
  for (let i = 104; i <= 112; i++) t[i].st = 0.5; // segundo tramo a 3 bins: misma curva
  assert.equal(detectCorners(t).length, 1);
});

test('detectCorners parte una ese en sus curvas al cambiar de lado el volante', async () => {
  const { detectCorners } = await load();
  const s = synthLap();
  // Izquierda 60-80, derecha 81-100, sin soltar el volante en el medio.
  for (let i = 60; i <= 80; i++) s[i].st = 0.5;
  for (let i = 81; i <= 100; i++) s[i].st = -0.5;
  const c = detectCorners(s);
  assert.equal(c.length, 2);
  assert.equal(c[0].i1, 80);
  assert.equal(c[1].i0, 81);
});

test('detectCorners no inventa curvas en una vuelta sin datos de volante', async () => {
  const { detectCorners } = await load();
  assert.deepEqual(detectCorners([]), []);
  assert.deepEqual(detectCorners(new Array(100).fill(null)), []);
});

test('cornerFacts ubica frenada, marcha, ápice y aceleración', async () => {
  const { detectCorners, cornerFacts } = await load();
  const s = synthLap();
  const c = detectCorners(s)[0];
  const f = cornerFacts(s, c);
  assert.equal(f.brakeBin, 45);
  assert.equal(f.gear, 3);
  assert.equal(f.throttleBin, 105);
  assert.equal(Math.round(f.apexSpeed), 19);
});

test('compareCorner ignora diferencias por debajo de la tolerancia', async () => {
  const { detectCorners, cornerFacts, compareCorner } = await load();
  const ref = synthLap();
  const mine = synthLap({ brakeAt: 46 }); // 1 bin = 5 m en una pista de 1000 m
  const c = detectCorners(ref)[0];
  const out = compareCorner(cornerFacts(mine, c), cornerFacts(ref, c), { trackLength: 1000 });
  assert.deepEqual(out, []);
});

test('compareCorner detecta frenada temprana, marcha de más y salida tarde', async () => {
  const { detectCorners, cornerFacts, compareCorner } = await load();
  const ref = synthLap();
  const mine = synthLap({ brakeAt: 35, gear: 4, throttleAt: 115 });
  const c = detectCorners(ref)[0];
  const out = compareCorner(cornerFacts(mine, c), cornerFacts(ref, c), { trackLength: 1000 });
  const kinds = out.map((f) => f.kind);
  assert.ok(kinds.includes('brakeEarly'));
  assert.ok(kinds.includes('gearHigh'));
  assert.ok(kinds.includes('throttleLate'));
  // 10 bins antes sobre 200 bins de una pista de 1000 m = 50 m.
  assert.equal(out.find((f) => f.kind === 'brakeEarly').meters, 50);
  assert.equal(out.find((f) => f.kind === 'gearHigh').gear, 3);
  // Ordenado por prioridad: el hallazgo más caro primero.
  assert.ok(out[0].loss >= out[out.length - 1].loss);
});

test('compareCorner descarta diferencias imposibles de corregir', async () => {
  const { detectCorners, cornerFacts, compareCorner } = await load();
  const ref = synthLap();
  const mine = synthLap({ brakeAt: 5 }); // 40 bins = 200 m antes: no es un consejo
  const c = detectCorners(ref)[0];
  const out = compareCorner(cornerFacts(mine, c), cornerFacts(ref, c), { trackLength: 1000 });
  assert.equal(out.filter((f) => f.kind === 'brakeEarly').length, 0);
});

test('adviceText rota frases de forma determinista', async () => {
  const { adviceText, bestAdvice } = await load();
  const f = { kind: 'brakeEarly', meters: 20, loss: 12 };
  const a = adviceText(f, 0), b = adviceText(f, 1);
  assert.notEqual(a, b);
  assert.equal(adviceText(f, 3), a); // 3 frases → vuelve a la primera
  assert.match(a, /20 m/);
  assert.equal(bestAdvice([]), null);
  assert.equal(bestAdvice([f], { variant: 0 }).text, a);
});

test('announcePct dispara el aviso antes de la curva y contempla la meta', async () => {
  const { announcePct, isWithinLead } = await load();
  // A 50 m/s, 2 s antes son 100 m: en una pista de 4000 m, 0,025 de vuelta.
  const p = announcePct(0.5, 50, { trackLength: 4000, seconds: 2 });
  assert.ok(Math.abs(p - 0.475) < 1e-9);
  assert.equal(isWithinLead(0.48, p, 0.5), true);
  assert.equal(isWithinLead(0.51, p, 0.5), false); // ya estás adentro
  assert.equal(isWithinLead(0.47, p, 0.5), false); // todavía falta
  // Curva justo después de meta: el tramo de aviso cruza la línea.
  const q = announcePct(0.01, 50, { trackLength: 4000, seconds: 2 });
  assert.ok(q > 0.9);
  assert.equal(isWithinLead(0.995, q, 0.01), true);
  assert.equal(isWithinLead(0.005, q, 0.01), true);
  assert.equal(isWithinLead(0.5, q, 0.01), false);
});

test('announcePct no se adelanta más allá del tope aunque vayas muy rápido', async () => {
  const { announcePct } = await load();
  const p = announcePct(0.5, 90, { trackLength: 1000, seconds: 4, maxLead: 0.08 });
  assert.ok(Math.abs(p - 0.42) < 1e-9);
});

test('anchorPct ancla el aviso al punto de frenada de la referencia', async () => {
  const { detectCorners, cornerFacts, anchorPct } = await load();
  const s = synthLap();
  const c = detectCorners(s)[0];
  const f = cornerFacts(s, c);
  // La referencia frena en el bin 45 de 200 → 0,225, antes del inicio (0,3).
  assert.equal(anchorPct(c, f), 0.225);
  // Sin frenada en la referencia (curva de gas), el ancla es la curva misma.
  assert.equal(anchorPct(c, { brakePct: null }), c.pctStart);
  assert.equal(anchorPct(c, null), c.pctStart);
});

test('fillTrackGaps interpola los huecos y cierra la vuelta', async () => {
  const { fillTrackGaps } = await load();
  const pts = new Array(8).fill(null);
  pts[0] = { lat: 0, lon: 0 };
  pts[4] = { lat: 4, lon: 0 };
  const out = fillTrackGaps(pts);
  assert.equal(out, null); // menos de 8 puntos conocidos: no alcanza

  const p2 = new Array(8).fill(null).map((_, i) => (i % 1 === 0 ? { lat: i, lon: 0 } : null));
  const o2 = fillTrackGaps(p2);
  assert.equal(o2.length, 8);
  assert.equal(o2[3].lat, 3);
});

test('posAtPct interpola entre bins en vez de saltar', async () => {
  const { posAtPct } = await load();
  const pts = new Array(4).fill(null).map((_, i) => ({ lat: i, lon: 0 }));
  assert.equal(posAtPct(pts, 0).lat, 0);
  assert.equal(posAtPct(pts, 0.125).lat, 0.5);   // medio bin
  assert.equal(posAtPct(pts, 0.25).lat, 1);
  // Wrap por meta: del último bin vuelve al primero.
  assert.equal(posAtPct(pts, 0.875).lat, 1.5);
  assert.equal(posAtPct(pts, 1).lat, 0);
});

test('meanOffset promedia el desfase de toda la vuelta y cancela el ruido de un bin', async () => {
  const { meanOffset } = await load();
  const n = 100;
  const ref = new Array(n).fill(null).map((_, i) => ({ e: i, n: 0 }));
  // La estima está 10 m corrida al este y 5 al norte...
  const bins = new Array(n).fill(null).map((_, i) => ({ pe: i - 10, pn: -5 }));
  // ...y un bin de la referencia está mal por 40 m (ruido de bineado).
  ref[7] = { e: 47, n: 0 };
  const off = meanOffset(bins, ref);
  // Un solo bin malo mueve el promedio 0,4 m sobre 100; anclar EN ese bin
  // habría movido la vuelta entera 40 m.
  assert.equal(Math.round(off.e * 10) / 10, 10.4);
  assert.equal(off.n, 5);
  assert.equal(off.samples, 100);
});

test('meanOffset exige cobertura mínima pero se conforma con un tercio de vuelta', async () => {
  const { meanOffset } = await load();
  const n = 100;
  const ref = new Array(n).fill(null).map((_, i) => ({ e: i, n: 0 }));
  const few = new Array(n).fill(null);
  for (let i = 0; i < 20; i++) few[i] = { pe: i, pn: 0 };
  assert.equal(meanOffset(few, ref), null); // 20%: no alcanza
  // 40% sí: con una vuelta a la que le falta un tramo (un paso por boxes) la
  // calibración tiene que poder recuperarse igual.
  const enough = new Array(n).fill(null);
  for (let i = 0; i < 40; i++) enough[i] = { pe: i, pn: 0 };
  assert.ok(meanOffset(enough, ref) != null);
  assert.equal(meanOffset(null, ref), null);
});

// Regresión: el borrado de la trazada y el reajuste de la posición dependían de
// `completedLap` del SDK, que no llega en la primera pasada por meta cuando
// saliste de boxes (no hay vuelta anterior cronometrada). Resultado: la vuelta
// vieja quedaba dibujada y la posición nunca se corregía.
test('isLapCrossing detecta el cruce de meta por el salto de LapDistPct', async () => {
  const { isLapCrossing } = await load();
  assert.equal(isLapCrossing(0.99, 0.01), true);
  assert.equal(isLapCrossing(0.85, 0.05), true);
  // Avance normal: no es cruce.
  assert.equal(isLapCrossing(0.30, 0.31), false);
  assert.equal(isLapCrossing(0.10, 0.90), false); // retroceso (reset a boxes)
  assert.equal(isLapCrossing(0.79, 0.19), false); // salto chico, no llega a meta
  // Sin dato previo (primer frame) no se inventa un cruce.
  assert.equal(isLapCrossing(null, 0.01), false);
  assert.equal(isLapCrossing(0.99, null), false);
});

test('detectShifts encuentra los cambios con marcha de origen y destino', async () => {
  const { detectShifts } = await load();
  const s = new Array(100).fill(null).map(() => ({ g: 3 }));
  for (let i = 40; i < 70; i++) s[i].g = 4;
  for (let i = 70; i < 100; i++) s[i].g = 5;
  const sh = detectShifts(s);
  assert.equal(sh.length, 2);
  assert.deepEqual({ bin: sh[0].bin, from: sh[0].from, to: sh[0].to, up: sh[0].up }, { bin: 40, from: 3, to: 4, up: true });
  assert.equal(sh[0].pct, 0.4);
  assert.equal(sh[1].to, 5);
});

test('detectShifts ignora un cambio que se deshace enseguida', async () => {
  const { detectShifts } = await load();
  const s = new Array(100).fill(null).map(() => ({ g: 3 }));
  s[50].g = 4; s[51].g = 4; // rebote de 2 bins: 3→4→3 no cuenta
  assert.deepEqual(detectShifts(s), []);
  // Pero si se sostiene, sí es un cambio.
  const t = new Array(100).fill(null).map(() => ({ g: 3 }));
  for (let i = 50; i < 60; i++) t[i].g = 4;
  assert.equal(detectShifts(t).length, 2); // 3→4 y 4→3
});

test('detectShifts tolera muestras sin marcha', async () => {
  const { detectShifts } = await load();
  assert.deepEqual(detectShifts([]), []);
  assert.deepEqual(detectShifts([null, { g: 0 }, { sp: 10 }]), []);
});

test('lastDownshiftPct devuelve el último descenso antes del ápice', async () => {
  const { lastDownshiftPct } = await load();
  const shifts = [
    { pct: 0.10, up: true, to: 5 },
    { pct: 0.20, up: false, to: 4 },
    { pct: 0.24, up: false, to: 3 },
    { pct: 0.40, up: false, to: 2 },
  ];
  assert.equal(lastDownshiftPct(shifts, 0.15, 0.30).to, 3);
  assert.equal(lastDownshiftPct(shifts, 0.15, 0.30).pct, 0.24);
  assert.equal(lastDownshiftPct(shifts, 0.50, 0.60), null); // no hay ninguno ahí
});

test('compareCorner avisa cuando el cambio de marcha llega tarde', async () => {
  const { detectCorners, cornerFacts, compareCorner, adviceText } = await load();
  // Misma marcha en el ápice, pero el cambio 20 bins (100 m) más tarde.
  const ref = synthLap();
  for (let i = 0; i < 40; i++) ref[i].g = 5;
  for (let i = 40; i < 200; i++) ref[i].g = 3;
  const mine = synthLap();
  for (let i = 0; i < 60; i++) mine[i].g = 5;
  for (let i = 60; i < 200; i++) mine[i].g = 3;
  const c = detectCorners(ref)[0];
  const out = compareCorner(cornerFacts(mine, c), cornerFacts(ref, c), { trackLength: 1000 });
  const f = out.find((x) => x.kind === 'shiftLate');
  assert.ok(f, 'debería detectar el cambio tardío');
  assert.equal(f.meters, 100);
  assert.equal(f.gear, 3);
  assert.match(adviceText(f, 0), /3ª 100 m antes/);
});

test('compareCorner no habla del momento del cambio si la marcha es distinta', async () => {
  const { detectCorners, cornerFacts, compareCorner } = await load();
  // Con marcha equivocada, el consejo que corresponde es la marcha, no el momento.
  const ref = synthLap({ gear: 3 });
  const mine = synthLap({ gear: 4 });
  const c = detectCorners(ref)[0];
  const out = compareCorner(cornerFacts(mine, c), cornerFacts(ref, c), { trackLength: 1000 });
  assert.equal(out.some((x) => x.kind === 'shiftLate' || x.kind === 'shiftEarly'), false);
  assert.ok(out.some((x) => x.kind === 'gearHigh'));
});

test('gearAtPct devuelve la marcha en cualquier punto, mirando hacia atrás', async () => {
  const { gearAtPct } = await load();
  const s = new Array(100).fill(null).map(() => ({ g: 3 }));
  for (let i = 50; i < 100; i++) s[i].g = 5;
  assert.equal(gearAtPct(s, 0.10), 3);
  assert.equal(gearAtPct(s, 0.60), 5);
  // Bin sin dato: toma el último conocido, no null.
  s[62] = null;
  assert.equal(gearAtPct(s, 0.62), 5);
  assert.equal(gearAtPct([], 0.5), null);
});

test('targetCorner da la curva en curso o la próxima, con wrap por meta', async () => {
  const { targetCorner } = await load();
  const corners = [
    { index: 0, pctStart: 0.10, pctEnd: 0.20 },
    { index: 1, pctStart: 0.50, pctEnd: 0.60 },
  ];
  assert.equal(targetCorner(corners, 0.05).index, 0); // viene la primera
  assert.equal(targetCorner(corners, 0.15).index, 0); // estoy dentro de la primera
  assert.equal(targetCorner(corners, 0.30).index, 1); // viene la segunda
  assert.equal(targetCorner(corners, 0.90).index, 0); // pasadas todas: vuelve a la primera
  assert.equal(targetCorner([], 0.5), null);
});

// Regresión: este bloque usaba una variable declarada más abajo en el handler,
// así que lanzaba en cada frame justo al cambiar de marcha y dejaba la vista
// congelada. Extraído acá, el contrato queda fijado y probado.
test('gearFlash marca el instante del cambio y no destella en la primera lectura', async () => {
  const { gearFlash } = await load();
  // Primera lectura: fija la marcha sin destellar.
  assert.deepEqual(gearFlash(null, 4, 1000), { gear: 4, flashAt: 0, up: false });
  // Sin cambio: nada.
  assert.equal(gearFlash(4, 4, 1000), null);
  // Sube y baja.
  assert.deepEqual(gearFlash(4, 5, 2000), { gear: 5, flashAt: 2000, up: true });
  assert.deepEqual(gearFlash(4, 3, 2000), { gear: 3, flashAt: 2000, up: false });
  // Sin dato de marcha no se toca nada (punto muerto o muestra vacía).
  assert.equal(gearFlash(4, null, 1000), null);
  assert.equal(gearFlash(4, 0, 1000), null);
});
