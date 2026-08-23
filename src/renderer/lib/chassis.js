// Suspensión y frenos: deriva de las muestras de una vuelta lo que el resto del
// análisis no puede ver (velocidad, freno y acelerador no distinguen una rueda
// bloqueada de una frenada suave, ni un piano de un bache).
//
// Los canales los agrega `ibt-parser.js` a cada bin: `def` (recorrido de los 4
// amortiguadores, en metros), `sv`/`svW` (mayor velocidad de amortiguador del
// bin y en qué rueda), `sl`/`slW` (patinaje sostenido de la rueda más trabada
// frenando), `bpF`/`bpR` (presión de línea de freno delantera y trasera, en bar)
// y `pit`/`rol` (cabeceo y balanceo, en radianes).
//
// Orden de ruedas en todos los arrays: LF, RF, LR, RR.

export const WHEELS = ['LF', 'RF', 'LR', 'RR'];
export const WHEEL_LABEL = ['Del. izq.', 'Del. der.', 'Tras. izq.', 'Tras. der.'];

// Un golpe fuerte de verdad mueve el amortiguador rápido. Medido en .ibt reales:
// la mediana está en 0,03 m/s y los pianos aparecen arriba de ~1 m/s. El piso
// evita que en una vuelta limpia el percentil marque cualquier cosa como golpe.
const IMPACT_MIN_VEL = 0.45; // m/s
const MAX_IMPACTS = 6;
// Dos eventos separados por menos de esto son el mismo (bins de ~4 m).
const MERGE_GAP_BINS = 4;
// Presión mínima (fracción del pico de la vuelta) para medir el reparto de
// frenada: con el pedal apenas rozado el reparto no significa nada.
const BIAS_MIN_PRESS = 0.25;

// ¿Esta vuelta trae canales de chasis? Las sesiones grabadas en vivo por ahora
// no los guardan, sólo las abiertas desde un .ibt.
export function hasChassisData(samples) {
  if (!Array.isArray(samples)) return false;
  return samples.some((s) => s && Array.isArray(s.def) && s.def.some((v) => v != null));
}

// Series por bin, listas para graficar (null donde no hay muestra).
export function chassisSeries(samples) {
  const n = Array.isArray(samples) ? samples.length : 0;
  const out = {
    n,
    slip: new Array(n).fill(null),   // 0..1
    impact: new Array(n).fill(null), // m/s
    pressF: new Array(n).fill(null), // bar
    pressR: new Array(n).fill(null),
    bias: new Array(n).fill(null),   // 0..1 = fracción delantera
    defl: [0, 1, 2, 3].map(() => new Array(n).fill(null)), // m
    pitch: new Array(n).fill(null),  // rad
    roll: new Array(n).fill(null),
  };
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    if (!s) continue;
    if (s.sl != null) out.slip[i] = s.sl;
    if (s.sv != null) out.impact[i] = s.sv;
    if (s.bpF != null) out.pressF[i] = s.bpF;
    if (s.bpR != null) out.pressR[i] = s.bpR;
    const tot = (s.bpF || 0) + (s.bpR || 0);
    if (tot > 0) out.bias[i] = s.bpF / tot;
    if (Array.isArray(s.def)) for (let w = 0; w < 4; w++) out.defl[w][i] = s.def[w] ?? null;
    if (s.pit != null) out.pitch[i] = s.pit;
    if (s.rol != null) out.roll[i] = s.rol;
  }
  return out;
}

// Agrupa bins marcados en eventos: bins vecinos (o casi) son el mismo evento.
// `pick(i)` devuelve el valor del bin o null; el evento se queda con el pico.
function groupEvents(n, pick, gap = MERGE_GAP_BINS) {
  const events = [];
  let cur = null;
  let since = 0;
  for (let i = 0; i < n; i++) {
    const v = pick(i);
    if (v != null) {
      if (cur && since <= gap) {
        cur.i1 = i;
        if (v.value > cur.peak) { cur.peak = v.value; cur.at = i; cur.meta = v.meta; }
      } else {
        if (cur) events.push(cur);
        cur = { i0: i, i1: i, at: i, peak: v.value, meta: v.meta };
      }
      since = 0;
    } else if (cur) {
      since++;
      if (since > gap) { events.push(cur); cur = null; }
    }
  }
  if (cur) events.push(cur);
  return events;
}

