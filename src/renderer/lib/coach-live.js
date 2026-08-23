// Coach en vivo: reglas deterministas que comparan tu vuelta contra una
// referencia, curva por curva. Nada de esto usa un modelo: son umbrales
// medidos sobre canales que ya tenemos (volante, freno, acelerador, marcha,
// velocidad) indexados por posición de pista.
//
// Todo el módulo es puro y trabaja sobre "bins": arrays de muestras indexados
// por LapDistPct, la misma estructura que produce el parser de .ibt, el
// grabador en vivo y el importador de CSV de Garage 61.

// ── Detección de curvas ──────────────────────────────────────────────────
// Una curva es un tramo donde el volante se sostiene girado. El umbral es
// relativo a la propia vuelta (un fórmula gira mucho menos grados que un MX-5),
// con un piso absoluto para que el bamboleo de una recta no cuente.
const STEER_FRAC = 0.22;        // fracción del volante "de curva" típico
const STEER_MIN_RAD = 0.06;     // ~3,4° — piso absoluto
const CORNER_MIN_BINS = 5;      // más corto que esto es una corrección
const CORNER_MERGE_BINS = 10;   // dos tramos más cerca que esto son una curva

// ── Comparación contra la referencia ─────────────────────────────────────
// Diferencias por debajo de esto no se avisan: son ruido de bineado y de
// trazada, no algo que el piloto pueda corregir.
const BRAKE_TOL_M = 8;          // metros en el punto de frenada
const THROTTLE_TOL_M = 8;       // metros en el punto de aceleración
const APEX_TOL_KMH = 2;         // km/h en el ápice
// Cuánto antes de la curva se busca el inicio de la frenada.
const BRAKE_LOOKBACK_BINS = 70;
// Techo de credibilidad: una diferencia enorme no suele ser algo que corregir
// sino que las dos vueltas no son comparables en esa curva (una salida de
// pista, un tráfico, un punto de frenada que el detector emparejó mal). Antes
// que dar un consejo absurdo, no decimos nada.
const MAX_DIFF_M = 120;
const MAX_DIFF_KMH = 30;
const BRAKE_ON = 0.15;          // pedal pisado
const THROTTLE_ON = 0.9;        // acelerador "a fondo"

const clampIdx = (i, n) => Math.max(0, Math.min(n - 1, i));
const pctOf = (i, n) => i / n;

function percentile(values, p) {
  if (!values.length) return 0;
  const a = [...values].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(a.length * p))];
}

// Curvas de la vuelta, en orden de pista. Cada una: {i0, i1, apex, pctStart,
// pctEnd, index}. `apex` es el bin de velocidad mínima dentro de la curva, que
// es donde de verdad está el vértice (el pico de volante puede estar antes).
export function detectCorners(samples, opts = {}) {
  const n = Array.isArray(samples) ? samples.length : 0;
  if (n < 20) return [];
  const minBins = opts.minBins ?? CORNER_MIN_BINS;
  const mergeBins = opts.mergeBins ?? CORNER_MERGE_BINS;

  const steer = new Array(n).fill(null);
  const vals = [];
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    if (s && s.st != null && isFinite(s.st)) { steer[i] = Math.abs(s.st); vals.push(steer[i]); }
  }
  if (vals.length < 20) return [];
  const ref = percentile(vals, 0.9);
  const thr = Math.max(STEER_MIN_RAD, ref * (opts.frac ?? STEER_FRAC));

  const runs = [];
  let start = null, gap = 0;
  for (let i = 0; i < n; i++) {
    const on = steer[i] != null && steer[i] >= thr;
    if (on) {
      if (start == null) start = i;
      gap = 0;
    } else if (start != null) {
      gap++;
      if (gap > mergeBins) { runs.push([start, i - gap]); start = null; gap = 0; }
    }
  }
  if (start != null) runs.push([start, n - 1]);

  return runs
    .filter(([a, b]) => b - a + 1 >= minBins)
    .map(([i0, i1], index) => {
      let apex = i0, best = Infinity;
      for (let i = i0; i <= i1; i++) {
        const s = samples[i];
        if (s && s.sp != null && s.sp < best) { best = s.sp; apex = i; }
      }
      return { index, i0, i1, apex, pctStart: pctOf(i0, n), pctEnd: pctOf(i1 + 1, n), pctApex: pctOf(apex, n) };
    })
    .map((c, index) => ({ ...c, index }));
}

