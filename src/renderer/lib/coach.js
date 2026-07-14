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

// Muestra en el bucket b, o la más cercana con dato (búsqueda hacia afuera).
function nearestSample(lap, b) {
  const n = lap?.samples?.length || 0;
  for (let d = 0; d < n; d++) {
    const a = at(lap, b - d);
    if (a) return a;
    const c = at(lap, b + d);
    if (c) return c;
  }
  return null;
}
function tAtBucket(lap, b) {
  // Busca hacia afuera la muestra más cercana que tenga tiempo (t) válido —
  // no basta con que exista la muestra (puede tener posición sin tiempo).
  const n = lap?.samples?.length || 0;
  for (let d = 0; d < n; d++) {
    const a = at(lap, b - d); if (a && a.t != null) return a.t;
    const c = at(lap, b + d); if (c && c.t != null) return c.t;
  }
  return null;
}

// Límites de sectores en índices de bucket. sectorPcts = puntos interiores
// (ej [0.33, 0.66]) → sectores [0,0.33), [0.33,0.66), [0.66,1].
function sectorBoundaries(sectorPcts, n) {
  const pts = Array.isArray(sectorPcts) && sectorPcts.length ? sectorPcts : [1 / 3, 2 / 3];
  const bounds = [0, ...pts.map((p) => Math.round(p * n)), n - 1];
  return bounds;
}

// Tiempos por sector de una vuelta, derivados del tiempo-a-distancia (t).
export function sectorTimes(lap, sectorPcts) {
  if (!lap || !lap.samples) return null;
  const n = lap.samples.length;
  const b = sectorBoundaries(sectorPcts, n);
  const out = [];
  for (let i = 0; i < b.length - 1; i++) {
    // El primer sector arranca en la meta (t=0), no en el bucket 0 (que puede
    // no tener dato). Los demás usan el tiempo acumulado en el límite anterior.
    const t0 = i === 0 ? 0 : tAtBucket(lap, b[i]);
    const t1 = tAtBucket(lap, b[i + 1]);
    // El último sector cierra en meta: usamos lapTime como t final.
    const tEnd = i === b.length - 2 ? (lap.lapTime || t1) : t1;
    out.push(t0 != null && tEnd != null && tEnd > t0 ? tEnd - t0 : null);
  }
  return out;
}

// Mejor tiempo por sector de toda la sesión + vuelta óptima (suma de los mejores).
export function sessionOptimal(session, pctsOverride) {
  if (!session || !session.laps) return null;
  const pcts = pctsOverride || session.sectorPcts;
  const valid = session.laps.filter((l) => l.valid && l.lapTime > 0 && Array.isArray(l.samples));
  if (valid.length === 0) return null;
  const nSectors = (Array.isArray(pcts) ? pcts.length : 2) + 1;
  const best = new Array(nSectors).fill(null);
  for (const l of valid) {
    const st = sectorTimes(l, pcts);
    if (!st) continue;
    st.forEach((v, i) => { if (v != null && (best[i] == null || v < best[i])) best[i] = v; });
  }
  const complete = best.every((v) => v != null);
  return { bestPerSector: best, optimalLap: complete ? best.reduce((a, b) => a + b, 0) : null };
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

    // Subviraje (proxy): en el apex, más ángulo de volante que la referencia
    // pero MENOS G lateral (usás menos agarre) → el auto no gira / entrás apretado.
    const apexLap = at(lap, msLap.idx);
    const apexRef = at(best, msBest.idx);
    if (apexLap && apexRef && apexLap.st != null && apexRef.st != null) {
      const moreSteer = Math.abs(apexLap.st) > Math.abs(apexRef.st) * 1.2 + 0.02;
      const lessGrip = apexLap.gLat != null && apexRef.gLat != null
        ? Math.abs(apexLap.gLat) < Math.abs(apexRef.gLat) - 0.2
        : true;
      if (moreSteer && lessGrip) sub.push("metés más volante que la referencia (posible subviraje / entrada apretada)");
    }

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

  const insights = buildInsights(lap);

  return { deltaTotal, deltaTrace: trace, tips, insights };
}

// Insights globales de la vuelta (no atados a un tramo): cambios de marcha,
// trail-braking y correcciones de volante. Usan solo canales confiables.
function buildInsights(lap) {
  const out = [];
  const S = lap.samples;
  const n = S.length;

  // Recorremos las muestras válidas en orden.
  const seq = [];
  for (let i = 0; i < n; i++) if (S[i]) seq.push(S[i]);
  if (seq.length < 10) return out;

  // Shifting: RPM en cada upshift vs RPM máxima de la vuelta.
  let maxRpm = 0;
  for (const s of seq) if ((s.rpm || 0) > maxRpm) maxRpm = s.rpm || 0;
  const shiftRpms = [];
  for (let i = 1; i < seq.length; i++) {
    if (seq[i].g != null && seq[i - 1].g != null && seq[i].g > seq[i - 1].g && seq[i].g > 0 && seq[i - 1].g > 0) {
      shiftRpms.push(seq[i - 1].rpm || 0);
    }
  }
  if (shiftRpms.length >= 2 && maxRpm > 0) {
    const avg = shiftRpms.reduce((a, b) => a + b, 0) / shiftRpms.length;
    if (avg < maxRpm * 0.88) {
      out.push({ type: "shifting", text: `Cambiás con RPM bajas (promedio ~${Math.round(avg)} vs pico ~${Math.round(maxRpm)}): estirá más las marchas para no perder aceleración.` });
    }
  }

  // Trail-braking: de los frames frenando, cuántos con volante girado.
  let braking = 0, trail = 0;
  for (const s of seq) {
    if ((s.br ?? 0) > 0.1) { braking++; if (Math.abs(s.st ?? 0) > 0.15) trail++; }
  }
  if (braking > 15) {
    const pct = trail / braking;
    if (pct < 0.12) out.push({ type: "trail", text: "Casi no hacés trail-braking: soltás el freno antes de girar. Probá arrastrar un toque de freno en la entrada para rotar el auto." });
  }

  // Correcciones de volante: reversiones bruscas de dirección (auto inestable).
  let reversals = 0;
  for (let i = 2; i < seq.length; i++) {
    const d1 = (seq[i - 1].st ?? 0) - (seq[i - 2].st ?? 0);
    const d2 = (seq[i].st ?? 0) - (seq[i - 1].st ?? 0);
    if (d1 * d2 < 0 && Math.abs(d2) > 0.06) reversals++;
  }
  if (reversals > seq.length * 0.12) {
    out.push({ type: "corrections", text: "Muchas correcciones de volante: el auto viene inestable (posible sobreviraje o entradas sucias). Suavizá manos y frenada." });
  }

  return out;
}

// Devuelve la mejor vuelta válida de una sesión (con muestras).
export function bestLapOf(session) {
  if (!session || !session.laps) return null;
  return session.laps
    .filter((l) => l.valid && l.lapTime > 0 && Array.isArray(l.samples))
    .reduce((best, l) => (best == null || l.lapTime < best.lapTime ? l : best), null);
}
