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
// Bahnschrift: sans técnica/condensada (estilo DIN, motorsport) que trae Windows.
// Se usa para tiempos y números; el texto va en Segoe UI. Nada de mono caricaturesca.
const BAHN = "'Bahnschrift', 'DIN Alternate', 'Segoe UI', system-ui, sans-serif";
const SANS = "'Segoe UI', system-ui, -apple-system, sans-serif";

// Tamaño de fuente que asegura que `text` entre en `maxW` px (determinístico, sin
// medir el DOM → válido al rasterizar a PNG). Nunca agranda.
function fitSize(text, maxW, desired, factor = 0.55) {
  const s = String(text ?? "");
  if (!s.length || !(maxW > 0)) return desired;
  return Math.max(12, Math.min(desired, maxW / (factor * s.length)));
}

function badgeStyle(model) {
  if (model.isPB) return { label: "PERSONAL BEST", stroke: GREEN, fill: "rgba(34,197,94,0.14)", text: GREEN_SOFT };
  if (model.badge === "INVÁLIDA") return { label: "NO VÁLIDA", stroke: RED, fill: "rgba(239,68,68,0.12)", text: "#fca5a5" };
  return { label: "VUELTA VÁLIDA", stroke: ACCENT, fill: "rgba(56,189,248,0.12)", text: ACCENT_SOFT };
}

// Marca: ala (logo real, tile redondeado como la app) + wordmark "iFly".
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
  return (
    <g transform={`translate(${rightX - w},${y})`}>
      <rect x="0" y="0" rx={h / 2} ry={h / 2} width={w} height={h} fill={b.fill} stroke={b.stroke} strokeWidth={1.5 * scale} />
      <text x={w / 2} y={h / 2} textAnchor="middle" dominantBaseline="central" fontFamily={SANS} fontSize={fs} fontWeight="700" fill={b.text} letterSpacing="1.5">{b.label}</text>
    </g>
  );
}

// Tile de dato (sector o stat): rótulo arriba, valor grande abajo (Bahnschrift).
function Tile({ x, y, w, h, label, value, unit, scale = 1 }) {
  const vs = fitSize(`${value}${unit ? " " + unit : ""}`, w - 26 * scale, 32 * scale, 0.5);
  return (
    <g transform={`translate(${x},${y})`}>
      <rect x="0" y="0" width={w} height={h} rx={12 * scale} fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.09)" />
      <text x={16 * scale} y={24 * scale} fontFamily={SANS} fontSize={15 * scale} fontWeight="700" fill={MUTED} letterSpacing="1.5">{label}</text>
      <text x={16 * scale} y={h - 16 * scale} fontFamily={BAHN} fontSize={vs} fontWeight="700" fill={TEXT}>
        {value}{unit && <tspan fontFamily={SANS} fontSize={14 * scale} fontWeight="600" fill={MUTED}> {unit}</tspan>}
      </text>
    </g>
  );
}

// Sparkline de velocidad: área con degradado + línea.
function Spark({ box, spark, scale = 1 }) {
  const px = (p) => (box.x + p.x * box.w).toFixed(1);
  const py = (p) => (box.y + box.h - p.y * box.h).toFixed(1);
  let line = "";
  spark.forEach((p, i) => { line += `${i ? " L" : "M"}${px(p)} ${py(p)}`; });
  const area = `${line} L${(box.x + box.w).toFixed(1)} ${(box.y + box.h).toFixed(1)} L${box.x.toFixed(1)} ${(box.y + box.h).toFixed(1)} Z`;
  return (
    <g>
      <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={10 * scale} fill="rgba(255,255,255,0.03)" />
      <path d={area} fill="url(#sc-spark)" />
      <path d={line} fill="none" stroke={ACCENT_SOFT} strokeWidth={2.5 * scale} strokeLinejoin="round" strokeLinecap="round" />
    </g>
  );
}

