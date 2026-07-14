import React, { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { Trash2, Trophy, Clock, Activity, Gauge, Upload, FolderOpen, RotateCcw, Pencil, Check, X, Search, ExternalLink } from "lucide-react";
import { analyzeLap, bestLapOf, consistency, sectorTimes, sessionOptimal } from "../lib/coach.js";
import lovelyTracks from "../assets/lovely-tracks.json"; // curvas + sectores por pista (© Lovely Sim Racing, CC BY-NC-SA)

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

// Tag corto de tipo de sesión: Q (qualy), R (race), P (practice/test).
function stTag(sessionType) {
  const t = (sessionType || "").toLowerCase();
  if (t.includes("qual")) return "Q";
  if (t.includes("race")) return "R";
  if (t.includes("practice") || t.includes("test") || t.includes("warm")) return "P";
  return t ? t[0].toUpperCase() : "?";
}

// Construye un path SVG desde una serie (con nulls = huecos).
function seriesPath(vals, n, yMin, yMax, W, H) {
  const span = yMax - yMin || 1;
  let d = "";
  let pen = false;
  for (let i = 0; i < n; i++) {
    const v = vals[i];
    if (v == null || !isFinite(v)) { pen = false; continue; }
    const x = (i / (n - 1)) * W;
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

// Ajuste de similitud 2D (Umeyama): src → dst. Devuelve {s,cos,sin,tx,ty,err}.
function fitSimilarity(src, dst) {
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
function applySim(T, x, y) {
  return { x: T.s * (T.cos * x - T.sin * y) + T.tx, y: T.s * (T.sin * x + T.cos * y) + T.ty };
}

// Ajuste AFÍN por mínimos cuadrados (matriz 2x2 + traslación). A diferencia de
// la similitud, absorbe reflexión, escala distinta por eje y shear → sirve para
// posiciones en cualquier sistema/unidad (ej. Lat/Lon de un CSP externo). Se
// centra src y dst para quedar bien condicionado. Correspondencia por índice.
function fitAffine(src, dst) {
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
function applyAffine(T, x, y) {
  const sx = x - T.mx, sy = y - T.my;
  return { x: T.a * sx + T.b * sy + T.mu, y: T.c * sx + T.d * sy + T.mv };
}

function Chart({ title, height = 110, n, hoverIdx, onHover, corners, children, tooltip = null, hasRef = false }) {
  const interactive = n > 1 && typeof onHover === "function";
  const hx = hoverIdx != null && n > 1 ? (hoverIdx / (n - 1)) * 1000 : null;
  const frac = hoverIdx != null && n > 1 ? hoverIdx / (n - 1) : 0;
  const handleMove = (e) => {
    if (!interactive) return;
    const r = e.currentTarget.getBoundingClientRect();
    const f = (e.clientX - r.left) / r.width;
    onHover(Math.max(0, Math.min(n - 1, Math.round(f * (n - 1)))));
  };
  const showTip = tooltip && tooltip.length > 0 && hoverIdx != null;
  return (
    <div className="rounded-lg border border-border bg-card/40 p-3">
      <div className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-2">{title}</div>
      <div className="relative" onMouseMove={handleMove} onMouseLeave={() => interactive && onHover(null)}>
        <svg viewBox={`0 0 1000 ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
          {corners && corners.map((c, i) => (
            <line key={`c-${i}`} x1={c.pct * 1000} y1="0" x2={c.pct * 1000} y2={height} stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
          ))}
          {children}
          {hx != null && <line x1={hx} y1="0" x2={hx} y2={height} stroke="rgba(255,255,255,0.55)" strokeWidth="1.5" />}
        </svg>
        {showTip && (
          <div
            className="absolute z-50 pointer-events-none rounded-md border border-border bg-[rgba(12,14,20,0.96)] px-2 py-1.5 shadow-lg text-[10px] space-y-0.5"
            style={{ top: 4, left: `${frac * 100}%`, transform: frac > 0.55 ? "translateX(calc(-100% - 8px))" : "translateX(8px)" }}
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

// Capa estática de trazadas (memoizada: no re-renderiza en cada hover).
// mode 'speed' → color por velocidad; 'compare' → verde/rojo por dónde ganás/
// perdés tiempo vs la referencia (derivada del delta).
const TrackLayer = React.memo(function TrackLayer({ segs, refD, showRef, k, mode, maxSlope }) {
  // Gradiente continuo: verde (ganás más) → gris (neutro) → rojo (perdés más).
  const cmpColor = (dv) => {
    const t = Math.max(-1, Math.min(1, dv / (maxSlope || 1e-9)));
    const grey = [140, 148, 158], green = [52, 211, 153], red = [239, 68, 68];
    const lerp = (a, b, u) => Math.round(a + (b - a) * u);
    const to = t < 0 ? green : red;
    const u = Math.abs(t);
    return `rgb(${lerp(grey[0], to[0], u)},${lerp(grey[1], to[1], u)},${lerp(grey[2], to[2], u)})`;
  };
  return (
    <g>
      {showRef && refD && (
        <path d={refD} fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth={3} strokeDasharray="7 5" strokeLinecap="round" />
      )}
      {segs.map((s, i) => (
        <path
          key={i}
          d={`M${s.x1.toFixed(1)},${s.y1.toFixed(1)}C${s.c1x.toFixed(1)},${s.c1y.toFixed(1)} ${s.c2x.toFixed(1)},${s.c2y.toFixed(1)} ${s.x2.toFixed(1)},${s.y2.toFixed(1)}`}
          fill="none"
          stroke={mode === "compare" ? cmpColor(s.dv) : `hsl(${Math.round(s.hue)},85%,55%)`}
          strokeWidth={4.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </g>
  );
});

// Mapa interactivo: zoom (rueda / +−), pan (arrastrar), toggle de trazadas y
// marcador del instante bajo el cursor (vinculado a los gráficos de telemetría).
function MapPanel({ mapPath, mapPathRef, mapDelta, hasRef, hoverIdx, baseView, outlineD, corners }) {
  const BV = baseView || { x: 0, y: 0, w: 1000, h: 380 };
  const W = BV.w, H = BV.h, X0 = BV.x, Y0 = BV.y;
  const [showLap, setShowLap] = useState(true);
  const [showRef, setShowRef] = useState(true);
  const [mode, setMode] = useState("speed"); // 'speed' | 'compare'
  const [view, setView] = useState(BV);
  const [dragging, setDragging] = useState(false);
  const effMode = hasRef ? mode : "speed"; // comparación necesita referencia
  const wrapRef = useRef(null);
  const dragRef = useRef(null);
  const k = view.w / W; // factor de zoom → escalamos trazos para tamaño ~constante

  // Resetear el encuadre cuando cambia la pista (baseView).
  useEffect(() => { setView(BV); }, [BV.x, BV.y, BV.w, BV.h]);

  const reset = () => setView(BV);
  const zoomAt = (fx, fy, factor) => setView((v) => {
    let nw = v.w * factor;
    if (nw >= W * 0.98) return { x: X0, y: Y0, w: W, h: H }; // snap a completo
    nw = Math.max(W * 0.1, nw);
    const nh = nw * (H / W);
    const cx = v.x + fx * v.w, cy = v.y + fy * v.h;
    const nx = Math.max(X0, Math.min(X0 + W - nw, cx - fx * nw));
    const ny = Math.max(Y0, Math.min(Y0 + H - nh, cy - fy * nh));
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
  }, [W, H, X0, Y0]);

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
    setView((v) => ({ ...v, x: Math.max(X0, Math.min(X0 + W - v.w, d.vx - dx)), y: Math.max(Y0, Math.min(Y0 + H - v.h, d.vy - dy)) }));
  };
  const onUp = () => { dragRef.current = null; setDragging(false); };

  // Capa de trazadas memoizada: no se reconstruye en cada hover (solo cuando
  // cambian datos/zoom/toggles), así el marcador de hover se mueve fluido.
  const segs = useMemo(() => {
    const out = [];
    if (showLap && mapPath) {
      const W = 3; // ventana de suavizado del delta (reduce ruido bucket a bucket)
      for (let i = 1; i < mapPath.length; i++) {
        const a = mapPath[i - 1], b = mapPath[i];
        if (a && b) {
          // dv = pendiente del delta (tiempo ganado/perdido) promediada sobre W
          // buckets → verde si ganás, rojo si perdés, sin saltar por ruido.
          const j = Math.max(0, i - W);
          const dv = mapDelta && mapDelta[i] != null && mapDelta[j] != null && i > j
            ? (mapDelta[i] - mapDelta[j]) / (i - j)
            : 0;
          // Puntos de control Catmull-Rom (tensión 1/6) usando los vecinos, para
          // dibujar cada tramo como una curva suave con uniones continuas.
          const p0 = mapPath[i - 2] || a;
          const p3 = mapPath[i + 1] || b;
          const c1x = a.x + (b.x - p0.x) / 6, c1y = a.y + (b.y - p0.y) / 6;
          const c2x = b.x - (p3.x - a.x) / 6, c2y = b.y - (p3.y - a.y) / 6;
          out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, c1x, c1y, c2x, c2y, hue: b.hue, dv });
        }
      }
    }
    return out;
  }, [mapPath, showLap, mapDelta]);
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
  const hLap = showLap && hoverIdx != null && mapPath && mapPath[hoverIdx];
  const hRef = showRef && hoverIdx != null && mapPathRef && mapPathRef[hoverIdx];

  return (
    <div className="rounded-lg border border-border bg-card/40 p-3">
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Mapa</span>
          {hasRef && (
            <div className="flex border border-border rounded-md overflow-hidden">
              {[["speed", "Velocidad"], ["compare", "Comparación"]].map(([v, l]) => (
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
          )}
        </div>
        <div className="flex items-center gap-1">
          <ToggleBtn active={showLap} onClick={() => setShowLap((v) => !v)} color="rgb(52,211,153)">Tu vuelta</ToggleBtn>
          {mapPathRef && <ToggleBtn active={showRef} onClick={() => setShowRef((v) => !v)} color="rgba(255,255,255,0.85)">Referencia</ToggleBtn>}
          <button onClick={() => zoomAt(0.5, 0.5, 0.7)} className="px-2 py-0.5 rounded-md text-xs font-bold hover:bg-white/10">+</button>
          <button onClick={() => zoomAt(0.5, 0.5, 1.45)} className="px-2 py-0.5 rounded-md text-xs font-bold hover:bg-white/10">−</button>
          <button onClick={reset} className="px-2 py-0.5 rounded-md text-[10px] font-semibold hover:bg-white/10">Reset</button>
        </div>
      </div>
      <div ref={wrapRef} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} style={{ cursor: dragging ? "grabbing" : "grab" }}>
        <svg viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} preserveAspectRatio="xMidYMid meet" className="w-full block" style={{ aspectRatio: `${W} / ${H}` }}>
          {outlineD && (
            <g>
              {/* Cinta de la pista: borde claro + asfalto oscuro (ancho en unidades
                  de pista → zoomea con el mapa). La trazada va centrada encima. */}
              <path d={outlineD} fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth={46} strokeLinejoin="round" strokeLinecap="round" />
              <path d={outlineD} fill="none" stroke="rgb(17,18,22)" strokeWidth={38} strokeLinejoin="round" strokeLinecap="round" />
            </g>
          )}
          <TrackLayer segs={segs} refD={refD} showRef={showRef} k={k} mode={effMode} maxSlope={maxSlope} />
          {corners && mapPath && corners.map((c, i) => {
            const b = Math.round(c.pct * (mapPath.length - 1));
            const p = mapPath[b];
            if (!p) return null;
            return (
              <g key={`cn-${i}`}>
                <circle cx={p.x} cy={p.y} r={3.5 * k} fill="white" stroke="black" strokeWidth={1.5 * k} />
                <text
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
        </svg>
      </div>
      <div className="text-[9px] text-muted-foreground/60 mt-1">
        {effMode === "compare"
          ? "Verde = ganás tiempo · rojo = perdés (vs referencia)"
          : "Color = velocidad (azul → rojo)"}
        {mapPathRef ? " · punteada = referencia" : ""} · rueda o +/− zoom · arrastrá para mover · hover en los gráficos = punto en el mapa
      </div>
    </div>
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
  const [showLapLine, setShowLapLine] = useState(true); // toggles de líneas en gráficos
  const [showRefLine, setShowRefLine] = useState(true);
  const [trackMap, setTrackMap] = useState(null); // { svg } | { error }
  const [trackmapDir, setTrackmapDir] = useState(null);
  const [refSessionId, setRefSessionId] = useState(null); // ghost: otra sesión como referencia
  const [refSession, setRefSession] = useState(null);
  const [refLapIdx, setRefLapIdx] = useState(-1); // vuelta de la referencia (-1 = mejor)
  const [g61Url, setG61Url] = useState(null); // URL de Garage 61 para este circuito+auto

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
    const unsub = window.fly.onRecordingsChange(() => loadList());
    return unsub;
  }, [loadList]);

  useEffect(() => {
    if (!selectedId) { setSession(null); return; }
    const isFile = /^(ibt|csv)/.test(selectedId); // .ibt/.csv escaneados o importados
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
  const analysis = useMemo(() => (best && lap ? analyzeLap(best, lap) : null), [best, lap]);

  // Datos de pista de Lovely (curvas + sectores reales) por nombre de circuito.
  const trackData = useMemo(() => {
    if (!session) return null;
    const nrm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    // Usamos el nombre interno con config (trackKey) si está; si no, el display.
    const target = nrm(session.trackKey || session.track);
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
    for (const k in tracks) {
      let score = cp(k, target) * 3 + lcs(k, target);
      if (k.includes(target) || target.includes(k)) score += Math.min(k.length, target.length);
      const dk = digits(k);
      if (dt.length && dk.length && dt.some((d) => dk.includes(d))) score += 50;
      if (score > bestScore) { bestScore = score; best = tracks[k]; }
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
    const getter = /^(ibt|csv)/.test(refSessionId) ? window.fly?.getIbtSession : window.fly?.getRecording;
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
    // .ibt/.csv son archivos reales → van a la papelera del SO (recuperables).
    if (source === "ibt" || source === "csv") {
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

  // Opciones de referencia (ghost): solo MISMO circuito + mismo auto que la
  // sesión actual. Match tolerante (igualdad, contención o prefijo común ≥6)
  // porque los nombres varían entre display/interno/CSV (ej. "Snetterton Racing
  // Circuit" vs "snetterton 300"), pero pistas distintas (Snetterton vs Tsukuba)
  // no se confunden.
  const norm = (x) => (x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const like = (a, b) => {
    a = norm(a); b = norm(b);
    if (!a || !b) return false;
    if (a === b || a.includes(b) || b.includes(a)) return true;
    let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i >= 6;
  };
  const refOptions = useMemo(() => {
    if (!session) return [];
    return sessions.filter((s) => {
      if (s.id === selectedId) return false;
      return like(s.trackKey || s.track, session.trackKey || session.track) && like(s.car, session.car);
    });
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
    const spBest = best?.samples || [];
    const speedLap = lap.samples.map((s) => (s && s.sp != null ? s.sp * 3.6 : null));
    const speedBest = spBest.map((s) => (s && s.sp != null ? s.sp * 3.6 : null));
    const throttle = lap.samples.map((s) => (s ? s.th : null));
    const brake = lap.samples.map((s) => (s ? s.br : null));
    const steer = lap.samples.map((s) => (s && s.st != null ? s.st : null));
    const rpm = lap.samples.map((s) => (s && s.rpm != null ? s.rpm : null));
    const delta = analysis ? analysis.deltaTrace.map((p) => p.delta) : [];

    // Series de la referencia (ghost) para superponer en cada gráfico.
    const refS = best && best !== lap ? (best.samples || []) : [];
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
    const rawLap = lap.samples.map((s) => (s && s.lat != null && s.lon != null ? { lat: s.lat, lon: s.lon, sp: s.sp } : null));
    const rawRef = (best && best !== lap ? (best.samples || []) : []).map((s) => (s && s.lat != null && s.lon != null ? { lat: s.lat, lon: s.lon } : null));
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
      mapPath = rawLap.map((p) => (p ? { ...tx(p), sp: p.sp, hue: 240 - 240 * ((p.sp - spLo) / (spHi - spLo || 1)) } : null));
      mapPathRef = nnRef.length > 20 ? rawRef.map((p) => (p ? tx(p) : null)) : null;
    }

    // G-G: puntos (gLon lateral X, gLat vertical Y) si hay G grabadas.
    const gPts = lap.samples.map((s) => (s && s.gLat != null && s.gLon != null ? { x: s.gLon, y: s.gLat } : null)).filter(Boolean);
    const hasG = gPts.length > 20;
    const gMax = hasG ? Math.max(1, ...gPts.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y)))) : 1;

    return { n, speedLap, speedBest, throttle, brake, steer, rpm, delta, throttleRef, brakeRef, steerRef, rpmRef, hasRef, spMin, spMax, dMax, stMax, rpmMax, mapPath, mapPathRef, gPts, hasG, gMax, hasMap: mapPath != null };
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
      mapPath = lap.samples.map((s) => { const p = trLap(s); return p ? { x: p.x, y: p.y, sp: s.sp, hue: hueOf(s.sp) } : null; });
    } else {
      // Sin datos de posición: ubicamos por LapDistPct sobre la línea base.
      mapPath = lap.samples.map((s, i) => { const p = center(i / (n - 1)); return p ? { x: p.x, y: p.y, sp: s ? s.sp : null, hue: hueOf(s ? s.sp : null) } : null; });
    }
    const refS = best && best !== lap ? (best.samples || []) : [];
    if (refS.length) {
      const trRef = alignSamples(refS);
      if (trRef) mapPathRef = refS.map((s) => trRef(s));
    }

    // Cinta de la pista a lo largo de la línea base c (como irdashies dibuja el
    // borde con trazo grueso). La trazada se ubica sobre/alrededor de c, así que
    // SIEMPRE coincide con la pista dibujada, sin depender de que inside/outside
    // cuadren. Si no hay c (SVG manual), caemos al contorno original.
    const ribbonD = Array.isArray(cl) && cl.length >= 2
      ? "M" + cl.map((p) => `${p[0]},${p[1]}`).join("L") + "Z"
      : parsed.outlineD;

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

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Sesiones */}
      <aside className="w-64 border-r border-border bg-card/30 flex flex-col shrink-0">
        <div className="p-3 pb-2 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <Clock className="size-3.5" /> Sesiones
          </span>
          <button
            onClick={handleImport}
            title="Importar telemetría de cualquier carpeta: .ibt de iRacing o .csv (ej. export de una vuelta de Garage 61)"
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold bg-accent/60 hover:bg-accent transition-colors"
          >
            <Upload className="size-3" /> Importar
          </button>
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
                  {(s.source === "ibt" || s.source === "csv") && (
                    <span className="text-[8px] font-bold uppercase tracking-widest px-1 py-px rounded bg-sky-500/15 text-sky-300">
                      {s.source === "ibt" ? "iRacing" : "CSV"}
                    </span>
                  )}
                  <Trash2
                    className="size-3 opacity-0 group-hover:opacity-60 hover:!opacity-100"
                    title={s.source === "ibt" || s.source === "csv" ? "Eliminar archivo (va a la papelera)" : "Eliminar grabación"}
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
                {analysis && (analysis.tips.length > 0 || (analysis.insights && analysis.insights.length > 0)) && (
                  <div className="rounded-lg border border-border bg-card/40 p-3 space-y-1.5">
                    <div className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
                      <Activity className="size-3.5" /> Coach
                    </div>
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
                  </div>
                )}

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
                    {/* Mapa full width con trazadas, zoom/pan y marcador de hover */}
                    {(svgMap || charts.hasMap) && (
                      <MapPanel
                        mapPath={svgMap ? svgMap.mapPath : charts.mapPath}
                        mapPathRef={svgMap ? svgMap.mapPathRef : charts.mapPathRef}
                        mapDelta={charts.delta}
                        hasRef={charts.hasRef}
                        hoverIdx={hoverIdx}
                        baseView={svgMap ? svgMap.baseView : undefined}
                        outlineD={svgMap ? svgMap.outlineD : undefined}
                        corners={corners}
                      />
                    )}

                    {/* Toggle de líneas (tu vuelta / referencia) para todos los gráficos */}
                    {charts.hasRef && (
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] text-muted-foreground uppercase tracking-widest">Líneas:</span>
                        <ToggleBtn active={showLapLine} onClick={() => setShowLapLine((v) => !v)} color="rgb(52,211,153)">Tu vuelta</ToggleBtn>
                        <ToggleBtn active={showRefLine} onClick={() => setShowRefLine((v) => !v)} color="rgb(168,85,247)">Referencia</ToggleBtn>
                      </div>
                    )}

                    <Chart title="Delta vs mejor vuelta (s)" n={charts.n} hoverIdx={hoverIdx} onHover={setHoverIdx} corners={corners}
                      tooltip={[{ label: "Delta (s)", value: tSec(atv(charts.delta, hoverIdx)), color: "rgb(125,211,252)" }]}>
                      <line x1="0" y1="55" x2="1000" y2="55" stroke="rgba(255,255,255,0.15)" strokeWidth="1" strokeDasharray="4 4" />
                      <path d={seriesPath(charts.delta, charts.n, -charts.dMax, charts.dMax, 1000, 110)} fill="none" stroke="rgb(125,211,252)" strokeWidth="2" />
                    </Chart>

                    <Chart title="Velocidad (km/h) — vuelta vs mejor" n={charts.n} hoverIdx={hoverIdx} onHover={setHoverIdx} corners={corners}
                      hasRef={charts.hasRef}
                      tooltip={[{ label: "Vel (km/h)", value: tKmh(atv(charts.speedLap, hoverIdx)), ref: tKmh(atv(charts.speedBest, hoverIdx)), color: "rgb(52,211,153)" }]}>
                      {showRefLine && charts.hasRef && <path d={seriesPath(charts.speedBest, charts.n, charts.spMin, charts.spMax, 1000, 110)} fill="none" stroke="rgba(168,85,247,0.7)" strokeWidth="1.5" strokeDasharray="5 3" />}
                      {showLapLine && <path d={seriesPath(charts.speedLap, charts.n, charts.spMin, charts.spMax, 1000, 110)} fill="none" stroke="rgb(52,211,153)" strokeWidth="2" />}
                    </Chart>

                    <Chart title="Acelerador (verde) y freno (rojo)" n={charts.n} hoverIdx={hoverIdx} onHover={setHoverIdx} corners={corners}
                      hasRef={charts.hasRef}
                      tooltip={[
                        { label: "Acelerador", value: tPct(atv(charts.throttle, hoverIdx)), ref: tPct(atv(charts.throttleRef, hoverIdx)), color: "rgb(52,211,153)" },
                        { label: "Freno", value: tPct(atv(charts.brake, hoverIdx)), ref: tPct(atv(charts.brakeRef, hoverIdx)), color: "rgb(239,68,68)" },
                      ]}>
                      {showRefLine && charts.hasRef && <path d={seriesPath(charts.throttleRef, charts.n, 0, 1, 1000, 110)} fill="none" stroke="rgba(52,211,153,0.5)" strokeWidth="1.5" strokeDasharray="5 3" />}
                      {showRefLine && charts.hasRef && <path d={seriesPath(charts.brakeRef, charts.n, 0, 1, 1000, 110)} fill="none" stroke="rgba(239,68,68,0.5)" strokeWidth="1.5" strokeDasharray="5 3" />}
                      {showLapLine && <path d={seriesPath(charts.throttle, charts.n, 0, 1, 1000, 110)} fill="none" stroke="rgb(52,211,153)" strokeWidth="2" />}
                      {showLapLine && <path d={seriesPath(charts.brake, charts.n, 0, 1, 1000, 110)} fill="none" stroke="rgb(239,68,68)" strokeWidth="2" />}
                    </Chart>

                    <Chart title="Volante (ángulo)" n={charts.n} hoverIdx={hoverIdx} onHover={setHoverIdx} corners={corners}
                      hasRef={charts.hasRef}
                      tooltip={[{ label: "Volante", value: tDeg(atv(charts.steer, hoverIdx)), ref: tDeg(atv(charts.steerRef, hoverIdx)), color: "rgb(234,179,8)" }]}>
                      <line x1="0" y1="55" x2="1000" y2="55" stroke="rgba(255,255,255,0.15)" strokeWidth="1" strokeDasharray="4 4" />
                      {showRefLine && charts.hasRef && <path d={seriesPath(charts.steerRef, charts.n, -charts.stMax, charts.stMax, 1000, 110)} fill="none" stroke="rgba(234,179,8,0.5)" strokeWidth="1.5" strokeDasharray="5 3" />}
                      {showLapLine && <path d={seriesPath(charts.steer, charts.n, -charts.stMax, charts.stMax, 1000, 110)} fill="none" stroke="rgb(234,179,8)" strokeWidth="2" />}
                    </Chart>

                    <Chart title="RPM" n={charts.n} hoverIdx={hoverIdx} onHover={setHoverIdx} corners={corners}
                      hasRef={charts.hasRef}
                      tooltip={[{ label: "RPM", value: tRpm(atv(charts.rpm, hoverIdx)), ref: tRpm(atv(charts.rpmRef, hoverIdx)), color: "rgb(129,140,248)" }]}>
                      {showRefLine && charts.hasRef && <path d={seriesPath(charts.rpmRef, charts.n, 0, charts.rpmMax, 1000, 110)} fill="none" stroke="rgba(129,140,248,0.5)" strokeWidth="1.5" strokeDasharray="5 3" />}
                      {showLapLine && <path d={seriesPath(charts.rpm, charts.n, 0, charts.rpmMax, 1000, 110)} fill="none" stroke="rgb(129,140,248)" strokeWidth="2" />}
                    </Chart>

                    <div className="text-[10px] text-muted-foreground/60">
                      Eje X = distancia de la vuelta (inicio → meta). Línea punteada = referencia. Pasá el mouse por un gráfico para ver el punto en el mapa.
                    </div>

                    {charts.hasG && (
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
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
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
