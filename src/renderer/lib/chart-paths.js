// Paths SVG para los gráficos del Análisis.

// Escalera: para series que cambian de a saltos y no pasan por los valores
// intermedios. La marcha es el caso: entre la 3a y la 4a no existe la 3.5, y
// seriesPath --que interpola en diagonal-- dibujaría una rampa que sugiere un
// cambio progresivo. Acá el trazo se mantiene horizontal mientras la marcha no
// cambia y salta en vertical exactamente en el bin del cambio, que es además
// donde hay que mirar.
//
// Los argumentos son los mismos de seriesPath: vals indexado por bin, n bins,
// el rango vertical (yMin..yMax), el tamaño del viewBox y el range [a,b] del
// zoom de tramo (fracciones 0..1 de la vuelta).
export function stepPath(vals, n, yMin, yMax, W, H, range) {
  const span = yMax - yMin || 1;
  const aF = range && range.length === 2 ? range[0] : 0;
  const bF = range && range.length === 2 ? range[1] : 1;
  const aI = aF * (n - 1), bI = bF * (n - 1), denom = (bI - aI) || 1;
  const xAt = (i) => ((i - aI) / denom) * W;
  const yAt = (v) => H - ((v - yMin) / span) * H;
  const fmt = (x, y) => `${x.toFixed(1)},${y.toFixed(1)}`;

  let d = '';
  let prevY = null;   // altura del tramo horizontal que venimos dibujando
  let lastX = null;   // hasta dónde lo estiramos
  for (let i = 0; i < n; i++) {
    const v = vals[i];
    // Fuera del zoom, o sin dato (neutral, bins vacíos): corta el trazo. No se
    // inventa una marcha que el sample no tiene.
    if (i < aI - 1 || i > bI + 1 || v == null || !isFinite(v)) {
      if (prevY != null && lastX != null) d += ` L${fmt(lastX, prevY)}`;
      prevY = null; lastX = null;
      continue;
    }
    const x = xAt(i), y = yAt(v);
    if (prevY == null) {
      d += `${d ? ' ' : ''}M${fmt(x, y)}`;
    } else if (y !== prevY) {
      d += ` L${fmt(x, prevY)} L${fmt(x, y)}`; // horizontal hasta el cambio, y el salto
    }
    prevY = y; lastX = x;
  }
  // Cola: el óltimo tramo se estira hasta su bin final.
  if (prevY != null && lastX != null && !d.endsWith(fmt(lastX, prevY))) d += ` L${fmt(lastX, prevY)}`;
  return d.trim();
}

// Ubica los cambios de marcha sobre la trazada YA PROYECTADA del mapa.
// `mapPts` es el array indexado por bucket que dibuja el mapa (con null donde
// falta la posición) y `shifts` son los cambios con su fracción de vuelta.
//
// El índice sale de la fracción y no del número de bin crudo: hoy la vuelta y la
// referencia miden 800 buckets las dos, pero si alguna trajera otra cantidad
// las marcas se correrían de lugar en la pista sin que nada avise.
//
// Si el bucket exacto no tiene posición se busca el más cercano que sí la tenga:
// los mapas reales vienen con huecos y perder la marca por un bin vacío es peor
// que correrla unos metros.
const HUECO_MAX = 12; // buckets a cada lado; a 800 por vuelta son ~1.5% de pista

export function shiftPointsOn(mapPts, shifts) {
  if (!Array.isArray(mapPts) || !mapPts.length || !Array.isArray(shifts) || !shifts.length) return [];
  const n = mapPts.length;
  const out = [];
  for (const sh of shifts) {
    if (!sh || sh.pct == null || !isFinite(sh.pct)) continue;
    const base = Math.min(n - 1, Math.max(0, Math.round(sh.pct * (n - 1))));
    let p = null;
    for (let d = 0; d <= HUECO_MAX && !p; d++) {
      p = mapPts[base - d] || mapPts[base + d] || null;
    }
    if (p) out.push({ x: p.x, y: p.y, up: !!sh.up, to: sh.to, pct: sh.pct });
  }
  return out;
}
