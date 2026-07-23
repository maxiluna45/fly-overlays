// Datos y formatos para construir la tarjeta de compartición de vueltas.
// Define el modelo de datos sin React/DOM (puro formato y transformación).

// Dimensiones y rótulos de los formatos de imagen soportados para exportar.
export const FORMATS = {
  story:  { w: 1080, h: 1920, label: 'Historia 9:16' },
  square: { w: 1080, h: 1080, label: 'Cuadrada 1:1' },
  wide:   { w: 1920, h: 1080, label: 'Apaisada 16:9' },
};

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

// Construye el modelo de datos de la tarjeta (tiempos formateados, badges, metadatos) para renderizar.
export function buildCardModel({ lap, session, best, displayName }) {
  const s = session || {};
  const sectors = Array.isArray(lap.sectors)
    ? lap.sectors.map((v, i) => ({ label: `S${i + 1}`, value: fmtSector(v) }))
    : [];
  const isPB = !!(best && lap && best.lapTime === lap.lapTime);
  return {
    time: fmtLapTime(lap.lapTime),
    sectors,
    badge: isPB ? 'PB' : (lap.valid ? 'VÁLIDA' : 'INVÁLIDA'),
    isPB,
    driver: displayName || '',
    car: s.car || '',
    track: s.track || '',
    date: s.startedAt ? new Date(s.startedAt).toLocaleDateString('es-CO') : '',
  };
}
