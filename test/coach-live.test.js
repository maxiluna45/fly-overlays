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
