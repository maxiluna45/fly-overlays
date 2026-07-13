// Coach IA nivel 1 — heurístico y determinístico (sin LLM).
// Compara una vuelta contra tu mejor vuelta y produce:
//   - la traza de delta acumulado a lo largo de la vuelta,
//   - tips concretos en los tramos donde más tiempo perdés,
//   - métricas de consistencia sobre todas las vueltas de la sesión.
//
// Todo se calcula a partir de las muestras por-distancia grabadas
// (throttle, brake, steer, speed, gear, rpm y t = tiempo dentro de la vuelta).

const MS_TO_KMH = 3.6;
const ZONES = 20; // dividimos la vuelta en 20 tramos para localizar pérdidas

// Devuelve la muestra en el bucket i, o null.
function at(lap, i) {
  return lap && lap.samples && lap.samples[i] ? lap.samples[i] : null;
}

// Traza de delta acumulado: delta[i] = t(lap) - t(best) en cada bucket.
// Se hace "carry-forward" del último delta conocido donde falten muestras,
// para que la línea sea continua.
export function buildDeltaTrace(best, lap) {
  const n = Math.max(best?.samples?.length || 0, lap?.samples?.length || 0);
  const out = [];
  let last = 0;
  for (let i = 0; i < n; i++) {
    const b = at(best, i);
    const l = at(lap, i);
    if (b && l && b.t != null && l.t != null) {
      last = l.t - b.t;
    }
    out.push({ i, d: i / n, delta: last });
  }
  return out;
}

// Consistencia sobre las vueltas válidas: media, desviación estándar y spread.
export function consistency(laps) {
  const valid = (laps || []).filter((l) => l.valid && l.lapTime > 0).map((l) => l.lapTime);
  if (valid.length < 2) return null;
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  const variance = valid.reduce((a, b) => a + (b - mean) ** 2, 0) / valid.length;
  const std = Math.sqrt(variance);
  return { count: valid.length, mean, std, best: Math.min(...valid), spread: Math.max(...valid) - Math.min(...valid) };
}

function fmtPct(d) {
  return `${Math.round(d * 100)}%`;
}
function fmtT(s) {
  const sign = s >= 0 ? "+" : "−";
  return `${sign}${Math.abs(s).toFixed(2)}s`;
}

// Analiza una vuelta contra la mejor. Devuelve { deltaTotal, deltaTrace, tips }.
export function analyzeLap(best, lap) {
  if (!best || !lap || !best.samples || !lap.samples) {
    return { deltaTotal: null, deltaTrace: [], tips: [] };
  }
  const n = Math.min(best.samples.length, lap.samples.length);
  const trace = buildDeltaTrace(best, lap);
  const deltaTotal = (lap.lapTime && best.lapTime) ? lap.lapTime - best.lapTime : (trace.length ? trace[trace.length - 1].delta : null);

  // Pérdida de tiempo por zona = delta al final - delta al inicio de la zona.
  const zoneSize = Math.floor(n / ZONES) || 1;
  const zones = [];
  for (let z = 0; z < ZONES; z++) {
    const a = z * zoneSize;
    const b = z === ZONES - 1 ? n - 1 : (z + 1) * zoneSize;
    const da = trace[a]?.delta ?? 0;
    const db = trace[b]?.delta ?? da;
    zones.push({ z, a, b, loss: db - da });
  }

  // Top zonas donde perdés tiempo (loss positivo).
  const worst = zones.filter((zz) => zz.loss > 0.04).sort((x, y) => y.loss - x.loss).slice(0, 3);

  const tips = [];
  for (const zz of worst) {
    const posPct = (zz.a / n + zz.b / n) / 2;
    const sub = [];
    // Análisis de inputs dentro de la zona (más un poco de "approach" antes).
    const from = Math.max(0, zz.a - zoneSize);
    const to = zz.b;

    // Punto de frenada: primer bucket con brake > 0.25.
    const brakeOnset = (l) => {
      for (let i = from; i <= to; i++) { const s = at(l, i); if (s && s.br > 0.25) return i; }
      return -1;
    };
    const boBest = brakeOnset(best);
    const boLap = brakeOnset(lap);
    if (boBest >= 0 && boLap >= 0) {
      const diff = boLap - boBest; // buckets
      if (Math.abs(diff) >= 2) {
        sub.push(diff > 0
          ? "frenás más tarde que en tu mejor vuelta (podés estar pasándote de largo)"
          : "frenás antes que en tu mejor vuelta (perdés velocidad de más)");
      }
    }

    // Velocidad mínima (apex) en la zona.
    const minSpeed = (l) => {
      let m = Infinity, idx = -1;
      for (let i = zz.a; i <= to; i++) { const s = at(l, i); if (s && s.sp != null && s.sp < m) { m = s.sp; idx = i; } }
      return { m, idx };
    };
    const msBest = minSpeed(best);
    const msLap = minSpeed(lap);
    if (isFinite(msBest.m) && isFinite(msLap.m)) {
      const dv = (msLap.m - msBest.m) * MS_TO_KMH;
      if (dv < -3) sub.push(`menor velocidad de paso por curva (${Math.round(msLap.m * MS_TO_KMH)} vs ${Math.round(msBest.m * MS_TO_KMH)} km/h)`);
    }

    // Reanudación del acelerador: primer bucket con throttle > 0.9 tras el apex.
    const throttleOn = (l, apexIdx) => {
      const start = apexIdx >= 0 ? apexIdx : zz.a;
      for (let i = start; i <= to; i++) { const s = at(l, i); if (s && s.th > 0.9) return i; }
      return -1;
    };
    const toBest = throttleOn(best, msBest.idx);
    const toLap = throttleOn(lap, msLap.idx);
    if (toBest >= 0 && toLap >= 0 && (toLap - toBest) >= 2) {
      sub.push("abrís el acelerador más tarde a la salida");
    }

    // Coasting: buckets sin gas ni freno.
    let coast = 0, total = 0;
    for (let i = zz.a; i <= to; i++) {
      const s = at(lap, i);
      if (s) { total++; if ((s.th ?? 0) < 0.05 && (s.br ?? 0) < 0.05) coast++; }
    }
    const coastPct = total > 0 ? coast / total : 0;
    if (coastPct > 0.25) sub.push(`vas en "coasting" (sin gas ni freno) en ~${Math.round(coastPct * 100)}% del tramo`);

    tips.push({
      severity: zz.loss > 0.2 ? "high" : zz.loss > 0.1 ? "med" : "low",
      posPct,
      loss: zz.loss,
      text: sub.length > 0
        ? `En ~${fmtPct(posPct)} de la vuelta perdés ${fmtT(zz.loss)}: ${sub.join("; ")}.`
        : `En ~${fmtPct(posPct)} de la vuelta perdés ${fmtT(zz.loss)} (revisá línea y ritmo en este tramo).`,
    });
  }

  if (tips.length === 0 && deltaTotal != null && deltaTotal <= 0.05) {
    tips.push({ severity: "low", posPct: 0, loss: 0, text: "Vuelta muy pareja a tu mejor referencia. Buen trabajo — buscá micro-ganancias en frenadas y salidas." });
  }

  return { deltaTotal, deltaTrace: trace, tips };
}

// Devuelve la mejor vuelta válida de una sesión (con muestras).
export function bestLapOf(session) {
  if (!session || !session.laps) return null;
  return session.laps
    .filter((l) => l.valid && l.lapTime > 0 && Array.isArray(l.samples))
    .reduce((best, l) => (best == null || l.lapTime < best.lapTime ? l : best), null);
}
