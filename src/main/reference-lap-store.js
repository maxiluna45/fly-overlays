const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Store de "vueltas de referencia" (estilo irdashies): guarda, por (trackId,
// carId), la mejor vuelta como un arreglo de tiempo-dentro-de-la-vuelta indexado
// por distancia (LapDistPct → t). Con eso se puede interpolar el tiempo en
// CUALQUIER punto de pista y calcular gaps relativos precisos entre dos autos
// (gap = t(otroPct) − t(selfPct), con wrap por meta), respetando el ritmo no
// uniforme de la vuelta (frenadas, rectas), a diferencia del fallback por
// EstTime. Persiste en userData para sobrevivir reinicios.

const BUCKETS = 400; // resolución de la referencia (~0.25% de vuelta)

class ReferenceLapStore {
  constructor() {
    this._laps = {};          // key -> { lapTime, times: number[BUCKETS] }
    this._buf = null;         // buffer de la vuelta en curso
    this._bufKey = null;
    this._saveTimer = null;
    try { this._path = path.join(app.getPath('userData'), 'reference-laps.json'); } catch (_) { this._path = null; }
    this._load();
  }

  _key(trackId, carId) { return `${trackId}_${carId}`; }

  _load() {
    if (!this._path) return;
    try {
      if (fs.existsSync(this._path)) {
        const raw = JSON.parse(fs.readFileSync(this._path, 'utf-8'));
        if (raw && typeof raw === 'object') this._laps = raw.laps || raw || {};
      }
    } catch (_) { this._laps = {}; }
  }

  _saveDebounced() {
    if (!this._path) return;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try { fs.writeFileSync(this._path, JSON.stringify({ laps: this._laps }), 'utf-8'); } catch (_) {}
    }, 2000);
  }

  // Alimenta el buffer con una muestra del player (llamar cada tick).
  feed(trackId, carId, lapDistPct, currentLapTime) {
    if (trackId == null || carId == null) return;
    if (!(lapDistPct >= 0 && lapDistPct <= 1) || !(currentLapTime > 0)) return;
    const key = this._key(trackId, carId);
    if (this._bufKey !== key || !this._buf) {
      this._buf = new Array(BUCKETS).fill(null);
      this._bufKey = key;
    }
    const b = Math.min(BUCKETS - 1, Math.max(0, Math.floor(lapDistPct * BUCKETS)));
    // Solo tomamos el primer tiempo de cada bucket (monótono creciente).
    if (this._buf[b] == null) this._buf[b] = currentLapTime;
  }

  // Cierra la vuelta en curso al cruzar meta. Si es válida y mejor que la
  // guardada (o no hay), la promueve a referencia.
  commit(trackId, carId, lastLapTime) {
    if (trackId == null || carId == null) return;
    const key = this._key(trackId, carId);
    const buf = this._bufKey === key ? this._buf : null;
    this._buf = null; this._bufKey = null;
    if (!buf || !(lastLapTime > 0)) return;
    const filled = buf.reduce((a, v) => a + (v != null ? 1 : 0), 0);
    if (filled < BUCKETS * 0.7) return; // cobertura insuficiente (vuelta parcial)
    const prev = this._laps[key];
    if (prev && prev.lapTime > 0 && lastLapTime >= prev.lapTime) return; // no mejora
    // Densificamos: rellenamos huecos por interpolación lineal y escalamos el
    // final al lastLapTime real (el buffer usa currentLapTime, que puede diferir
    // levemente del oficial).
    const dense = this._densify(buf);
    if (!dense) return;
    const rawTotal = dense[BUCKETS - 1] || lastLapTime;
    const scale = rawTotal > 0 ? lastLapTime / rawTotal : 1;
    for (let i = 0; i < BUCKETS; i++) dense[i] = Math.round(dense[i] * scale * 1000) / 1000;
    this._laps[key] = { lapTime: Math.round(lastLapTime * 1000) / 1000, times: dense };
    this._saveDebounced();
  }

  _densify(buf) {
    const out = buf.slice();
    // Primer valor conocido
    let firstIdx = out.findIndex((v) => v != null);
    if (firstIdx < 0) return null;
    for (let i = 0; i < firstIdx; i++) out[i] = 0; // antes del primer sample: t≈0
    // Interpolar huecos internos
    let i = firstIdx;
    while (i < BUCKETS) {
      if (out[i] != null) { i++; continue; }
      let j = i;
      while (j < BUCKETS && out[j] == null) j++;
      const a = out[i - 1];
      const b = j < BUCKETS ? out[j] : a;
      const span = (j - (i - 1));
      for (let k = i; k < j; k++) out[k] = a + (b - a) * ((k - (i - 1)) / span);
      i = j;
    }
    return out;
  }

  has(trackId, carId) {
    if (trackId == null || carId == null) return false;
    return !!this._laps[this._key(trackId, carId)];
  }

  lapTime(trackId, carId) {
    const r = this._laps[this._key(trackId, carId)];
    return r ? r.lapTime : 0;
  }

  // Tiempo-dentro-de-la-vuelta en pct (0..1), interpolado. null si no hay ref.
  interp(trackId, carId, pct) {
    if (trackId == null || carId == null) return null;
    const r = this._laps[this._key(trackId, carId)];
    if (!r || !Array.isArray(r.times)) return null;
    const f = ((pct % 1) + 1) % 1;
    const x = f * (BUCKETS - 1);
    const i0 = Math.floor(x), i1 = Math.min(BUCKETS - 1, i0 + 1), t = x - i0;
    const a = r.times[i0], b = r.times[i1];
    if (a == null || b == null) return null;
    return a + (b - a) * t;
  }

  reset() { this._buf = null; this._bufKey = null; }
}

module.exports = { ReferenceLapStore };
