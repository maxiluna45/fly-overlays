const fs = require('fs');
const path = require('path');

// Cantidad de "bins" de distancia por vuelta. Cada muestra se guarda en el bin
// correspondiente a su LapDistPct (0..1). Muestrear por DISTANCIA (y no por
// tiempo) alinea las trazas entre vueltas: el punto i de dos vueltas es el
// mismo lugar de la pista, así se pueden superponer y calcular el delta.
const BUCKETS = 800;         // resolución de la trazada por distancia (mejor detalle en curvas)
const MAX_LAPS = 250;        // tope de vueltas guardadas por sesión
const MAX_SESSIONS_ON_DISK = 60;

// Grabador de sesiones en vivo. Recibe frames de telemetría desde IrsdkClient
// (solo con SDK real, nunca en preview), los agrupa por vuelta y persiste cada
// sesión como un JSON en userData/recordings.
class SessionRecorder {
  constructor(dir) {
    this.dir = dir;
    this._ensureDir();
    this._session = null;      // sesión en curso { id, ... , laps: [] }
    this._buckets = new Array(BUCKETS).fill(null); // buffer de la vuelta actual
    this._bucketCount = 0;
    this._writeTimer = null;
    this._listeners = new Set();
    this._summaryCache = new Map(); // clave archivo|mtime|size → resumen para el listado
  }

  _ensureDir() {
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (_) {}
  }

  onChange(cb) {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }
  _emitChange() {
    for (const cb of this._listeners) { try { cb(); } catch (_) {} }
  }

  // key de sesión: mismo track+car+tipo = misma sesión.
  _sessionKey(f) {
    return `${f.track || '?'}|${f.car || '?'}|${f.sessionType || '?'}`;
  }

  _startSession(f, startedAt) {
    this._session = {
      id: String(startedAt),
      startedAt,
      track: f.track || 'Desconocido',
      trackKey: f.trackKey || null,
      trackIdIr: f.trackIdIr || null,
      carIdIr: f.carIdIr || null,
      car: f.car || 'Desconocido',
      sessionType: f.sessionType || 'Practice',
      sectorPcts: Array.isArray(f.sectorPcts) ? f.sectorPcts : null,
      trackLength: f.trackLength || null,
      trackNorthOffset: f.trackNorthOffset ?? null,
      key: this._sessionKey(f),
      laps: [],
    };
    this._buckets = new Array(BUCKETS).fill(null);
    this._bucketCount = 0;
  }

  // Recibe un frame de telemetría (~60 Hz). Debe llamarse SOLO con datos reales.
  handleFrame(f) {
    if (!f) return;

    // 1) Si se completó una vuelta, finalizarla con el buffer acumulado.
    if (f.completedLap) {
      this._finalizeLap(f, f.completedLap);
    }

    // 2) Acumular la muestra del frame actual (sobrescribe el bin: último gana).
    if (f.onTrack && f.lapDistPct >= 0 && f.lapDistPct <= 1) {
      const b = Math.min(BUCKETS - 1, Math.max(0, Math.floor(f.lapDistPct * BUCKETS)));
      if (this._buckets[b] == null) this._bucketCount++;
      this._buckets[b] = {
        th: round3(f.throttle),
        br: round3(f.brake),
        st: round3(f.steer),
        sp: round2(f.speed),
        g: f.gear | 0,
        rpm: Math.round(f.rpm || 0),
        t: round3(f.currentLapTime),
        gLat: round3(f.gLat),
        gLon: round3(f.gLon),
        yaw: round3(f.yaw),
        lat: round6(f.lat),
        lon: round6(f.lon),
      };
    }
  }

  _finalizeLap(f, completed) {
    // Empezar sesión si hace falta o si cambió el contexto (track/car/tipo).
    const startedAt = completed.at || (f.at) || Date.now();
    if (!this._session || this._session.key !== this._sessionKey(f)) {
      // Persistir la anterior antes de arrancar una nueva.
      if (this._session && this._session.laps.length > 0) this._writeNow();
      this._startSession(f, startedAt);
    }

    // Solo guardamos vueltas con cobertura razonable (evita out-laps parciales
    // y vueltas donde recién nos conectamos a mitad de pista).
    const coverage = this._bucketCount / BUCKETS;
    if (completed.time > 0 && coverage >= 0.6) {
      // Materializar las trazas como arrays de largo BUCKETS (null donde falta).
      const samples = this._buckets.map((s) => s || null);
      this._session.laps.push({
        lap: completed.number,
        lapTime: round3(completed.time),
        valid: !!completed.valid,
        // Sectores reales de iRacing agrupando los 24 micro-sectores en 3.
        sectors: microsToSectors(completed.micros),
        micros: (completed.micros || []).map((v) => (v != null ? round3(v) : null)),
        samples,
      });
      if (this._session.laps.length > MAX_LAPS) this._session.laps.shift();
      this._scheduleWrite();
    }

    // Reset del buffer para la nueva vuelta.
    this._buckets = new Array(BUCKETS).fill(null);
    this._bucketCount = 0;
  }

