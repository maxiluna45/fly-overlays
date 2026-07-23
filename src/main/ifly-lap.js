const fs = require('fs');

// Formato nativo de iFly para compartir UNA vuelta como ghost/referencia.
// Estructura de sesión de salida idéntica a la de csv-parser/ibt-parser para
// reusar todo el render del análisis (una sesión con una sola vuelta).
const IFLY_LAP_VERSION = 1;

function buildIflyLap(lap, session, meta = {}) {
  if (!lap) throw new Error('buildIflyLap: falta la vuelta');
  const s = session || {};
  return {
    format: 'iflylap',
    version: IFLY_LAP_VERSION,
    track: s.track || null,
    trackKey: s.trackKey || null,
    trackIdIr: s.trackIdIr ?? null,
    carIdIr: s.carIdIr ?? null,
    car: s.car || null,
    sessionType: s.sessionType || null,
    trackLength: s.trackLength ?? null,
    sectorPcts: Array.isArray(s.sectorPcts) ? s.sectorPcts : null,
    lap: {
      lap: lap.lap ?? 1,
      lapTime: lap.lapTime ?? 0,
      valid: lap.valid !== false,
      sectors: lap.sectors ?? null,
      micros: lap.micros ?? null,
      samples: Array.isArray(lap.samples) ? lap.samples : [],
    },
    meta: {
      driver: meta.driver || '',
      exportedAt: meta.exportedAt || 0,
      appVersion: meta.appVersion || '',
    },
  };
}

function parseIflyLapText(text) {
  let o;
  try { o = JSON.parse(text); } catch (_) { throw new Error('.iflylap no es JSON válido'); }
  if (!o || o.format !== 'iflylap') throw new Error('Archivo con formato desconocido (no es .iflylap)');
  if (o.version !== IFLY_LAP_VERSION) throw new Error(`Versión de .iflylap no soportada: ${o.version}`);
  if (!o.lap || !Array.isArray(o.lap.samples)) throw new Error('.iflylap sin muestras de vuelta');
  const lap = {
    lap: o.lap.lap ?? 1,
    lapTime: o.lap.lapTime ?? 0,
    valid: o.lap.valid !== false,
    sectors: o.lap.sectors ?? null,
    micros: o.lap.micros ?? null,
    samples: o.lap.samples,
    source: 'ifly',
    label: o.meta && o.meta.driver ? o.meta.driver : (o.track || 'iflylap'),
  };
  return {
    track: o.track || 'iflylap',
    trackKey: o.trackKey || null,
    trackIdIr: o.trackIdIr ?? null,
    carIdIr: o.carIdIr ?? null,
    car: o.car || 'iFly',
    sessionType: o.sessionType || 'Import',
    sectorPcts: Array.isArray(o.sectorPcts) ? o.sectorPcts : null,
    trackLength: o.trackLength ?? null,
    startedAt: (o.meta && o.meta.exportedAt) || 0,
    laps: [lap],
  };
}

function parseIflyLapSession(filePath) {
  const text = fs.readFileSync(filePath, 'utf-8');
  const s = parseIflyLapText(text);
  if (!s.startedAt) {
    try { s.startedAt = Math.floor(fs.statSync(filePath).mtimeMs); } catch (_) {}
  }
  return s;
}

module.exports = { buildIflyLap, parseIflyLapText, parseIflyLapSession, IFLY_LAP_VERSION };
