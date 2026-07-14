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

function fmtT(s) {
  const sign = s >= 0 ? "+" : "−";
  return `${sign}${Math.abs(s).toFixed(2)}s`;
}
// Diferencia de buckets → metros (si conocemos el largo de pista).
function bucketsToMeters(db, n, trackLength) {
  if (!trackLength || trackLength <= 0 || n <= 1) return null;
  return (db / n) * trackLength;
}
// Primer bucket frenando fuerte (>0.25) en [from,to].
function firstBrake(l, from, to) {
  for (let i = from; i <= to; i++) { const s = at(l, i); if (s && (s.br ?? 0) > 0.25) return i; }
  return -1;
}
// Velocidad mínima (apex) en [from,to].
function minSpeedIn(l, from, to) {
  let m = Infinity, idx = -1;
  for (let i = from; i <= to; i++) { const s = at(l, i); if (s && s.sp != null && s.sp < m) { m = s.sp; idx = i; } }
  return { m, idx };
}
// Primer bucket a fondo (>0.9) desde `start` hasta `to`.
function firstFullThrottle(l, start, to) {
  for (let i = Math.max(0, start); i <= to; i++) { const s = at(l, i); if (s && (s.th ?? 0) > 0.9) return i; }
  return -1;
}

// Zonas de análisis: una por CURVA real (con su nombre), abarcando desde el
// punto medio con la curva anterior hasta el punto medio con la siguiente
// (frenada → apex → salida). Si no hay curvas, detecta zonas de frenada.
function buildSegments(lap, n, corners) {
  if (Array.isArray(corners) && corners.length) {
    const cs = corners.filter((c) => c && c.pct != null).slice().sort((a, b) => a.pct - b.pct);
    return cs.map((c, i) => {
      const prev = i > 0 ? cs[i - 1].pct : c.pct - 0.05;
      const next = i < cs.length - 1 ? cs[i + 1].pct : c.pct + 0.05;
      return {
        label: c.label,
        a: Math.max(0, Math.round(((prev + c.pct) / 2) * (n - 1))),
        apex: Math.round(c.pct * (n - 1)),
        b: Math.min(n - 1, Math.round(((c.pct + next) / 2) * (n - 1))),
      };
    });
  }
  // Fallback: zonas de frenada detectadas.
  const zones = [];
  let i = 0;
  while (i < n) {
    const s = at(lap, i);
    if (s && (s.br ?? 0) > 0.3) {
      const start = i; let j = i;
      while (j < n && (() => { const x = at(lap, j); return x && (x.br ?? 0) > 0.15; })()) j++;
      zones.push({ label: `Frenada ${zones.length + 1}`, a: Math.max(0, start - Math.round(n * 0.01)), apex: null, b: Math.min(n - 1, j + Math.round(n * 0.06)) });
      i = j + 1;
    } else i++;
  }
  return zones;
}

// Detalle de una zona: fase donde perdés (entrada/apex/salida) + causas concretas.
function segmentDetail(best, lap, seg, n, trackLength, deltaAt) {
  const from = seg.a, to = seg.b;
  const causes = [];

  // Punto de frenada (en metros si se puede).
  const boB = firstBrake(best, from, to), boL = firstBrake(lap, from, to);
  if (boB >= 0 && boL >= 0) {
    const dm = bucketsToMeters(boL - boB, n, trackLength);
    if (dm != null && Math.abs(dm) >= 5) causes.push(dm > 0 ? `frenás ${Math.round(dm)} m más tarde` : `frenás ${Math.round(-dm)} m antes (perdés velocidad)`);
    else if (dm == null && Math.abs(boL - boB) >= 3) causes.push(boL > boB ? "frenás más tarde" : "frenás antes");
  }

  // Velocidad mínima (apex).
  const msB = minSpeedIn(best, from, to), msL = minSpeedIn(lap, from, to);
  if (isFinite(msB.m) && isFinite(msL.m)) {
    const dv = (msL.m - msB.m) * MS_TO_KMH;
    if (dv < -2) causes.push(`velocidad mínima ${Math.round(msL.m * MS_TO_KMH)} vs ${Math.round(msB.m * MS_TO_KMH)} km/h`);
  }

  // Reaplicación de gas a la salida.
  const apexB = msB.idx >= 0 ? msB.idx : from, apexL = msL.idx >= 0 ? msL.idx : from;
  const tOnB = firstFullThrottle(best, apexB, to), tOnL = firstFullThrottle(lap, apexL, to);
  if (tOnB >= 0 && tOnL >= 0) {
    const dm = bucketsToMeters(tOnL - tOnB, n, trackLength);
    if (dm != null && dm >= 5) causes.push(`abrís gas ${Math.round(dm)} m tarde a la salida`);
    else if (dm == null && tOnL - tOnB >= 3) causes.push("abrís gas tarde a la salida");
  }

  // Coasting (sin gas ni freno) en la zona.
  let coast = 0, tot = 0;
  for (let i = from; i <= to; i++) { const s = at(lap, i); if (s) { tot++; if ((s.th ?? 0) < 0.05 && (s.br ?? 0) < 0.05) coast++; } }
  if (tot > 0 && coast / tot > 0.3) causes.push(`vas "coasting" (sin gas ni freno) en ~${Math.round((coast / tot) * 100)}% de la zona`);

  // Subviraje (proxy) en el apex: más volante pero menos G lateral que la ref.
  const aL = at(lap, apexL), aB = at(best, apexB);
  if (aL && aB && aL.st != null && aB.st != null) {
    const moreSteer = Math.abs(aL.st) > Math.abs(aB.st) * 1.2 + 0.02;
    const lessGrip = aL.gLat != null && aB.gLat != null ? Math.abs(aL.gLat) < Math.abs(aB.gLat) - 0.2 : true;
    if (moreSteer && lessGrip) causes.push("metés más volante con menos agarre (subviraje / entrada apretada)");
  }

  // Fase donde se concentra la pérdida: entrada (frenada) vs salida (tracción).
  const apex = seg.apex != null ? seg.apex : Math.round((from + to) / 2);
  const lossEntry = deltaAt(apex) - deltaAt(from);
  const lossExit = deltaAt(to) - deltaAt(apex);
  let phase = null;
  if (lossEntry > 0.02 || lossExit > 0.02) {
    if (lossExit > lossEntry * 1.4) phase = "salida";
    else if (lossEntry > lossExit * 1.4) phase = "entrada/frenada";
    else phase = "apex";
  }

  return { causes: causes.slice(0, 3), phase };
}

