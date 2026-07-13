const fs = require('fs');
const path = require('path');
const { parseSessionInfo } = require('./session-parser');

// Parser de archivos .ibt (telemetría en disco de iRacing).
// Formato binario (ver irsdk_defines.h del SDK oficial):
//   [header 112B] → [varHeaders numVars×144B] → [sessionInfo YAML] → [muestras]
// Cada muestra es un registro de `bufLen` bytes; cada variable vive en un
// offset fijo dentro del registro. Extraemos SOLO los canales del player y los
// agrupamos por vuelta, downsampleados a 200 bins por distancia — la MISMA
// estructura que produce SessionRecorder, para reusar el análisis y el coach.

const BUCKETS = 200;
const MAX_LAPS = 300;
const MAX_FILE_BYTES = 300 * 1024 * 1024; // 300 MB — más que eso lo salteamos

// Tamaños por tipo de variable irsdk.
const TYPE_SIZE = [1, 1, 4, 4, 4, 8]; // char, bool, int, bitField, float, double

function readHeader(buf) {
  return {
    ver: buf.readInt32LE(0),
    sessionInfoLen: buf.readInt32LE(16),
    sessionInfoOffset: buf.readInt32LE(20),
    numVars: buf.readInt32LE(24),
    varHeaderOffset: buf.readInt32LE(28),
    numBuf: buf.readInt32LE(32),
    bufLen: buf.readInt32LE(36),
    bufOffset: buf.readInt32LE(52), // varBuf[0].bufOffset
  };
}

function readVarHeaders(buf, h) {
  const vars = {};
  for (let i = 0; i < h.numVars; i++) {
    const base = h.varHeaderOffset + i * 144;
    if (base + 144 > buf.length) break;
    const type = buf.readInt32LE(base);
    const offset = buf.readInt32LE(base + 4);
    const count = buf.readInt32LE(base + 8);
    let name = buf.toString('utf8', base + 16, base + 48);
    const nul = name.indexOf('\0');
    if (nul >= 0) name = name.slice(0, nul);
    vars[name] = { type, offset, count };
  }
  return vars;
}

function readVar(buf, base, vh) {
  if (!vh) return null;
  const o = base + vh.offset;
  if (o + (TYPE_SIZE[vh.type] || 4) > buf.length) return null;
  switch (vh.type) {
    case 0: return buf.readInt8(o);
    case 1: return buf.readUInt8(o);
    case 2: return buf.readInt32LE(o);
    case 3: return buf.readInt32LE(o);
    case 4: return buf.readFloatLE(o);
    case 5: return buf.readDoubleLE(o);
    default: return null;
  }
}

function round2(v) { return v == null || !isFinite(v) ? null : Math.round(v * 100) / 100; }
function round3(v) { return v == null || !isFinite(v) ? null : Math.round(v * 1000) / 1000; }

// Extrae track / car / tipo de sesión del YAML (o del nombre de archivo).
function metaFromSessionInfo(yamlStr, fileName, sessionNum) {
  const meta = { track: null, car: null, sessionType: null };
  const parsed = parseSessionInfo(yamlStr);
  if (parsed) {
    meta.track = parsed?.WeekendInfo?.TrackDisplayName || parsed?.WeekendInfo?.TrackName || null;
    try {
      const idx = parsed?.DriverInfo?.DriverCarIdx;
      const drivers = parsed?.DriverInfo?.Drivers || [];
      const me = drivers.find((d) => d.CarIdx === idx) || drivers[0];
      if (me) meta.car = me.CarScreenName || me.CarPath || null;
    } catch (_) {}
    try {
      const sessions = parsed?.SessionInfo?.Sessions || [];
      const s = sessions.find((x) => x.SessionNum === sessionNum) || (sessionNum != null ? sessions[sessionNum] : null) || sessions[sessions.length - 1];
      if (s) meta.sessionType = s.SessionType || s.SessionName || null;
    } catch (_) {}
  }
  // Fallbacks desde el nombre de archivo (ej: "car_track 2024-01-01 20h00m00s.ibt").
  if (!meta.track) meta.track = fileName.replace(/\.ibt$/i, '');
  if (!meta.car) meta.car = 'iRacing';
  if (!meta.sessionType) meta.sessionType = 'Session';
  return meta;
}

