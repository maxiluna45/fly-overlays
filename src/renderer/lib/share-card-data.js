export const FORMATS = {
  story:  { w: 1080, h: 1920, label: 'Historia 9:16' },
  square: { w: 1080, h: 1080, label: 'Cuadrada 1:1' },
  wide:   { w: 1920, h: 1080, label: 'Apaisada 16:9' },
};

export function fmtLapTime(sec) {
  if (sec == null || !isFinite(sec) || sec <= 0) return '—';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

export function fmtSector(sec) {
  if (sec == null || !isFinite(sec) || sec <= 0) return '—';
  return sec.toFixed(3);
}

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