// Datos de una curva concreta en una vuelta concreta: dónde se frena, con qué
// marcha se pasa, a qué velocidad y dónde se vuelve a acelerar. `prevExit` es
// el bin de salida de la curva anterior, para no buscar la frenada tan atrás
// como para agarrar la de la curva de antes.
export function cornerFacts(samples, corner, { prevExit = null } = {}) {
  const n = samples.length;
  if (!corner || !n) return null;
  const lookFrom = Math.max(prevExit != null ? prevExit + 1 : 0, corner.i0 - BRAKE_LOOKBACK_BINS);

  let brake = null, brakePeak = 0;
  for (let i = clampIdx(lookFrom, n); i <= corner.apex; i++) {
    const s = samples[i];
    if (!s || s.br == null) continue;
    if (s.br > brakePeak) brakePeak = s.br;
    if (brake == null && s.br >= BRAKE_ON) brake = i;
  }

  const apexS = samples[corner.apex];
  let throttle = null;
  for (let i = corner.apex; i <= Math.min(n - 1, corner.i1 + BRAKE_LOOKBACK_BINS); i++) {
    const s = samples[i];
    if (s && s.th != null && s.th >= THROTTLE_ON) { throttle = i; break; }
  }

  let gear = null;
  for (let i = corner.apex; i >= corner.i0; i--) {
    const s = samples[i];
    if (s && s.g != null && s.g > 0) { gear = s.g; break; }
  }

  const entry = brake != null ? samples[brake] : null;
  return {
    brakeBin: brake,
    brakePct: brake != null ? pctOf(brake, n) : null,
    brakePeak,
    entrySpeed: entry && entry.sp != null ? entry.sp : null,
    apexSpeed: apexS && apexS.sp != null ? apexS.sp : null,
    apexBin: corner.apex,
    gear,
    throttleBin: throttle,
    throttlePct: throttle != null ? pctOf(throttle, n) : null,
    bins: n,
  };
}

// Todas las curvas de una vuelta, con sus datos, en un solo paso.
export function lapFacts(samples, corners) {
  const out = [];
  let prevExit = null;
  for (const c of corners) {
    out.push(cornerFacts(samples, c, { prevExit }));
    prevExit = c.i1;
  }
  return out;
}

// ── Reglas ───────────────────────────────────────────────────────────────
// Cada hallazgo trae `loss`, una estimación grosera de cuánto cuesta, sólo
// para ordenar cuál avisar primero cuando hay varios. No se muestra como
// tiempo perdido porque no lo medimos: es una prioridad, no un cronómetro.
export const RULES = {
  brakeEarly: { kind: 'brakeEarly' },
  brakeLate: { kind: 'brakeLate' },
  gearHigh: { kind: 'gearHigh' },
  gearLow: { kind: 'gearLow' },
  throttleLate: { kind: 'throttleLate' },
  apexSlow: { kind: 'apexSlow' },
};

// Compara una curva tuya contra la misma curva de la referencia.
// `trackLength` en metros convierte diferencias de posición a metros.
export function compareCorner(mine, ref, { trackLength = 0 } = {}) {
  const found = [];
  if (!mine || !ref) return found;
  const toM = (dPct) => (trackLength > 0 ? dPct * trackLength : null);

  if (mine.brakePct != null && ref.brakePct != null) {
    const dM = toM(mine.brakePct - ref.brakePct);
    if (dM != null && Math.abs(dM) >= BRAKE_TOL_M && Math.abs(dM) <= MAX_DIFF_M) {
      found.push({
        kind: dM < 0 ? 'brakeEarly' : 'brakeLate',
        meters: Math.round(Math.abs(dM)),
        loss: Math.abs(dM) * 0.6,
      });
    }
  }

  if (mine.gear != null && ref.gear != null && mine.gear !== ref.gear) {
    found.push({
      kind: mine.gear > ref.gear ? 'gearHigh' : 'gearLow',
      gear: ref.gear,
      loss: 25,
    });
  }

  if (mine.apexSpeed != null && ref.apexSpeed != null) {
    const dKmh = (mine.apexSpeed - ref.apexSpeed) * 3.6;
    if (dKmh <= -APEX_TOL_KMH && dKmh >= -MAX_DIFF_KMH) {
      found.push({ kind: 'apexSlow', kmh: Math.round(-dKmh), loss: -dKmh * 4 });
    }
  }

  if (mine.throttlePct != null && ref.throttlePct != null) {
    const dM = toM(mine.throttlePct - ref.throttlePct);
    if (dM != null && dM >= THROTTLE_TOL_M && dM <= MAX_DIFF_M) {
      found.push({ kind: 'throttleLate', meters: Math.round(dM), loss: dM * 0.8 });
    }
  }

  return found.sort((a, b) => b.loss - a.loss);
}

