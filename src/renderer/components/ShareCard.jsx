import React, { forwardRef } from "react";
import { FORMATS, shareMapBox } from "../lib/share-card-data.js";

// Paleta de marca iFly (misma que la app: HUD oscuro con neón azul).
const INK = "#0b0e14";
const ACCENT = "#38bdf8";
const ACCENT_SOFT = "#7dd3fc";
const TEXT = "#e8eef8";
const MUTED = "#8a93a6";
const GREEN = "#22c55e";
const GREEN_SOFT = "#4ade80";
const RED = "#ef4444";
// Datos/tiempos en mono (estética de cronómetro de timing); rótulos en sans.
const MONO = "ui-monospace, 'Cascadia Mono', Consolas, 'DejaVu Sans Mono', monospace";
const SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

// Tamaño de fuente que asegura que `text` entre en `maxW` px, aproximando el
// ancho por cantidad de caracteres (determinístico, sin medir el DOM → válido al
// rasterizar a PNG). Nunca agranda.
function fitSize(text, maxW, desired, factor = 0.6) {
  const s = String(text ?? "");
  if (!s.length || !(maxW > 0)) return desired;
  return Math.max(12, Math.min(desired, maxW / (factor * s.length)));
}

// Etiqueta y color del badge según el estado de la vuelta.
function badgeStyle(model) {
  if (model.isPB) return { label: "PERSONAL BEST", stroke: GREEN, fill: "rgba(34,197,94,0.14)", text: GREEN_SOFT };
  if (model.badge === "INVÁLIDA") return { label: "NO VÁLIDA", stroke: RED, fill: "rgba(239,68,68,0.12)", text: "#fca5a5" };
  return { label: "VUELTA VÁLIDA", stroke: ACCENT, fill: "rgba(56,189,248,0.12)", text: ACCENT_SOFT };
}

// Marca: ala (logo real, como tile redondeado igual que la app) + wordmark "iFly".
function Brand({ x, y, logoUrl, scale = 1 }) {
  const s = 64 * scale;
  return (
    <g transform={`translate(${x},${y})`}>
      {logoUrl && (
        <>
          <defs><clipPath id="sc-logoclip"><rect x="0" y={-s * 0.5} width={s} height={s} rx={s * 0.24} /></clipPath></defs>
          <image href={logoUrl} x="0" y={-s * 0.5} width={s} height={s} clipPath="url(#sc-logoclip)" preserveAspectRatio="xMidYMid slice" />
        </>
      )}
      <text x={logoUrl ? s + 16 : 0} y="0" dominantBaseline="central" fontFamily={SANS} fontSize={40 * scale} fontWeight="800" fill={TEXT} letterSpacing="0.5">
        <tspan>i</tspan><tspan fill={ACCENT}>Fly</tspan>
      </text>
    </g>
  );
}

// Píldora del badge, anclada por su borde derecho a `rightX`.
function Badge({ rightX, y, model, scale = 1 }) {
  const b = badgeStyle(model);
  const fs = 22 * scale;
  const h = 46 * scale;
  const w = 34 * scale + b.label.length * fs * 0.72;
  const x = rightX - w;
  return (
    <g transform={`translate(${x},${y})`}>
      <rect x="0" y="0" rx={h / 2} ry={h / 2} width={w} height={h} fill={b.fill} stroke={b.stroke} strokeWidth={1.5 * scale} />
      <text x={w / 2} y={h / 2} textAnchor="middle" dominantBaseline="central" fontFamily={SANS} fontSize={fs} fontWeight="700" fill={b.text} letterSpacing="1.5">{b.label}</text>
    </g>
  );
}

// Chip de un sector: rótulo (S1) + valor mono.
function SectorChip({ x, y, w, h, s, scale = 1 }) {
  return (
    <g transform={`translate(${x},${y})`}>
      <rect x="0" y="0" width={w} height={h} rx={12 * scale} fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.08)" />
      <text x={16 * scale} y={h / 2} dominantBaseline="central" fontFamily={SANS} fontSize={17 * scale} fontWeight="700" fill={MUTED} letterSpacing="1">{s.label}</text>
      <text x={w - 16 * scale} y={h / 2} textAnchor="end" dominantBaseline="central" fontFamily={MONO} fontSize={24 * scale} fill={TEXT}>{s.value}</text>
    </g>
  );
}

