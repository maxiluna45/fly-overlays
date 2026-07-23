import React, { forwardRef } from "react";
import { FORMATS } from "../lib/share-card-data.js";

// Margen de la tarjeta.
const PAD = 60;

// Tamaño de fuente que ASEGURA que `text` entre en `maxW` px, aproximando el
// ancho por cantidad de caracteres (sin medir el DOM → determinístico y válido
// también cuando el SVG se rasteriza a PNG, donde no hay layout previo).
// `factor` ≈ ancho medio de glifo / tamaño de fuente (~0.58 sans bold, ~0.62 mono).
// Nunca agranda: parte de `desired` y solo achica si el texto no entra.
function fitSize(text, maxW, desired, factor = 0.58) {
  const s = String(text ?? "");
  if (!s.length || !(maxW > 0)) return desired;
  return Math.max(12, Math.min(desired, maxW / (factor * s.length)));
}

// Tarjeta SVG para compartir una vuelta. El <svg> se expone por ref para
// rasterizarlo a PNG (ver render-svg-to-png). `mapEls` es el subárbol del mapa
// ya construido y ESCALADO por el contenedor; acá solo se traslada a la caja.
export const ShareCard = forwardRef(function ShareCard({ model, mapEls, format = "square" }, ref) {
  const F = FORMATS[format] || FORMATS.square;
  const { w, h } = F;
  const vertical = format === "story";
  // Zona del mapa según formato (DEBE coincidir con `shareBox` en AnalysisView).
  const map = vertical
    ? { x: PAD, y: 120, w: w - 2 * PAD, h: h * 0.5 }
    : { x: PAD, y: 90, w: w * 0.52, h: h - 260 };
  // Columna de stats: en vertical ocupa el ancho completo bajo el mapa; en
  // horizontal va a la derecha del mapa. El borde derecho se fija a PAD del
  // borde de la tarjeta, así ningún texto se sale (se achica para entrar).
  const colX = vertical ? PAD : map.x + map.w + 40;
  const colW = (w - PAD) - colX;
  const timeSize = fitSize(model.time, colW, vertical ? 150 : 96);
  const trackSize = fitSize(model.track, colW, 40, 0.56);
  const carSize = fitSize(model.car, colW, 30, 0.56);
  const metaStr = [model.driver, model.date].filter(Boolean).join(" · ");
  const metaSize = fitSize(metaStr, colW, 26, 0.56);
  // Línea base del tiempo: en vertical bajo el mapa; en horizontal arriba.
  const timeY = vertical ? map.y + map.h + 90 + timeSize * 0.75 : 90 + timeSize * 0.75;
  const badgeY = timeY + 46;
  const secStartY = badgeY + 56;
  return (
    <svg ref={ref} width={w} height={h} viewBox={`0 0 ${w} ${h}`} xmlns="http://www.w3.org/2000/svg" style={{ background: "#0b0e14" }}>
      <rect x="0" y="0" width={w} height={h} fill="#0b0e14" />
      <text x={PAD} y="72" fill="#38bdf8" fontSize="40" fontWeight="800" fontFamily="sans-serif">iFLY</text>
      {/* Mapa (subárbol ya alineado y escalado por el contenedor) */}
      <g transform={`translate(${map.x},${map.y})`}>{mapEls}</g>
      {/* Tiempo (se achica para entrar en la columna) */}
      <text x={colX} y={timeY} fill="#fff" fontSize={timeSize} fontWeight="800" fontFamily="sans-serif">{model.time}</text>
      <text x={colX} y={badgeY} fill={model.isPB ? "#34d399" : "#94a3b8"} fontSize="30" fontWeight="700" fontFamily="sans-serif">▸ {model.badge}</text>
      {/* Sectores */}
      {model.sectors.map((s, i) => (
        <text key={i} x={colX} y={secStartY + i * 42} fill="#cbd5e1" fontSize="32" fontFamily="monospace">{s.label}  {s.value}</text>
      ))}
      {/* Meta (abajo, anclada al pie de la tarjeta) */}
      <text x={colX} y={h - 128} fill="#e2e8f0" fontSize={trackSize} fontWeight="700" fontFamily="sans-serif">{model.track}</text>
      <text x={colX} y={h - 128 + carSize + 14} fill="#94a3b8" fontSize={carSize} fontFamily="sans-serif">{model.car}</text>
      <text x={colX} y={h - 128 + carSize + 14 + metaSize + 16} fill="#64748b" fontSize={metaSize} fontFamily="sans-serif">{metaStr}</text>
    </svg>
  );
});
