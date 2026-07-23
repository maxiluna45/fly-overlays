// Datos y formatos para construir la tarjeta de compartición de vueltas.
// Define el modelo de datos sin React/DOM (puro formato y transformación).

// Dimensiones y rótulos de los formatos de imagen soportados para exportar.
export const FORMATS = {
  story:  { w: 1080, h: 1920, label: 'Historia 9:16' },
  square: { w: 1080, h: 1080, label: 'Cuadrada 1:1' },
  wide:   { w: 1920, h: 1080, label: 'Apaisada 16:9' },
};

// Cuántos gráficos se van a renderizar REALMENTE en la tarjeta (elegidos por el
// usuario Y con datos suficientes). Compartido entre AnalysisView (escala del
// mapa) y ShareCard (layout) para que ambos usen la misma caja.
export function countShareCharts(model, charts = []) {
  let n = 0;
  if (charts.includes('speed') && Array.isArray(model && model.spark) && model.spark.length > 3) n++;
  const th = (model && model.sparkTh) || [], br = (model && model.sparkBr) || [];
  if (charts.includes('pedals') && (th.length > 3 || br.length > 3)) n++;
  return n;
}

// Caja del MAPA (héroe) de la tarjeta por formato: { x, y, w, h }. Fuente única
// de verdad compartida entre ShareCard (que traslada el mapa a x,y) y AnalysisView
// (que escala el subárbol del mapa a w×h). En 'wide' el mapa ocupa la izquierda y
// los datos van en columna (su alto no depende de los gráficos); en 'story' y
// 'square' el mapa CEDE altura según cuántos gráficos haya debajo — así el
// contenido siempre entra, sin desbordar la tarjeta.
export function shareMapBox(format, chartCount = 1) {
  const c = Math.max(0, Math.min(2, chartCount | 0));
  switch (format) {
    case 'story': return { x: 64, y: 210, w: 952, h: c >= 2 ? 620 : c === 1 ? 770 : 900 };
    // En 'wide' el mapa cede ANCHO (no alto) cuando hay dos gráficos: la
    // columna de datos gana espacio y respira mejor.
    case 'wide':  return { x: 56, y: 130, w: c >= 2 ? 960 : 1060, h: 820 };
    case 'square':
    default:      return { x: 64, y: 120, w: 952, h: c >= 1 ? 310 : 420 };
  }
}

// Formatea tiempo de vuelta completa como "m:ss.sss" (p. ej. "1:23.456").
export function fmtLapTime(sec) {
  if (sec == null || !isFinite(sec) || sec <= 0) return '—';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

// Formatea tiempo de sector con 3 decimales (p. ej. "23.456").
export function fmtSector(sec) {
  if (sec == null || !isFinite(sec) || sec <= 0) return '—';
  return sec.toFixed(3);
}

// Sanitiza un nombre de archivo: en Windows los caracteres \ / : * ? " < > | son
// inválidos (p. ej. el tiempo de vuelta "1:32.345" o el nombre de pista con "/"
// rompen el diálogo nativo de guardado). Los reemplaza por "-" y normaliza espacios.
export function sanitizeFilename(name) {
  const replaced = String(name ?? '').replace(/[\\/:*?"<>|]/g, '-');
  return replaced.replace(/[\s-]{2,}/g, (m) => (m.includes('-') ? '-' : ' ')).trim();
}

// Sparkline de velocidad + Vmáx/Vprom a partir de las muestras (por distancia) de
// la vuelta. `spark` = puntos {x,y} en 0..1 (x = avance de vuelta, y = velocidad
// normalizada, 1 = más rápido). Velocidades en m/s → km/h para mostrar.
export function buildSpeedStats(lap, n = 120) {
  const samples = Array.isArray(lap && lap.samples) ? lap.samples : [];
  const pts = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s && s.sp != null && isFinite(s.sp)) pts.push({ i, v: s.sp });
  }
  if (pts.length < 8) return { topSpeedKmh: null, avgSpeedKmh: null, spark: null };
  let lo = Infinity, hi = -Infinity, sum = 0;
  for (const p of pts) { if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v; sum += p.v; }
  const span = (hi - lo) || 1;
  const N = (samples.length - 1) || 1;
  const stride = Math.max(1, Math.floor(pts.length / n));
  const spark = [];
  for (let k = 0; k < pts.length; k += stride) spark.push({ x: pts[k].i / N, y: (pts[k].v - lo) / span });
  return { topSpeedKmh: Math.round(hi * 3.6), avgSpeedKmh: Math.round((sum / pts.length) * 3.6), spark };
}

// Traza normalizada 0..1 de un canal por distancia ('th' | 'br' | 'sp'...).
// x = avance de vuelta, y = valor clampeado a 0..1 (los pedales ya vienen 0..1).
// null si no hay muestras suficientes.
export function buildChannelTrace(lap, key, n = 120) {
  const samples = Array.isArray(lap && lap.samples) ? lap.samples : [];
  const pts = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s && s[key] != null && isFinite(s[key])) pts.push({ i, v: s[key] });
  }
  if (pts.length < 8) return null;
  const N = (samples.length - 1) || 1;
  const stride = Math.max(1, Math.floor(pts.length / n));
  const out = [];
  for (let k = 0; k < pts.length; k += stride) {
    out.push({ x: pts[k].i / N, y: Math.max(0, Math.min(1, pts[k].v)) });
  }
  return out;
}

// Construye el modelo de datos de la tarjeta (tiempos, badges, metadatos, stats de
// velocidad y trazas para los gráficos) para renderizar.
export function buildCardModel({ lap, session, best, displayName }) {
  const s = session || {};
  const sectors = Array.isArray(lap.sectors)
    ? lap.sectors.map((v, i) => ({ label: `S${i + 1}`, value: fmtSector(v) }))
    : [];
  const isPB = !!(best && lap && best.lapTime === lap.lapTime);
  const { topSpeedKmh, avgSpeedKmh, spark } = buildSpeedStats(lap);
  return {
    time: fmtLapTime(lap.lapTime),
    sectors,
    topSpeedKmh,
    avgSpeedKmh,
    spark,
    sparkTh: buildChannelTrace(lap, 'th'),
    sparkBr: buildChannelTrace(lap, 'br'),
    badge: isPB ? 'PB' : (lap.valid ? 'VÁLIDA' : 'INVÁLIDA'),
    isPB,
    driver: displayName || '',
    car: s.car || '',
    track: s.track || '',
    date: s.startedAt ? new Date(s.startedAt).toLocaleDateString('es-CO') : '',
  };
}
