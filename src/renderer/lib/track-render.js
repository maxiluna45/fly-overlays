// Trazada del mapa compartida entre el análisis (MapPanel) y la tarjeta (ShareCard).
// Funciones PURAS: reciben datos y devuelven paths/segmentos, sin React ni DOM.

export function speedColor(sp, spMin, spMax) {
  const span = (spMax - spMin) || 1;
  const t = Math.max(0, Math.min(1, (sp - spMin) / span));
  // azul (240) → rojo (0)
  const hue = 240 - t * 240;
  return `hsl(${Math.round(hue)},85%,55%)`;
}

// mapPath: array de largo BUCKETS con { x, y, hue, th?, br? } o null.
// Devuelve segmentos Bézier cúbicos (Catmull-Rom, tensión 1/6) uniendo puntos
// válidos consecutivos; saltea huecos > 6 buckets (posible dropout).
export function buildTrackSegments(mapPath) {
  const out = [];
  if (!Array.isArray(mapPath)) return out;
  const pts = [];
  for (let i = 0; i < mapPath.length; i++) if (mapPath[i]) pts.push({ i, p: mapPath[i] });
  for (let k = 1; k < pts.length; k++) {
    const prv = pts[k - 1], cur = pts[k];
    if (cur.i - prv.i > 6) continue;
    const a = prv.p, b = cur.p;
    const p0 = (pts[k - 2] || prv).p, p3 = (pts[k + 1] || cur).p;
    const c1x = a.x + (b.x - p0.x) / 6, c1y = a.y + (b.y - p0.y) / 6;
    const c2x = b.x - (p3.x - a.x) / 6, c2y = b.y - (p3.y - a.y) / 6;
    out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, c1x, c1y, c2x, c2y, hue: b.hue, th: b.th, br: b.br });
  }
  return out;
}

// Ajuste de similitud 2D (Umeyama): src → dst. Devuelve {s,cos,sin,tx,ty,err}.
export function fitSimilarity(src, dst) {
  const n = src.length;
  if (n < 3) return null;
  let msx = 0, msy = 0, mdx = 0, mdy = 0;
  for (let i = 0; i < n; i++) { msx += src[i].x; msy += src[i].y; mdx += dst[i].x; mdy += dst[i].y; }
  msx /= n; msy /= n; mdx /= n; mdy /= n;
  let a = 0, b = 0, varS = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i].x - msx, sy = src[i].y - msy, dx = dst[i].x - mdx, dy = dst[i].y - mdy;
    a += sx * dx + sy * dy;
    b += sx * dy - sy * dx;
    varS += sx * sx + sy * sy;
  }
  const mag = Math.hypot(a, b) || 1e-9;
  const cos = a / mag, sin = b / mag;
  const s = mag / (varS || 1e-9);
  const tx = mdx - s * (cos * msx - sin * msy);
  const ty = mdy - s * (sin * msx + cos * msy);
  let err = 0;
  for (let i = 0; i < n; i++) {
    const x = s * (cos * src[i].x - sin * src[i].y) + tx;
    const y = s * (sin * src[i].x + cos * src[i].y) + ty;
    err += (x - dst[i].x) ** 2 + (y - dst[i].y) ** 2;
  }
  return { s, cos, sin, tx, ty, err };
}
export function applySim(T, x, y) {
  return { x: T.s * (T.cos * x - T.sin * y) + T.tx, y: T.s * (T.sin * x + T.cos * y) + T.ty };
}

// Ajuste AFÍN por mínimos cuadrados (matriz 2x2 + traslación). A diferencia de
// la similitud, absorbe reflexión, escala distinta por eje y shear → sirve para
// posiciones en cualquier sistema/unidad (ej. Lat/Lon de un CSP externo). Se
// centra src y dst para quedar bien condicionado. Correspondencia por índice.
export function fitAffine(src, dst) {
  const n = src.length;
  if (n < 3) return null;
  let mx = 0, my = 0, mu = 0, mv = 0;
  for (let i = 0; i < n; i++) { mx += src[i].x; my += src[i].y; mu += dst[i].x; mv += dst[i].y; }
  mx /= n; my /= n; mu /= n; mv /= n;
  let Sxx = 0, Sxy = 0, Syy = 0, gxu = 0, gyu = 0, gxv = 0, gyv = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i].x - mx, sy = src[i].y - my, du = dst[i].x - mu, dv = dst[i].y - mv;
    Sxx += sx * sx; Sxy += sx * sy; Syy += sy * sy;
    gxu += sx * du; gyu += sy * du; gxv += sx * dv; gyv += sy * dv;
  }
  const det = Sxx * Syy - Sxy * Sxy;
  if (Math.abs(det) < 1e-9) return null;
  const inv00 = Syy / det, inv01 = -Sxy / det, inv11 = Sxx / det;
  // A = [[a,b],[c,d]] resolviendo G·col = rhs para cada fila de salida.
  const a = inv00 * gxu + inv01 * gyu, b = inv01 * gxu + inv11 * gyu;
  const c = inv00 * gxv + inv01 * gyv, d = inv01 * gxv + inv11 * gyv;
  let err = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i].x - mx, sy = src[i].y - my;
    const u = a * sx + b * sy + mu, v = c * sx + d * sy + mv;
    err += (u - dst[i].x) ** 2 + (v - dst[i].y) ** 2;
  }
  return { a, b, c, d, mx, my, mu, mv, err };
}
export function applyAffine(T, x, y) {
  const sx = x - T.mx, sy = y - T.my;
  return { x: T.a * sx + T.b * sy + T.mu, y: T.c * sx + T.d * sy + T.mv };
}

// Rotación por defecto del mapa a partir de `WeekendInfo.TrackNorthOffset`.
//
// El mapa se dibuja desde lat/lon, o sea que sin rotar sale con el NORTE
// ARRIBA. TrackNorthOffset es la orientación del circuito respecto del norte,
// así que girando el contenido en sentido contrario el mapa queda como iRacing
// dibuja esa pista, que es la orientación que uno tiene en la cabeza.
//
// Devuelve grados 0..359, o null si el YAML no trae el dato (ahí el mapa se
// queda con norte arriba, como venía).
export function autoMapRotation(northOffsetRad) {
  if (northOffsetRad == null || !isFinite(northOffsetRad)) return null;
  const deg = (northOffsetRad * 180) / Math.PI;
  return ((Math.round(360 - deg) % 360) + 360) % 360;
}
