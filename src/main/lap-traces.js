// Trazas de vuelta: el tiempo dentro de la vuelta en cada punto de pista.
//
// Con esto calculamos el delta por nuestra cuenta en vez de leer el de iRacing.
// Motivo, medido en la telemetría: apenas despistás, el sim invalida la vuelta y
// apaga los flags *_OK de TODAS sus variables de delta por el resto de la
// vuelta, así que la barra se queda sin dato justo cuando más se mira. Restando
// contra una traza propia el número sigue vivo, y además cada referencia da un
// valor distinto de verdad (las del sim devuelven el mismo número en varias
// variables cuando tu mejor de sesión es también tu óptima).

const BUCKETS = 400;          // ~0.25% de vuelta, igual que reference-lap-store
const COBERTURA_MINIMA = 0.7; // por debajo de esto la vuelta fue parcial

// Una muestra por bucket, la primera (el tiempo es monotono creciente).
function feedTrace(buf, pct, t) {
  if (!Array.isArray(buf)) return;
  if (!(pct >= 0 && pct <= 1) || !(t > 0)) return;
  const b = Math.min(BUCKETS - 1, Math.max(0, Math.floor(pct * BUCKETS)));
  if (buf[b] == null) buf[b] = t;
}

// Rellena los huecos por interpolación lineal.
function densify(buf) {
  const out = new Array(BUCKETS);
  for (let i = 0; i < BUCKETS; i++) out[i] = buf[i] != null ? buf[i] : null;
  const first = out.findIndex((v) => v != null);
  if (first < 0) return null;
  for (let i = 0; i < first; i++) out[i] = 0; // antes del primer sample: t~0
  let i = first;
  while (i < BUCKETS) {
    if (out[i] != null) { i++; continue; }
    let j = i;
    while (j < BUCKETS && out[j] == null) j++;
    const a = out[i - 1];
    const b = j < BUCKETS ? out[j] : a;
    const span = j - (i - 1);
    for (let k = i; k < j; k++) out[k] = a + (b - a) * ((k - (i - 1)) / span);
    i = j;
  }
  return out;
}

// Cierra la vuelta: devuelve { lapTime, times[] } o null si no sirve como
// referencia (parcial, o invalidada por el sim, que manda lastLapTime -1).
function sealTrace(buf, lapTime) {
  if (!Array.isArray(buf) || !(lapTime > 0)) return null;
  let llenos = 0;
  for (let i = 0; i < BUCKETS; i++) if (buf[i] != null) llenos++;
  if (llenos < BUCKETS * COBERTURA_MINIMA) return null;
  const dense = densify(buf);
  if (!dense) return null;
  // El buffer se llena con LapCurrentLapTime, que puede diferir del oficial:
  // escalamos para que el final coincida con el tiempo de vuelta real.
  const bruto = dense[BUCKETS - 1] || lapTime;
  const k = bruto > 0 ? lapTime / bruto : 1;
  const times = dense.map((v) => Math.round(v * k * 1000) / 1000);
  return { lapTime: Math.round(lapTime * 1000) / 1000, times };
}

// Tiempo de la traza en ese punto de pista (0..1), interpolado.
function timeAt(trace, pct) {
  if (!trace || !Array.isArray(trace.times)) return null;
  const f = ((pct % 1) + 1) % 1;
  const x = f * (BUCKETS - 1);
  const i0 = Math.floor(x), i1 = Math.min(BUCKETS - 1, i0 + 1);
  const a = trace.times[i0], b = trace.times[i1];
  if (a == null || b == null) return null;
  return a + (b - a) * (x - i0);
}

// Seguimiento de la sesión: la vuelta en curso, la anterior y la mejor.
function createTracker() {
  let cur = [];
  let lastLap = null;
  let sessionBest = null;

  // En el frame del cruce de meta, LapDistPct ya volvio a 0 pero
  // LapCurrentLapTime todavia trae el cronometro de la vuelta que termina
  // (medido en telemetria real: daba picos de -43s). Mientras los dos no esten
  // sincronizados no hay delta que valga.
  const desincronizado = (trace, pct, t) => pct < 0.05 && t > trace.lapTime * 0.5;

  const delta = (trace, pct, t) => {
    if (!trace || !(t >= 0) || desincronizado(trace, pct, t)) return null;
    const ref = timeAt(trace, pct);
    return ref == null ? null : Math.round((t - ref) * 1000) / 1000;
  };

  return {
    feed(pct, t) { feedTrace(cur, pct, t); },

    // Al cruzar meta. lapTime <= 0 = vuelta invalida: se descarta como
    // referencia, pero igual arranca el buffer de la siguiente.
    completeLap(lapTime) {
      const sealed = sealTrace(cur, lapTime);
      cur = [];
      if (!sealed) return;
      lastLap = sealed;
      if (!sessionBest || sealed.lapTime < sessionBest.lapTime) sessionBest = sealed;
    },

    deltas(pct, t) {
      return { sessionBest: delta(sessionBest, pct, t), lastLap: delta(lastLap, pct, t) };
    },

    // Vuelta proyectada: lo que llevás más lo que falta al ritmo de tu mejor.
    // No depende de qué referencia se esté mirando en la barra, que es el
    // punto: el proyectado es una propiedad de TU vuelta, no de con quién te
    // comparás.
    predict(pct, t) {
      if (!sessionBest || !(t >= 0) || desincronizado(sessionBest, pct, t)) return null;
      const hecho = timeAt(sessionBest, pct);
      if (hecho == null) return null;
      const falta = sessionBest.lapTime - hecho;
      return Math.round((t + falta) * 1000) / 1000;
    },

    lapTimes() {
      return { sessionBest: sessionBest ? sessionBest.lapTime : 0, lastLap: lastLap ? lastLap.lapTime : 0 };
    },

    reset() { cur = []; lastLap = null; sessionBest = null; },
  };
}

module.exports = { BUCKETS, feedTrace, densify, sealTrace, timeAt, createTracker };
