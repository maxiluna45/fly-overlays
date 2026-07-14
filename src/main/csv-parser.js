const fs = require('fs');
const path = require('path');

// Parser de CSV de telemetría (ej: export de una vuelta de Garage 61, o de
// cualquier herramienta que exporte canales por muestra). Lo convertimos a la
// MISMA estructura de lap por distancia (200 bins) que el resto del análisis,
// para usarlo como referencia "ghost".
//
// Columnas reconocidas (con alias): LapDistPct (obligatoria), Speed (m/s),
// Throttle, Brake, SteeringWheelAngle, Gear, RPM, LatAccel, LongAccel, Yaw,
// Lat, Lon, y una columna de tiempo (SessionTime / LapCurrentLapTime / Time).

const BUCKETS = 400; // resolución de la trazada por distancia (mejor detalle en curvas)

function csvToLap(csvText, meta = {}) {
  const lines = csvText.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return null;
  const header = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  const idx = {};
  header.forEach((h, i) => { idx[h] = i; });
  const col = (names) => {
    for (const nm of names) if (idx[nm] != null) return idx[nm];
    return -1;
  };
  const cPct = col(['LapDistPct', 'LapDist%', 'lapDistPct']);
  const cSp = col(['Speed', 'speed']);
  const cTh = col(['Throttle', 'throttle']);
  const cBr = col(['Brake', 'brake']);
  const cSt = col(['SteeringWheelAngle', 'Steering', 'Steer', 'steeringWheelAngle']);
  const cG = col(['Gear', 'gear']);
  const cRpm = col(['RPM', 'Rpm', 'rpm']);
  const cGLat = col(['LatAccel', 'latAccel']);
  const cGLon = col(['LongAccel', 'longAccel']);
  const cYaw = col(['YawRate', 'Yaw', 'yaw']);
  const cLat = col(['Lat', 'lat']);
  const cLon = col(['Lon', 'lon']);
  const cT = col(['SessionTime', 'LapCurrentLapTime', 'Time', 'time', 'sessionTime']);
  if (cPct < 0) return null; // sin distancia no podemos alinear por pista

  const buckets = new Array(BUCKETS).fill(null);
  const num = (row, c) => {
    if (c < 0 || c >= row.length) return null;
    const v = parseFloat(row[c]);
    return isFinite(v) ? v : null;
  };
  let t0 = null, maxT = 0, filled = 0;
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(',');
    if (row.length < 2) continue;
    let pct = num(row, cPct);
    if (pct == null) continue;
    if (pct > 1) pct = pct / 100; // si viene en %
    if (pct < 0 || pct > 1) continue;
    let t = num(row, cT);
    if (t != null) { if (t0 == null) t0 = t; t = t - t0; if (t > maxT) maxT = t; }
    const b = Math.min(BUCKETS - 1, Math.max(0, Math.floor(pct * BUCKETS)));
    if (buckets[b] == null) filled++;
    buckets[b] = {
      th: num(row, cTh), br: num(row, cBr), st: num(row, cSt), sp: num(row, cSp),
      g: (num(row, cG) || 0) | 0, rpm: Math.round(num(row, cRpm) || 0), t,
      gLat: num(row, cGLat), gLon: num(row, cGLon), yaw: num(row, cYaw),
      lat: num(row, cLat), lon: num(row, cLon),
    };
  }
  if (filled < BUCKETS * 0.35) return null; // cobertura mínima (con 400 buckets)

  // Sin columna de tiempo (caso de los CSV de Garage 61): reconstruimos el
  // tiempo-a-distancia integrando 1/velocidad sobre la distancia y escalándolo
  // al lapTime (que viene en el nombre del archivo). Física: tiempo = ∫ ds/v;
  // con bins de distancia iguales, t_i ∝ Σ (Δp / v). El escalado al lapTime
  // corrige la constante de largo de pista → queda en segundos reales.
  const hasTime = cT >= 0 && t0 != null;
  if (!hasTime && meta.lapTime > 0) {
    let raw = 0;
    const rawArr = new Array(BUCKETS).fill(0);
    for (let i = 0; i < BUCKETS; i++) {
      const b = buckets[i];
      if (b && b.sp != null && b.sp > 0.1) raw += (1 / BUCKETS) / b.sp;
      rawArr[i] = raw;
    }
    const rawTotal = raw || 1;
    for (let i = 0; i < BUCKETS; i++) {
      if (buckets[i]) buckets[i].t = Math.round(meta.lapTime * (rawArr[i] / rawTotal) * 1000) / 1000;
    }
    maxT = meta.lapTime;
  }

  const lapTime = meta.lapTime > 0 ? meta.lapTime : (maxT > 0 ? maxT : 0);
  return {
    lap: meta.lapNumber || 1,
    lapTime,
    valid: true,
    sectors: null,
    micros: null,
    samples: buckets,
    source: 'csv',
    label: meta.label,
  };
}

// Lap time desde un string tipo "MM.SS.mmm" (ej "00.52.837" → 52.837s).
function lapTimeFromStr(s) {
  const m = (s || '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + parseInt(m[3], 10) / 1000;
  return 0;
}

// Nombre de export de Garage 61: "Garage 61 - Driver - Car - Track - MM.SS.mmm - id".
// Devuelve { driver, car, track, lapTime } o null si no matchea ese formato.
function parseG61Name(base) {
  const parts = base.split(' - ');
  if (parts[0] && parts[0].toLowerCase().startsWith('garage 61') && parts.length >= 5) {
    return { driver: parts[1] || '', car: parts[2] || 'CSV', track: parts[3] || base, lapTime: lapTimeFromStr(parts[4]) };
  }
  return null;
}

function csvMetaFromName(filePath) {
  const base = path.basename(filePath).replace(/\.csv$/i, '');
  const g = parseG61Name(base);
  if (g) return { track: g.track, car: g.car, sessionType: g.driver || 'Import', lapTime: g.lapTime };
  return { track: base, car: 'CSV', sessionType: 'Import', lapTime: 0 };
}

// Metadata liviana para el listado.
function parseCsvMeta(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const m = csvMetaFromName(filePath);
    return { track: m.track, car: m.car, sessionType: m.sessionType, startedAt: Math.floor(stat.mtimeMs), lapCount: 1, bestLap: m.lapTime > 0 ? m.lapTime : null };
  } catch (_) { return null; }
}

// Parse completo → sesión con una sola vuelta, lista para el análisis.
function parseCsvSession(filePath) {
  const stat = fs.statSync(filePath);
  const text = fs.readFileSync(filePath, 'utf-8');
  const m = csvMetaFromName(filePath);
  const lap = csvToLap(text, { label: m.track, lapNumber: 1, lapTime: m.lapTime });
  if (!lap) throw new Error('CSV sin columnas de telemetría reconocibles (falta LapDistPct)');
  return {
    track: m.track,
    car: m.car,
    sessionType: m.sessionType,
    sectorPcts: null,
    trackLength: null,
    startedAt: Math.floor(stat.mtimeMs),
    laps: [lap],
  };
}

module.exports = { csvToLap, parseCsvMeta, parseCsvSession };
