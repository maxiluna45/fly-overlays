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
const RED_SOFT = "#f87171";
// Bahnschrift: sans técnica/condensada (estilo DIN, motorsport) que trae Windows.
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

// Línea (y área opcional) de una traza normalizada 0..1 dentro de `box`.
function TracePath({ box, pts, color, sw, fill = null }) {
  const px = (p) => (box.x + p.x * box.w).toFixed(1);
  const py = (p) => (box.y + box.h - p.y * box.h).toFixed(1);
  let line = "";
  pts.forEach((p, i) => { line += `${i ? " L" : "M"}${px(p)} ${py(p)}`; });
  return (
    <>
      {fill && <path d={`${line} L${(box.x + box.w).toFixed(1)} ${(box.y + box.h).toFixed(1)} L${box.x.toFixed(1)} ${(box.y + box.h).toFixed(1)} Z`} fill={fill} />}
      <path d={line} fill="none" stroke={color} strokeWidth={sw} strokeLinejoin="round" strokeLinecap="round" />
    </>
  );
}

// Bloque de datos con LAYOUT DISTRIBUIDO: cada bloque declara su alto; el espacio
// sobrante de la región lo absorben primero los gráficos (flex) y después los
// gaps (parejos, con tope). Si aún sobra, la pila se centra. Así ningún formato
// queda con huecos muertos ni amontonado.
function DataBlock({ region, model, scale = 1, mapMode = "speed", charts = [] }) {
  const { x, top, w, bottom } = region;
  const blocks = [];

  // 1) Encabezado: eyebrow + tiempo + divisor.
  const eye = 20 * scale;
  const timeSize = fitSize(model.time, w, 130 * scale, 0.5);
  blocks.push({
    h: eye + 12 * scale + timeSize * 0.88 + 18 * scale,
    render: (y) => (
      <g key="hd">
        <text x={x} y={y + eye} fontFamily={SANS} fontSize={eye} fontWeight="700" fill={MUTED} letterSpacing="5">VUELTA</text>
        <text x={x} y={y + eye + 12 * scale + timeSize * 0.78} fontFamily={BAHN} fontSize={timeSize} fontWeight="700" fill={TEXT} letterSpacing="1">{model.time}</text>
        <line x1={x} y1={y + eye + 12 * scale + timeSize * 0.88 + 16 * scale} x2={x + w} y2={y + eye + 12 * scale + timeSize * 0.88 + 16 * scale} stroke={ACCENT} strokeWidth={2 * scale} opacity="0.75" />
      </g>
    ),
  });

  // 2) Tiles: sectores si hay; si no, Vmáx/Vprom.
  const tiles = model.sectors.length
    ? model.sectors.map((s) => ({ label: s.label, value: s.value }))
    : [
        model.topSpeedKmh != null && { label: "VMÁX", value: model.topSpeedKmh, unit: "km/h" },
        model.avgSpeedKmh != null && { label: "VPROM", value: model.avgSpeedKmh, unit: "km/h" },
      ].filter(Boolean);
  if (tiles.length) {
    const th = 68 * scale, gap = 14 * scale;
    const tw = (w - (tiles.length - 1) * gap) / tiles.length;
    blocks.push({
      h: th,
      render: (y) => (
        <g key="tiles">
          {tiles.map((t, i) => <Tile key={i} x={x + i * (tw + gap)} y={y} w={tw} h={th} label={t.label} value={t.value} unit={t.unit} scale={scale} />)}
        </g>
      ),
    });
  }

  // 3) Gráficos elegidos por el usuario (flex: absorben el espacio sobrante).
  const lblH = 26 * scale;
  const sw = 2.5 * scale;
  if (charts.includes("speed") && Array.isArray(model.spark) && model.spark.length > 3) {
    blocks.push({
      h: 130 * scale, flex: true,
      render: (y, h) => {
        const box = { x, y: y + lblH, w, h: h - lblH };
        return (
          <g key="c-sp">
            <text x={x} y={y + 15 * scale} fontFamily={SANS} fontSize={15 * scale} fontWeight="700" fill={MUTED} letterSpacing="2">VELOCIDAD</text>
            <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={10 * scale} fill="rgba(255,255,255,0.03)" />
            <TracePath box={box} pts={model.spark} color={ACCENT_SOFT} sw={sw} fill="url(#sc-spark)" />
          </g>
        );
      },
    });
  }
  if (charts.includes("pedals") && ((model.sparkTh && model.sparkTh.length > 3) || (model.sparkBr && model.sparkBr.length > 3))) {
    blocks.push({
      h: 130 * scale, flex: true,
      render: (y, h) => {
        const box = { x, y: y + lblH, w, h: h - lblH };
        return (
          <g key="c-ped">
            <text x={x} y={y + 15 * scale} fontFamily={SANS} fontSize={15 * scale} fontWeight="700" letterSpacing="2">
              <tspan fill={GREEN_SOFT}>ACELERADOR</tspan><tspan fill={MUTED}>  ·  </tspan><tspan fill={RED_SOFT}>FRENO</tspan>
            </text>
            <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={10 * scale} fill="rgba(255,255,255,0.03)" />
            {model.sparkTh && <TracePath box={box} pts={model.sparkTh} color={GREEN_SOFT} sw={sw} />}
            {model.sparkBr && <TracePath box={box} pts={model.sparkBr} color={RED_SOFT} sw={sw} />}
          </g>
        );
      },
    });
  }

  // 4) Leyenda del color del MAPA (según el modo elegido).
  const lg = mapMode === "throttle"
    ? { id: "sc-legend-th", lo: "SIN GAS", hi: "A FONDO" }
    : mapMode === "brake"
    ? { id: "sc-legend-br", lo: "SIN FRENO", hi: "FRENO MÁX" }
    : { id: "sc-legend", lo: "LENTO", hi: "RÁPIDO" };
  blocks.push({
    h: 34 * scale,
    render: (y) => {
      const lw = Math.min(w, 260 * scale);
      return (
        <g key="lg" transform={`translate(${x},${y})`}>
          <rect x="0" y="0" width={lw} height={8 * scale} rx={4 * scale} fill={`url(#${lg.id})`} />
          <text x="0" y={26 * scale} fontFamily={SANS} fontSize={13 * scale} fill={MUTED} letterSpacing="1">{lg.lo}</text>
          <text x={lw} y={26 * scale} textAnchor="end" fontFamily={SANS} fontSize={13 * scale} fill={MUTED} letterSpacing="1">{lg.hi}</text>
        </g>
      );
    },
  });

  // 5) Meta: pista + auto/piloto/fecha.
  const trackSize = fitSize(model.track, w, 42 * scale, 0.55);
  const carSize = 26 * scale;
  const metaLine = [model.car, model.driver, model.date].filter(Boolean).join("  ·  ");
  const metaSize = fitSize(metaLine, w, carSize, 0.52);
  blocks.push({
    h: trackSize + 12 * scale + metaSize,
    render: (y) => (
      <g key="meta">
        <text x={x} y={y + trackSize * 0.9} fontFamily={SANS} fontSize={trackSize} fontWeight="800" fill={TEXT}>{model.track}</text>
        <text x={x} y={y + trackSize + 12 * scale + metaSize * 0.8} fontFamily={SANS} fontSize={metaSize} fontWeight="600" fill={MUTED}>{metaLine}</text>
      </g>
    ),
  });

  // ── Distribución del espacio ──
  const n = blocks.length;
  const minGap = 20 * scale, maxGap = 48 * scale;
  let totalH = blocks.reduce((a, b) => a + b.h, 0);
  let gap = n > 1 ? ((bottom - top) - totalH) / (n - 1) : 0;
  const flex = blocks.filter((b) => b.flex);
  if (gap > maxGap && flex.length) {
    // El exceso lo absorben los gráficos (crecen), gaps quedan al tope.
    const extra = (gap - maxGap) * (n - 1);
    for (const b of flex) b.h += extra / flex.length;
    gap = maxGap;
  }
  let offset = 0;
  if (gap > maxGap) {
    // Sin gráficos que crezcan: gaps al tope y la pila se centra en la región.
    offset = ((gap - maxGap) * (n - 1)) / 2;
    gap = maxGap;
  }
  gap = Math.max(minGap, gap);

  let y = top + offset;
  const els = blocks.map((b) => { const el = b.render(y, b.h); y += b.h + gap; return el; });
  return <g>{els}</g>;
}

// Tarjeta SVG para compartir una vuelta. El <svg> se expone por ref para
// rasterizarlo a PNG. `mapEls` = subárbol del mapa ya alineado y escalado;
// `logoUrl` = logo (ala) como data URL; `hasSat` = mapa satelital (sin halo);
// `mapMode` = canal que colorea el mapa; `charts` = gráficos elegidos.
export const ShareCard = forwardRef(function ShareCard({ model, mapEls, format = "square", logoUrl = null, hasSat = false, mapMode = "speed", charts = ["speed"] }, ref) {
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
        <linearGradient id="sc-legend-th" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="rgb(70,78,90)" />
          <stop offset="100%" stopColor="rgb(46,204,113)" />
        </linearGradient>
        <linearGradient id="sc-legend-br" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="rgb(70,78,90)" />
          <stop offset="100%" stopColor="rgb(239,68,68)" />
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

      <DataBlock region={region} model={model} scale={sc} mapMode={mapMode} charts={charts} />
    </svg>
  );
});
