import React, { useEffect, useMemo, useRef, useState } from "react";
import { EditCorners } from "./ui/edit-corners.jsx";

// Radar de proximidad (spotter). iRacing NO expone la posición lateral de los
// otros autos: la única posición por auto es CarIdxLapDistPct. Por eso:
//   - Eje longitudinal (adelante/atrás): EXACTO, de relMeters (Δpct × largo).
//   - Lado (izq/der): del spotter propio del juego (CarLeftRight) — mismo dato
//     que las barras naranjas nativas. Es binario (izq/der/ambos, hasta 2 autos)
//     pero fiable para el aviso "hay auto al lado, no cierres".

const CLASS_PALETTE = { 1: "#f6c915", 2: "#3b82f6", 3: "#ef4444", 4: "#22c55e", 5: "#a855f7", 6: "#f97316", 7: "#06b6d4" };
function classColorCss(c) {
  if (c == null || c === 0) return null;
  if (c > 0 && c <= 16) return CLASS_PALETTE[c] || "rgb(160,160,170)";
  const hex = (c & 0xffffff).toString(16).padStart(6, "0");
  return `#${hex}`;
}

// Líneas de la grilla con forma de "huso": gruesas al medio, afinándose a una
// punta en los extremos. Combinado con un gradiente de opacidad, se desvanecen
// suavemente hacia las puntas. (viewBox en unidades 0..100.)
function vLens(cx, cy, L, w) {
  return `M ${cx} ${cy - L} C ${cx + w} ${cy - L * 0.45} ${cx + w} ${cy + L * 0.45} ${cx} ${cy + L} C ${cx - w} ${cy + L * 0.45} ${cx - w} ${cy - L * 0.45} ${cx} ${cy - L} Z`;
}
function hLens(cx, cy, L, w) {
  return `M ${cx - L} ${cy} C ${cx - L * 0.45} ${cy - w} ${cx + L * 0.45} ${cy - w} ${cx + L} ${cy} C ${cx + L * 0.45} ${cy + w} ${cx - L * 0.45} ${cy + w} ${cx - L} ${cy} Z`;
}

// Color por cercanía (metros): más cerca = más urgente.
function proxColor(dist) {
  const d = Math.abs(dist);
  if (d < 3) return "rgb(239,68,68)";     // rojo: muy cerca
  if (d < 8) return "rgb(249,115,22)";    // naranja
  if (d < 18) return "rgb(234,179,8)";    // amarillo
  return "rgb(52,211,153)";               // verde: lejano
}