// Bloqueos de rueda de la vuelta, del más fuerte al más leve.
// `peak` = patinaje 0..1 · `wheel` = índice en WHEELS · `pct` = punto de pista.
export function findLockups(samples) {
  const n = Array.isArray(samples) ? samples.length : 0;
  if (!n) return [];
  const evs = groupEvents(n, (i) => {
    const s = samples[i];
    return s && s.sl != null ? { value: s.sl, meta: s.slW ?? null } : null;
  });
  return evs
    .map((e) => ({
      pct: e.at / n,
      pctStart: e.i0 / n,
      pctEnd: (e.i1 + 1) / n,
      peak: e.peak,
      wheel: e.meta,
      speed: samples[e.i0] && samples[e.i0].sp != null ? samples[e.i0].sp : null,
      brake: samples[e.at] && samples[e.at].br != null ? samples[e.at].br : null,
    }))
    .sort((a, b) => b.peak - a.peak);
}

// Golpes más fuertes de la vuelta (pianos, baches, tocar el fondo). El umbral
// es el mayor entre un piso absoluto y el percentil 99 de la propia vuelta, así
// una vuelta limpia no inventa golpes y una sucia no los reporta todos.
export function findImpacts(samples, { limit = MAX_IMPACTS } = {}) {
  const n = Array.isArray(samples) ? samples.length : 0;
  if (!n) return [];
  const vals = [];
  for (let i = 0; i < n; i++) if (samples[i] && samples[i].sv != null) vals.push(samples[i].sv);
  if (vals.length < 20) return [];
  vals.sort((a, b) => a - b);
  const p99 = vals[Math.floor(vals.length * 0.99)];
  const thr = Math.max(IMPACT_MIN_VEL, p99);
  const evs = groupEvents(n, (i) => {
    const s = samples[i];
    return s && s.sv != null && s.sv >= thr ? { value: s.sv, meta: s.svW ?? null } : null;
  });
  return evs
    .map((e) => ({ pct: e.at / n, vel: e.peak, wheel: e.meta }))
    .sort((a, b) => b.vel - a.vel)
    .slice(0, limit);
}

// Reparto de frenada medido (no el que dice el setup): fracción de la presión
// total que se va al eje delantero, promediada sobre las frenadas fuertes.
// Devuelve null si en la vuelta no hubo una frenada de verdad.
export function brakeBalance(samples) {
  const n = Array.isArray(samples) ? samples.length : 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    if (!s) continue;
    const tot = (s.bpF || 0) + (s.bpR || 0);
    if (tot > peak) peak = tot;
  }
  if (peak <= 0) return null;
  const floor = peak * BIAS_MIN_PRESS;
  let sum = 0, count = 0, maxF = 0, maxR = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    if (!s || s.bpF == null || s.bpR == null) continue;
    const tot = s.bpF + s.bpR;
    if (tot < floor) continue;
    sum += s.bpF / tot;
    count++;
    if (s.bpF > maxF) maxF = s.bpF;
    if (s.bpR > maxR) maxR = s.bpR;
  }
  if (!count) return null;
  // Algunos autos (verificado en el BMW M2 G87) informan la MISMA presión de
  // línea en los dos ejes: ahí el 50% no es un reparto medido sino el canal
  // repitiéndose, y decirlo como dato sería mentir.
  const flat = Math.abs(maxF - maxR) < 0.5;
  return { front: sum / count, peakFront: maxF, peakRear: maxR, samples: count, flat };
}

// Recorrido de cada amortiguador en la vuelta: mínimo, máximo y cuánto se usó.
// Más recorrido = más compresión (verificado: frenando sube el delantero y baja
// el trasero). Sirve para ver qué rueda trabaja al límite de su carrera.
export function travelRange(samples) {
  const n = Array.isArray(samples) ? samples.length : 0;
  const out = [0, 1, 2, 3].map(() => ({ min: null, max: null, range: 0 }));
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    if (!s || !Array.isArray(s.def)) continue;
    for (let w = 0; w < 4; w++) {
      const v = s.def[w];
      if (v == null) continue;
      const o = out[w];
      if (o.min == null || v < o.min) o.min = v;
      if (o.max == null || v > o.max) o.max = v;
    }
  }
  for (const o of out) o.range = o.min != null && o.max != null ? o.max - o.min : 0;
  return out;
}

// Resumen para la tarjeta del análisis.
export function chassisSummary(samples) {
  if (!hasChassisData(samples)) return null;
  const lockups = findLockups(samples);
  return {
    lockups,
    worstLock: lockups.length ? lockups[0] : null,
    impacts: findImpacts(samples),
    balance: brakeBalance(samples),
    travel: travelRange(samples),
  };
}