// Lee solo header + sessionInfo (rápido) para el listado. No recorre muestras.
function parseIbtMeta(filePath) {
  let fd;
  try {
    const stat = fs.statSync(filePath);
    fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(112);
    fs.readSync(fd, head, 0, 112, 0);
    const h = readHeader(head);
    let yamlStr = '';
    if (h.sessionInfoLen > 0 && h.sessionInfoLen < 4 * 1024 * 1024) {
      const si = Buffer.alloc(h.sessionInfoLen);
      fs.readSync(fd, si, 0, h.sessionInfoLen, h.sessionInfoOffset);
      yamlStr = si.toString('utf8').replace(/\0+$/g, '');
    }
    const fileName = path.basename(filePath);
    const meta = metaFromSessionInfo(yamlStr, fileName, null);
    return {
      track: meta.track,
      car: meta.car,
      sessionType: meta.sessionType,
      startedAt: Math.floor(stat.mtimeMs),
      lapCount: null, // se conoce recién al abrir (parse completo)
      bestLap: null,
    };
  } catch (err) {
    return null;
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

// Parse completo: devuelve la sesión con vueltas + trazas, lista para el análisis.
function parseIbtSession(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`Archivo demasiado grande (${Math.round(stat.size / 1e6)} MB)`);
  }
  const buf = fs.readFileSync(filePath);
  const h = readHeader(buf);
  const vars = readVarHeaders(buf, h);

  const yamlStr = (h.sessionInfoLen > 0)
    ? buf.toString('utf8', h.sessionInfoOffset, h.sessionInfoOffset + h.sessionInfoLen).replace(/\0+$/g, '')
    : '';

  const V = {
    lap: vars['Lap'],
    pct: vars['LapDistPct'],
    curT: vars['LapCurrentLapTime'],
    lastT: vars['LapLastLapTime'],
    th: vars['Throttle'],
    br: vars['Brake'],
    st: vars['SteeringWheelAngle'],
    sp: vars['Speed'],
    g: vars['Gear'],
    rpm: vars['RPM'],
    onTrack: vars['IsOnTrack'],
    sessNum: vars['SessionNum'],
  };

  if (h.bufLen <= 0 || h.bufOffset <= 0) throw new Error('Header .ibt inválido');
  const numSamples = Math.floor((buf.length - h.bufOffset) / h.bufLen);

  const laps = [];
  let buckets = new Array(BUCKETS).fill(null);
  let bucketCount = 0;
  let maxT = 0;
  let prevLap = null;
  let sessionNumSeen = null;

  const finalize = (lapNum, lapLast) => {
    const coverage = bucketCount / BUCKETS;
    const lapTime = lapLast > 0 ? lapLast : (maxT > 0 ? maxT : 0);
    if (lapTime > 0 && coverage >= 0.6) {
      laps.push({
        lap: lapNum,
        lapTime: round3(lapTime),
        valid: lapLast > 0, // .ibt no expone invalidación por límites; aprox.
        sectors: null,
        micros: null,
        samples: buckets.map((s) => s || null),
      });
      if (laps.length > MAX_LAPS) laps.shift();
    }
    buckets = new Array(BUCKETS).fill(null);
    bucketCount = 0;
    maxT = 0;
  };

  for (let s = 0; s < numSamples; s++) {
    const base = h.bufOffset + s * h.bufLen;
    const lap = readVar(buf, base, V.lap);
    if (lap == null) continue;
    const pct = readVar(buf, base, V.pct);
    const onTrack = V.onTrack ? readVar(buf, base, V.onTrack) : 1;
    if (sessionNumSeen == null && V.sessNum) sessionNumSeen = readVar(buf, base, V.sessNum);

    // Cruce de meta: se completó la vuelta prevLap.
    if (prevLap != null && lap > prevLap) {
      const lapLast = V.lastT ? (readVar(buf, base, V.lastT) || 0) : 0;
      finalize(prevLap, lapLast);
    }
    prevLap = lap;

    if (onTrack && pct != null && pct >= 0 && pct <= 1) {
      const t = readVar(buf, base, V.curT);
      if (t != null && t > maxT) maxT = t;
      const b = Math.min(BUCKETS - 1, Math.max(0, Math.floor(pct * BUCKETS)));
      if (buckets[b] == null) bucketCount++;
      buckets[b] = {
        th: round3(readVar(buf, base, V.th)),
        br: round3(readVar(buf, base, V.br)),
        st: round3(readVar(buf, base, V.st)),
        sp: round2(readVar(buf, base, V.sp)),
        g: (readVar(buf, base, V.g) | 0),
        rpm: Math.round(readVar(buf, base, V.rpm) || 0),
        t: round3(t),
      };
    }
  }

  const fileName = path.basename(filePath);
  const meta = metaFromSessionInfo(yamlStr, fileName, sessionNumSeen);

  return {
    track: meta.track,
    car: meta.car,
    sessionType: meta.sessionType,
    startedAt: Math.floor(stat.mtimeMs),
    laps,
  };
}

module.exports = { parseIbtMeta, parseIbtSession };
