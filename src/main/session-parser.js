const YAML = require('yaml');

/**
 * Parsea el SessionInfo YAML de iRacing y extrae info útil para overlays.
 *
 * Estructura típica:
 * - WeekendInfo.TrackName, TrackDisplayName, TrackLength
 * - SessionInfo.Sessions[].SessionName, SessionType
 * - SplitTimeInfo.SectorStartPct[] ← % de la vuelta donde empieza cada sector
 *   (no recuerdo el path exacto, lo descubrimos en el test)
 */

function parseSessionInfo(yamlString) {
  if (!yamlString) return null;
  try {
    return YAML.parse(yamlString);
  } catch (err) {
    console.error('[session-parser] YAML parse error:', err.message);
    return null;
  }
}

/**
 * Devuelve la lista de puntos de sector (en % de vuelta).
 * Retorna array de números en [0, 1), ej: [0.333, 0.666] para un split normal.
 *
 * iRacing expone los sectores en varias partes del YAML según la versión.
 * Esta función busca en los lugares más comunes.
 */
function getSectorPoints(parsed) {
  if (!parsed) return [1/3, 2/3]; // fallback: 2 splits iguales

  // Lugares comunes donde iRacing pone los sector points:
  const candidates = [
    () => parsed?.SplitTimeInfo?.SectorStartPct,
    () => parsed?.SessionInfo?.SplitTimeInfo?.SectorStartPct,
    () => parsed?.WeekendInfo?.SplitTimeInfo?.SectorStartPct,
    () => parsed?.SplitTimeInfo?.Splits?.[0]?.SectorStartPct,
    () => {
      // A veces viene como "SplitPct" en cada sesión
      const sessions = parsed?.SessionInfo?.Sessions || [];
      for (const s of sessions) {
        if (s.SplitPct) return s.SplitPct;
        if (s.SectorPct) return s.SectorPct;
      }
      return null;
    },
  ];

  for (const c of candidates) {
    try {
      const result = c();
      if (Array.isArray(result) && result.length > 0) {
        return result.map((p) => (typeof p === 'number' ? p : parseFloat(p))).filter((p) => !isNaN(p) && p > 0 && p < 1);
      }
    } catch (_) {}
  }

  return [1/3, 2/3]; // fallback
}

/**
 * Devuelve metadata útil del circuito/sesión para los overlays.
 */
function getTrackInfo(parsed) {
  if (!parsed) return { name: 'Unknown', length: 0, sectorCount: 2 };
  return {
    name: parsed?.WeekendInfo?.TrackDisplayName || parsed?.WeekendInfo?.TrackName || 'Unknown',
    length: parseFloat(parsed?.WeekendInfo?.TrackLength) || 0,
    configName: parsed?.WeekendInfo?.TrackConfigName || '',
    sectorPoints: getSectorPoints(parsed),
    sectorCount: getSectorPoints(parsed).length + 1, // N splits → N+1 sectores
  };
}

module.exports = {
  parseSessionInfo,
  getSectorPoints,
  getTrackInfo,
};
