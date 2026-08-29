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