export function Radar({ previewMode = false, injectedTelemetry = null, settings = {} }) {
  const cfg = useMemo(() => ({
    range: 60,               // alcance adelante/atrás en metros (para el aviso de aproximación)
    carLength: 4.6,          // largo del auto en metros. iRacing NO lo expone; con este
                             // valor dibujamos ambos autos a escala y se ve el solape
                             // nariz-a-cola exacto (monomarca F4 → ajustá acá si hace falta).
    showClassColors: true,
    showDistance: true,
    fontSize: 12,
    ...settings,
  }), [settings]);

  const [telemetry, setTelemetry] = useState({ connected: false, onTrack: false, preview: false, relative: null, carLeftRight: 0 });
  const [unlocked, setUnlocked] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    if (injectedTelemetry) return;
    if (typeof window === "undefined" || !window.fly) return;
    if (typeof window.fly.onTelemetry !== "function") return;
    try { return window.fly.onTelemetry((data) => setTelemetry((p) => ({ ...p, ...data }))); } catch (_) {}
  }, [injectedTelemetry]);

  useEffect(() => {
    if (injectedTelemetry) setTelemetry((p) => ({ ...p, ...injectedTelemetry }));
  }, [injectedTelemetry]);

  useEffect(() => {
    if (injectedTelemetry) return;
    if (typeof window === "undefined" || !window.fly) return;
    if (typeof window.fly.onTelemetryHeavy !== "function") return;
    try {
      return window.fly.onTelemetryHeavy((data) => {
        if (data.relative) setTelemetry((p) => ({ ...p, relative: data.relative }));
      });
    } catch (_) {}
  }, [injectedTelemetry]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.fly) return;
    if (typeof window.fly.onLockState !== "function") return;
    try {
      const unsub = window.fly.onLockState((s) => setUnlocked(!!s.unlocked));
      if (typeof window.fly.getLockState === "function") window.fly.getLockState().then((s) => setUnlocked(!!s.unlocked));
      return unsub;
    } catch (_) {}
  }, []);

  const shouldShow = unlocked || previewMode || telemetry.preview || (telemetry.onTrack && telemetry.connected);
  const rel = telemetry.relative;
  const drivers = rel?.drivers || [];
  const playerIdx = rel?.playerIdx ?? -1;
  const range = Math.max(15, cfg.range || 60);

  const multiClass = useMemo(() => new Set(drivers.map((d) => d.carClassId)).size > 1, [drivers]);

  // Autos cercanos EN PISTA dentro del alcance (por distancia longitudinal real).
  const nearby = useMemo(() => {
    return drivers.filter((d) =>
      d.carIdx !== playerIdx && d.onTrack && !d.onPit && !d.out &&
      d.relMeters != null && isFinite(d.relMeters) && Math.abs(d.relMeters) <= range
    );
  }, [drivers, playerIdx, range]);

  // Spotter del juego (izq/der). Enum irsdk (raw de memoria compartida, 0-based):
  // 0 Clear · 1 Left · 2 Right · 3 LeftRight · 4 2Left · 5 2Right.
  const clr = telemetry.carLeftRight | 0;
  const hasLeft = clr === 1 || clr === 3 || clr === 4;
  const hasRight = clr === 2 || clr === 3 || clr === 5;
  const twoLeft = clr === 4;
  const twoRight = clr === 5;

  // ── Modelo en PORCENTAJE del contenedor (HTML/CSS: degradados + transiciones
  // suaves, fondo transparente). Escala CERCANA: cada auto a su LARGO REAL, así la
  // trompa/cola quedan a escala y el solape lado a lado es exacto. ──
  const carLength = Math.max(2, cfg.carLength || 4.6);            // m
  const winM = Math.max(6, cfg.spotterRange || carLength * 3);    // m visibles (±) a escala
  const carH = (carLength / (2 * winM)) * 100;                    // alto del auto en % del alto
  const clamp01 = (v) => Math.max(0, Math.min(100, v));
  const yPct = (m) => 50 - (m / winM) * 50;                       // metros → % (adelante=arriba)
  const bandTop = (m) => yPct(m + carLength / 2);                 // % del borde delantero (trompa)
  const inWin = (m) => Math.abs(m) <= winM + carLength / 2;
  // Opacidad por cercanía: más cerca = más opaco.
  const proxOp = (m, max) => Math.max(0.1, Math.min(max, max * (1 - Math.abs(m) / (winM + carLength))));

  const nearest = useMemo(() => {
    let best = null;
    for (const d of nearby) if (best == null || Math.abs(d.relMeters) < Math.abs(best.relMeters)) best = d;
    return best;
  }, [nearby]);

  // Auto de al lado: CarLeftRight da el LADO; la ALTURA (y qué auto) la tomamos del
  // solapado más cercano. iRacing no dice qué auto puntual hay a cada lado.
  let besideCar = null;
  for (const d of nearby) {
    if (Math.abs(d.relMeters) > winM + carLength) continue;
    if (besideCar == null || Math.abs(d.relMeters) < Math.abs(besideCar.relMeters)) besideCar = d;
  }
  const besideIdx = (hasLeft || hasRight) && besideCar ? besideCar.carIdx : null;
  const besideM = besideCar ? besideCar.relMeters : 0;

  // Autos adelante/atrás dentro de la ventana (para los semicírculos amarillos).
  const longCars = nearby.filter((d) => inWin(d.relMeters) && d.carIdx !== besideIdx);

  // Franja lateral (roja) para un lado. Siempre montada; opacidad 0 si no hay auto
  // → transición suave de aparición/desaparición. Corte recto en trompa/cola.
  const redBand = (side, active) => {
    const op = active ? proxOp(besideM, 0.82) : 0;
    const top = clamp01(active ? bandTop(besideM) : 50 - carH / 2);
    const dir = side === "left" ? "to left" : "to right";
    return (
      <div key={side} style={{
        position: "absolute", [side]: 0, width: "52%", top: `${top}%`, height: `${carH}%`,
        background: `linear-gradient(${dir}, rgba(239,68,68,0.95), rgba(239,68,68,0))`,
        opacity: op, transition: "top 140ms linear, opacity 200ms ease", pointerEvents: "none", willChange: "top, opacity",
      }} />
    );
  };

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full select-none transition-opacity duration-300 ${shouldShow ? "opacity-100" : "opacity-0"} ${unlocked ? "cursor-grab" : ""}`}
      style={unlocked ? { WebkitAppRegion: "drag" } : undefined}
    >
      {unlocked && <EditCorners />}
      {telemetry.preview && (
        <div className="absolute top-1 right-1 px-1.5 py-0.5 rounded bg-yellow-500/20 border border-yellow-500/40 text-[8px] font-bold tracking-widest text-yellow-400 z-50" style={{ pointerEvents: "none" }}>PREVIEW</div>
      )}
      {unlocked && (
        <div className="absolute top-1 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded text-[9px] font-bold tracking-widest z-50 shadow" style={{ pointerEvents: "none", background: "rgb(59,130,246)", color: "white" }}>EDIT MODE · F7 TO LOCK</div>
      )}

      {/* Radar estilo RaceLab: SIN FONDO (transparente sobre el juego). */}
      <div className="absolute inset-0 overflow-hidden" style={{ pointerEvents: "none" }}>
        {/* Glows AMARILLOS radiales centrados en TU auto, cortados en seco al medio
            (semicírculo hacia adelante / atrás). Fijos: SOLO la opacidad varía
            según la cercanía del auto más próximo de ese lado. */}
        {(() => {
          let ahead = null, behind = null;
          for (const d of longCars) {
            if (d.relMeters >= 0) { if (!ahead || d.relMeters < ahead.relMeters) ahead = d; }
            else if (!behind || Math.abs(d.relMeters) < Math.abs(behind.relMeters)) behind = d;
          }
          return (
            <>
              <div style={{
                position: "absolute", left: 0, right: 0, top: 0, height: "50%",
                background: "radial-gradient(circle at 50% 100%, rgba(250,204,21,1) 0%, rgba(250,204,21,0) 45%)",
                opacity: ahead ? proxOp(ahead.relMeters, 0.6) : 0, transition: "opacity 220ms ease", pointerEvents: "none",
              }} />
              <div style={{
                position: "absolute", left: 0, right: 0, bottom: 0, height: "50%",
                background: "radial-gradient(circle at 50% 0%, rgba(250,204,21,1) 0%, rgba(250,204,21,0) 45%)",
                opacity: behind ? proxOp(behind.relMeters, 0.6) : 0, transition: "opacity 220ms ease", pointerEvents: "none",
              }} />
            </>
          );
        })()}

        {/* Degradados ROJOS laterales (auto al lado), a su altura real. */}
        {redBand("left", hasLeft)}
        {redBand("right", hasRight)}

        {/* Grilla: 1 línea vertical + 3 horizontales, con forma de huso (gruesas al
            medio, afinándose y desvaneciéndose hacia las puntas). Cortas. */}
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 w-full h-full" style={{ pointerEvents: "none" }}>
          <defs>
            <linearGradient id="gLineV" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="white" stopOpacity="0" />
              <stop offset="0.5" stopColor="white" stopOpacity="0.55" />
              <stop offset="1" stopColor="white" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="gLineH" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="white" stopOpacity="0" />
              <stop offset="0.5" stopColor="white" stopOpacity="0.45" />
              <stop offset="1" stopColor="white" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={vLens(50, 50, 24, 0.55)} fill="url(#gLineV)" />
          {/* Horizontales: superior e inferior EXACTAS en la trompa/cola de tu
              auto (50 ∓ carH/2); la del medio en el centro. */}
          {[50 - carH / 2, 50, 50 + carH / 2].map((y, i) => (
            <path key={i} d={hLens(50, y, 20, 0.45)} fill="url(#gLineH)" />
          ))}
        </svg>

        {/* Tu auto: rectángulo blanco con forma de auto (más largo que ancho),
            bordes redondeados, al centro y a escala real. */}
        <div style={{
          position: "absolute", left: "50%", top: "50%", height: `${carH}%`, aspectRatio: "0.42",
          transform: "translate(-50%,-50%)", background: "white", borderRadius: "16%",
          boxShadow: "0 0 5px rgba(0,0,0,0.55)", pointerEvents: "none",
        }} />


        {/* Sin datos aún */}
        {!rel && (
          <div className="absolute inset-0 flex items-center justify-center text-center px-2" style={{ color: "rgba(255,255,255,0.45)", fontSize: `${cfg.fontSize - 1}px`, textShadow: "0 1px 2px rgba(0,0,0,0.8)" }}>
            {telemetry.connected ? "Esperando autos…" : "Sin conexión con iRacing"}
          </div>
        )}
      </div>
    </div>
  );
}