// Bloque de datos (eyebrow + tiempo + divisor + pista/auto + sectores + fecha).
// `col` = { x, top, w } de la columna donde se apila. `scale` ajusta tamaños.
function DataBlock({ col, model, scale = 1 }) {
  const timeSize = fitSize(model.time, col.w, 112 * scale, 0.58);
  const trackSize = fitSize(model.track, col.w, 40 * scale, 0.56);
  const carSize = fitSize(model.car, col.w, 28 * scale, 0.56);
  const eyeY = col.top;
  const timeY = eyeY + timeSize * 0.82 + 14 * scale;
  const divY = timeY + 30 * scale;
  const trackY = divY + 44 * scale;
  const carY = trackY + carSize + 12 * scale;
  const chipH = 52 * scale;
  const chipGap = 14 * scale;
  const chipsY = carY + 22 * scale;
  const n = Math.max(1, model.sectors.length);
  const chipW = (col.w - (n - 1) * chipGap) / n;
  return (
    <g>
      <text x={col.x} y={eyeY} fontFamily={SANS} fontSize={19 * scale} fontWeight="700" fill={MUTED} letterSpacing="4">VUELTA</text>
      <text x={col.x} y={timeY} fontFamily={MONO} fontSize={timeSize} fontWeight="700" fill={TEXT}>{model.time}</text>
      <line x1={col.x} y1={divY} x2={col.x + col.w} y2={divY} stroke={ACCENT} strokeWidth={2 * scale} opacity="0.7" />
      <text x={col.x} y={trackY} fontFamily={SANS} fontSize={trackSize} fontWeight="800" fill={TEXT}>{model.track}</text>
      <text x={col.x} y={carY} fontFamily={SANS} fontSize={carSize} fontWeight="600" fill={MUTED}>{[model.car, model.date].filter(Boolean).join("  ·  ")}</text>
      {model.sectors.map((s, i) => (
        <SectorChip key={i} x={col.x + i * (chipW + chipGap)} y={chipsY} w={chipW} h={chipH} s={s} scale={scale} />
      ))}
    </g>
  );
}

// Tarjeta SVG para compartir una vuelta. El <svg> se expone por ref para
// rasterizarlo a PNG (ver render-svg-to-png). `mapEls` es el subárbol del mapa
// ya alineado y ESCALADO por el contenedor; acá solo se traslada a su caja.
// `logoUrl` es el logo (ala) como data URL (embebido, para que el PNG lo incluya).
export const ShareCard = forwardRef(function ShareCard({ model, mapEls, format = "square", logoUrl = null }, ref) {
  const F = FORMATS[format] || FORMATS.square;
  const { w, h } = F;
  const map = shareMapBox(format);
  const wide = format === "wide";
  const sc = format === "story" ? 1.25 : 1;

  // Columna de datos: a la derecha del mapa en 'wide', debajo en apilado.
  const col = wide
    ? { x: map.x + map.w + 56, top: 150, w: w - (map.x + map.w + 56) - 64 }
    : { x: 64, top: map.y + map.h + (format === "story" ? 120 : 78), w: w - 128 };

  return (
    <svg ref={ref} width={w} height={h} viewBox={`0 0 ${w} ${h}`} xmlns="http://www.w3.org/2000/svg" style={{ background: INK }}>
      <defs>
        {/* Glow neón del mapa (hace eco del ala del logo). */}
        <filter id="sc-glow" x="-25%" y="-25%" width="150%" height="150%">
          <feGaussianBlur in="SourceGraphic" stdDeviation={3.5} result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        {/* Halo ambiental detrás del mapa. */}
        <radialGradient id="sc-ambient" cx="50%" cy="45%" r="62%">
          <stop offset="0%" stopColor={ACCENT} stopOpacity="0.16" />
          <stop offset="100%" stopColor={ACCENT} stopOpacity="0" />
        </radialGradient>
      </defs>

      <rect x="0" y="0" width={w} height={h} fill={INK} />

      {/* Panel de datos sutil para "asentar" la info (no dejarla flotando). */}
      {wide ? (
        <rect x={col.x - 32} y="96" width={w - (col.x - 32) - 56} height={h - 192} rx="28" fill="rgba(255,255,255,0.03)" />
      ) : (
        <rect x="40" y={col.top - 56} width={w - 80} height={h - (col.top - 56) - 48} rx="28" fill="rgba(255,255,255,0.03)" />
      )}

      {/* Marca + badge, arriba. */}
      <Brand x="64" y={wide ? 74 : 70} logoUrl={logoUrl} scale={sc} />
      <Badge rightX={w - 64} y={wide ? 50 : 46} model={model} scale={sc} />

      {/* Divisor vertical entre mapa y datos (solo apaisado). */}
      {wide && <line x1={map.x + map.w + 28} y1="130" x2={map.x + map.w + 28} y2={h - 130} stroke="rgba(255,255,255,0.08)" strokeWidth="2" />}

      {/* Mapa héroe: halo + trazada con glow. */}
      <ellipse cx={map.x + map.w / 2} cy={map.y + map.h / 2} rx={map.w * 0.52} ry={map.h * 0.52} fill="url(#sc-ambient)" />
      <g transform={`translate(${map.x},${map.y})`} filter="url(#sc-glow)">{mapEls}</g>

      {/* Datos. */}
      <DataBlock col={col} model={model} scale={sc} />
    </svg>
  );
});