// Analiza una vuelta contra la referencia, anclando a curvas reales.
// opts: { corners: [{pct,label}], trackLength: metros }.
export function analyzeLap(best, lap, opts = {}) {
  if (!best || !lap || !best.samples || !lap.samples) {
    return { deltaTotal: null, deltaTrace: [], tips: [], insights: [], headline: null };
  }
  const n = Math.min(best.samples.length, lap.samples.length);
  const trace = buildDeltaTrace(best, lap);
  const deltaTotal = (lap.lapTime && best.lapTime) ? lap.lapTime - best.lapTime : (trace.length ? trace[trace.length - 1].delta : null);
  const trackLength = opts.trackLength || 0;
  const deltaAt = (i) => trace[Math.max(0, Math.min(trace.length - 1, i))]?.delta ?? 0;

  const segments = buildSegments(lap, n, opts.corners);
  for (const s of segments) s.loss = deltaAt(s.b) - deltaAt(s.a);

  // Curvas/zonas donde MÁS perdés (top 4).
  const worst = segments.filter((s) => s.loss > 0.03).sort((x, y) => y.loss - x.loss).slice(0, 4);

  const tips = [];
  for (const seg of worst) {
    const d = segmentDetail(best, lap, seg, n, trackLength, deltaAt);
    tips.push({
      severity: seg.loss > 0.25 ? "high" : seg.loss > 0.1 ? "med" : "low",
      loss: seg.loss,
      label: seg.label,
      text: `${seg.label} · ${fmtT(seg.loss)}${d.phase ? ` (${d.phase})` : ""} — ${d.causes.length ? d.causes.join("; ") : "revisá línea y ritmo"}.`,
    });
  }

  if (tips.length === 0 && deltaTotal != null && deltaTotal <= 0.05) {
    tips.push({ severity: "low", loss: 0, text: "Vuelta muy pareja a tu referencia. Buen trabajo — buscá micro-ganancias en frenadas y salidas." });
  }

  const headline = worst.length
    ? { label: worst[0].label, loss: worst[0].loss, total: worst.reduce((a, s) => a + s.loss, 0) }
    : null;

  const insights = buildInsights(lap);
  return { deltaTotal, deltaTrace: trace, tips, insights, headline };
}

// (#6) Consistencia POR CURVA sobre las vueltas válidas: en qué curva variás más
// entre vueltas (ahí hay tiempo fácil ganando repetibilidad).
export function cornerConsistency(session, opts = {}) {
  const corners = (opts.corners || []).filter((c) => c && c.pct != null).slice().sort((a, b) => a.pct - b.pct);
  if (!session || !session.laps || !corners.length) return null;
  const valid = session.laps.filter((l) => l.valid && l.lapTime > 0 && Array.isArray(l.samples));
  if (valid.length < 3) return null;
  const n = valid[0].samples.length;
  const per = corners.map((c, i) => {
    const prev = i > 0 ? corners[i - 1].pct : c.pct - 0.05;
    const next = i < corners.length - 1 ? corners[i + 1].pct : c.pct + 0.05;
    const a = Math.max(0, Math.round(((prev + c.pct) / 2) * (n - 1)));
    const b = Math.min(n - 1, Math.round(((c.pct + next) / 2) * (n - 1)));
    const times = [];
    for (const l of valid) { const t0 = tAtBucket(l, a), t1 = tAtBucket(l, b); if (t0 != null && t1 != null && t1 > t0) times.push(t1 - t0); }
    if (times.length < 3) return null;
    const mean = times.reduce((x, y) => x + y, 0) / times.length;
    const std = Math.sqrt(times.reduce((x, y) => x + (y - mean) ** 2, 0) / times.length);
    return { label: c.label, std, mean };
  }).filter(Boolean);
  if (!per.length) return null;
  per.sort((x, y) => y.std - x.std);
  return { worst: per[0], perCorner: per };
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