// ── Frases ───────────────────────────────────────────────────────────────
// Varias por regla, para que no repita siempre lo mismo. La elección es
// determinista (rota por número de vuelta), no aleatoria: así el mismo aviso
// en la misma vuelta siempre se lee igual y se puede reproducir un problema.
const PHRASES = {
  brakeEarly: [
    (f) => `Frená ${f.meters} m más tarde`,
    (f) => `Estirá la frenada ${f.meters} m`,
    (f) => `Podés llegar ${f.meters} m más adentro`,
  ],
  brakeLate: [
    (f) => `Frená ${f.meters} m antes`,
    (f) => `Adelantá la frenada ${f.meters} m`,
    (f) => `Estás llegando ${f.meters} m pasado`,
  ],
  gearHigh: [
    (f) => `Una marcha menos: ${f.gear}ª`,
    (f) => `Bajá a ${f.gear}ª`,
    (f) => `Con ${f.gear}ª sale mejor`,
  ],
  gearLow: [
    (f) => `Una marcha más: ${f.gear}ª`,
    (f) => `Subí a ${f.gear}ª`,
    (f) => `Te sobra vuelta: ${f.gear}ª`,
  ],
  apexSlow: [
    (f) => `Más velocidad en el ápice: te faltan ${f.kmh} km/h`,
    (f) => `Tomala más abierta, ${f.kmh} km/h de diferencia`,
    (f) => `Menos freno adentro: ${f.kmh} km/h más`,
  ],
  throttleLate: [
    (f) => `Acelerá ${f.meters} m antes`,
    (f) => `Abrí el acelerador ${f.meters} m más temprano`,
    (f) => `Salís tarde: ${f.meters} m de acelerador perdidos`,
  ],
};

export function adviceText(finding, variant = 0) {
  if (!finding) return '';
  const list = PHRASES[finding.kind];
  if (!list || !list.length) return '';
  return list[((variant % list.length) + list.length) % list.length](finding);
}

// El aviso que vale la pena dar para una curva: el hallazgo más caro.
export function bestAdvice(findings, { variant = 0, cornerLabel = null } = {}) {
  if (!Array.isArray(findings) || !findings.length) return null;
  const f = findings[0];
  return {
    kind: f.kind,
    text: adviceText(f, variant),
    detail: f,
    cornerLabel,
    others: findings.length - 1,
  };
}

// ── Anticipación ─────────────────────────────────────────────────────────
// El aviso tiene que llegar ANTES de la curva. Devuelve la fracción de vuelta
// en la que hay que dispararlo para que el piloto lo escuche `seconds` antes
// de entrar, a la velocidad a la que viene.
export function announcePct(cornerPctStart, speedMs, { trackLength = 0, seconds = 2.5, maxLead = 0.08 } = {}) {
  if (!(trackLength > 0) || !(speedMs > 0)) return cornerPctStart;
  const lead = Math.min(maxLead, (speedMs * seconds) / trackLength);
  const p = cornerPctStart - lead;
  return p < 0 ? p + 1 : p;
}

// Punto de pista al que se ancla el aviso de una curva: el de FRENADA de la
// referencia si lo hay, y si no el inicio de la curva. Un "frená 60 m antes"
// que llega cuando ya estás frenando no sirve de nada.
export function anchorPct(corner, facts) {
  const bp = facts && facts.brakePct;
  return bp != null && bp < corner.pctStart ? bp : corner.pctStart;
}

// ¿Ya pasamos el punto de disparo, sin haber entrado todavía en la curva?
// Contempla el wrap por meta (una curva justo después de la línea).
export function isWithinLead(pct, triggerPct, cornerPctStart) {
  if (triggerPct <= cornerPctStart) return pct >= triggerPct && pct < cornerPctStart;
  return pct >= triggerPct || pct < cornerPctStart; // el tramo cruza la meta
}
