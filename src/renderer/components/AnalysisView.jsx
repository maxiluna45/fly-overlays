import React, { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { Trash2, Trophy, Clock, Activity, Gauge, Upload, FolderOpen, RotateCcw, Pencil, Check, X, Search, ExternalLink, Maximize2, Crop } from "lucide-react";
import { analyzeLap, bestLapOf, consistency, sectorTimes, sessionOptimal, cornerConsistency, resampleSamples, drivingMetrics } from "../lib/coach.js";
import { isComparableReference } from "../lib/session-match.js";
import { buildTrackSegments, fitSimilarity, applySim, fitAffine, applyAffine, speedColor, autoMapRotation } from "../lib/track-render.js";
import { hasChassisData, chassisSeries, chassisSummary, WHEEL_LABEL } from "../lib/chassis.js";
import { ShareCard } from "./ShareCard.jsx";
import { buildCardModel, FORMATS, shareMapBox, countShareCharts, sanitizeFilename } from "../lib/share-card-data.js";
import { svgToPngBlob } from "../lib/render-svg-to-png.js";
import lovelyTracks from "../assets/lovely-tracks.json"; // curvas + sectores por pista (© Lovely Sim Racing, CC BY-NC-SA)

// Ancho de asfalto (metros) para engrosar el eje de OSM y dibujar ambos bordes.
// OSM no guarda el ancho de pista; ~14 m es un valor típico de circuito de GP y
// contiene la línea de carrera (medido en Spa: p95 6 m del eje, máx 11.7 m).
const ROAD_WIDTH_M = 14;

function fmtLap(s) {
  if (s == null || !isFinite(s) || s <= 0) return "—";
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(3).padStart(6, "0")}`;
}
function fmtDelta(s) {
  if (s == null || !isFinite(s)) return "—";
  return `${s >= 0 ? "+" : "−"}${Math.abs(s).toFixed(3)}`;
}
function fmtDate(ms) {
  try {
    const d = new Date(ms);
    return d.toLocaleString("es-CO", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch (_) { return ""; }
}

// Fecha corta (día/mes hh:mm) para identificar sesiones que se llaman igual.
function fmtShortDate(ms) {
  try {
    const d = new Date(ms);
    return d.toLocaleString("es-CO", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch (_) { return ""; }
}

// Helpers para los tooltips de los gráficos (valor en un bucket + formato).
const atv = (arr, i) => (arr && i != null && arr[i] != null && isFinite(arr[i]) ? arr[i] : null);
const tPct = (v) => (v != null ? `${Math.round(v * 100)}%` : "—");
const tKmh = (v) => (v != null ? `${Math.round(v)}` : "—");
const tDeg = (v) => (v != null ? `${Math.round((v * 180) / Math.PI)}°` : "—");
const tRpm = (v) => (v != null ? `${Math.round(v)}` : "—");
const tSec = (v) => (v != null ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}` : "—");
// Colores de las 4 ruedas en el gráfico de suspensión (orden LF, RF, LR, RR).
const SUSP_COLORS = ["rgb(125,211,252)", "rgb(52,211,153)", "rgb(234,179,8)", "rgb(244,114,182)"];
const tBar = (v) => (v != null ? `${Math.round(v)}` : "—");
const tMm = (v) => (v != null ? `${Math.round(v * 1000)}` : "—");
const tVel = (v) => (v != null ? v.toFixed(2) : "—");
const pctLabel = (f) => `${Math.round(f * 100)}%`;

// Tag corto de tipo de sesión: Q (qualy), R (race), P (practice/test).
function stTag(sessionType) {
  const t = (sessionType || "").toLowerCase();
  if (t.includes("qual")) return "Q";
  if (t.includes("race")) return "R";
  if (t.includes("practice") || t.includes("test") || t.includes("warm")) return "P";
  return t ? t[0].toUpperCase() : "?";
}

// Construye un path SVG desde una serie (con nulls = huecos).
function seriesPath(vals, n, yMin, yMax, W, H, range) {
  const span = yMax - yMin || 1;
  // range = [aFrac, bFrac] (0..1): dibuja solo esa porción, expandida a todo el
  // ancho (zoom en X). Sin range → toda la vuelta (comportamiento normal).
  const aF = range && range.length === 2 ? range[0] : 0;
  const bF = range && range.length === 2 ? range[1] : 1;
  const aI = aF * (n - 1), bI = bF * (n - 1), denom = (bI - aI) || 1;
  let d = "";
  let pen = false;
  for (let i = 0; i < n; i++) {
    const v = vals[i];
    if (i < aI - 1 || i > bI + 1 || v == null || !isFinite(v)) { pen = false; continue; }
    const x = ((i - aI) / denom) * W;
    const y = H - ((v - yMin) / span) * H;
    d += `${pen ? " L" : " M"}${x.toFixed(1)},${y.toFixed(1)}`;
    pen = true;
  }
  return d.trim();
}

// Construye un path SVG suave (Bézier cúbica con tangentes Catmull-Rom, tensión
// 1/6) a partir de una lista de puntos {x,y}; los null cortan en subtrazados.
function smoothPath(pts) {
  if (!Array.isArray(pts)) return "";
  let d = "", i = 0;
  const f = (n) => n.toFixed(1);
  while (i < pts.length) {
    if (!pts[i]) { i++; continue; }
    let j = i;
    const run = [];
    while (j < pts.length && pts[j]) { run.push(pts[j]); j++; }
    d += `M${f(run[0].x)},${f(run[0].y)}`;
    for (let k = 1; k < run.length; k++) {
      const a = run[k - 1], b = run[k];
      const p0 = run[k - 2] || a, p3 = run[k + 1] || b;
      const c1x = a.x + (b.x - p0.x) / 6, c1y = a.y + (b.y - p0.y) / 6;
      const c2x = b.x - (p3.x - a.x) / 6, c2y = b.y - (p3.y - a.y) / 6;
      d += `C${f(c1x)},${f(c1y)} ${f(c2x)},${f(c2y)} ${f(b.x)},${f(b.y)}`;
    }
    i = j;
  }
  return d;
}

// ── Mapa de pista desde SVG de iRacing ──
// Parsea el SVG, samplea el path por LapDistPct y alinea la línea GPS del auto
// a la forma real del circuito con un ajuste de similitud 2D (escala + rotación
// + traslación). Así se ve el contorno real del trazado y encima la línea por
// donde efectivamente pasó el auto.

let _hiddenSvg = null;
function pathSampler(d) {
  if (typeof document === "undefined") return null;
  if (!_hiddenSvg) {
    _hiddenSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    _hiddenSvg.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden;left:-9999px");
    document.body.appendChild(_hiddenSvg);
  }
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", d);
  _hiddenSvg.appendChild(p);
  let total = 0;
  try { total = p.getTotalLength(); } catch (_) {}
  const at = (frac) => {
    const f = ((frac % 1) + 1) % 1;
    try { const pt = p.getPointAtLength(f * total); return { x: pt.x, y: pt.y }; } catch (_) { return { x: 0, y: 0 }; }
  };
  return { total, at, dispose: () => { try { _hiddenSvg.removeChild(p); } catch (_) {} } };
}

function parseTrackSvg(svgText) {
  try {
    const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const svg = doc.querySelector("svg");
    if (!svg) return null;
    let vb = svg.getAttribute("viewBox");
    // sampleD = un path continuo (el más largo) para muestrear por LapDistPct.
    // outlineD = TODOS los paths juntos (inside + outside) para dibujar el
    // contorno completo de la pista (ambos bordes).
    const ds = [];
    let sampleD = null, best = 0;
    for (const p of doc.querySelectorAll("path")) {
      const dd = p.getAttribute("d") || "";
      if (!dd) continue;
      ds.push(dd);
      if (dd.length > best) { best = dd.length; sampleD = dd; }
    }
    if (!sampleD) return null;
    return { sampleD, outlineD: ds.join(" "), viewBox: vb };
  } catch (_) { return null; }
}

