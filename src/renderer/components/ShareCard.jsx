import React, { forwardRef } from "react";
import { FORMATS } from "../lib/share-card-data.js";

// Tarjeta SVG para compartir una vuelta. El <svg> se expone por ref para
// rasterizarlo a PNG (ver render-svg-to-png). `mapEls` es el subárbol del mapa
// ya construido por el contenedor (segmentos de trazada + outline/tiles según
// fuente), para no duplicar la lógica de alineado acá.
export const ShareCard = forwardRef(function ShareCard({ model, mapEls, format = "square" }, ref) {
  const F = FORMATS[format] || FORMATS.square;
  const { w, h } = F;
  const vertical = format === "story";
  // Zona del mapa según formato.
  const map = vertical
    ? { x: 60, y: 120, w: w - 120, h: h * 0.5 }
    : { x: 60, y: 90, w: w * 0.52, h: h - 260 };
  const stats = vertical
    ? { x: 60, y: map.y + map.h + 40 }
    : { x: map.x + map.w + 60, y: 140 };
  return (
    <svg ref={ref} width={w} height={h} viewBox={`0 0 ${w} ${h}`} xmlns="http://www.w3.org/2000/svg" style={{ background: "#0b0e14" }}>
      <rect x="0" y="0" width={w} height={h} fill="#0b0e14" />
      <text x="60" y="70" fill="#38bdf8" fontSize="40" fontWeight="800" fontFamily="sans-serif">iFLY</text>
      {/* Mapa (subárbol ya alineado, escalado al viewport del mapa) */}
      <g transform={`translate(${map.x},${map.y})`}>{mapEls}</g>
      {/* Tiempo */}
      <text x={stats.x} y={stats.y} fill="#fff" fontSize="96" fontWeight="800" fontFamily="sans-serif">{model.time}</text>
      <text x={stats.x} y={stats.y + 44} fill={model.isPB ? "#34d399" : "#94a3b8"} fontSize="30" fontWeight="700" fontFamily="sans-serif">▸ {model.badge}</text>
      {/* Sectores */}
      {model.sectors.map((s, i) => (
        <text key={i} x={stats.x} y={stats.y + 110 + i * 42} fill="#cbd5e1" fontSize="34" fontFamily="monospace">{s.label}  {s.value}</text>
      ))}
      {/* Meta */}
      <text x={stats.x} y={h - 120} fill="#e2e8f0" fontSize="34" fontWeight="700" fontFamily="sans-serif">{model.track}</text>
      <text x={stats.x} y={h - 80} fill="#94a3b8" fontSize="28" fontFamily="sans-serif">{model.car}</text>
      <text x={stats.x} y={h - 44} fill="#64748b" fontSize="26" fontFamily="sans-serif">{[model.driver, model.date].filter(Boolean).join(" · ")}</text>
    </svg>
  );
});
