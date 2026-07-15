const fs = require('fs');
const path = require('path');
const { parseSessionInfo, getSectorPoints, getTrackInfo } = require('./session-parser');

// Parser de archivos .ibt (telemetría en disco de iRacing).
// Formato binario (ver irsdk_defines.h del SDK oficial):
//   [header 112B] → [varHeaders numVars×144B] → [sessionInfo YAML] → [muestras]
// Cada muestra es un registro de `bufLen` bytes; cada variable vive en un
// offset fijo dentro del registro. Extraemos SOLO los canales del player y los
// agrupamos por vuelta, downsampleados a 200 bins por distancia — la MISMA
// estructura que produce SessionRecorder, para reusar el análisis y el coach.

const BUCKETS = 800; // resolución de la trazada por distancia (mejor detalle en curvas cerradas)
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
function round6(v) { return v == null || !isFinite(v) ? null : Math.round(v * 1e6) / 1e6; }

// Extrae track / car / tipo de sesión + sectores + largo del YAML (o del nombre).
function metaFromSessionInfo(yamlStr, fileName, sessionNum) {
  const meta = { track: null, trackKey: null, car: null, sessionType: null, sectorPcts: null, trackLength: null, bestLap: null, trackIdIr: null, carIdIr: null };
  const parsed = parseSessionInfo(yamlStr);
  if (parsed) {
    meta.track = parsed?.WeekendInfo?.TrackDisplayName || parsed?.WeekendInfo?.TrackName || null;
    // Nombre interno con config (ej. "snetterton 300") para emparejar mapa/curvas.
    meta.trackKey = parsed?.WeekendInfo?.TrackName
      || [parsed?.WeekendInfo?.TrackDisplayName, parsed?.WeekendInfo?.TrackConfigName].filter(Boolean).join(' ')
      || null;
    // IDs numéricos de iRacing (para mapear a Garage 61 por platform_id).
    const tid = parseInt(parsed?.WeekendInfo?.TrackID, 10);
    if (isFinite(tid)) meta.trackIdIr = tid;
    const idx = parsed?.DriverInfo?.DriverCarIdx;
    try {
      const drivers = parsed?.DriverInfo?.Drivers || [];
      const me = drivers.find((d) => d.CarIdx === idx) || drivers[0];
      if (me) {
        meta.car = me.CarScreenName || me.CarPath || null;
        const cid = parseInt(me.CarID, 10);
        if (isFinite(cid)) meta.carIdIr = cid;
      }
    } catch (_) {}
    try {
      const sessions = parsed?.SessionInfo?.Sessions || [];
      const s = sessions.find((x) => x.SessionNum === sessionNum) || (sessionNum != null ? sessions[sessionNum] : null) || sessions[sessions.length - 1];
      if (s) meta.sessionType = s.SessionType || s.SessionName || null;
      // Nota: ResultsPositions/ResultsFastestLap del YAML suelen NO incluir al
      // jugador (o listar el fastest de otro auto), así que el mejor tiempo se
      // calcula aparte muestreando LapLastLapTime en parseIbtMeta.
    } catch (_) {}
    try {
      const pts = getSectorPoints(parsed);
      if (Array.isArray(pts) && pts.length > 0) meta.sectorPcts = pts;
      const ti = getTrackInfo(parsed);
      if (ti && ti.length > 0) meta.trackLength = ti.length;
    } catch (_) {}
  }
  // Fallbacks desde el nombre de archivo (ej: "car_track 2024-01-01 20h00m00s.ibt").
  if (!meta.track) meta.track = fileName.replace(/\.ibt$/i, '');
  if (!meta.car) meta.car = 'iRacing';
  if (!meta.sessionType) meta.sessionType = 'Session';
  return meta;
}