function Chart({ title, height = 110, n, hoverIdx, onHover, corners, children, tooltip = null, hasRef = false, range = null, selecting = false, onSelectRange }) {
  const aF = range && range.length === 2 ? range[0] : 0;
  const bF = range && range.length === 2 ? range[1] : 1;
  const spanF = (bF - aF) || 1;
  const interactive = n > 1 && typeof onHover === "function";
  const toView = (frac) => (frac - aF) / spanF; // frac real (0..1) → frac de la vista
  const hViewFrac = hoverIdx != null && n > 1 ? toView(hoverIdx / (n - 1)) : null;
  const hx = hViewFrac != null && hViewFrac >= -0.002 && hViewFrac <= 1.002 ? hViewFrac * 1000 : null;

  const dragRef = React.useRef(null);
  const [sel, setSel] = React.useState(null); // {a,b} en fracs de la vista

  const viewFrac = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  const handleDown = (e) => { if (selecting) { const f = viewFrac(e); dragRef.current = f; setSel({ a: f, b: f }); } };
  const handleMove = (e) => {
    if (selecting) { if (dragRef.current != null) setSel({ a: dragRef.current, b: viewFrac(e) }); return; }
    if (!interactive) return;
    const actual = aF + viewFrac(e) * spanF;
    onHover(Math.max(0, Math.min(n - 1, Math.round(actual * (n - 1)))));
  };
  const finishSel = () => {
    if (selecting && dragRef.current != null && sel) {
      const lo = Math.min(sel.a, sel.b), hi = Math.max(sel.a, sel.b);
      if (hi - lo > 0.015 && typeof onSelectRange === "function") onSelectRange([aF + lo * spanF, aF + hi * spanF]);
    }
    dragRef.current = null; setSel(null);
  };
  const handleLeave = () => { if (selecting) finishSel(); else if (interactive) onHover(null); };

  const showTip = !selecting && tooltip && tooltip.length > 0 && hx != null;
  const tipFrac = hViewFrac != null ? Math.max(0, Math.min(1, hViewFrac)) : 0;
  return (
    <div className="rounded-lg border border-border bg-card/40 p-3">
      <div className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-2">{title}</div>
      <div className="relative" onMouseDown={handleDown} onMouseMove={handleMove} onMouseUp={finishSel} onMouseLeave={handleLeave} style={{ cursor: selecting ? "crosshair" : "default" }}>
        <svg viewBox={`0 0 1000 ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
          {corners && corners.map((c, i) => {
            const cf = toView(c.pct);
            if (cf < 0 || cf > 1) return null;
            return <line key={`c-${i}`} x1={cf * 1000} y1="0" x2={cf * 1000} y2={height} stroke="rgba(255,255,255,0.08)" strokeWidth="1" />;
          })}
          {children}
          {hx != null && <line x1={hx} y1="0" x2={hx} y2={height} stroke="rgba(255,255,255,0.55)" strokeWidth="1.5" />}
          {sel && <rect x={Math.min(sel.a, sel.b) * 1000} y="0" width={Math.abs(sel.b - sel.a) * 1000} height={height} fill="rgba(125,211,252,0.18)" stroke="rgba(125,211,252,0.55)" strokeWidth="1" />}
        </svg>
        {showTip && (
          <div
            className="absolute z-50 pointer-events-none rounded-md border border-border bg-[rgba(12,14,20,0.96)] px-2 py-1.5 shadow-lg text-[10px] space-y-0.5"
            style={{ top: 4, left: `${tipFrac * 100}%`, transform: tipFrac > 0.55 ? "translateX(calc(-100% - 8px))" : "translateX(8px)" }}
          >
            {hasRef && (
              <div className="flex items-center justify-end gap-2 text-[8px] uppercase tracking-widest text-muted-foreground/60 pb-0.5 mb-0.5 border-b border-border/60">
                <span>vuelta</span><span>ref</span>
              </div>
            )}
            {tooltip.map((r, i) => (
              <div key={i} className="flex items-center gap-1.5 whitespace-nowrap">
                <span className="size-1.5 rounded-full shrink-0" style={{ background: r.color }} />
                <span className="text-muted-foreground mr-auto">{r.label}</span>
                <span className="font-mono font-semibold text-foreground tabular-nums">{r.value}</span>
                {hasRef && <span className="font-mono text-muted-foreground/70 tabular-nums">{r.ref != null ? r.ref : "—"}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ToggleBtn({ active, onClick, color, children }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold transition-colors"
      style={{ background: active ? "rgba(255,255,255,0.08)" : "transparent", color: active ? "var(--color-text)" : "rgba(255,255,255,0.4)" }}
    >
      <span className="size-2 rounded-full" style={{ background: active ? color : "rgba(255,255,255,0.25)" }} />
      {children}
    </button>
  );
}

// Selector de fuente del mapa: SVG del juego (irdashies) · trazado real de OSM ·
// foto satelital (Esri). `avail` = qué fuentes hay para esta pista.
function MapSourceSwitch({ source, setSource, avail }) {
  const opts = [
    { v: "svg", label: "SVG estilizado" },
    { v: "osm", label: "Open Street Map" },
    { v: "sat", label: "Satélite" },
  ].filter((o) => avail[o.v]);
  if (opts.length < 2) return null; // con una sola fuente no hay nada que elegir
  const Btn = ({ v, children }) => (
    <button
      onClick={() => setSource(v)}
      className="px-2 py-0.5 rounded-md text-[10px] font-semibold transition-colors"
      style={{ background: source === v ? "rgba(125,211,252,0.18)" : "transparent", color: source === v ? "rgb(125,211,252)" : "rgba(255,255,255,0.45)" }}
    >
      {children}
    </button>
  );
  return (
    <div className="flex items-center gap-1 rounded-md border border-border/60 p-0.5" title="Fuente del mapa">
      <span className="text-[9px] text-muted-foreground/60 uppercase tracking-wider pl-1 pr-0.5">Mapa</span>
      {opts.map((o) => <Btn key={o.v} v={o.v}>{o.label}</Btn>)}
    </div>
  );
}

// ===== Grip (círculo de fricción) =====
// % del límite de grip usado por bucket: |G combinada| / envolvente(velocidad).
// iRacing no publica el grip real del neumático, así que usamos el proxy
// estándar (Motec "G Sum"): cuánta aceleración total genera el auto vs. la
// máxima que demostró poder generar A ESA VELOCIDAD. La envolvente g-g-v se
// estima de las mismas vueltas (p95 de G combinada por bin de velocidad), por
// lo que se auto-calibra por auto/pista/estado de gomas. Con carga aero esto
// importa: a alta velocidad hay mucho más grip disponible que en curvas lentas,
// y una G-máx única mentiría en ambas.
function buildGripPct(lapSamples, refSamples) {
  const src = [];
  for (const arr of [lapSamples, refSamples]) {
    if (!Array.isArray(arr)) continue;
    for (const s of arr) {
      if (s && s.gLat != null && s.gLon != null && s.sp != null && isFinite(s.sp)) {
        src.push({ sp: s.sp, g: Math.hypot(s.gLat, s.gLon) });
      }
    }
  }
  // Sin suficientes muestras con G (ej: CSV sin columnas de aceleración) no hay modo Grip.
  if (src.length < 40) return { lap: null, ref: null };
  let spLo = Infinity, spHi = -Infinity;
  for (const p of src) { if (p.sp < spLo) spLo = p.sp; if (p.sp > spHi) spHi = p.sp; }
  const BINS = 12;
  const span = Math.max(1e-6, spHi - spLo);
  const byBin = Array.from({ length: BINS }, () => []);
  for (const p of src) {
    const b = Math.min(BINS - 1, Math.max(0, Math.floor(((p.sp - spLo) / span) * BINS)));
    byBin[b].push(p.g);
  }
  // p95 por bin: robusto a picos aislados (pianos, contactos, baches).
  const env = byBin.map((gs) => {
    if (gs.length < 5) return null;
    gs.sort((a, b) => a - b);
    return gs[Math.floor(gs.length * 0.95)];
  });
  // Bins vacíos (velocidades poco visitadas) → vecino no-nulo más cercano.
  for (let i = 0; i < BINS; i++) {
    if (env[i] != null) continue;
    for (let j = 1; j < BINS && env[i] == null; j++) {
      if (env[i - j] != null) env[i] = env[i - j];
      else if (env[i + j] != null) env[i] = env[i + j];
    }
  }
  if (env.some((v) => v == null || !(v > 0))) return { lap: null, ref: null };
  // Envolvente(velocidad): interpolación lineal entre centros de bin.
  const envAt = (sp) => {
    const u = ((sp - spLo) / span) * BINS - 0.5;
    const i0 = Math.max(0, Math.min(BINS - 1, Math.floor(u)));
    const i1 = Math.min(BINS - 1, i0 + 1);
    const t = Math.max(0, Math.min(1, u - i0));
    return env[i0] + (env[i1] - env[i0]) * t;
  };
  const pct = (arr) => (Array.isArray(arr) && arr.length
    ? arr.map((s) => (s && s.gLat != null && s.gLon != null && s.sp != null
      ? Math.min(1, Math.hypot(s.gLat, s.gLon) / Math.max(0.1, envAt(s.sp)))
      : null))
    : null);
  return { lap: pct(lapSamples), ref: pct(refSamples) };
}

// Capa estática de trazadas (memoizada: no re-renderiza en cada hover).
// mode 'speed' → color por velocidad; 'compare' → verde/rojo por dónde ganás/
// perdés tiempo vs la referencia (derivada del delta); 'grip' → % del límite
// de grip usado (gris = margen · verde = medio · amarillo = cerca · rojo = límite).
const TrackLayer = React.memo(function TrackLayer({ segs, segsRef = [], refD, showRef, showLap = true, k, mode, maxSlope }) {
  // Gradiente continuo: verde (ganás más) → gris (neutro) → rojo (perdés más).
  const cmpColor = (dv) => {
    const t = Math.max(-1, Math.min(1, dv / (maxSlope || 1e-9)));
    const grey = [140, 148, 158], green = [52, 211, 153], red = [239, 68, 68];
    const lerp = (a, b, u) => Math.round(a + (b - a) * u);
    const to = t < 0 ? green : red;
    const u = Math.abs(t);
    return `rgb(${lerp(grey[0], to[0], u)},${lerp(grey[1], to[1], u)},${lerp(grey[2], to[2], u)})`;
  };
  // Degradado por intensidad: gris (0%) → color (100%). Separado por canal, así
  // se ve el % real y el trail-braking (freno y gas a la vez, cada uno en su vista).
  const BASE = [70, 78, 90];
  const lerp3 = (a, b, u) => {
    const c = Math.max(0, Math.min(1, u));
    return `rgb(${Math.round(a[0] + (b[0] - a[0]) * c)},${Math.round(a[1] + (b[1] - a[1]) * c)},${Math.round(a[2] + (b[2] - a[2]) * c)})`;
  };
  const throttleColor = (th) => lerp3(BASE, [46, 204, 113], th ?? 0);
  const brakeColor = (br) => lerp3(BASE, [239, 68, 68], br ?? 0);
  // Grip: gris (margen) → verde (uso medio) → amarillo (cerca) → rojo (al límite).
  const GRIP_STOPS = [
    [0.0, [70, 78, 90]],
    [0.6, [46, 204, 113]],
    [0.85, [234, 179, 8]],
    [1.0, [239, 68, 68]],
  ];
  const gripColor = (gr) => {
    if (gr == null || !isFinite(gr)) return "rgb(120,130,145)";
    const v = Math.max(0, Math.min(1, gr));
    for (let i = 1; i < GRIP_STOPS.length; i++) {
      if (v <= GRIP_STOPS[i][0]) {
        const [p0, c0] = GRIP_STOPS[i - 1];
        const [p1, c1] = GRIP_STOPS[i];
        return lerp3(c0, c1, (v - p0) / (p1 - p0 || 1));
      }
    }
    return "rgb(239,68,68)";
  };
  const channelColor = mode === "throttle" ? (s) => throttleColor(s.th)
    : mode === "brake" ? (s) => brakeColor(s.br)
    : mode === "grip" ? (s) => gripColor(s.gr)
    : null;
  const d = (s) => `M${s.x1.toFixed(1)},${s.y1.toFixed(1)}C${s.c1x.toFixed(1)},${s.c1y.toFixed(1)} ${s.c2x.toFixed(1)},${s.c2y.toFixed(1)} ${s.x2.toFixed(1)},${s.y2.toFixed(1)}`;
  const lapColor = (s) => (mode === "compare" ? cmpColor(s.dv) : channelColor ? channelColor(s) : `hsl(${Math.round(s.hue)},85%,55%)`);
  return (
    <g>
      {/* Referencia: en Acelerador/Freno se colorea por su % (punteada); en los
          otros modos, punteada blanca neutra. */}
      {showRef && (channelColor
        ? segsRef.map((s, i) => (
            <path key={`r${i}`} d={d(s)} fill="none" stroke={channelColor(s)} strokeWidth={3 * k} strokeDasharray={`${8 * k} ${5 * k}`} strokeLinecap="round" strokeLinejoin="round" />
          ))
        : refD ? <path d={refD} fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth={3 * k} strokeDasharray={`${7 * k} ${5 * k}`} strokeLinecap="round" /> : null)}
      {/* Tu vuelta */}
      {showLap && segs.map((s, i) => (
        <path key={i} d={d(s)} fill="none" stroke={lapColor(s)} strokeWidth={4.5 * k} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </g>
  );
});

// Mapa interactivo: zoom (rueda / +−), pan (arrastrar), toggle de trazadas y
// marcador del instante bajo el cursor (vinculado a los gráficos de telemetría).
function MapPanel({ mapPath, mapPathRef, mapDelta, hasRef, hoverIdx, baseView, outlineD, corners, fill = false, highlightRange = null, roadWidth = 0, outlineMode = null, tiles = null, attribution = null, scrim = false, gripLap = null, gripRef = null, rot = 0, onRotChange = null, onRotReset = null }) {
  const BV = baseView || { x: 0, y: 0, w: 1000, h: 380 };
  const W = BV.w, H = BV.h, X0 = BV.x, Y0 = BV.y;
  const [showLap, setShowLap] = useState(true);
  const [showRef, setShowRef] = useState(true);
  const [mode, setMode] = useState("speed"); // 'speed' | 'compare' | 'inputs'
  const [view, setView] = useState(BV);
  const [dragging, setDragging] = useState(false);
  // 'compare' necesita referencia y 'grip' datos de G; 'speed' e 'inputs'
  // funcionan siempre.
  const effMode = (mode === "compare" && !hasRef) || (mode === "grip" && !gripLap) ? "speed" : mode;
  const wrapRef = useRef(null);
  const dragRef = useRef(null);
  // Factor de tamaño de trazos: proporcional al ancho VISIBLE (tamaño ~constante
  // en pantalla) e INDEPENDIENTE de la escala de coordenadas (SVG estilizado ~1000
  // unidades, o metros reales ~miles). Referencia fija 1200 en vez de W.
  const k = view.w / 1200;

  // Centro de rotación: el del baseView. El contenido se rota con un <g> y el
  // encuadre base pasa a ser el bounding box de la trazada ROTADA (expandido al
  // aspect del contenedor). Con rot=0 devuelve exactamente el BV → sin cambios.
  const rcx = X0 + W / 2, rcy = Y0 + H / 2;
  const rotView = useMemo(() => {
    if (!rot) return BV;
    const th = (rot * Math.PI) / 180, cos = Math.cos(th), sin = Math.sin(th);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let any = false;
    if (Array.isArray(mapPath)) {
      for (const p of mapPath) {
        if (!p) continue;
        any = true;
        const dx = p.x - rcx, dy = p.y - rcy;
        const rx = dx * cos - dy * sin, ry = dx * sin + dy * cos;
        if (rx < minX) minX = rx; if (rx > maxX) maxX = rx;
        if (ry < minY) minY = ry; if (ry > maxY) maxY = ry;
      }
    }
    if (!any) {
      for (const [dx, dy] of [[-W / 2, -H / 2], [W / 2, -H / 2], [W / 2, H / 2], [-W / 2, H / 2]]) {
        const rx = dx * cos - dy * sin, ry = dx * sin + dy * cos;
        if (rx < minX) minX = rx; if (rx > maxX) maxX = rx;
        if (ry < minY) minY = ry; if (ry > maxY) maxY = ry;
      }
    }
    let rw = (maxX - minX) * 1.1 || 1, rh = (maxY - minY) * 1.1 || 1;
    const target = W / H;
    if (rw / rh < target) rw = rh * target; else rh = rw / target;
    return { x: rcx + (minX + maxX) / 2 - rw / 2, y: rcy + (minY + maxY) / 2 - rh / 2, w: rw, h: rh };
  }, [rot, mapPath, rcx, rcy, W, H]);
  const B = rotView; // encuadre base efectivo (pan/zoom se acotan a él)

  // Resetear el encuadre cuando cambia la pista o la rotación.
  useEffect(() => { setView(B); }, [B.x, B.y, B.w, B.h]);

  const reset = () => setView(B);
  const zoomAt = (fx, fy, factor) => setView((v) => {
    let nw = v.w * factor;
    if (nw >= B.w * 0.98) return { x: B.x, y: B.y, w: B.w, h: B.h }; // snap a completo
    // Zoom-in máximo: ancho visible mínimo = 4% del total (25×).
    nw = Math.max(B.w * 0.04, nw);
    const nh = nw * (B.h / B.w);
    const cx = v.x + fx * v.w, cy = v.y + fy * v.h;
    const nx = Math.max(B.x, Math.min(B.x + B.w - nw, cx - fx * nw));
    const ny = Math.max(B.y, Math.min(B.y + B.h - nh, cy - fy * nh));
    return { x: nx, y: ny, w: nw, h: nh };
  });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, e.deltaY < 0 ? 0.8 : 1.28);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [B.x, B.y, B.w, B.h]);

  const onDown = (e) => {
    const r = wrapRef.current.getBoundingClientRect();
    dragRef.current = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, rw: r.width, rh: r.height };
    setDragging(true);
  };
  const onMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = ((e.clientX - d.sx) / d.rw) * view.w;
    const dy = ((e.clientY - d.sy) / d.rh) * view.h;
    setView((v) => ({ ...v, x: Math.max(B.x, Math.min(B.x + B.w - v.w, d.vx - dx)), y: Math.max(B.y, Math.min(B.y + B.h - v.h, d.vy - dy)) }));
  };
  const onUp = () => { dragRef.current = null; setDragging(false); };
  // Transform de rotación del contenido (todo el mapa gira junto).
  const rotT = rot ? `rotate(${rot} ${rcx} ${rcy})` : undefined;

  // Capa de trazadas memoizada: no se reconstruye en cada hover (solo cuando
  // cambian datos/zoom/toggles), así el marcador de hover se mueve fluido.
  const segs = useMemo(() => {
    if (!showLap || !mapPath) return [];
    // Geometría base (Catmull-Rom) compartida con ShareCard.
    const base = buildTrackSegments(mapPath);
    // Recorremos los mismos puntos válidos (mismo filtro de huecos) para saber
    // a qué índice original corresponde cada segmento de `base` y así inyectar
    // dv (comparación, depende de mapDelta) y gr (grip, depende de gripLap) —
    // ambos quedan fuera de buildTrackSegments porque no son geometría pura.
    const pts = [];
    for (let i = 0; i < mapPath.length; i++) if (mapPath[i]) pts.push({ i, p: mapPath[i] });
    const W = 3; // ventana de suavizado del delta (reduce ruido bucket a bucket)
    const out = [];
    let bi = 0;
    for (let k = 1; k < pts.length; k++) {
      const prv = pts[k - 1], cur = pts[k];
      if (cur.i - prv.i > 6) continue; // hueco grande → no puenteamos
      const s = base[bi++];
      // dv = pendiente del delta promediada sobre ~W buckets.
      const j = Math.max(0, cur.i - W);
      const dv = mapDelta && mapDelta[cur.i] != null && mapDelta[j] != null && cur.i > j
        ? (mapDelta[cur.i] - mapDelta[j]) / (cur.i - j)
        : 0;
      out.push({ ...s, dv, gr: gripLap ? gripLap[cur.i] : null });
    }
    return out;
  }, [mapPath, showLap, mapDelta, gripLap]);

  // Segmentos de la REFERENCIA (para colorearla por inputs en el modo Freno/Gas).
  const segsRef = useMemo(() => {
    const out = [];
    if (!mapPathRef) return out;
    const pts = [];
    for (let i = 0; i < mapPathRef.length; i++) if (mapPathRef[i]) pts.push({ i, p: mapPathRef[i] });
    for (let k = 1; k < pts.length; k++) {
      const prv = pts[k - 1], cur = pts[k];
      if (cur.i - prv.i > 6) continue;
      const a = prv.p, b = cur.p;
      const p0 = (pts[k - 2] || prv).p, p3 = (pts[k + 1] || cur).p;
      const c1x = a.x + (b.x - p0.x) / 6, c1y = a.y + (b.y - p0.y) / 6;
      const c2x = b.x - (p3.x - a.x) / 6, c2y = b.y - (p3.y - a.y) / 6;
      out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, c1x, c1y, c2x, c2y, th: b.th, br: b.br, gr: gripRef ? gripRef[cur.i] : null });
    }
    return out;
  }, [mapPathRef, gripRef]);
  // Escala robusta para el color de comparación: percentil ~85 de |dv| en vez
  // del máximo. Así un pico aislado (típico con una referencia mucho más rápida,
  // o con tiempos reconstruidos de un CSV) no aplana todo el mapa a gris.
  const maxSlope = useMemo(() => {
    const vals = segs.map((s) => Math.abs(s.dv || 0)).filter((v) => v > 1e-6).sort((a, b) => a - b);
    if (!vals.length) return 1e-9;
    const p = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.85))];
    return Math.max(p, 1e-4);
  }, [segs]);
  const refD = useMemo(() => {
    if (!(showRef && mapPathRef)) return "";
    return smoothPath(mapPathRef);
  }, [mapPathRef, showRef]);
  // Banda de la porción seleccionada en los gráficos (se pinta la ZONA de pista,
  // no la trazada, para no molestar el análisis). Sigue los puntos de la vuelta
  // en el rango [aFrac,bFrac] con un trazo ancho translúcido.
  const highlightD = useMemo(() => {
    if (!highlightRange || !mapPath || highlightRange.length !== 2) return "";
    const len = mapPath.length;
    const aI = Math.max(0, Math.floor(highlightRange[0] * (len - 1)));
    const bI = Math.min(len - 1, Math.ceil(highlightRange[1] * (len - 1)));
    if (bI - aI < 1) return "";
    return smoothPath(mapPath.slice(aI, bI + 1));
  }, [highlightRange, mapPath]);
  const hLap = showLap && hoverIdx != null && mapPath && mapPath[hoverIdx];
  const hRef = showRef && hoverIdx != null && mapPathRef && mapPathRef[hoverIdx];

  return (
    <div className={`rounded-lg border border-border bg-card/40 p-3 ${fill ? "h-full flex flex-col" : ""}`}>
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Mapa</span>
          <div className="flex border border-border rounded-md overflow-hidden">
            {[["speed", "Velocidad"], ...(hasRef ? [["compare", "Comparación"]] : []), ["throttle", "Acelerador"], ["brake", "Freno"], ...(gripLap ? [["grip", "Grip"]] : [])].map(([v, l]) => (
              <button
                key={v}
                onClick={() => setMode(v)}
                className="px-2 py-0.5 text-[10px] font-bold transition-colors hover:bg-white/5"
                style={{ background: effMode === v ? "rgba(125,211,252,0.15)" : "transparent", color: effMode === v ? "rgb(125,211,252)" : "rgba(255,255,255,0.5)" }}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <ToggleBtn active={showLap} onClick={() => setShowLap((v) => !v)} color="rgb(52,211,153)">Tu vuelta</ToggleBtn>
          {mapPathRef && <ToggleBtn active={showRef} onClick={() => setShowRef((v) => !v)} color="rgba(255,255,255,0.85)">Referencia</ToggleBtn>}
          {onRotChange && (
            <div className="flex items-center gap-1 pl-1" title="Rotación del mapa (se guarda por circuito)">
              <RotateCcw className="size-3 text-muted-foreground/60" />
              <input
                type="range"
                min="0"
                max="355"
                step="5"
                value={rot}
                onChange={(e) => onRotChange(parseInt(e.target.value, 10) || 0)}
                className="w-20 accent-sky-400"
              />
              <span className="text-[10px] font-mono tabular-nums w-7 text-right text-muted-foreground">{rot}°</span>
              {onRotReset && (
                <button
                  onClick={onRotReset}
                  className="px-1.5 py-0.5 rounded-md text-[10px] font-semibold hover:bg-white/10 text-muted-foreground"
                  title="Volver a la orientación original del circuito (la que informa iRacing)"
                >
                  Restablecer original
                </button>
              )}
            </div>
          )}
          <button onClick={() => zoomAt(0.5, 0.5, 0.7)} className="px-2 py-0.5 rounded-md text-xs font-bold hover:bg-white/10">+</button>
          <button onClick={() => zoomAt(0.5, 0.5, 1.45)} className="px-2 py-0.5 rounded-md text-xs font-bold hover:bg-white/10">−</button>
          <button onClick={reset} className="px-2 py-0.5 rounded-md text-[10px] font-semibold hover:bg-white/10">Reset</button>
        </div>
      </div>
      <div ref={wrapRef} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} className={`relative ${fill ? "flex-1 min-h-0" : ""}`} style={{ cursor: dragging ? "grabbing" : "grab" }}>
        {/* Satélite en vista a altura completa: 'slice' para cubrir sin bandas
            negras (el contenedor es más cuadrado que el viewBox). Resto: 'meet'. */}
        <svg viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} preserveAspectRatio={tiles ? "xMidYMid slice" : "xMidYMid meet"} className={fill ? "w-full h-full block" : "w-full block"} style={fill ? undefined : { aspectRatio: `${W} / ${H}` }}>
          {/* Foto satelital (tiles de Esri) como fondo, en el mismo espacio de la
              trazada (rota junto con todo el contenido). Scrim oscuro encima,
              SIN rotar (alineado a pantalla), para que cubra siempre la vista. */}
          {tiles && (
            <g transform={rotT}>
              {tiles.map((t) => (
                <image key={`${t.x}/${t.y}`} href={t.url} x={t.px} y={t.py} width={256.7} height={256.7} preserveAspectRatio="none" style={{ imageRendering: "auto" }} />
              ))}
            </g>
          )}
          {scrim && <rect x={view.x} y={view.y} width={view.w} height={view.h} fill="rgba(0,0,0,0.28)" />}
          <g transform={rotT}>
          {outlineD && outlineMode === "stroke" && (
            // Trazado REAL de OSM (highway=raceway) como líneas finas: el eje real
            // del circuito superpuesto a la línea GPS (misma proyección, SIN
            // alinear). Sirve para ver cuánto coincide OSM con iRacing. Grosor
            // constante en pantalla (k) para apreciar el detalle a cualquier zoom.
            <path d={outlineD} fill="none" stroke="rgba(125,211,252,0.55)" strokeWidth={2.2 * k} strokeLinejoin="round" strokeLinecap="round" />
          )}
          {outlineD && outlineMode !== "stroke" && roadWidth > 0 && (
            // Cinta de ASFALTO real (OSM): centerline engrosada al ancho real de
            // pista (metros → escala con el zoom). Rim claro + asfalto oscuro
            // inset → bordes definidos. La trazada de color va encima.
            <g>
              <path d={outlineD} fill="none" stroke="rgba(255,255,255,0.32)" strokeWidth={roadWidth} strokeLinejoin="round" strokeLinecap="round" />
              <path d={outlineD} fill="none" stroke="rgb(24,26,32)" strokeWidth={Math.max(0.5, roadWidth - 2.6)} strokeLinejoin="round" strokeLinecap="round" />
            </g>
          )}
          {outlineD && outlineMode !== "stroke" && !(roadWidth > 0) && (
            <g>
              {/* Bordes de iRacing (fallback SVG estilizado): relleno evenodd entre
                  inside/outside; trazo fino en cada borde. */}
              <path
                d={outlineD}
                fill={(outlineD.match(/M/gi) || []).length >= 2 ? "rgba(255,255,255,0.07)" : "none"}
                fillRule="evenodd"
                stroke="rgba(255,255,255,0.4)"
                strokeWidth={2.5 * k}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </g>
          )}
          {/* Zona de pista resaltada (selección de los gráficos): banda ancha
              translúcida debajo de la trazada, para no taparla. */}
          {highlightD && (
            <path d={highlightD} fill="none" stroke="rgba(250,204,21,0.12)" strokeWidth={44 * k} strokeLinecap="round" strokeLinejoin="round" />
          )}
          <TrackLayer segs={segs} segsRef={segsRef} refD={refD} showRef={showRef} showLap={showLap} k={k} mode={effMode} maxSlope={maxSlope} />
          {corners && mapPath && corners.map((c, i) => {
            const b = Math.round(c.pct * (mapPath.length - 1));
            const p = mapPath[b];
            if (!p) return null;
            return (
              <g key={`cn-${i}`}>
                <circle cx={p.x} cy={p.y} r={3.5 * k} fill="white" stroke="black" strokeWidth={1.5 * k} />
                <text
                  transform={rot ? `rotate(${-rot} ${p.x} ${p.y})` : undefined}
                  x={p.x + 7 * k}
                  y={p.y - 6 * k}
                  fontSize={22 * k}
                  fontWeight="bold"
                  fill="white"
                  stroke="black"
                  strokeWidth={5 * k}
                  strokeLinejoin="round"
                  paintOrder="stroke"
                  style={{ userSelect: "none", paintOrder: "stroke" }}
                >
                  {c.label}
                </text>
              </g>
            );
          })}
          {hRef && <circle cx={hRef.x} cy={hRef.y} r={7 * k} fill="none" stroke="white" strokeWidth={2.5 * k} />}
          {hLap && <circle cx={hLap.x} cy={hLap.y} r={7 * k} fill="rgb(52,211,153)" stroke="black" strokeWidth={1.5 * k} />}
          </g>
        </svg>
        {attribution && (
          <div className="absolute bottom-1 right-1.5 text-[8px] text-white/70 bg-black/45 px-1.5 py-0.5 rounded pointer-events-none">{attribution}</div>
        )}
      </div>
      <div className="text-[9px] text-muted-foreground/60 mt-1 shrink-0">
        {effMode === "compare"
          ? "Verde = ganás tiempo · rojo = perdés (vs referencia)"
          : effMode === "throttle"
          ? "Acelerador: gris (0%) → verde (100%)"
          : effMode === "brake"
          ? "Freno: gris (0%) → rojo (100%)"
          : "Color = velocidad (azul → rojo)"}
        {mapPathRef ? " · punteada = referencia" : ""} · usá los toggles Tu vuelta / Referencia para aislar una · rueda o +/− zoom
      </div>
    </div>
  );
}

// Tarjeta de métricas de manejo (coasting, frenada/trail, gas, correcciones,
// balance, uso de grip) + eventos estimados de bloqueo/patinada. `hasRef` habilita
// los deltas vs referencia.
function DrivingMetricsCard({ m, hasRef }) {
  const [tip, setTip] = useState(null); // tooltip propio de encabezados: {text,x,y}
  const cardRef = useRef(null);
  const showTip = (text, e) => {
    const r = cardRef.current && cardRef.current.getBoundingClientRect();
    if (!r) return;
    setTip({ text, x: e.clientX - r.left, y: e.clientY - r.top, w: r.width });
  };
  const thProps = (t) => ({ onMouseEnter: (e) => showTip(t, e), onMouseMove: (e) => showTip(t, e), onMouseLeave: () => setTip(null) });
  if (!m || !m.corners || !m.corners.length) return null;
  const o = m.overall;
  const pct = (v) => (v == null ? "—" : `${Math.round(v * 100)}%`);
  const mm = (v) => (v == null ? "—" : `${Math.round(v)} m`);
  const DeltaM = ({ v, goodNeg }) => {
    if (v == null || Math.abs(v) < 3) return null;
    const bad = goodNeg ? v > 0 : v < 0;
    return <span className="ml-1 text-[9px] font-mono" style={{ color: bad ? "rgb(248,113,113)" : "rgb(52,211,153)" }}>{v > 0 ? "+" : "−"}{Math.round(Math.abs(v))}</span>;
  };
  const balColor = (b) => (b === "sobreviraje" ? "rgb(248,113,113)" : b === "subviraje" ? "rgb(234,179,8)" : "rgba(255,255,255,0.5)");
  const balTxt = (b) => (b === "sobreviraje" ? "sobre" : b === "subviraje" ? "sub" : "—");
  return (
    <div ref={cardRef} className="relative rounded-lg border border-border bg-card/40 p-3">
      {tip && (
        <div className="absolute z-50 pointer-events-none rounded-md border border-border px-2 py-1 shadow-lg text-[10px] leading-snug font-sans normal-case tracking-normal text-foreground/90"
          style={{ left: Math.max(4, Math.min(tip.x + 12, (tip.w || 800) - 236)), top: tip.y + 14, width: 230, background: "rgba(20,22,28,0.97)" }}>
          {tip.text}
        </div>
      )}
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-1.5"><Gauge className="size-3.5" /> Métricas de manejo</span>
        <span className="text-[9px] text-muted-foreground/50">estimaciones · por curva</span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] mb-2">
        <span>Coasting: <span className="font-mono font-semibold" style={{ color: o.coastPct > 0.2 ? "rgb(248,113,113)" : "var(--color-text)" }}>{pct(o.coastPct)}</span>{o.coastTime != null ? <span className="text-muted-foreground/70"> (~{o.coastTime.toFixed(1)}s)</span> : null}</span>
        <span>Grip pico: <span className="font-mono font-semibold">{o.gMax ? o.gMax.toFixed(1) : "—"}g</span></span>
        <span title={o.lockups.map((e) => e.label).filter(Boolean).join(", ") || "sin eventos"}>Bloqueos (est.): <span className="font-mono font-semibold" style={{ color: o.lockups.length ? "rgb(248,113,113)" : "var(--color-text)" }}>{o.lockups.length}</span></span>
        <span title={o.spins.map((e) => e.label).filter(Boolean).join(", ") || "sin eventos"}>Patinadas (est.): <span className="font-mono font-semibold" style={{ color: o.spins.length ? "rgb(249,115,22)" : "var(--color-text)" }}>{o.spins.length}</span></span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px] font-mono tnum whitespace-nowrap">
          <thead>
            <tr className="text-muted-foreground/70 text-[9px] uppercase">
              <th className="text-left font-semibold py-1 pr-2">Curva</th>
              <th className="text-right font-semibold py-1 px-2" {...thProps("Punto de frenada: metros antes del apex donde empezás a frenar. Δ vs referencia: + = frenás más tarde, − = más temprano.")}><span className="cursor-help border-b border-dotted border-muted-foreground/40">Frenada</span></th>
              <th className="text-right font-semibold py-1 px-2" {...thProps("Trail-braking: % de la entrada en que seguís frenando mientras ya girás el volante. Más alto = más rotás el auto con el freno.")}><span className="cursor-help border-b border-dotted border-muted-foreground/40">Trail</span></th>
              <th className="text-right font-semibold py-1 px-2" {...thProps("Velocidad mínima en la curva (km/h). Δ vs referencia: + = pasás más rápido por el apex.")}><span className="cursor-help border-b border-dotted border-muted-foreground/40">Vmín</span></th>
              <th className="text-right font-semibold py-1 px-2" {...thProps("Reaplicación de gas: metros tras el apex hasta pleno acelerador. Δ vs referencia: + = abrís gas más tarde (peor).")}><span className="cursor-help border-b border-dotted border-muted-foreground/40">Gas</span></th>
              <th className="text-right font-semibold py-1 px-2" {...thProps("Coasting: % de la curva sin gas ni freno. Tiempo muerto — cuanto más bajo, mejor.")}><span className="cursor-help border-b border-dotted border-muted-foreground/40">Coast</span></th>
              <th className="text-right font-semibold py-1 px-2" {...thProps("Correcciones de volante (reversiones) dentro de la curva. Muchas = auto inestable o sobremanejo.")}><span className="cursor-help border-b border-dotted border-muted-foreground/40">Corr.</span></th>
              <th className="text-right font-semibold py-1 px-2" {...thProps("Balance estimado: sub (subviraje, poco agarre para el volante que metés) o sobre (sobreviraje, correcciones tras el apex). Heurístico.")}><span className="cursor-help border-b border-dotted border-muted-foreground/40">Balance</span></th>
              <th className="text-right font-semibold py-1 pl-2" {...thProps("Uso del círculo de fricción: % del grip pico de la vuelta que aprovechás en esta curva.")}><span className="cursor-help border-b border-dotted border-muted-foreground/40">Grip</span></th>
            </tr>
          </thead>
          <tbody>
            {m.corners.map((c, i) => (
              <tr key={i} className="border-t border-border/40">
                <td className="text-left py-0.5 pr-2 font-sans text-foreground/90 truncate max-w-[110px]">{c.label}</td>
                <td className="text-right py-0.5 px-2">{mm(c.brakePointM)}{hasRef && <DeltaM v={c.brakeDeltaM} goodNeg={false} />}</td>
                <td className="text-right py-0.5 px-2" style={{ color: c.trailPct >= 0.4 ? "rgb(52,211,153)" : c.trailPct < 0.12 ? "rgba(255,255,255,0.4)" : "var(--color-text)" }}>{pct(c.trailPct)}</td>
                <td className="text-right py-0.5 px-2">{c.minKmh != null ? Math.round(c.minKmh) : "—"}{hasRef && <DeltaM v={c.minDeltaKmh} goodNeg={false} />}</td>
                <td className="text-right py-0.5 px-2">{mm(c.throttleOnM)}{hasRef && <DeltaM v={c.throttleDeltaM} goodNeg={true} />}</td>
                <td className="text-right py-0.5 px-2" style={{ color: c.coastPct > 0.25 ? "rgb(248,113,113)" : "var(--color-text)" }}>{pct(c.coastPct)}</td>
                <td className="text-right py-0.5 px-2" style={{ color: c.reversals >= 4 ? "rgb(248,113,113)" : c.reversals >= 2 ? "rgb(234,179,8)" : "var(--color-text)" }}>{c.reversals}</td>
                <td className="text-right py-0.5 px-2 font-sans" style={{ color: balColor(c.balance) }}>{balTxt(c.balance)}</td>
                <td className="text-right py-0.5 pl-2">{c.frictionPct != null ? pct(c.frictionPct) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="text-[9px] text-muted-foreground/50 mt-1.5 leading-tight">
        Frenada = m antes del apex · Gas = m tras el apex a pleno · Vmín en km/h · verde = mejor que la ref, rojo = peor. Bloqueo/patinada son estimaciones (iRacing no expone velocidad de rueda).
      </div>
    </div>
  );
}

// Construye el subárbol SVG del mapa (contorno + trazada) YA AJUSTADO a la caja
// del ShareCard. ShareCard solo TRASLADA `mapEls` a (map.x, map.y): acá metemos
// un <g> con la ESCALA que encaja el `baseView` del mapa dentro de la caja
// (fit "meet", centrado). Reusa la MISMA alineación que MapPanel — el `mapPath`
// ya viene alineado por svgMap/gpsMap (afín) — y la MISMA geometría Bézier
// (`buildTrackSegments`). Color por velocidad vía el `hue` precomputado, que es
// idéntico a `speedColor` (240=azul → 0=rojo). NO embebe tiles satelitales.
// `box` = { w, h } de la zona de mapa que calcula ShareCard para el formato.
// Rotación preferida del mapa POR CIRCUITO, persistida en localStorage: girás
// una vez y ese circuito queda siempre con esa orientación (análisis y tarjeta).
const ROT_STORE_KEY = "ifly.trackRotation";
// Devuelve null cuando el circuito NO tiene rotación manual guardada. Es
// distinto de 0: 0 es "el usuario eligió norte arriba" y null es "que decida el
// automático". Sin esa distinción el botón de restablecer no tendría a qué
// volver.
function loadTrackRot(trackKey) {
  if (!trackKey) return null;
  try {
    const m = JSON.parse(localStorage.getItem(ROT_STORE_KEY) || "{}");
    const v = m[trackKey];
    return isFinite(v) ? ((Math.round(v) % 360) + 360) % 360 : null;
  } catch (_) { return null; }
}
function clearTrackRot(trackKey) {
  if (!trackKey) return;
  try {
    const m = JSON.parse(localStorage.getItem(ROT_STORE_KEY) || "{}");
    delete m[trackKey];
    localStorage.setItem(ROT_STORE_KEY, JSON.stringify(m));
  } catch (_) {}
}
function saveTrackRot(trackKey, deg) {
  if (!trackKey) return;
  try {
    const m = JSON.parse(localStorage.getItem(ROT_STORE_KEY) || "{}");
    m[trackKey] = ((Math.round(deg) % 360) + 360) % 360;
    localStorage.setItem(ROT_STORE_KEY, JSON.stringify(m));
  } catch (_) {}
}

function buildShareMapEls(map, box, mode = "speed", rotDeg = 0) {
  if (!map || !Array.isArray(map.mapPath) || !box) return null;
  const BV = map.baseView || { x: 0, y: 0, w: 1000, h: 380 };
  // Encuadre por ROTACIÓN: rotamos los puntos reales de la trazada alrededor
  // del centro del view y ajustamos la caja al bounding box rotado (con un 6%
  // de margen para el contorno). Esto maximiza el tamaño del trazado en la
  // caja para CUALQUIER ángulo — con 0° también: encuadra a la trazada real,
  // no al viewport con padding, así el mapa se ve más grande.
  const th = ((rotDeg || 0) * Math.PI) / 180;
  const cos = Math.cos(th), sin = Math.sin(th);
  const cx = BV.x + BV.w / 2, cy = BV.y + BV.h / 2;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of map.mapPath) {
    if (!p) continue;
    const dx = p.x - cx, dy = p.y - cy;
    const rx = dx * cos - dy * sin, ry = dx * sin + dy * cos;
    if (rx < minX) minX = rx; if (rx > maxX) maxX = rx;
    if (ry < minY) minY = ry; if (ry > maxY) maxY = ry;
  }
  if (!isFinite(minX)) { minX = -BV.w / 2; maxX = BV.w / 2; minY = -BV.h / 2; maxY = BV.h / 2; }
  const rw = (maxX - minX) * 1.06 || 1, rh = (maxY - minY) * 1.06 || 1;
  const scale = Math.min(box.w / rw, box.h / rh);
  const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
  // Punto p → s·R·(p−c) + centroCaja − s·mid (bbox rotado centrado en la caja).
  const tx = box.w / 2 - scale * midX;
  const ty = box.h / 2 - scale * midY;
  // Grosor de trazo en UNIDADES NATIVAS del mapa (la <g> lo escala luego), con el
  // mismo factor k que MapPanel para que la tarjeta se vea como el análisis.
  const k = (BV.w || 1200) / 1200;
  const segs = buildTrackSegments(map.mapPath);
  const dpath = (s) => `M${s.x1.toFixed(1)},${s.y1.toFixed(1)}C${s.c1x.toFixed(1)},${s.c1y.toFixed(1)} ${s.c2x.toFixed(1)},${s.c2y.toFixed(1)} ${s.x2.toFixed(1)},${s.y2.toFixed(1)}`;
  const roadWidth = map.roadWidth || 0;
  const outlineMode = map.outlineMode || null;
  // Tiles satelitales YA embebidos como data URL (los baja el main sin CORS para
  // que el canvas no se contamine al exportar el PNG).
  const tiles = Array.isArray(map.tiles) ? map.tiles.filter((t) => t && t.dataUrl) : null;
  return (
    <g clipPath="url(#sc-mapclip)">
      <defs><clipPath id="sc-mapclip"><rect x="0" y="0" width={box.w} height={box.h} /></clipPath></defs>
      <g transform={`translate(${tx.toFixed(2)},${ty.toFixed(2)}) scale(${scale}) rotate(${rotDeg || 0}) translate(${-cx},${-cy})`}>
        {/* Fondo satelital (foto) + scrim oscuro para que resalte la trazada. */}
        {tiles && tiles.map((t) => (
          <image key={`${t.x}/${t.y}`} href={t.dataUrl} x={t.px} y={t.py} width={256.7} height={256.7} preserveAspectRatio="none" />
        ))}
        {/* Scrim sobredimensionado: con el re-encuadre (zoom/rotación) el área
            visible puede exceder el viewport original de los tiles. */}
        {tiles && map.scrim && <rect x={BV.x - BV.w} y={BV.y - BV.h} width={BV.w * 3} height={BV.h * 3} fill="rgba(0,0,0,0.30)" />}
        {/* Contorno real: OSM = cinta de asfalto (rim claro + asfalto oscuro),
            SVG estilizado = bordes del circuito. Misma lógica que MapPanel. */}
        {map.outlineD && outlineMode === "stroke" && (
          <path d={map.outlineD} fill="none" stroke="rgba(125,211,252,0.55)" strokeWidth={2.2 * k} strokeLinejoin="round" strokeLinecap="round" />
        )}
        {map.outlineD && outlineMode !== "stroke" && roadWidth > 0 && (
          <g>
            <path d={map.outlineD} fill="none" stroke="rgba(255,255,255,0.32)" strokeWidth={roadWidth} strokeLinejoin="round" strokeLinecap="round" />
            <path d={map.outlineD} fill="none" stroke="rgb(24,26,32)" strokeWidth={Math.max(0.5, roadWidth - 2.6)} strokeLinejoin="round" strokeLinecap="round" />
          </g>
        )}
        {map.outlineD && outlineMode !== "stroke" && !(roadWidth > 0) && (
          <path
            d={map.outlineD}
            fill={(map.outlineD.match(/M/gi) || []).length >= 2 ? "rgba(255,255,255,0.07)" : "none"}
            fillRule="evenodd"
            stroke="rgba(255,255,255,0.4)"
            strokeWidth={2.5 * k}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {/* Trazada coloreada según el modo elegido (velocidad / acelerador /
            freno), con glow neón (solo la trazada, no la foto satelital). El
            degradado gris→color de pedales es el mismo que usa MapPanel. */}
        <g filter="url(#sc-glow)">
          {segs.map((s, i) => {
            const BASE = [70, 78, 90];
            const lerp3 = (a, b, u) => {
              const c = Math.max(0, Math.min(1, u == null ? 0 : u));
              return `rgb(${Math.round(a[0] + (b[0] - a[0]) * c)},${Math.round(a[1] + (b[1] - a[1]) * c)},${Math.round(a[2] + (b[2] - a[2]) * c)})`;
            };
            const color = mode === "throttle" ? lerp3(BASE, [46, 204, 113], s.th)
              : mode === "brake" ? lerp3(BASE, [239, 68, 68], s.br)
              : `hsl(${Math.round(s.hue)},85%,55%)`;
            return <path key={i} d={dpath(s)} fill="none" stroke={color} strokeWidth={4.5 * k} strokeLinecap="round" strokeLinejoin="round" />;
          })}
        </g>
      </g>
    </g>
  );
}

export function AnalysisView() {
  const [sessions, setSessions] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [session, setSession] = useState(null);
  const [lapIdx, setLapIdx] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [telemetryDir, setTelemetryDir] = useState(null);
  const [labels, setLabels] = useState({});          // títulos personalizados por id
  const [query, setQuery] = useState("");            // búsqueda en el listado
  const [srcFilter, setSrcFilter] = useState([]);    // fuentes activas: ibt|csv|live
  const [typeFilter, setTypeFilter] = useState([]);  // tipos activos: race|qual|practice
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState("");
  const [hoverIdx, setHoverIdx] = useState(null); // bucket bajo el cursor (charts↔mapa)
  // Hover throttleado a un frame: mousemove dispara cientos de eventos/seg y cada
  // setHoverIdx re-renderiza la vista entera. Coalescemos a ≤1 update por rAF.
  const hoverRaf = useRef(0);
  const hoverNext = useRef(null);
  const setHover = useCallback((v) => {
    hoverNext.current = v;
    if (hoverRaf.current) return;
    hoverRaf.current = requestAnimationFrame(() => {
      hoverRaf.current = 0;
      setHoverIdx(hoverNext.current);
    });
  }, []);
  useEffect(() => () => { if (hoverRaf.current) cancelAnimationFrame(hoverRaf.current); }, []);
  const [detailOpen, setDetailOpen] = useState(false); // vista de análisis detallado (pantalla completa)
  const [zoomRange, setZoomRange] = useState(null); // [aFrac,bFrac] porción de la vuelta ampliada en los gráficos
  const [rangeTool, setRangeTool] = useState(false); // herramienta de selección de rango activa
  const [showLapLine, setShowLapLine] = useState(true); // toggles de líneas en gráficos
  const [showRefLine, setShowRefLine] = useState(true);
  const [trackMap, setTrackMap] = useState(null); // { svg } | { error }
  const [osmTrack, setOsmTrack] = useState(null); // geometría real de OSM { centerline } | { error }
  const [trackmapDir, setTrackmapDir] = useState(null);
  const [refSessionId, setRefSessionId] = useState(null); // ghost: otra sesión como referencia
  const [refSession, setRefSession] = useState(null);
  const [refLapIdx, setRefLapIdx] = useState(-1); // vuelta de la referencia (-1 = mejor)
  const [g61Url, setG61Url] = useState(null); // URL de Garage 61 para este circuito+auto
  // === Compartir vuelta (tarjeta PNG + .iflylap) ===
  const [shareOpen, setShareOpen] = useState(false);
  const [shareFormat, setShareFormat] = useState("square"); // story | square | wide
  const [shareMapSource, setShareMapSource] = useState("osm"); // osm | sat | svg
  const [shareMapMode, setShareMapMode] = useState("speed"); // speed | throttle | brake (color del mapa)
  const [shareCharts, setShareCharts] = useState(["speed"]); // gráficos elegidos: speed | pedals
  // Rotación del mapa (grados 0..359): UN estado por circuito, compartido por el
  // mapa del análisis y la tarjeta, y persistido por trackKey.
  // `null` = sin ajuste manual → manda la orientación automática del YAML.
  const [trackRotManual, setTrackRotManual] = useState(null);
  const rotKey = session ? (session.trackKey || session.track || null) : null;
  useEffect(() => { setTrackRotManual(loadTrackRot(rotKey)); }, [rotKey]);
  const autoRot = useMemo(() => autoMapRotation(session?.trackNorthOffset), [session]);
  const trackRot = trackRotManual != null ? trackRotManual : (autoRot ?? 0);
  const setTrackRot = (d) => {
    const v = ((Math.round(d) % 360) + 360) % 360;
    setTrackRotManual(v);
    saveTrackRot(rotKey, v);
  };
  const resetTrackRot = useCallback(() => {
    setTrackRotManual(null);
    clearTrackRot(rotKey);
  }, [rotKey]);
  // Sólo hay algo que restablecer si el usuario tocó la rotación de esta pista.
  const rotIsManual = trackRotManual != null;
  const [displayName, setDisplayName] = useState("");
  const [shareMsg, setShareMsg] = useState(null); // feedback efímero de acciones
  const [shareBusy, setShareBusy] = useState(false);
  const shareSvgRef = useRef(null);
  const [shareLogoUrl, setShareLogoUrl] = useState(null);
  // Tiles satelitales para la tarjeta: { tiles:[{...,dataUrl}] } | 'loading' | 'error' | null.
  const [satShareTiles, setSatShareTiles] = useState(null);
  // Logo (ala) como data URL compacto para embeberlo en la tarjeta: al rasterizar
  // el <svg> a PNG, una URL relativa (./logo.png) no cargaría dentro del data: URL
  // del SVG. Lo dibujamos una vez en un canvas chico (mismo origen → sin taint) y
  // guardamos un PNG data URL liviano que sí viaja embebido.
  useEffect(() => {
    let alive = true;
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = 160; c.height = 160;
        c.getContext("2d").drawImage(img, 0, 0, 160, 160);
        if (alive) setShareLogoUrl(c.toDataURL("image/png"));
      } catch (_) {}
    };
    img.src = "./logo.png";
    return () => { alive = false; };
  }, []);

  // URL fija del botón general de Garage 61 (la que pediste).
  const GARAGE61_URL = "https://garage61.net/app/laps/498/153;a=-1;bw=0,;bp=,0";
  const openExternal = (url) => { if (url && window.fly?.openExternal) window.fly.openExternal(url); };

  const loadList = useCallback(async () => {
    if (!window.fly?.getRecordings) return;
    // Merge de sesiones grabadas en vivo + archivos .ibt de iRacing.
    const [live, ibt] = await Promise.all([
      window.fly.getRecordings(),
      window.fly.getIbtSessions ? window.fly.getIbtSessions() : Promise.resolve([]),
    ]);
    const merged = [
      ...(live || []).map((s) => ({ ...s, source: "live" })),
      ...(ibt || []),
    ].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    setSessions(merged);
    setSelectedId((cur) => cur || (merged[0] ? merged[0].id : null));
  }, []);

  useEffect(() => {
    loadList();
    if (!window.fly?.onRecordingsChange) return;
    // Debounce: durante una sesión en vivo `recordings:changed` llega seguido (una
    // por vuelta). Coalescemos para no re-listar/re-renderizar en cada evento.
    let t = null;
    const unsub = window.fly.onRecordingsChange(() => {
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; loadList(); }, 400);
    });
    return () => { if (t) clearTimeout(t); unsub && unsub(); };
  }, [loadList]);

  const closeDetail = () => { setDetailOpen(false); setZoomRange(null); setRangeTool(false); };
  // Cerrar el análisis detallado con Escape (o quitar el zoom si hay uno).
  useEffect(() => {
    if (!detailOpen) return;
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (zoomRange) { setZoomRange(null); setRangeTool(false); } else { closeDetail(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailOpen, zoomRange]);

  useEffect(() => {
    if (!selectedId) { setSession(null); return; }
    const isFile = /^(ibt|csv|ifly)/.test(selectedId); // .ibt/.csv/.iflylap escaneados o importados
    const getter = isFile ? window.fly?.getIbtSession : window.fly?.getRecording;
    if (!getter) { setSession(null); return; }
    let mounted = true;
    setSession(null); // limpiar mientras carga (parsear un .ibt puede tardar)
    setEditingTitle(false);
    setRefSessionId(null); // la referencia elegida no aplica a la sesión nueva
    setLoading(true);
    getter(selectedId).then((s) => {
      if (!mounted) return;
      setSession(s);
      setLoading(false);
      // Comparar por defecto la última vuelta válida contra la mejor.
      if (s && s.laps) {
        const lastValid = [...s.laps].reverse().findIndex((l) => l.valid && l.lapTime > 0);
        setLapIdx(lastValid >= 0 ? s.laps.length - 1 - lastValid : (s.laps.length - 1));
      }
    }).catch(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [selectedId]);

  const sessionBest = useMemo(() => bestLapOf(session), [session]);
  const lap = session && session.laps && lapIdx >= 0 ? session.laps[lapIdx] : null;
  const cons = useMemo(() => consistency(session?.laps), [session]);

  // Referencia (ghost): mejor de otra sesión (local, .ibt o .csv importado) si
  // se eligió; si no, la mejor de esta sesión. Para la referencia somos
  // tolerantes: si no hay una vuelta "válida" (p. ej. un CSV sin lapTime),
  // igual usamos la primera vuelta con muestras, así el ghost aparece.
  const best = useMemo(() => {
    if (refSession) {
      // Vuelta puntual elegida de la referencia, o su mejor vuelta por defecto.
      if (refLapIdx >= 0 && refSession.laps && refSession.laps[refLapIdx]) return refSession.laps[refLapIdx];
      return (
        bestLapOf(refSession) ||
        (refSession.laps || []).find((l) => Array.isArray(l.samples) && l.samples.some(Boolean)) ||
        null
      );
    }
    return sessionBest;
  }, [refSession, refLapIdx, sessionBest]);
  // Datos de pista de Lovely (curvas + sectores reales) por nombre de circuito.
  const trackData = useMemo(() => {
    if (!session) return null;
    const nrm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    // Quita prefijos genéricos ("circuit de", "autódromo", etc.) que hacen que
    // nombres distintos colisionen (ej. "Circuit de Spa" vs "Circuit de
    // Barcelona" comparten "circuitde" → matcheaba mal). Solo prefijo, seguro.
    const GEN = ["circuitde", "circuito", "circuit", "autodromonazionale", "autodromointernacional", "autodromo", "autodrome", "the"];
    const strip = (s) => { for (const p of GEN) if (s.startsWith(p)) return s.slice(p.length); return s; };
    // Usamos el nombre interno con config (trackKey) si está; si no, el display.
    const target = strip(nrm(session.trackKey || session.track));
    if (!target) return null;
    const tracks = lovelyTracks.tracks;
    if (tracks[target]) return tracks[target];
    // Match tolerante. Las claves de Lovely varían el orden ("snetterton circuit
    // 300" vs "snetterton 300 circuit"), así que combinamos: prefijo común ×3
    // (prioriza la base distintiva, ej "snetterton") + subsecuencia común (LCS,
    // desambigua la config: "2000 full" vs "2000 moto") + bonus por config igual.
    const cp = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
    const lcs = (a, b) => {
      const nA = a.length, nB = b.length;
      let prev = new Array(nB + 1).fill(0);
      for (let i = 1; i <= nA; i++) {
        const cur = new Array(nB + 1).fill(0);
        for (let j = 1; j <= nB; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
        prev = cur;
      }
      return prev[nB];
    };
    const digits = (s) => (s.match(/\d+/g) || []);
    const dt = digits(target);
    let best = null, bestScore = 0;
    for (const kRaw in tracks) {
      const k = strip(kRaw);
      let score = cp(k, target) * 3 + lcs(k, target);
      if (k.includes(target) || target.includes(k)) score += Math.min(k.length, target.length);
      const dk = digits(k);
      if (dt.length && dk.length && dt.some((d) => dk.includes(d))) score += 50;
      if (score > bestScore) { bestScore = score; best = tracks[kRaw]; }
    }
    return bestScore >= 12 ? best : null;
  }, [session]);
  // Límites de sector reales (de Lovely) o el fallback de la sesión.
  const realSectorPcts = useMemo(() => {
    if (trackData && trackData.sectors && trackData.sectors.length) {
      const p = trackData.sectors.map((s) => s.m).filter((m) => m > 0 && m < 1);
      if (p.length) return p;
    }
    return (session && session.sectorPcts) || null;
  }, [trackData, session]);
  // Curvas para etiquetar (por LapDistPct).
  const corners = useMemo(() => {
    if (!trackData || !trackData.turns || !trackData.turns.length) return [];
    return trackData.turns.map((t, i) => ({ pct: t.s, label: t.name || `T${i + 1}` }));
  }, [trackData]);

  // Coach: análisis de la vuelta anclado a curvas reales + largo de pista.
  const analysis = useMemo(
    () => (best && lap ? analyzeLap(best, lap, { corners, trackLength: session?.trackLength || 0 }) : null),
    [best, lap, corners, session]
  );
  // (#6) Consistencia por curva sobre toda la sesión.
  const cornerConsist = useMemo(
    () => (session && corners.length ? cornerConsistency(session, { corners }) : null),
    [session, corners]
  );
  // Métricas de manejo (coasting, frenada, gas, correcciones, balance, grip).
  const driveMetrics = useMemo(
    () => (lap ? drivingMetrics(best, lap, { corners, trackLength: session?.trackLength || 0 }) : null),
    [best, lap, corners, session]
  );

  const sectorInfo = useMemo(() => {
    if (!session || !lap) return null;
    const pcts = realSectorPcts;
    const lapS = sectorTimes(lap, pcts);
    const refS = best ? sectorTimes(best, pcts) : null;
    const opt = sessionOptimal(session, pcts);
    return { lapS, refS, opt, count: lapS ? lapS.length : 0, real: !!(trackData && trackData.sectors && trackData.sectors.length) };
  }, [session, lap, best, realSectorPcts, trackData]);

  useEffect(() => {
    if (window.fly?.getTelemetryDir) window.fly.getTelemetryDir().then(setTelemetryDir);
  }, []);

  // Cargar la sesión de referencia (ghost) cuando se elige otra.
  useEffect(() => {
    if (!refSessionId || refSessionId === selectedId) { setRefSession(null); return; }
    const getter = /^(ibt|csv|ifly)/.test(refSessionId) ? window.fly?.getIbtSession : window.fly?.getRecording;
    if (!getter) { setRefSession(null); return; }
    let m = true;
    setRefLapIdx(-1); // al cambiar de referencia, arrancar en su mejor vuelta
    getter(refSessionId).then((s) => {
      if (!m) return;
      if (!s) console.warn("[analysis] no se pudo cargar la referencia:", refSessionId, "(¿el archivo tiene columnas de distancia/tiempo?)");
      setRefSession(s);
    });
    return () => { m = false; };
  }, [refSessionId, selectedId]);

  const handleDelete = async (id, source, e) => {
    e.stopPropagation();
    // .ibt/.csv/.iflylap son archivos reales → van a la papelera del SO (recuperables).
    if (source === "ibt" || source === "csv" || source === "ifly") {
      if (!window.fly?.deleteTelemetry) {
        console.warn("[analysis] deleteTelemetry no existe — reiniciá Electron (el preload no se recarga con HMR)");
        return;
      }
      const ok = await window.fly.deleteTelemetry(id);
      if (!ok) return;
    } else {
      if (!window.fly?.deleteRecording) return;
      await window.fly.deleteRecording(id);
    }
    if (id === selectedId) { setSelectedId(null); setSession(null); }
    loadList();
  };

  const handleImport = async () => {
    if (!window.fly?.importIbt) {
      console.warn("[analysis] window.fly.importIbt no existe — reiniciá Electron (el preload no se recarga con HMR)");
      return;
    }
    const item = await window.fly.importIbt();
    if (!item) return;
    setSessions((prev) => (prev.some((s) => s.id === item.id) ? prev : [item, ...prev]));
    setSelectedId(item.id);
  };

  const handlePickFolder = async () => {
    if (!window.fly?.pickTelemetryDir) {
      console.warn("[analysis] window.fly.pickTelemetryDir no existe — reiniciá Electron (el preload no se recarga con HMR)");
      return;
    }
    const info = await window.fly.pickTelemetryDir();
    if (info) { setTelemetryDir(info); loadList(); }
  };

  const handleResetFolder = async () => {
    if (!window.fly?.resetTelemetryDir) return;
    const info = await window.fly.resetTelemetryDir();
    if (info) { setTelemetryDir(info); loadList(); }
  };

  // Título a mostrar: label personalizado si existe, si no el nombre por defecto.
  const titleOf = (s) => (s && (labels[s.id] || s.track)) || "";

  // === Mapa de pista (SVG manual) ===
  useEffect(() => {
    if (window.fly?.getTrackmapDir) window.fly.getTrackmapDir().then((d) => setTrackmapDir(d?.dir || null));
  }, []);
  // Buscar el SVG de la pista de la sesión actual en la carpeta de trackmaps.
  useEffect(() => {
    if (!session || !window.fly?.getTrackMap) { setTrackMap(null); return; }
    let m = true; setTrackMap(null);
    window.fly.getTrackMap(session.trackKey || session.track).then((r) => { if (m) setTrackMap(r); });
    return () => { m = false; };
  }, [session]);

  // Geometría REAL del circuito (OpenStreetMap), georreferenciada al GPS de la
  // telemetría. bbox de la vuelta → Overpass (cacheado por pista en el main).
  useEffect(() => {
    setOsmTrack(null);
    if (!session || !lap || !lap.samples || !window.fly?.getOsmTrack) return;
    let laMin = Infinity, laMax = -Infinity, loMin = Infinity, loMax = -Infinity, c = 0;
    for (const s of lap.samples) {
      if (s && s.lat != null && s.lon != null) { laMin = Math.min(laMin, s.lat); laMax = Math.max(laMax, s.lat); loMin = Math.min(loMin, s.lon); loMax = Math.max(loMax, s.lon); c++; }
    }
    if (c < 30 || !isFinite(laMin)) return; // sin GPS suficiente
    let m = true;
    window.fly.getOsmTrack({ latMin: laMin, lonMin: loMin, latMax: laMax, lonMax: loMax, key: session.trackKey || session.track })
      .then((r) => { if (m) setOsmTrack(r || null); });
    return () => { m = false; };
  }, [session, lap]);

  // URL de Garage 61 para la pista+auto de esta sesión (por IDs de iRacing).
  useEffect(() => {
    setG61Url(null);
    if (!session || !window.fly?.getGarage61Url) return;
    if (session.trackIdIr == null || session.carIdIr == null) return;
    let m = true;
    window.fly.getGarage61Url(session.trackIdIr, session.carIdIr).then((u) => { if (m) setG61Url(u || null); });
    return () => { m = false; };
  }, [session]);

  // Cargar los títulos personalizados guardados.
  useEffect(() => {
    if (window.fly?.getSessionLabels) window.fly.getSessionLabels().then((m) => setLabels(m || {}));
  }, []);

  // Tipo de sesión normalizado a race|qual|practice (para el filtro por pills).
  const sessionKind = (s) => {
    const t = (s?.sessionType || "").toLowerCase();
    if (/qual/.test(t)) return "qual";
    if (/race/.test(t)) return "race";
    if (/practice|test|warm/.test(t)) return "practice";
    return "other";
  };

  // Listado filtrado por búsqueda + pills (fuente y tipo). Dentro de cada grupo
  // los pills suman (OR); entre grupos se combinan (AND). Sin pills = todo.
  const shownSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((s) => {
      if (q && !`${labels[s.id] || ""} ${s.track || ""} ${s.car || ""} ${s.sessionType || ""}`.toLowerCase().includes(q)) return false;
      if (srcFilter.length && !srcFilter.includes(s.source)) return false;
      if (typeFilter.length && !typeFilter.includes(sessionKind(s))) return false;
      return true;
    });
  }, [sessions, query, labels, srcFilter, typeFilter]);

  // Opciones de referencia (ghost): mismo circuito, y mismo auto salvo que una
  // de las dos sea un CSV importado. La regla vive en lib/session-match.js
  // (testeada): cada fuente nombra los circuitos distinto, así que hay que
  // probar TODOS los nombres que trae cada sesión, no solo el primero.
  const refOptions = useMemo(() => {
    if (!session) return [];
    return sessions.filter((s) => s.id !== selectedId && isComparableReference(s, session));
  }, [sessions, selectedId, session, labels]);

  const saveTitle = async () => {
    const id = session?.id;
    if (!id) { setEditingTitle(false); return; }
    const v = titleInput.trim();
    if (window.fly?.setSessionLabel) {
      const m = await window.fly.setSessionLabel(id, v);
      setLabels(m || {});
    } else {
      setLabels((prev) => { const n = { ...prev }; if (v) n[id] = v; else delete n[id]; return n; });
    }
    setEditingTitle(false);
  };


  // Series para los gráficos (largo n = cantidad de buckets).
  const charts = useMemo(() => {
    if (!lap || !lap.samples) return null;
    const n = lap.samples.length;
    // Reescalamos la referencia a la longitud de la vuelta (pueden tener distinta
    // cantidad de buckets) para que se superpongan alineadas por lugar de pista.
    const spBest = resampleSamples(best?.samples || [], n);
    const speedLap = lap.samples.map((s) => (s && s.sp != null ? s.sp * 3.6 : null));
    const speedBest = spBest.map((s) => (s && s.sp != null ? s.sp * 3.6 : null));
    const throttle = lap.samples.map((s) => (s ? s.th : null));
    const brake = lap.samples.map((s) => (s ? s.br : null));
    const steer = lap.samples.map((s) => (s && s.st != null ? s.st : null));
    const rpm = lap.samples.map((s) => (s && s.rpm != null ? s.rpm : null));
    const delta = analysis ? analysis.deltaTrace.map((p) => p.delta) : [];

    // Series de la referencia (ghost) para superponer en cada gráfico.
    const refS = best && best !== lap ? spBest : [];
    const hasRef = refS.length > 0;
    const throttleRef = refS.map((s) => (s ? s.th : null));
    const brakeRef = refS.map((s) => (s ? s.br : null));
    const steerRef = refS.map((s) => (s && s.st != null ? s.st : null));
    const rpmRef = refS.map((s) => (s && s.rpm != null ? s.rpm : null));

    const speedVals = [...speedLap, ...speedBest].filter((v) => v != null && isFinite(v));
    const spMin = speedVals.length ? Math.min(...speedVals) - 5 : 0;
    const spMax = speedVals.length ? Math.max(...speedVals) + 5 : 300;
    const dvals = delta.filter((v) => v != null && isFinite(v));
    const dMax = dvals.length ? Math.max(0.1, Math.max(...dvals.map(Math.abs))) : 0.5;
    const steerVals = [...steer, ...steerRef].filter((v) => v != null && isFinite(v));
    const stMax = steerVals.length ? Math.max(0.1, Math.max(...steerVals.map(Math.abs))) : 1;
    const rpmVals = [...rpm, ...rpmRef].filter((v) => v != null && isFinite(v));
    const rpmMax = rpmVals.length ? Math.max(...rpmVals) : 1;

    // Mapa: puntos lat/lon alineados POR BUCKET (length n, null donde falta),
    // con bounding box COMPARTIDO entre vuelta y referencia, para que ambas
    // trazadas queden alineadas y podamos marcar el instante del hover.
    const rawLap = lap.samples.map((s) => (s && s.lat != null && s.lon != null ? { lat: s.lat, lon: s.lon, sp: s.sp, th: s.th, br: s.br } : null));
    const rawRef = (best && best !== lap ? (best.samples || []) : []).map((s) => (s && s.lat != null && s.lon != null ? { lat: s.lat, lon: s.lon, th: s.th, br: s.br } : null));
    const nnLap = rawLap.filter(Boolean);
    const nnRef = rawRef.filter(Boolean);
    let mapPath = null, mapPathRef = null;
    if (nnLap.length > 20) {
      const all = [...nnLap, ...nnRef];
      const lats = all.map((p) => p.lat), lons = all.map((p) => p.lon);
      const minLat = Math.min(...lats), maxLat = Math.max(...lats);
      const minLon = Math.min(...lons), maxLon = Math.max(...lons);
      const W = 1000, H = 380, pad = 24;
      const dLat = maxLat - minLat || 1e-6, dLon = maxLon - minLon || 1e-6;
      const sc = Math.min((W - 2 * pad) / dLon, (H - 2 * pad) / dLat);
      // Centrado dentro del viewBox.
      const offX = (W - dLon * sc) / 2, offY = (H - dLat * sc) / 2;
      const tx = (p) => ({ x: offX + (p.lon - minLon) * sc, y: H - offY - (p.lat - minLat) * sc });
      const sps = nnLap.map((p) => p.sp).filter((v) => v != null);
      const spLo = sps.length ? Math.min(...sps) : 0;
      const spHi = sps.length ? Math.max(...sps) : 1;
      mapPath = rawLap.map((p) => (p ? { ...tx(p), sp: p.sp, hue: 240 - 240 * ((p.sp - spLo) / (spHi - spLo || 1)), th: p.th, br: p.br } : null));
      mapPathRef = nnRef.length > 20 ? rawRef.map((p) => (p ? { ...tx(p), th: p.th, br: p.br } : null)) : null;
    }

    // G-G: puntos (gLon lateral X, gLat vertical Y) si hay G grabadas.
    const gPts = lap.samples.map((s) => (s && s.gLat != null && s.gLon != null ? { x: s.gLon, y: s.gLat } : null)).filter(Boolean);
    const hasG = gPts.length > 20;
    const gMax = hasG ? Math.max(1, ...gPts.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y)))) : 1;

    // % del límite de grip por bucket (círculo de fricción vs envolvente g-g-v).
    // Se indexa por bucket igual que los mapPath, así el mapa lo pinta directo.
    const grip = buildGripPct(lap.samples, best && best !== lap ? best.samples : null);

    // Suspensión y frenos (sólo en vueltas que traen los canales de chasis:
    // hoy las abiertas desde un .ibt). Series por bin + resumen de eventos.
    let chassis = null;
    if (hasChassisData(lap.samples)) {
      const cs = chassisSeries(lap.samples);
      const summary = chassisSummary(lap.samples);
      const pressVals = [...cs.pressF, ...cs.pressR].filter((v) => v != null && isFinite(v));
      const deflVals = cs.defl.flat().filter((v) => v != null && isFinite(v));
      chassis = {
        ...cs,
        summary,
        pressMax: pressVals.length ? Math.max(...pressVals) : 1,
        deflMin: deflVals.length ? Math.min(...deflVals) : 0,
        deflMax: deflVals.length ? Math.max(...deflVals) : 1,
        slipMax: Math.max(0.3, ...cs.slip.filter((v) => v != null)),
      };
    }

    return { n, speedLap, speedBest, throttle, brake, steer, rpm, delta, throttleRef, brakeRef, steerRef, rpmRef, hasRef, spMin, spMax, dMax, stMax, rpmMax, mapPath, mapPathRef, gPts, hasG, gMax, hasMap: mapPath != null, gripLap: grip.lap, gripRef: grip.ref, chassis };
  }, [lap, best, analysis]);

  // Mapa con la FORMA REAL del circuito (SVG de iRacing): sampleamos el path por
  // LapDistPct y alineamos la línea GPS del auto al SVG con un ajuste de similitud.
  const svgMap = useMemo(() => {
    if (!trackMap || trackMap.error || !trackMap.svg || !lap || !lap.samples) return null;
    const parsed = parseTrackSvg(trackMap.svg);
    if (!parsed) return null;
    const n = lap.samples.length;
    if (n < 10) return null;

    const cl = trackMap.centerline;
    // Línea base de la pista (borde de irdashies, ordenado desde la meta en el
    // sentido de manejo). center(pct) da el punto de pista para esa fracción.
    let center; // (pct 0..1) -> {x,y}
    if (Array.isArray(cl) && cl.length >= 10) {
      const m = cl.length;
      center = (pct) => {
        const f = ((pct % 1) + 1) % 1;
        const idx = f * (m - 1);
        const i0 = Math.floor(idx), i1 = Math.min(m - 1, i0 + 1), t = idx - i0;
        const a = cl[i0], b = cl[i1];
        return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t };
      };
    } else {
      const sampler = pathSampler(parsed.sampleD);
      if (!sampler || !sampler.total) return null;
      const K = 720;
      const dense = new Array(K);
      for (let j = 0; j < K; j++) dense[j] = sampler.at(j / K);
      sampler.dispose();
      center = (pct) => dense[((Math.floor((((pct % 1) + 1) % 1) * K)) % K + K) % K];
    }

    const sps = lap.samples.filter((s) => s && s.sp != null).map((s) => s.sp);
    const spLo = sps.length ? Math.min(...sps) : 0, spHi = sps.length ? Math.max(...sps) : 1;
    const hueOf = (sp) => (sp != null ? 240 - 240 * ((sp - spLo) / (spHi - spLo || 1)) : 210);

    // Alineación de la trazada de posición REAL a la pista. La telemetría y la
    // línea base comparten el orden por LapDistPct, así que la correspondencia es
    // directa (bucket i ↔ punto de pista en pct i). Usamos un ajuste AFÍN (2x2 +
    // traslación): absorbe rotación, reflexión, escala distinta por eje y shear,
    // por lo que sirve para posiciones en cualquier sistema/unidad (iRacing en
    // grados, o el sistema propio del CSV). Barremos el offset de meta y AMBAS
    // direcciones por si el LapDistPct del CSV corre al revés; nos quedamos con
    // el ajuste de menor error, sin fallback.
    // Alinea las muestras de una vuelta (por su índice/pct) a la pista, buscando
    // el mejor ajuste afín sobre offset de meta y ambas direcciones. Cada vuelta
    // se alinea con su PROPIO ajuste (pueden venir de fuentes con distinto sistema
    // de coordenadas). Devuelve la función que transforma una muestra, o null.
    const alignSamples = (samples) => {
      const m = samples.length;
      const ix = [];
      for (let i = 0; i < m; i++) { const s = samples[i]; if (s && s.lat != null && s.lon != null) ix.push(i); }
      if (ix.length < Math.max(10, m * 0.4)) return null;
      const src = ix.map((i) => ({ x: samples[i].lon, y: samples[i].lat }));
      let bestErr = Infinity, bestT = null;
      for (const dir of [1, -1]) {
        for (let bi = 0; bi < 90; bi++) {
          const b0 = bi / 90;
          const dst = ix.map((i) => center(b0 + dir * (i / (m - 1))));
          const fit = fitAffine(src, dst);
          if (fit && fit.err < bestErr) { bestErr = fit.err; bestT = fit; }
        }
      }
      return bestT ? (s) => (s && s.lat != null && s.lon != null ? applyAffine(bestT, s.lon, s.lat) : null) : null;
    };

    const trLap = alignSamples(lap.samples);
    let mapPath, mapPathRef = null;
    if (trLap) {
      // Trazada REAL: posición GPS transformada por el ajuste afín, sin retoques.
      mapPath = lap.samples.map((s) => { const p = trLap(s); return p ? { x: p.x, y: p.y, sp: s.sp, hue: hueOf(s.sp), th: s.th, br: s.br } : null; });
    } else {
      // Sin datos de posición: ubicamos por LapDistPct sobre la línea central.
      mapPath = lap.samples.map((s, i) => { const p = center(i / (n - 1)); return p ? { x: p.x, y: p.y, sp: s ? s.sp : null, hue: hueOf(s ? s.sp : null), th: s ? s.th : null, br: s ? s.br : null } : null; });
    }
    const refS = best && best !== lap ? (best.samples || []) : [];
    if (refS.length) {
      const trRef = alignSamples(refS);
      if (trRef) mapPathRef = refS.map((s) => { const p = trRef(s); return p ? { x: p.x, y: p.y, th: s ? s.th : null, br: s ? s.br : null } : null; });
    }

    // Contorno = los DOS bordes reales del SVG (inside + outside), que están en
    // el mismo sistema de coordenadas que la línea central `c` (ambos salen del
    // mismo SVG), así que la trazada (ubicada sobre/alrededor de c) cae correcta
    // entre los bordes, y el ancho de pista es el REAL (variable), no una cinta
    // de ancho fijo. Fallback a la cinta del centro solo si no hay bordes.
    const ribbonD = parsed.outlineD && parsed.outlineD.length > 4
      ? parsed.outlineD
      : (Array.isArray(cl) && cl.length >= 2 ? "M" + cl.map((p) => `${p[0]},${p[1]}`).join("L") + "Z" : "");

    // Encuadre: bbox de c + la trazada, centrado, con margen y aspecto acotado
    // (evita letterbox → el zoom mapea 1:1 con el cursor).
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const acc = (x, y) => { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; };
    if (Array.isArray(cl)) for (const p of cl) acc(p[0], p[1]);
    for (const p of mapPath) if (p) acc(p.x, p.y);
    if (!isFinite(minX)) return null;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    let w = ((maxX - minX) || 1) * 1.14, h = ((maxY - minY) || 1) * 1.14;
    const target = Math.max(1.5, Math.min(3.2, w / h));
    if (w / h < target) w = h * target; else h = w / target;
    const baseView = { x: cx - w / 2, y: cy - h / 2, w, h };
    return { mapPath, mapPathRef, outlineD: ribbonD, baseView };
  }, [trackMap, lap, best]);

  // ── Mapa GPS-NATIVO (exacto): proyecta el Lat/Lon real de la telemetría a
  // metros y usa la geometría REAL del circuito (OpenStreetMap, mismo GPS del
  // mundo) como contorno. La línea y la pista comparten sistema de coordenadas
  // → calzan sin ninguna transformación de alineado. Es la fuente preferida
  // cuando hay GPS; si no, cae a svgMap (SVG de irdashies).
  const gpsMap = useMemo(() => {
    if (!lap || !lap.samples) return null;
    const n = lap.samples.length;
    let laMin = Infinity, laMax = -Infinity, loMin = Infinity, loMax = -Infinity, c = 0;
    for (const s of lap.samples) if (s && s.lat != null && s.lon != null) { laMin = Math.min(laMin, s.lat); laMax = Math.max(laMax, s.lat); loMin = Math.min(loMin, s.lon); loMax = Math.max(loMax, s.lon); c++; }
    if (c < n * 0.3 || !isFinite(laMin)) return null; // sin GPS suficiente → fallback
    const lat0 = (laMin + laMax) / 2, lon0 = (loMin + loMax) / 2;
    const R = 6378137, kx = Math.cos((lat0 * Math.PI) / 180);
    // Equirectangular a metros; y hacia abajo en pantalla (norte arriba).
    const proj = (la, lo) => ({ x: R * ((lo - lon0) * Math.PI / 180) * kx, y: -R * ((la - lat0) * Math.PI / 180) });

    const sps = lap.samples.filter((s) => s && s.sp != null).map((s) => s.sp);
    const spLo = sps.length ? Math.min(...sps) : 0, spHi = sps.length ? Math.max(...sps) : 1;
    const hueOf = (sp) => (sp != null ? 240 - 240 * ((sp - spLo) / (spHi - spLo || 1)) : 210);

    const mapPath = lap.samples.map((s) => (s && s.lat != null && s.lon != null ? { ...proj(s.lat, s.lon), sp: s.sp, hue: hueOf(s.sp), th: s.th, br: s.br } : null));
    const refS = best && best !== lap ? (best.samples || []) : [];
    let mapPathRef = null;
    if (refS.length && refS.some((s) => s && s.lat != null && s.lon != null)) {
      mapPathRef = refS.map((s) => (s && s.lat != null && s.lon != null ? { ...proj(s.lat, s.lon), th: s.th, br: s.br } : null));
    }

    // Contorno REAL de OSM (highway=raceway). El eje del circuito de OSM está en
    // el MISMO espacio geográfico que el GPS del auto: calzan sin alinear (medido
    // en Spa: línea a 2.7 m del eje en la mediana, p95 6 m — una línea de carrera
    // normal sobre pista de ~14 m). Engrosamos el eje contiguo al ancho real de
    // pista para dibujar AMBOS bordes. OSM no guarda el ancho, así que usamos un
    // valor típico (~14 m): la FORMA y la POSICIÓN son reales, solo el ancho es
    // estimado. La cinta va en metros reales → escala con el zoom.
    // Dibujamos TODOS los tramos de OSM como cinta de asfalto (cada uno engrosado
    // al ancho real). Usar todos —no solo el eje contiguo más largo— evita que se
    // recorten secciones (p. ej. Snetterton perdía tramos con el stitch). Si sobra
    // algún tramo alternativo, no molesta; lo importante es que esté completo.
    let outlineD = "", roadWidth = 0, outlineMode = null;
    let allPts = [];
    const segsLL = osmTrack && Array.isArray(osmTrack.segments) && osmTrack.segments.length
      ? osmTrack.segments
      : (osmTrack && Array.isArray(osmTrack.centerline) && osmTrack.centerline.length > 20 ? [osmTrack.centerline] : null);
    if (segsLL) {
      const projSegs = segsLL.map((seg) => seg.map(([lo, la]) => proj(la, lo)));
      outlineD = projSegs.map((seg) => smoothPath(seg)).join(" ");
      roadWidth = ROAD_WIDTH_M; // ancho de asfalto estimado (m reales)
      allPts = projSegs.flat();
    }
    if (!outlineD) return null; // sin geometría OSM no hay mapa GPS que ofrecer

    // Encuadre: bbox de la línea + el contorno OSM, con margen y aspecto acotado.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const acc = (x, y) => { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; };
    for (const p of mapPath) if (p) acc(p.x, p.y);
    for (const p of allPts) acc(p.x, p.y);
    if (!isFinite(minX)) return null;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    let w = ((maxX - minX) || 1) * 1.08, h = ((maxY - minY) || 1) * 1.08;
    const target = Math.max(1.3, Math.min(3.2, w / h));
    if (w / h < target) w = h * target; else h = w / target;
    return { mapPath, mapPathRef, outlineD, roadWidth, outlineMode, baseView: { x: cx - w / 2, y: cy - h / 2, w, h }, hasOsm: true };
  }, [lap, best, osmTrack]);

  // ── Mapa SATELITAL: tiles de Esri World Imagery (basemap satelital gratuito, sin
  // API key) proyectados en Web Mercator. El GPS de la vuelta se proyecta al MISMO
  // espacio de píxeles de los tiles → la trazada cae sobre el asfalto real de la
  // foto satelital. Solo requiere GPS (no depende de OSM). Requiere conexión.
  const satMap = useMemo(() => {
    if (!lap || !lap.samples) return null;
    const pts = lap.samples.filter((s) => s && s.lat != null && s.lon != null);
    if (pts.length < lap.samples.length * 0.3) return null;
    let laMin = Infinity, laMax = -Infinity, loMin = Infinity, loMax = -Infinity;
    for (const s of pts) { laMin = Math.min(laMin, s.lat); laMax = Math.max(laMax, s.lat); loMin = Math.min(loMin, s.lon); loMax = Math.max(loMax, s.lon); }
    const worldPx = (z) => 256 * 2 ** z;
    const lonToX = (lon, z) => (lon + 180) / 360 * worldPx(z);
    const latToY = (lat, z) => { const r = (lat * Math.PI) / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * worldPx(z); };
    // Elegimos el zoom MÁS detallado cuyo mosaico no exceda ~130 tiles.
    let Z = 13;
    for (let z = 18; z >= 12; z--) {
      const pw = lonToX(loMax, z) - lonToX(loMin, z), ph = latToY(laMin, z) - latToY(laMax, z);
      const tX = Math.ceil(pw / 256) + 2, tY = Math.ceil(ph / 256) + 2;
      if (tX * tY <= 130) { Z = z; break; }
    }
    // Origen LOCAL: los píxeles Web Mercator son enormes (~4.3 M). Con un viewBox
    // desplazado a esos valores el renderer SVG pierde precisión y parte las
    // curvas. Restamos la esquina del bbox → coordenadas chicas (~miles). Todo
    // (trazada + tiles + view) se desplaza igual, así que la alineación se mantiene.
    const ox = lonToX(loMin, Z), oy = latToY(laMax, Z);
    const proj = (la, lo) => ({ x: lonToX(lo, Z) - ox, y: latToY(la, Z) - oy });
    const sps = pts.map((s) => s.sp).filter((v) => v != null);
    const spLo = sps.length ? Math.min(...sps) : 0, spHi = sps.length ? Math.max(...sps) : 1;
    const hueOf = (sp) => (sp != null ? 240 - 240 * ((sp - spLo) / (spHi - spLo || 1)) : 210);
    const mapPath = lap.samples.map((s) => (s && s.lat != null && s.lon != null ? { ...proj(s.lat, s.lon), sp: s.sp, hue: hueOf(s.sp), th: s.th, br: s.br } : null));
    const refS = best && best !== lap ? (best.samples || []) : [];
    let mapPathRef = null;
    if (refS.length && refS.some((s) => s && s.lat != null && s.lon != null)) {
      mapPathRef = refS.map((s) => (s && s.lat != null && s.lon != null ? { ...proj(s.lat, s.lon), th: s.th, br: s.br } : null));
    }
    const minX = 0, maxX = lonToX(loMax, Z) - ox, minY = 0, maxY = latToY(laMin, Z) - oy;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    let w = ((maxX - minX) || 1) * 1.12, h = ((maxY - minY) || 1) * 1.12;
    const target = Math.max(1.3, Math.min(3.2, w / h));
    if (w / h < target) w = h * target; else h = w / target;
    const vx = cx - w / 2, vy = cy - h / 2;
    // Índices de tile en coordenadas ABSOLUTAS (sumamos el origen de vuelta);
    // posición de cada tile RELATIVA al origen local.
    const tx0 = Math.floor((vx + ox) / 256), tx1 = Math.floor((vx + w + ox) / 256), ty0 = Math.floor((vy + oy) / 256), ty1 = Math.floor((vy + h + oy) / 256);
    const nMax = 2 ** Z, tiles = [];
    for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) {
      if (tx < 0 || ty < 0 || tx >= nMax || ty >= nMax) continue;
      tiles.push({ x: tx, y: ty, px: tx * 256 - ox, py: ty * 256 - oy, url: `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${Z}/${ty}/${tx}` });
    }
    return { mapPath, mapPathRef, tiles, attribution: "Imágenes: Esri, Maxar, Earthstar Geographics", baseView: { x: vx, y: vy, w, h }, roadWidth: 0, outlineMode: null, scrim: true };
  }, [lap, best]);

  // Fuente de mapa elegible por el usuario: 'svg' = SVG del juego (irdashies) ·
  // 'osm' = trazado real de OSM · 'sat' = foto satelital (Esri). Si la elegida no
  // está disponible para esta pista, cae a la primera que sí lo esté.
  const [mapSource, setMapSource] = useState("svg");
  const availMaps = { svg: svgMap, osm: gpsMap, sat: satMap };
  const fallbackOrder = { svg: ["svg", "osm", "sat"], osm: ["osm", "svg", "sat"], sat: ["sat", "osm", "svg"] };
  const activeMap = (fallbackOrder[mapSource] || ["svg", "osm", "sat"]).map((k) => availMaps[k]).find(Boolean) || null;
  const mapAvail = { svg: !!svgMap, osm: !!gpsMap, sat: !!satMap };

  // === Compartir: datos y acciones ===
  // Nombre a mostrar en la tarjeta (default vacío; el usuario decide qué poner —
  // NO se toma el nombre real de iRacing automáticamente).
  useEffect(() => {
    if (window.fly?.getConfig) window.fly.getConfig().then((c) => setDisplayName(c?.displayName || "")).catch(() => {});
  }, []);

  // ¿La vuelta seleccionada tiene muestras utilizables para compartir?
  const canShare = !!(lap && Array.isArray(lap.samples) && lap.samples.some(Boolean));

  // Modelo de la tarjeta (tiempo, sectores, badge PB/válida, meta).
  const cardModel = useMemo(
    () => (lap ? buildCardModel({ lap, session, best: sessionBest, displayName }) : null),
    [lap, session, sessionBest, displayName]
  );

  // Fuentes de mapa disponibles PARA COMPARTIR. El satélite queda diferido
  // (los tiles remotos de Esri contaminan el canvas → toBlob falla), así que
  // solo ofrecemos OSM y SVG estilizado, con fallback automático a SVG.
  // Satélite listo para la tarjeta cuando ya se bajaron los tiles (data URLs).
  const satReady = satShareTiles && satShareTiles.tiles ? { ...satMap, tiles: satShareTiles.tiles } : null;
  const shareMapAvail = { osm: !!gpsMap, svg: !!svgMap, sat: !!satMap };
  const shareSources = { osm: gpsMap, svg: svgMap, sat: satReady };
  const shareFallback = { osm: ["osm", "svg"], svg: ["svg", "osm"], sat: ["sat", "osm", "svg"] };
  const shareMap = ((shareFallback[shareMapSource] || ["osm", "svg"]).map((k) => shareSources[k]).find(Boolean)) || null;
  // Fuente REALMENTE usada (tras el fallback), para resaltar el botón correcto.
  const effShareSource = shareMap && shareMap === satReady ? "sat" : shareMap === gpsMap ? "osm" : shareMap === svgMap ? "svg" : null;
  const satLoading = shareMapSource === "sat" && satShareTiles === "loading";

  // Bajar los tiles satelitales (como data URLs, vía main) cuando se elige
  // satélite para compartir. Sin esto el PNG saldría en blanco (canvas contaminado).
  useEffect(() => {
    if (shareMapSource !== "sat" || !satMap || !shareOpen || !window.fly?.shareTiles) { setSatShareTiles(null); return; }
    let alive = true;
    setSatShareTiles("loading");
    const urls = (satMap.tiles || []).map((t) => t.url);
    window.fly.shareTiles(urls).then((dataUrls) => {
      if (!alive) return;
      if (!Array.isArray(dataUrls)) { setSatShareTiles("error"); return; }
      const tiles = (satMap.tiles || []).map((t, i) => ({ ...t, dataUrl: dataUrls[i] })).filter((t) => t.dataUrl);
      setSatShareTiles(tiles.length ? { tiles } : "error");
    }).catch(() => { if (alive) setSatShareTiles("error"); });
    return () => { alive = false; };
  }, [shareMapSource, satMap, shareOpen]);

  // Zona del mapa de la tarjeta según formato Y nº de gráficos (el mapa cede
  // altura). Fuente única compartida con ShareCard (mismo countShareCharts).
  const shareBox = useMemo(() => {
    const b = shareMapBox(shareFormat, countShareCharts(cardModel, shareCharts));
    return { w: b.w, h: b.h };
  }, [shareFormat, cardModel, shareCharts]);

  // Subárbol del mapa ya ajustado a la caja de la tarjeta (trazada + contorno).
  const shareMapEls = useMemo(() => buildShareMapEls(shareMap, shareBox, shareMapMode, trackRot), [shareMap, shareBox, shareMapMode, trackRot]);
  const toggleShareChart = (k) => setShareCharts((cs) => (cs.includes(k) ? cs.filter((c) => c !== k) : [...cs, k]));

  const flashShare = (text) => { setShareMsg(text); setTimeout(() => setShareMsg(null), 2600); };

  const doCopy = async () => {
    if (!shareSvgRef.current) return;
    setShareBusy(true);
    try {
      const { w, h } = FORMATS[shareFormat] || FORMATS.square;
      const blob = await svgToPngBlob(shareSvgRef.current, w, h);
      const buf = await blob.arrayBuffer();
      const r = await window.fly.exportCopyImage(buf);
      flashShare(r && r.ok ? "Imagen copiada al portapapeles" : `No se pudo copiar${r && r.error ? `: ${r.error}` : ""}`);
    } catch (err) { flashShare(`Error al generar la imagen: ${err.message}`); }
    finally { setShareBusy(false); }
  };
  const doSave = async () => {
    if (!shareSvgRef.current) return;
    setShareBusy(true);
    try {
      const { w, h } = FORMATS[shareFormat] || FORMATS.square;
      const blob = await svgToPngBlob(shareSvgRef.current, w, h);
      const buf = await blob.arrayBuffer();
      const r = await window.fly.exportSaveImage(buf, sanitizeFilename(`iFly - ${session.track} - ${cardModel.time}.png`));
      if (r && r.ok) flashShare("PNG guardado");
      else if (r && r.error) flashShare(`No se pudo guardar: ${r.error}`);
    } catch (err) { flashShare(`Error al generar la imagen: ${err.message}`); }
    finally { setShareBusy(false); }
  };
  const doExportLap = async () => {
    setShareBusy(true);
    try {
      const meta = { driver: displayName, exportedAt: Date.now(), appVersion: APP_VERSION };
      const r = await window.fly.exportSaveLap({ lap, session, meta }, sanitizeFilename(`${session.track} - ${session.car} - ${cardModel.time}.iflylap`));
      if (r && r.ok) flashShare("Vuelta .iflylap exportada");
      else if (r && r.error) flashShare(`No se pudo exportar: ${r.error}`);
    } catch (err) { flashShare(`Error al exportar: ${err.message}`); }
    finally { setShareBusy(false); }
  };
  const saveDisplayName = (name) => {
    setDisplayName(name);
    if (window.fly?.setDisplayName) window.fly.setDisplayName(name).catch(() => {});
  };

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Sesiones */}
      <aside className="w-64 border-r border-border bg-card/30 flex flex-col shrink-0">
        <div className="p-3 pb-2 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <Clock className="size-3.5" /> Sesiones
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => loadList()}
              title="Refrescar: volver a leer las sesiones (grabadas + .ibt/.csv de la carpeta)"
              className="flex items-center justify-center size-[26px] rounded-md bg-accent/60 hover:bg-accent transition-colors"
            >
              <RotateCcw className="size-3" />
            </button>
            <button
              onClick={handleImport}
              title="Importar telemetría de cualquier carpeta: .ibt de iRacing o .csv (ej. export de una vuelta de Garage 61)"
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold bg-accent/60 hover:bg-accent transition-colors"
            >
              <Upload className="size-3" /> Importar
            </button>
          </div>
        </div>
        {/* Buscador */}
        <div className="px-2 pb-2">
          <div className="flex items-center gap-1.5">
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground pointer-events-none" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar sesión..."
                className="w-full bg-background border border-border rounded-md text-xs pl-7 pr-2 py-1 text-foreground"
              />
            </div>
            <button
              onClick={() => openExternal(GARAGE61_URL)}
              title="Abrir Garage 61 (laps)"
              className="shrink-0 flex items-center justify-center size-[26px] rounded-md bg-accent/60 hover:bg-accent transition-colors"
            >
              <ExternalLink className="size-3.5" />
            </button>
          </div>
          {/* Pills de filtro: fuente + tipo de sesión */}
          <div className="flex flex-wrap gap-1 mt-1.5">
            {[
              { g: "src", v: "ibt", label: "iRacing" },
              { g: "src", v: "csv", label: "CSV" },
              { g: "src", v: "live", label: "Grabado" },
              { g: "type", v: "race", label: "Race" },
              { g: "type", v: "qual", label: "Qualy" },
              { g: "type", v: "practice", label: "Practice" },
            ].map((p) => {
              const sel = p.g === "src" ? srcFilter : typeFilter;
              const setSel = p.g === "src" ? setSrcFilter : setTypeFilter;
              const active = sel.includes(p.v);
              return (
                <button
                  key={`${p.g}-${p.v}`}
                  onClick={() => setSel((cur) => (cur.includes(p.v) ? cur.filter((x) => x !== p.v) : [...cur, p.v]))}
                  className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border transition-colors ${
                    active
                      ? "bg-sky-500/20 border-sky-500/50 text-sky-300"
                      : "bg-transparent border-border text-muted-foreground hover:bg-accent/50"
                  }`}
                >
                  {p.label}
                </button>
              );
            })}
            {(srcFilter.length > 0 || typeFilter.length > 0) && (
              <button
                onClick={() => { setSrcFilter([]); setTypeFilter([]); }}
                title="Limpiar filtros"
                className="px-2 py-0.5 rounded-full text-[10px] font-semibold text-muted-foreground/70 hover:text-foreground"
              >
                ✕ limpiar
              </button>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-1.5 pb-2 space-y-1">
          {sessions.length === 0 && (
            <div className="px-2 py-4 text-[11px] text-muted-foreground">
              No hay sesiones grabadas todavía. Salí a pista con iRacing y la app va a grabar cada vuelta automáticamente.
            </div>
          )}
          {sessions.length > 0 && shownSessions.length === 0 && (
            <div className="px-2 py-4 text-[11px] text-muted-foreground">
              {query ? `Sin resultados para "${query}".` : "Ninguna sesión coincide con los filtros."}
            </div>
          )}
          {shownSessions.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelectedId(s.id)}
              className={`w-full text-left px-2 py-1.5 rounded-md transition-colors group ${
                s.id === selectedId ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
              }`}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="text-xs font-semibold truncate">{titleOf(s)}</span>
                <div className="flex items-center gap-1 shrink-0">
                  {(s.source === "ibt" || s.source === "csv" || s.source === "ifly") && (
                    <span className="text-[8px] font-bold uppercase tracking-widest px-1 py-px rounded bg-sky-500/15 text-sky-300">
                      {s.source === "ibt" ? "iRacing" : s.source === "csv" ? "CSV" : "iFly"}
                    </span>
                  )}
                  <Trash2
                    className="size-3 opacity-0 group-hover:opacity-60 hover:!opacity-100"
                    title={s.source === "ibt" || s.source === "csv" || s.source === "ifly" ? "Eliminar archivo (va a la papelera)" : "Eliminar grabación"}
                    onClick={(e) => handleDelete(s.id, s.source, e)}
                  />
                </div>
              </div>
              <div className="text-[10px] text-muted-foreground truncate">{s.car}</div>
              <div className="flex items-center justify-between text-[10px] text-muted-foreground mt-0.5">
                <span>{s.sessionType}{s.lapCount != null ? ` · ${s.lapCount} vueltas` : ""}</span>
                <span className="font-mono">{s.bestLap != null ? fmtLap(s.bestLap) : ""}</span>
              </div>
              <div className="text-[9px] text-muted-foreground/70">{fmtDate(s.startedAt)}</div>
            </button>
          ))}
        </div>

        {/* Carpeta de telemetría .ibt */}
        <div className="border-t border-border p-2 space-y-1">
          <div className="flex items-center gap-1 text-[9px] uppercase tracking-widest text-muted-foreground/70 font-bold">
            <FolderOpen className="size-3" /> Carpeta telemetría iRacing
          </div>
          <div className="text-[10px] text-muted-foreground font-mono break-all leading-tight" title={telemetryDir?.dir}>
            {telemetryDir?.dir || "—"}{telemetryDir?.custom ? "" : "  (default)"}
          </div>
          <div className="flex gap-1">
            <button
              onClick={handlePickFolder}
              className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold bg-accent/60 hover:bg-accent transition-colors"
            >
              <FolderOpen className="size-3" /> Cambiar
            </button>
            {telemetryDir?.custom && (
              <button
                onClick={handleResetFolder}
                title="Volver a la carpeta por defecto"
                className="flex items-center justify-center px-2 py-1 rounded-md text-[10px] font-semibold hover:bg-accent/50 transition-colors"
              >
                <RotateCcw className="size-3" />
              </button>
            )}
          </div>
        </div>

        {/* Mapa de pista (SVG manual) */}
        <div className="border-t border-border p-2 space-y-1">
          <div className="flex items-center gap-1 text-[9px] uppercase tracking-widest text-muted-foreground/70 font-bold">
            <Trophy className="size-3" /> Mapa de pista
          </div>
          <div className="text-[10px] text-muted-foreground/70 leading-tight">
            Contorno automático (geometría de iRacing, uso personal). Podés sobreescribir dejando un <code>.svg</code> con el nombre de la pista en esta carpeta.
          </div>
          <div className="text-[10px] text-muted-foreground font-mono break-all leading-tight" title={trackmapDir}>{trackmapDir || "—"}</div>
          <button
            onClick={() => window.fly?.openTrackmapFolder?.()}
            className="w-full flex items-center justify-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold bg-accent/60 hover:bg-accent transition-colors"
          >
            <FolderOpen className="size-3" /> Abrir carpeta (override)
          </button>
          {session && trackMap && trackMap.error && (
            <div className="text-[10px] text-muted-foreground/70 leading-tight">Sin mapa para "{session.track}".</div>
          )}
          {trackMap && trackMap.svg && (
            <div className="text-[10px] text-emerald-400">
              Mapa cargado ✓ {trackMap.source === "manual" ? "(tuyo)" : "(auto)"}{svgMap ? "" : " · alineando…"}
            </div>
          )}
        </div>
      </aside>

      {/* Detalle */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {loading ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            Cargando sesión...
          </div>
        ) : !session ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            {sessions.length === 0
              ? "No hay sesiones. Grabá una en pista, activá el logging de iRacing (Alt+L) para los .ibt, o usá Importar para cargar un .ibt o un .csv (ej. export de Garage 61)."
              : "Seleccioná una sesión para ver el análisis."}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {/* Cabecera de sesión */}
            <div className="flex items-center justify-between">
              <div>
                {editingTitle ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      value={titleInput}
                      onChange={(e) => setTitleInput(e.target.value)}
                      autoFocus
                      onKeyDown={(e) => { if (e.key === "Enter") saveTitle(); if (e.key === "Escape") setEditingTitle(false); }}
                      placeholder={session.track}
                      className="bg-background border border-border rounded-md text-sm font-bold px-2 py-0.5 text-foreground"
                    />
                    <button onClick={saveTitle} title="Guardar"><Check className="size-4 text-emerald-400" /></button>
                    <button onClick={() => setEditingTitle(false)} title="Cancelar"><X className="size-4 text-muted-foreground hover:text-foreground" /></button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-bold">{titleOf(session)}</h2>
                    <button
                      onClick={() => { setTitleInput(labels[session.id] || ""); setEditingTitle(true); }}
                      title="Renombrar sesión"
                    >
                      <Pencil className="size-3.5 text-muted-foreground hover:text-foreground" />
                    </button>
                    {g61Url && (
                      <button
                        onClick={() => openExternal(g61Url)}
                        title="Ver vueltas de este circuito y auto en Garage 61"
                        className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-sky-500/15 text-sky-300 hover:bg-sky-500/25 transition-colors"
                      >
                        <ExternalLink className="size-3" /> Garage 61
                      </button>
                    )}
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground">{session.car} · {session.sessionType}</p>
              </div>
              {cons && (
                <div className="flex gap-4 text-right">
                  <Metric label="Mejor" value={fmtLap(cons.best)} icon={Trophy} />
                  <Metric label="Consistencia (σ)" value={`${cons.std.toFixed(3)}s`} icon={Activity} />
                  <Metric label="Spread" value={`${cons.spread.toFixed(3)}s`} icon={Gauge} />
                </div>
              )}
            </div>

            {/* Vueltas + análisis */}
            <div className="flex gap-4">
              {/* Lista de vueltas */}
              <div className="w-44 shrink-0">
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-bold mb-1.5">Vueltas</div>
                <div className="space-y-0.5 max-h-[260px] overflow-y-auto pr-1">
                  {session.laps.map((l, i) => {
                    const isBest = sessionBest && l === sessionBest;
                    const isSel = i === lapIdx;
                    return (
                      <button
                        key={i}
                        onClick={() => setLapIdx(i)}
                        className={`w-full flex items-center justify-between px-2 py-1 rounded text-xs font-mono transition-colors ${
                          isSel ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                        }`}
                      >
                        <span className="flex items-center gap-1">
                          {isBest && <Trophy className="size-3 text-purple-400" />}
                          L{l.lap}
                        </span>
                        <span className={l.valid ? "" : "text-red-400/70"}>
                          {fmtLap(l.lapTime)}{!l.valid && "*"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Coach + gráficos */}
              <div className="flex-1 min-w-0 space-y-4">
                {/* Referencia (ghost) + resumen de comparación */}
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground shrink-0">Referencia:</span>
                    <select
                      value={refSessionId || ""}
                      onChange={(e) => setRefSessionId(e.target.value || null)}
                      className="flex-1 min-w-0 bg-card border border-border rounded-md text-xs px-2 py-1 text-foreground"
                      title="Compará tu vuelta contra la mejor de otra sesión grabada o un archivo importado (.ibt / .csv)"
                    >
                      <option value="">Mejor de esta sesión</option>
                      {refOptions.map((s) => (
                        <option key={s.id} value={s.id}>
                          {`${stTag(s.sessionType)} · ${titleOf(s)} · ${fmtShortDate(s.startedAt)}`}{s.source === "ibt" ? " (iRacing)" : s.source === "csv" ? " (CSV)" : ""}
                        </option>
                      ))}
                    </select>
                    {refSession && refSession.laps && refSession.laps.length > 1 && (
                      <select
                        value={refLapIdx}
                        onChange={(e) => setRefLapIdx(Number(e.target.value))}
                        className="shrink-0 w-48 bg-card border border-border rounded-md text-xs px-2 py-1 text-foreground"
                        title="Vuelta de la referencia a comparar (podés elegir una que no sea la mejor)"
                      >
                        <option value={-1}>Mejor vuelta</option>
                        {refSession.laps.map((l, i) => (
                          <option key={i} value={i}>L{l.lap} — {fmtLap(l.lapTime)}{l.valid ? "" : " *"}</option>
                        ))}
                      </select>
                    )}
                  </div>
                  {lap && best && lap !== best && analysis && (
                    <div className="text-xs text-muted-foreground">
                      <span className="text-foreground font-semibold">L{lap.lap}</span> ({fmtLap(lap.lapTime)}) vs {refSession ? "referencia" : "tu mejor"} L{best.lap} ({fmtLap(best.lapTime)}) ·
                      <span className={analysis.deltaTotal > 0 ? "text-red-400 ml-1" : "text-emerald-400 ml-1"}>
                        {fmtDelta(analysis.deltaTotal)}s
                      </span>
                    </div>
                  )}
                </div>

                {/* Coach IA */}
                {analysis && (analysis.tips.length > 0 || (analysis.insights && analysis.insights.length > 0) || cornerConsist) && (
                  <div className="rounded-lg border border-border bg-card/40 p-3 space-y-1.5">
                    <div className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
                      <Activity className="size-3.5" /> Coach
                    </div>
                    {/* Titular: mayor oportunidad de tiempo */}
                    {analysis.headline && (
                      <div className="flex items-baseline gap-2 text-xs mb-0.5 pb-1.5 border-b border-border/60">
                        <span className="text-[10px] uppercase tracking-widest text-muted-foreground/70">Mayor oportunidad</span>
                        <span className="font-bold text-foreground">{analysis.headline.label}</span>
                        <span className="font-mono text-red-400">+{analysis.headline.loss.toFixed(2)}s</span>
                        {analysis.headline.total > analysis.headline.loss + 0.01 && (
                          <span className="text-[10px] text-muted-foreground/70 ml-auto">recuperable ~{analysis.headline.total.toFixed(2)}s</span>
                        )}
                      </div>
                    )}
                    {analysis.tips.map((t, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs">
                        <span
                          className="mt-1 size-1.5 rounded-full shrink-0"
                          style={{ background: t.severity === "high" ? "rgb(239,68,68)" : t.severity === "med" ? "rgb(234,179,8)" : "rgb(52,211,153)" }}
                        />
                        <span className="text-foreground/90">{t.text}</span>
                      </div>
                    ))}
                    {analysis.insights && analysis.insights.map((t, i) => (
                      <div key={`ins-${i}`} className="flex items-start gap-2 text-xs">
                        <span className="mt-1 size-1.5 rounded-full shrink-0 bg-sky-400" />
                        <span className="text-foreground/80">{t.text}</span>
                      </div>
                    ))}
                    {/* (#6) Consistencia por curva */}
                    {cornerConsist && cornerConsist.worst && cornerConsist.worst.std >= 0.1 && (
                      <div className="flex items-start gap-2 text-xs">
                        <span className="mt-1 size-1.5 rounded-full shrink-0 bg-purple-400" />
                        <span className="text-foreground/80">
                          Sos inconsistente en <span className="font-semibold">{cornerConsist.worst.label}</span> (±{cornerConsist.worst.std.toFixed(2)}s entre vueltas): ahí hay tiempo fácil repitiendo la misma línea/frenada.
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {/* Métricas de manejo por curva */}
                {driveMetrics && <DrivingMetricsCard m={driveMetrics} hasRef={!!best} />}

                {/* Tabla de sectores reales */}
                {sectorInfo && sectorInfo.lapS && (
                  <div className="rounded-lg border border-border bg-card/40 p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Sectores{sectorInfo.real ? " (reales)" : ""}</span>
                      {trackData && <span className="text-[9px] text-muted-foreground/50">curvas/sectores: Lovely Sim Racing</span>}
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs font-mono tnum">
                        <thead>
                          <tr className="text-muted-foreground/70 text-[10px] uppercase">
                            <th className="text-left font-semibold py-1"></th>
                            {sectorInfo.lapS.map((_, i) => <th key={i} className="text-right font-semibold py-1 px-2">S{i + 1}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <td className="text-muted-foreground text-[10px]">Vuelta</td>
                            {sectorInfo.lapS.map((v, i) => <td key={i} className="text-right px-2 py-0.5">{v != null ? v.toFixed(3) : "—"}</td>)}
                          </tr>
                          {sectorInfo.refS && (
                            <tr>
                              <td className="text-muted-foreground text-[10px]">Δ ref</td>
                              {sectorInfo.lapS.map((v, i) => {
                                const r = sectorInfo.refS[i];
                                const d = v != null && r != null ? v - r : null;
                                return <td key={i} className={`text-right px-2 py-0.5 ${d == null ? "" : d > 0 ? "text-red-400" : "text-emerald-400"}`}>{d == null ? "—" : `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(3)}`}</td>;
                              })}
                            </tr>
                          )}
                          {sectorInfo.opt && sectorInfo.opt.bestPerSector && (
                            <tr>
                              <td className="text-muted-foreground text-[10px]">Óptima</td>
                              {sectorInfo.opt.bestPerSector.map((v, i) => <td key={i} className="text-right px-2 py-0.5 text-purple-300">{v != null ? v.toFixed(3) : "—"}</td>)}
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                    {sectorInfo.opt && sectorInfo.opt.optimalLap && (
                      <div className="text-[11px] text-muted-foreground mt-2">
                        Vuelta óptima (suma de tus mejores sectores): <span className="text-purple-300 font-mono font-semibold">{fmtLap(sectorInfo.opt.optimalLap)}</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Gráficos */}
                {charts && (
                  <>
                    <div className="flex items-center justify-between gap-2">
                      <MapSourceSwitch source={mapSource} setSource={setMapSource} avail={mapAvail} />
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setShareOpen(true)}
                          disabled={!canShare}
                          title={canShare ? "Compartir esta vuelta como imagen (.png) o archivo de referencia (.iflylap)" : "Esta vuelta no tiene muestras de telemetría para compartir"}
                          className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold bg-sky-500/15 text-sky-300 hover:bg-sky-500/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <Upload className="size-3" /> Compartir
                        </button>
                        <button
                          onClick={() => setDetailOpen(true)}
                          title="Abrir análisis detallado a pantalla completa (mapa + gráficos)"
                          className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold bg-accent/60 hover:bg-accent transition-colors"
                        >
                          <Maximize2 className="size-3" /> Análisis detallado
                        </button>
                      </div>
                    </div>
                    <AnalysisDetail
                      charts={charts}
                      svgMap={activeMap}
                      corners={corners}
                      hoverIdx={hoverIdx}
                      setHoverIdx={setHover}
                      showLapLine={showLapLine}
                      setShowLapLine={setShowLapLine}
                      showRefLine={showRefLine}
                      setShowRefLine={setShowRefLine}
                      mapRot={trackRot}
                      onMapRotChange={setTrackRot}
                      onMapRotReset={rotIsManual ? resetTrackRot : null}
                    />
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Vista de análisis detallado a pantalla completa: mapa (izq) + gráficos (der) */}
      {detailOpen && session && charts && (
        <div className="fixed inset-0 z-50 bg-background/98 backdrop-blur-sm flex flex-col">
          <div className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0">
            <div className="flex items-baseline gap-2 min-w-0">
              <span className="text-sm font-bold truncate">{titleOf(session)}</span>
              {lap && <span className="text-[11px] text-muted-foreground font-mono">L{lap.lap} · {fmtLap(lap.lapTime)}</span>}
              {best && best !== lap && <span className="text-[11px] text-muted-foreground">vs ref {fmtLap(best.lapTime)}</span>}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setRangeTool((v) => !v)}
                title="Zoom de tramo: activá y arrastrá sobre un gráfico para ampliar esa porción de la vuelta (se resalta en el mapa)"
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold transition-colors ${rangeTool ? "bg-sky-500/25 text-sky-300 border border-sky-500/50" : "bg-accent/60 hover:bg-accent"}`}
              >
                <Crop className="size-3.5" /> {rangeTool ? "Seleccioná un tramo…" : "Zoom de tramo"}
              </button>
              {zoomRange && (
                <button
                  onClick={() => { setZoomRange(null); setRangeTool(false); }}
                  title="Ver la vuelta completa"
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold bg-accent/60 hover:bg-accent transition-colors"
                >
                  <RotateCcw className="size-3.5" /> Vuelta completa
                </button>
              )}
              <MapSourceSwitch source={mapSource} setSource={setMapSource} avail={mapAvail} />
              <button
                onClick={closeDetail}
                title="Cerrar (Esc)"
                className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold bg-accent/60 hover:bg-accent transition-colors"
              >
                <X className="size-4" /> Cerrar
              </button>
            </div>
          </div>
          <div className="flex-1 min-h-0 p-4">
            <AnalysisDetail
              charts={charts}
              svgMap={activeMap}
              corners={corners}
              hoverIdx={hoverIdx}
              setHoverIdx={setHoverIdx}
              showLapLine={showLapLine}
              setShowLapLine={setShowLapLine}
              showRefLine={showRefLine}
              setShowRefLine={setShowRefLine}
              split
              range={zoomRange}
              selecting={rangeTool}
              onSelectRange={(r) => { setZoomRange(r); setRangeTool(false); }}
              mapRot={trackRot}
              onMapRotChange={setTrackRot}
              onMapRotReset={rotIsManual ? resetTrackRot : null}
            />
          </div>
        </div>
      )}

      {/* Panel Compartir: tarjeta PNG (3 formatos, mapa OSM/SVG) + export .iflylap */}
      {shareOpen && session && cardModel && (
        <div className="fixed inset-0 z-[60] bg-background/98 backdrop-blur-sm flex flex-col">
          <div className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0">
            <div className="flex items-baseline gap-2 min-w-0">
              <span className="text-sm font-bold truncate">Compartir vuelta</span>
              {lap && <span className="text-[11px] text-muted-foreground font-mono">L{lap.lap} · {cardModel.time}</span>}
            </div>
            <button
              onClick={() => setShareOpen(false)}
              title="Cerrar"
              className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold bg-accent/60 hover:bg-accent transition-colors"
            >
              <X className="size-4" /> Cerrar
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-4">
            <div className="flex flex-col md:flex-row gap-6 max-w-5xl mx-auto">
              {/* Controles */}
              <div className="w-full md:w-72 shrink-0 space-y-4">
                {/* Formato */}
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-bold mb-1.5">Formato</div>
                  <div className="flex flex-col gap-1">
                    {Object.entries(FORMATS).map(([k, F]) => (
                      <button
                        key={k}
                        onClick={() => setShareFormat(k)}
                        className={`text-left px-2 py-1 rounded-md text-xs font-semibold border transition-colors ${
                          shareFormat === k ? "bg-sky-500/20 border-sky-500/50 text-sky-300" : "bg-transparent border-border text-muted-foreground hover:bg-accent/50"
                        }`}
                      >
                        {F.label}
                      </button>
                    ))}
                  </div>
                </div>
                {/* Fuente del mapa */}
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-bold mb-1.5">Mapa</div>
                  {(shareMapAvail.osm || shareMapAvail.svg || shareMapAvail.sat) ? (
                    <div className="flex flex-col gap-1">
                      {[
                        { v: "osm", label: "Open Street Map" },
                        { v: "sat", label: "Satélite" },
                        { v: "svg", label: "SVG estilizado" },
                      ].filter((o) => shareMapAvail[o.v]).map((o) => (
                        <button
                          key={o.v}
                          onClick={() => setShareMapSource(o.v)}
                          className={`text-left px-2 py-1 rounded-md text-xs font-semibold border transition-colors ${
                            shareMapSource === o.v
                              ? "bg-sky-500/20 border-sky-500/50 text-sky-300"
                              : "bg-transparent border-border text-muted-foreground hover:bg-accent/50"
                          }`}
                        >
                          {o.label}{o.v === "sat" && satLoading ? " · cargando…" : ""}
                        </button>
                      ))}
                      {shareMapSource === "sat" && satShareTiles === "error" && (
                        <div className="text-[9px] text-amber-400/80 leading-tight mt-0.5">
                          No se pudo cargar el satélite (¿sin conexión?). Se usa OSM.
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-[10px] text-muted-foreground/70 leading-tight">Sin mapa para esta vuelta; la tarjeta se comparte sin trazada.</div>
                  )}
                </div>
                {/* Rotación del mapa */}
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-bold mb-1.5">Rotación del mapa</div>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min="0"
                      max="355"
                      step="5"
                      value={trackRot}
                      onChange={(e) => setTrackRot(parseInt(e.target.value, 10) || 0)}
                      className="flex-1 accent-sky-400"
                    />
                    <span className="text-xs font-mono tabular-nums w-9 text-right text-muted-foreground">{trackRot}°</span>
                  </div>
                  <div className="flex gap-1 mt-1">
                    {[0, 90, 180, 270].map((d) => (
                      <button
                        key={d}
                        onClick={() => setTrackRot(d)}
                        className={`flex-1 px-2 py-0.5 rounded-md text-[10px] font-semibold border transition-colors ${
                          trackRot === d
                            ? "bg-sky-500/20 border-sky-500/50 text-sky-300"
                            : "bg-transparent border-border text-muted-foreground hover:bg-accent/50"
                        }`}
                      >
                        {d}°
                      </button>
                    ))}
                  </div>
                  <div className="text-[9px] text-muted-foreground/60 leading-tight mt-0.5">Se guarda por circuito (también rota el mapa del análisis).</div>
                </div>
                {/* Color del mapa */}
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-bold mb-1.5">Color del mapa</div>
                  <div className="flex gap-1">
                    {[
                      { v: "speed", label: "Velocidad" },
                      { v: "throttle", label: "Acelerador" },
                      { v: "brake", label: "Freno" },
                    ].map((o) => (
                      <button
                        key={o.v}
                        onClick={() => setShareMapMode(o.v)}
                        className={`flex-1 px-2 py-1 rounded-md text-xs font-semibold border transition-colors ${
                          shareMapMode === o.v
                            ? "bg-sky-500/20 border-sky-500/50 text-sky-300"
                            : "bg-transparent border-border text-muted-foreground hover:bg-accent/50"
                        }`}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
                {/* Gráficos de la tarjeta */}
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-bold mb-1.5">Gráficos</div>
                  <div className="flex gap-1">
                    {[
                      { v: "speed", label: "Velocidad" },
                      { v: "pedals", label: "Acelerador y freno" },
                    ].map((o) => (
                      <button
                        key={o.v}
                        onClick={() => toggleShareChart(o.v)}
                        className={`flex-1 px-2 py-1 rounded-md text-xs font-semibold border transition-colors ${
                          shareCharts.includes(o.v)
                            ? "bg-sky-500/20 border-sky-500/50 text-sky-300"
                            : "bg-transparent border-border text-muted-foreground hover:bg-accent/50"
                        }`}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                  <div className="text-[9px] text-muted-foreground/60 leading-tight mt-0.5">Elegí cuáles mostrar; el espacio se redistribuye solo.</div>
                </div>
                {/* Nombre a mostrar */}
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-bold mb-1.5">Nombre a mostrar</div>
                  <input
                    value={displayName}
                    onChange={(e) => saveDisplayName(e.target.value.slice(0, 40))}
                    placeholder="Tu nombre o alias (opcional)"
                    className="w-full bg-background border border-border rounded-md text-xs px-2 py-1 text-foreground"
                  />
                  <div className="text-[9px] text-muted-foreground/60 leading-tight mt-0.5">Se guarda para la próxima. Dejalo vacío si no querés que aparezca.</div>
                </div>
                {/* Acciones */}
                <div className="flex flex-col gap-1.5 pt-1">
                  <button
                    onClick={doCopy}
                    disabled={shareBusy}
                    className="flex items-center justify-center gap-1 px-2 py-1.5 rounded-md text-xs font-semibold bg-sky-500/20 text-sky-300 hover:bg-sky-500/30 transition-colors disabled:opacity-40"
                  >
                    Copiar imagen
                  </button>
                  <button
                    onClick={doSave}
                    disabled={shareBusy}
                    className="flex items-center justify-center gap-1 px-2 py-1.5 rounded-md text-xs font-semibold bg-accent/60 hover:bg-accent transition-colors disabled:opacity-40"
                  >
                    Guardar PNG
                  </button>
                  <button
                    onClick={doExportLap}
                    disabled={shareBusy}
                    className="flex items-center justify-center gap-1 px-2 py-1.5 rounded-md text-xs font-semibold bg-accent/60 hover:bg-accent transition-colors disabled:opacity-40"
                  >
                    Exportar .iflylap
                  </button>
                  {shareMsg && <div className="text-[11px] text-emerald-400 mt-1 leading-snug">{shareMsg}</div>}
                </div>
              </div>
              {/* Preview */}
              <div className="flex-1 min-w-0 flex items-start justify-center">
                <div className="rounded-lg overflow-hidden border border-border [&>svg]:block [&>svg]:max-h-[64vh] [&>svg]:max-w-full [&>svg]:h-auto [&>svg]:w-auto">
                  <ShareCard ref={shareSvgRef} model={cardModel} mapEls={shareMapEls} format={shareFormat} logoUrl={shareLogoUrl} hasSat={effShareSource === "sat"} mapMode={shareMapMode} charts={shareCharts} />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Mapa + gráficos de telemetría (con hover vinculado). `split` = layout a dos
// mitades (mapa izq / gráficos der) para la vista de análisis detallado; si no,
// apilado (mapa arriba, gráficos abajo) para la vista normal.
// Resumen de suspensión y frenos de la vuelta: bloqueos, golpes, reparto de
// frenada medido y cuánto recorrido usó cada amortiguador.
function ChassisCard({ summary }) {
  if (!summary) return null;
  const { lockups, impacts, balance, travel } = summary;
  const maxRange = Math.max(0.001, ...travel.map((t) => t.range));
  return (
    <div className="rounded-lg border border-border bg-card/40 p-3 space-y-3">
      <div className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Suspensión y frenos</div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70">Bloqueos de rueda</div>
          {lockups.length === 0 ? (
            <div className="text-sm text-muted-foreground/60">Ninguno</div>
          ) : (
            <div className="space-y-0.5 mt-0.5">
              {lockups.slice(0, 3).map((l, i) => (
                <div key={i} className="flex items-baseline gap-1.5 text-[11px]">
                  <span className="font-mono font-semibold tabular-nums" style={{ color: l.peak > 0.4 ? "rgb(239,68,68)" : "rgb(234,179,8)" }}>
                    {Math.round(l.peak * 100)}%
                  </span>
                  <span className="text-muted-foreground">{WHEEL_LABEL[l.wheel] || "?"}</span>
                  <span className="ml-auto font-mono text-muted-foreground/60 tabular-nums">{pctLabel(l.pct)} de vuelta</span>
                </div>
              ))}
              {lockups.length > 3 && <div className="text-[10px] text-muted-foreground/50">+{lockups.length - 3} más</div>}
            </div>
          )}
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70">Golpes más fuertes</div>
          {impacts.length === 0 ? (
            <div className="text-sm text-muted-foreground/60">Vuelta limpia</div>
          ) : (
            <div className="space-y-0.5 mt-0.5">
              {impacts.slice(0, 3).map((g, i) => (
                <div key={i} className="flex items-baseline gap-1.5 text-[11px]">
                  <span className="font-mono font-semibold tabular-nums text-sky-300">{tVel(g.vel)} m/s</span>
                  <span className="text-muted-foreground">{WHEEL_LABEL[g.wheel] || "?"}</span>
                  <span className="ml-auto font-mono text-muted-foreground/60 tabular-nums">{pctLabel(g.pct)} de vuelta</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 mb-1">Reparto de frenada medido</div>
        {!balance ? (
          <div className="text-sm text-muted-foreground/60">Sin frenadas fuertes en esta vuelta</div>
        ) : balance.flat ? (
          <div className="text-[11px] text-muted-foreground/70">
            Este auto informa la misma presión de línea adelante y atrás ({tBar(balance.peakFront)} bar de pico), así que el reparto real no se puede medir.
          </div>
        ) : (
          <>
            <div className="flex h-3 rounded overflow-hidden border border-border/60">
              <div style={{ width: `${balance.front * 100}%`, background: "rgb(125,211,252)" }} />
              <div style={{ width: `${(1 - balance.front) * 100}%`, background: "rgb(168,85,247)" }} />
            </div>
            <div className="flex justify-between text-[10px] mt-0.5">
              <span className="text-sky-300 font-mono">{Math.round(balance.front * 100)}% delantero · pico {tBar(balance.peakFront)} bar</span>
              <span className="text-purple-300 font-mono">{Math.round((1 - balance.front) * 100)}% trasero · pico {tBar(balance.peakRear)} bar</span>
            </div>
          </>
        )}
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 mb-1">Recorrido usado por amortiguador</div>
        <div className="space-y-1">
          {travel.map((t, w) => (
            <div key={w} className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground w-16 shrink-0">{WHEEL_LABEL[w]}</span>
              <div className="flex-1 h-2 rounded bg-white/5 overflow-hidden">
                <div className="h-full rounded" style={{ width: `${(t.range / maxRange) * 100}%`, background: "rgb(52,211,153)" }} />
              </div>
              <span className="text-[10px] font-mono tabular-nums text-muted-foreground w-12 text-right">{tMm(t.range)} mm</span>
            </div>
          ))}
        </div>
      </div>

      <div className="text-[9px] text-muted-foreground/50">
        Más recorrido = más compresión. Los golpes son la velocidad del amortiguador: pianos, baches y tocar el fondo.
      </div>
    </div>
  );
}

function AnalysisDetail({ charts, svgMap, corners, hoverIdx, setHoverIdx, showLapLine, setShowLapLine, showRefLine, setShowRefLine, split = false, range = null, selecting = false, onSelectRange, mapRot = 0, onMapRotChange = null, onMapRotReset = null }) {
  // Path strings de las series MEMOIZADOS: son O(800) de armado de string y NO
  // dependen de `hoverIdx`. Sin este memo se reconstruían las ~11 series en CADA
  // mousemove (setHoverIdx re-renderiza AnalysisView entero) → stutter. Con deps
  // [charts, range] solo se recalculan al cambiar de vuelta o el zoom.
  const P = useMemo(() => {
    if (!charts) return null;
    const sp = (vals, yMin, yMax) => seriesPath(vals, charts.n, yMin, yMax, 1000, 110, range);
    return {
      delta: sp(charts.delta, -charts.dMax, charts.dMax),
      speedBest: sp(charts.speedBest, charts.spMin, charts.spMax),
      speedLap: sp(charts.speedLap, charts.spMin, charts.spMax),
      throttleRef: sp(charts.throttleRef, 0, 1),
      brakeRef: sp(charts.brakeRef, 0, 1),
      throttle: sp(charts.throttle, 0, 1),
      brake: sp(charts.brake, 0, 1),
      steerRef: sp(charts.steerRef, -charts.stMax, charts.stMax),
      steer: sp(charts.steer, -charts.stMax, charts.stMax),
      rpmRef: sp(charts.rpmRef, 0, charts.rpmMax),
      rpm: sp(charts.rpm, 0, charts.rpmMax),
      ...(charts.chassis ? {
        slip: sp(charts.chassis.slip, 0, charts.chassis.slipMax),
        pressF: sp(charts.chassis.pressF, 0, charts.chassis.pressMax),
        pressR: sp(charts.chassis.pressR, 0, charts.chassis.pressMax),
        defl: charts.chassis.defl.map((d) => sp(d, charts.chassis.deflMin, charts.chassis.deflMax)),
      } : {}),
    };
  }, [charts, range]);
  if (!charts) return null;

  const mapPanel = (svgMap || charts.hasMap) ? (
    <MapPanel
      mapPath={svgMap ? svgMap.mapPath : charts.mapPath}
      mapPathRef={svgMap ? svgMap.mapPathRef : charts.mapPathRef}
      mapDelta={charts.delta}
      hasRef={charts.hasRef}
      gripLap={charts.gripLap}
      gripRef={charts.gripRef}
      hoverIdx={hoverIdx}
      baseView={svgMap ? svgMap.baseView : undefined}
      outlineD={svgMap ? svgMap.outlineD : undefined}
      roadWidth={svgMap ? (svgMap.roadWidth || 0) : 0}
      outlineMode={svgMap ? (svgMap.outlineMode || null) : null}
      tiles={svgMap ? svgMap.tiles : undefined}
      attribution={svgMap ? svgMap.attribution : undefined}
      scrim={svgMap ? svgMap.scrim : false}
      corners={corners}
      fill={split}
      highlightRange={range}
      rot={mapRot}
      onRotChange={onMapRotChange}
      onRotReset={onMapRotReset}
    />
  ) : null;

  // Props comunes a todos los gráficos (incluye rango/selección).
  const cp = { n: charts.n, hoverIdx, onHover: setHoverIdx, corners, range, selecting, onSelectRange };

  const chartsCol = (
    <>
      {charts.hasRef && (
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground uppercase tracking-widest">Líneas:</span>
          <ToggleBtn active={showLapLine} onClick={() => setShowLapLine((v) => !v)} color="rgb(52,211,153)">Tu vuelta</ToggleBtn>
          <ToggleBtn active={showRefLine} onClick={() => setShowRefLine((v) => !v)} color="rgb(168,85,247)">Referencia</ToggleBtn>
        </div>
      )}

      <Chart title="Delta vs mejor vuelta (s)" {...cp}
        tooltip={[{ label: "Delta (s)", value: tSec(atv(charts.delta, hoverIdx)), color: "rgb(125,211,252)" }]}>
        <line x1="0" y1="55" x2="1000" y2="55" stroke="rgba(255,255,255,0.15)" strokeWidth="1" strokeDasharray="4 4" />
        <path d={P.delta} fill="none" stroke="rgb(125,211,252)" strokeWidth="2" />
      </Chart>

      <Chart title="Velocidad (km/h) — vuelta vs mejor" {...cp} hasRef={charts.hasRef}
        tooltip={[{ label: "Vel (km/h)", value: tKmh(atv(charts.speedLap, hoverIdx)), ref: tKmh(atv(charts.speedBest, hoverIdx)), color: "rgb(52,211,153)" }]}>
        {showRefLine && charts.hasRef && <path d={P.speedBest} fill="none" stroke="rgba(168,85,247,0.7)" strokeWidth="1.5" strokeDasharray="5 3" />}
        {showLapLine && <path d={P.speedLap} fill="none" stroke="rgb(52,211,153)" strokeWidth="2" />}
      </Chart>

      <Chart title="Acelerador (verde) y freno (rojo)" {...cp} hasRef={charts.hasRef}
        tooltip={[
          { label: "Acelerador", value: tPct(atv(charts.throttle, hoverIdx)), ref: tPct(atv(charts.throttleRef, hoverIdx)), color: "rgb(52,211,153)" },
          { label: "Freno", value: tPct(atv(charts.brake, hoverIdx)), ref: tPct(atv(charts.brakeRef, hoverIdx)), color: "rgb(239,68,68)" },
        ]}>
        {showRefLine && charts.hasRef && <path d={P.throttleRef} fill="none" stroke="rgba(52,211,153,0.5)" strokeWidth="1.5" strokeDasharray="5 3" />}
        {showRefLine && charts.hasRef && <path d={P.brakeRef} fill="none" stroke="rgba(239,68,68,0.5)" strokeWidth="1.5" strokeDasharray="5 3" />}
        {showLapLine && <path d={P.throttle} fill="none" stroke="rgb(52,211,153)" strokeWidth="2" />}
        {showLapLine && <path d={P.brake} fill="none" stroke="rgb(239,68,68)" strokeWidth="2" />}
      </Chart>

      <Chart title="Volante (ángulo)" {...cp} hasRef={charts.hasRef}
        tooltip={[{ label: "Volante", value: tDeg(atv(charts.steer, hoverIdx)), ref: tDeg(atv(charts.steerRef, hoverIdx)), color: "rgb(234,179,8)" }]}>
        <line x1="0" y1="55" x2="1000" y2="55" stroke="rgba(255,255,255,0.15)" strokeWidth="1" strokeDasharray="4 4" />
        {showRefLine && charts.hasRef && <path d={P.steerRef} fill="none" stroke="rgba(234,179,8,0.5)" strokeWidth="1.5" strokeDasharray="5 3" />}
        {showLapLine && <path d={P.steer} fill="none" stroke="rgb(234,179,8)" strokeWidth="2" />}
      </Chart>

      <Chart title="RPM" {...cp} hasRef={charts.hasRef}
        tooltip={[{ label: "RPM", value: tRpm(atv(charts.rpm, hoverIdx)), ref: tRpm(atv(charts.rpmRef, hoverIdx)), color: "rgb(129,140,248)" }]}>
        {showRefLine && charts.hasRef && <path d={P.rpmRef} fill="none" stroke="rgba(129,140,248,0.5)" strokeWidth="1.5" strokeDasharray="5 3" />}
        {showLapLine && <path d={P.rpm} fill="none" stroke="rgb(129,140,248)" strokeWidth="2" />}
      </Chart>

      {charts.chassis && (
        <>
          <Chart title="Bloqueo de rueda (% de patinaje frenando)" {...cp}
            tooltip={[{ label: "Patinaje", value: tPct(atv(charts.chassis.slip, hoverIdx)), color: "rgb(239,68,68)" }]}>
            <path d={P.slip} fill="none" stroke="rgb(239,68,68)" strokeWidth="2" />
          </Chart>

          <Chart title="Presión de freno (bar) — delantero vs trasero" {...cp}
            tooltip={[
              { label: "Delantero", value: tBar(atv(charts.chassis.pressF, hoverIdx)), color: "rgb(125,211,252)" },
              { label: "Trasero", value: tBar(atv(charts.chassis.pressR, hoverIdx)), color: "rgb(168,85,247)" },
            ]}>
            <path d={P.pressF} fill="none" stroke="rgb(125,211,252)" strokeWidth="2" />
            <path d={P.pressR} fill="none" stroke="rgb(168,85,247)" strokeWidth="1.7" />
          </Chart>

          <Chart title="Suspensión — recorrido por rueda (mm)" {...cp}
            tooltip={charts.chassis.defl.map((d, w) => ({ label: WHEEL_LABEL[w], value: tMm(atv(d, hoverIdx)), color: SUSP_COLORS[w] }))}>
            {P.defl.map((d, w) => <path key={w} d={d} fill="none" stroke={SUSP_COLORS[w]} strokeWidth="1.6" />)}
          </Chart>

          <ChassisCard summary={charts.chassis.summary} />
        </>
      )}

      <div className="text-[10px] text-muted-foreground/60">
        Eje X = distancia de la vuelta (inicio → meta). Línea punteada = referencia. Pasá el mouse por un gráfico para ver el punto en el mapa.
      </div>

      {!split && charts.hasG && (
        <div className="rounded-lg border border-border bg-card/40 p-3">
          <div className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-2">G-G (uso del neumático)</div>
          <div style={{ maxWidth: 260, margin: "0 auto" }}>
            <svg viewBox="0 0 200 200" className="w-full" style={{ height: 240 }}>
              <circle cx="100" cy="100" r="80" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="1" />
              <circle cx="100" cy="100" r="40" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
              <line x1="100" y1="20" x2="100" y2="180" stroke="rgba(255,255,255,0.12)" strokeWidth="1" />
              <line x1="20" y1="100" x2="180" y2="100" stroke="rgba(255,255,255,0.12)" strokeWidth="1" />
              {charts.gPts.map((p, i) => (
                <circle key={i} cx={100 + (p.x / charts.gMax) * 80} cy={100 - (p.y / charts.gMax) * 80} r="1.4" fill="rgba(52,211,153,0.5)" />
              ))}
            </svg>
          </div>
          <div className="text-[9px] text-muted-foreground/60 text-center">X = G lateral · Y = G longitudinal (frenada/aceleración)</div>
        </div>
      )}
    </>
  );

  if (split) {
    return (
      <div className="flex gap-4 h-full min-h-0">
        <div className="w-1/2 min-w-0 h-full">{mapPanel}</div>
        <div className="w-1/2 min-w-0 overflow-y-auto pr-1 space-y-4">{chartsCol}</div>
      </div>
    );
  }
  return (<>{mapPanel}{chartsCol}</>);
}

function Metric({ label, value, icon: Icon }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 flex items-center gap-1 justify-end">
        {Icon && <Icon className="size-3" />} {label}
      </div>
      <div className="text-sm font-mono font-semibold">{value}</div>
    </div>
  );
}