// Bloque de datos, apilado con un cursor vertical dentro de `region`
// { x, top, w, bottom }. La meta (pista/auto/fecha) se ancla al pie.
function DataBlock({ region, model, scale = 1 }) {
  const { x, top, w, bottom } = region;
  const els = [];
  let y = top;

  const eye = 20 * scale;
  els.push(<text key="eye" x={x} y={y + eye} fontFamily={SANS} fontSize={eye} fontWeight="700" fill={MUTED} letterSpacing="5">VUELTA</text>);
  y += eye + 12 * scale;

  const timeSize = fitSize(model.time, w, 130 * scale, 0.5);
  els.push(<text key="time" x={x} y={y + timeSize * 0.8} fontFamily={BAHN} fontSize={timeSize} fontWeight="700" fill={TEXT} letterSpacing="1">{model.time}</text>);
  y += timeSize * 0.85 + 16 * scale;

  els.push(<line key="div" x1={x} y1={y} x2={x + w} y2={y} stroke={ACCENT} strokeWidth={2 * scale} opacity="0.75" />);
  y += 24 * scale;

  // Fila de tiles: sectores si hay, si no Vmáx/Vprom (siempre hay muestras).
  const tiles = model.sectors.length
    ? model.sectors.map((s) => ({ label: s.label, value: s.value }))
    : [
        model.topSpeedKmh != null && { label: "VMÁX", value: model.topSpeedKmh, unit: "km/h" },
        model.avgSpeedKmh != null && { label: "VPROM", value: model.avgSpeedKmh, unit: "km/h" },
      ].filter(Boolean);
  if (tiles.length) {
    const gap = 14 * scale, th = 68 * scale;
    const tw = (w - (tiles.length - 1) * gap) / tiles.length;
    tiles.forEach((t, i) => els.push(<Tile key={`t${i}`} x={x + i * (tw + gap)} y={y} w={tw} h={th} label={t.label} value={t.value} unit={t.unit} scale={scale} />));
    y += th + 24 * scale;
  }

  // Sparkline de velocidad + leyenda, solo si entra (deja aire para la meta).
  const metaReserve = 96 * scale;
  if (Array.isArray(model.spark) && model.spark.length > 3 && bottom - y - metaReserve > 90 * scale) {
    els.push(<text key="spklbl" x={x} y={y + 14 * scale} fontFamily={SANS} fontSize={15 * scale} fontWeight="700" fill={MUTED} letterSpacing="2">VELOCIDAD</text>);
    y += 26 * scale;
    const sh = Math.min(180 * scale, bottom - y - metaReserve - 34 * scale);
    els.push(<Spark key="spk" box={{ x, y, w, h: sh }} spark={model.spark} scale={scale} />);
    y += sh + 12 * scale;
    const lw = Math.min(w, 240 * scale);
    els.push(
      <g key="lg" transform={`translate(${x},${y})`}>
        <rect x="0" y="0" width={lw} height={8 * scale} rx={4 * scale} fill="url(#sc-legend)" />
        <text x="0" y={26 * scale} fontFamily={SANS} fontSize={13 * scale} fill={MUTED} letterSpacing="1">LENTO</text>
        <text x={lw} y={26 * scale} textAnchor="end" fontFamily={SANS} fontSize={13 * scale} fill={MUTED} letterSpacing="1">RÁPIDO</text>
      </g>
    );
  }

  // Meta anclada al pie.
  const trackSize = fitSize(model.track, w, 42 * scale, 0.55);
  const carSize = 26 * scale;
  els.push(<text key="track" x={x} y={bottom - carSize - 14 * scale} fontFamily={SANS} fontSize={trackSize} fontWeight="800" fill={TEXT}>{model.track}</text>);
  els.push(<text key="meta" x={x} y={bottom} fontFamily={SANS} fontSize={carSize} fontWeight="600" fill={MUTED}>{[model.car, model.date].filter(Boolean).join("  ·  ")}</text>);

  return <g>{els}</g>;
}

// Tarjeta SVG para compartir una vuelta. El <svg> se expone por ref para
// rasterizarlo a PNG. `mapEls` es el subárbol del mapa ya alineado y escalado;
// `logoUrl` es el logo (ala) como data URL; `hasSat` = el mapa es satelital
// (se omite el halo neón, que solo pega con la trazada sobre fondo oscuro).
export const ShareCard = forwardRef(function ShareCard({ model, mapEls, format = "square", logoUrl = null, hasSat = false }, ref) {
  const F = FORMATS[format] || FORMATS.square;
  const { w, h } = F;
  const map = shareMapBox(format);
  const wide = format === "wide";
  const sc = format === "story" ? 1.25 : 1;

  const region = wide
    ? { x: map.x + map.w + 56, top: 150, w: w - (map.x + map.w + 56) - 64, bottom: h - 64 }
    : { x: 64, top: map.y + map.h + (format === "story" ? 70 : 48), w: w - 128, bottom: h - 56 };

  return (
    <svg ref={ref} width={w} height={h} viewBox={`0 0 ${w} ${h}`} xmlns="http://www.w3.org/2000/svg" style={{ background: INK }}>
      <defs>
        <filter id="sc-glow" x="-25%" y="-25%" width="150%" height="150%">
          <feGaussianBlur in="SourceGraphic" stdDeviation={3.5} result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <radialGradient id="sc-ambient" cx="50%" cy="45%" r="60%">
          <stop offset="0%" stopColor={ACCENT} stopOpacity="0.10" />
          <stop offset="100%" stopColor={ACCENT} stopOpacity="0" />
        </radialGradient>
        <linearGradient id="sc-spark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={ACCENT} stopOpacity="0.38" />
          <stop offset="100%" stopColor={ACCENT} stopOpacity="0" />
        </linearGradient>
        <linearGradient id="sc-legend" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="hsl(240,85%,55%)" />
          <stop offset="35%" stopColor="hsl(160,85%,50%)" />
          <stop offset="65%" stopColor="hsl(55,90%,55%)" />
          <stop offset="100%" stopColor="hsl(0,85%,55%)" />
        </linearGradient>
      </defs>

      <rect x="0" y="0" width={w} height={h} fill={INK} />

      {/* Panel de datos sutil (para asentar la info). */}
      {wide ? (
        <rect x={region.x - 32} y="96" width={w - (region.x - 32) - 56} height={h - 192} rx="28" fill="rgba(255,255,255,0.03)" />
      ) : (
        <rect x="40" y={region.top - 44} width={w - 80} height={h - (region.top - 44) - 40} rx="28" fill="rgba(255,255,255,0.03)" />
      )}

      <Brand x="64" y={wide ? 74 : 70} logoUrl={logoUrl} scale={sc} />
      <Badge rightX={w - 64} y={wide ? 50 : 46} model={model} scale={sc} />

      {wide && <line x1={map.x + map.w + 28} y1="130" x2={map.x + map.w + 28} y2={h - 130} stroke="rgba(255,255,255,0.08)" strokeWidth="2" />}

      {/* Mapa héroe: halo ambiental solo con mapa vectorial (no con satélite). */}
      {!hasSat && <ellipse cx={map.x + map.w / 2} cy={map.y + map.h / 2} rx={map.w * 0.42} ry={map.h * 0.42} fill="url(#sc-ambient)" />}
      <g transform={`translate(${map.x},${map.y})`}>{mapEls}</g>

      <DataBlock region={region} model={model} scale={sc} />
    </svg>
  );
});