  // Cierra la sesión en curso (ej: al desconectar iRacing). La deja persistida.
  endSession() {
    // sync=true: endSession puede correr justo antes de app.quit()
    // (window-all-closed) — una escritura async ahí se perdería.
    if (this._session && this._session.laps.length > 0) this._writeNow(true);
    this._session = null;
    this._buckets = new Array(BUCKETS).fill(null);
    this._bucketCount = 0;
  }

  _scheduleWrite() {
    if (this._writeTimer) return;
    this._writeTimer = setTimeout(() => { this._writeTimer = null; this._writeNow(); }, 800);
  }

  _writeNow(sync = false) {
    if (!this._session) return;
    const file = path.join(this.dir, `session-${this._session.id}.json`);
    const json = JSON.stringify(this._session);
    if (sync) {
      // Cierre de sesión (puede venir justo antes de app.quit()): sincrónico
      // para garantizar que el archivo quede en disco antes de salir.
      try {
        fs.writeFileSync(file, json, 'utf-8');
        this._pruneOld();
        this._emitChange();
      } catch (err) {
        console.error('[recorder] error guardando:', err.message);
      }
      return;
    }
    // Escritura periódica (cada ~800ms mientras se graba): asíncrona para no
    // bloquear el main (el JSON de una sesión larga pesa varios MB), y
    // encadenada para no solapar dos escrituras al mismo archivo.
    this._writeChain = (this._writeChain || Promise.resolve())
      .then(() => fs.promises.writeFile(file, json, 'utf-8'))
      .then(() => { this._pruneOld(); this._emitChange(); })
      .catch((err) => { console.error('[recorder] error guardando:', err.message); });
  }

  _pruneOld() {
    try {
      const files = fs.readdirSync(this.dir).filter((f) => f.startsWith('session-') && f.endsWith('.json'));
      if (files.length <= MAX_SESSIONS_ON_DISK) return;
      // Ordenar por mtime asc y borrar los más viejos.
      const withTime = files.map((f) => ({ f, m: fs.statSync(path.join(this.dir, f)).mtimeMs }));
      withTime.sort((a, b) => a.m - b.m);
      for (const { f } of withTime.slice(0, withTime.length - MAX_SESSIONS_ON_DISK)) {
        try { fs.unlinkSync(path.join(this.dir, f)); } catch (_) {}
      }
    } catch (_) {}
  }

  // === API para el renderer (vía IPC) ===

  // Devuelve un resumen por sesión (sin las trazas). Antes hacía JSON.parse del
  // archivo COMPLETO de cada sesión (vueltas × 800 buckets) en cada llamada — muy
  // caro y en el proceso principal. Ahora cacheamos el resumen por mtime+size, así
  // solo se re-parsea un archivo si cambió (la sesión en curso mientras se graba).
  listSessions() {
    let files = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.startsWith('session-') && f.endsWith('.json'));
    } catch (_) { return []; }
    const out = [];
    for (const f of files) {
      const full = path.join(this.dir, f);
      try {
        const st = fs.statSync(full);
        const key = `${f}|${st.mtimeMs}|${st.size}`;
        let summary = this._summaryCache.get(key);
        if (summary === undefined) {
          const raw = JSON.parse(fs.readFileSync(full, 'utf-8'));
          const valid = raw.laps.filter((l) => l.valid && l.lapTime > 0);
          const best = valid.reduce((m, l) => (m == null || l.lapTime < m ? l.lapTime : m), null);
          summary = {
            id: raw.id,
            startedAt: raw.startedAt,
            track: raw.track,
            trackKey: raw.trackKey || null,
            car: raw.car,
            sessionType: raw.sessionType,
            lapCount: raw.laps.length,
            bestLap: best,
            // Tiempos de vueltas válidas: livianos (~decenas de floats) y le
            // permiten a Progreso calcular consistencia sin abrir la sesión.
            lapTimes: valid.map((l) => l.lapTime),
          };
          this._summaryCache.set(key, summary);
        }
        out.push(summary);
      } catch (_) {}
    }
    out.sort((a, b) => b.startedAt - a.startedAt);
    return out;
  }

  getSession(id) {
    try {
      const file = path.join(this.dir, `session-${id}.json`);
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (_) { return null; }
  }

  deleteSession(id) {
    try {
      fs.unlinkSync(path.join(this.dir, `session-${id}.json`));
      if (this._session && this._session.id === String(id)) this._session = null;
      this._emitChange();
      return true;
    } catch (_) { return false; }
  }
}

function round2(v) { return v == null || !isFinite(v) ? null : Math.round(v * 100) / 100; }
function round3(v) { return v == null || !isFinite(v) ? null : Math.round(v * 1000) / 1000; }
function round6(v) { return v == null || !isFinite(v) ? null : Math.round(v * 1e6) / 1e6; }

// Agrupa los 24 micro-sectores en 3 sectores (suma por tercios). Devuelve null
// si algún micro falta.
function microsToSectors(micros) {
  if (!Array.isArray(micros) || micros.length !== 24) return null;
  const out = [];
  for (let s = 0; s < 3; s++) {
    let sum = 0;
    for (let i = 0; i < 8; i++) {
      const v = micros[s * 8 + i];
      if (v == null || !isFinite(v) || v <= 0) return null;
      sum += v;
    }
    out.push(round3(sum));
  }
  return out;
}

module.exports = { SessionRecorder, BUCKETS };