// Lee header + sessionInfo + una muestra (rápido) para el listado. Leemos el
// SessionNum de la primera muestra para saber a QUÉ sesión (practice/qualy/race)
// corresponde el .ibt — el YAML lista todas las del fin de semana, y sin esto
// caeríamos siempre en la última (Race).
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
    // SessionNum (de la primera muestra) + mejor vuelta (mínimo LapLastLapTime).
    // Leemos varHeaders para ubicar los canales y muestreamos el buffer. El
    // mejor tiempo del jugador NO está fiable en el YAML de resultados, así que
    // lo sacamos de su telemetría real.
    let sessionNum = null, bestLap = null;
    const lapTimes = [];
    try {
      if (h.numVars > 0 && h.varHeaderOffset > 0 && h.bufLen > 0 && h.bufOffset > 0) {
        const vhBuf = Buffer.alloc(h.numVars * 144);
        fs.readSync(fd, vhBuf, 0, vhBuf.length, h.varHeaderOffset);
        let sn = null, vLast = null;
        for (let i = 0; i < h.numVars; i++) {
          const b = i * 144;
          if (b + 144 > vhBuf.length) break;
          let name = vhBuf.toString('utf8', b + 16, b + 48);
          const nul = name.indexOf('\0');
          if (nul >= 0) name = name.slice(0, nul);
          if (name === 'SessionNum') sn = { type: vhBuf.readInt32LE(b), offset: vhBuf.readInt32LE(b + 4) };
          else if (name === 'LapLastLapTime') vLast = { type: vhBuf.readInt32LE(b), offset: vhBuf.readInt32LE(b + 4) };
        }
        const numSamples = Math.floor((stat.size - h.bufOffset) / h.bufLen);
        if (numSamples > 0) {
          const rec = Buffer.alloc(h.bufLen);
          fs.readSync(fd, rec, 0, h.bufLen, h.bufOffset);
          if (sn) sessionNum = readVar(rec, 0, sn);
          // LapLastLapTime queda constante durante TODA la vuelta siguiente (miles
          // de muestras a 60 Hz), así que con ~1500 lecturas espaciadas alcanza para
          // captar el tiempo de cada vuelta. Tomamos el mínimo (> 1s, descarta basura).
          // Antes hacíamos hasta 5000 readSync por archivo → decenas de miles de
          // seeks síncronos con muchos .ibt, congelando el proceso principal.
          if (vLast) {
            const step = Math.max(60, Math.ceil(numSamples / 1500));
            for (let s = 0; s < numSamples; s += step) {
              fs.readSync(fd, rec, 0, h.bufLen, h.bufOffset + s * h.bufLen);
              const t = readVar(rec, 0, vLast);
              if (t != null && t > 1) {
                if (bestLap == null || t < bestLap) bestLap = t;
                // LapLastLapTime cambia una vez por vuelta: cada valor DISTINTO
                // consecutivo es una vuelta nueva. Sirve para la consistencia
                // en Progreso (dos vueltas con tiempo idéntico al ms se funden
                // en una: aceptable para una métrica de dispersión).
                const r = Math.round(t * 1000) / 1000;
                if (lapTimes.length === 0 || lapTimes[lapTimes.length - 1] !== r) lapTimes.push(r);
              }
            }
          }
        }
      }
    } catch (_) {}
    const fileName = path.basename(filePath);
    const meta = metaFromSessionInfo(yamlStr, fileName, sessionNum);
    return {
      track: meta.track,
      trackKey: meta.trackKey,
      car: meta.car,
      sessionType: meta.sessionType,
      startedAt: Math.floor(stat.mtimeMs),
      lapCount: null, // se conoce recién al abrir (parse completo)
      bestLap: bestLap != null ? Math.round(bestLap * 1000) / 1000 : null,
      lapTimes: lapTimes.length ? lapTimes : null,
      trackIdIr: meta.trackIdIr,
      carIdIr: meta.carIdIr,
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
    gLat: vars['LatAccel'],
    gLon: vars['LongAccel'],
    yaw: vars['YawRate'],
    lat: vars['Lat'],
    lon: vars['Lon'],
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
        gLat: round3(readVar(buf, base, V.gLat)),
        gLon: round3(readVar(buf, base, V.gLon)),
        yaw: round3(readVar(buf, base, V.yaw)),
        lat: round6(readVar(buf, base, V.lat)),
        lon: round6(readVar(buf, base, V.lon)),
      };
    }
  }

  const fileName = path.basename(filePath);
  const meta = metaFromSessionInfo(yamlStr, fileName, sessionNumSeen);

  return {
    track: meta.track,
    trackKey: meta.trackKey,
    car: meta.car,
    sessionType: meta.sessionType,
    sectorPcts: meta.sectorPcts,
    trackLength: meta.trackLength,
    trackIdIr: meta.trackIdIr,
    carIdIr: meta.carIdIr,
    startedAt: Math.floor(stat.mtimeMs),
    laps,
  };
}

module.exports = { parseIbtMeta, parseIbtSession };
