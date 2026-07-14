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
    range: 60,               // alcance adelante/atrás en metros
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

  // ── Geometría del radar (viewBox 120×160, player al centro) ──
  const W = 120, H = 160, CX = 60, CY = 80, PAD = 12;
  const yFor = (m) => Math.max(PAD, Math.min(H - PAD, CY - (m / range) * (H / 2 - PAD)));

  const nearest = useMemo(() => {
    let best = null;
    for (const d of nearby) if (best == null || Math.abs(d.relMeters) < Math.abs(best.relMeters)) best = d;
    return best;
  }, [nearby]);

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

      <div className="absolute inset-0 flex flex-col p-1">
        <div
          className="flex-1 relative overflow-hidden"
          style={{
            borderRadius: 10,
            background: "rgba(14,16,22,0.86)",
            border: "1px solid rgba(255,255,255,0.06)",
            boxShadow: "0 8px 28px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.04)",
            backdropFilter: "blur(10px)",
          }}
        >
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="w-full h-full block">
            {/* Zonas de aviso lateral (spotter). Se encienden con CarLeftRight. */}
            <rect x="0" y="0" width="14" height={H} fill={hasLeft ? (twoLeft ? "rgba(239,68,68,0.30)" : "rgba(249,115,22,0.26)") : "rgba(255,255,255,0.02)"} />
            <rect x={W - 14} y="0" width="14" height={H} fill={hasRight ? (twoRight ? "rgba(239,68,68,0.30)" : "rgba(249,115,22,0.26)") : "rgba(255,255,255,0.02)"} />

            {/* Ejes/guías */}
            <line x1={CX} y1={PAD} x2={CX} y2={H - PAD} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
            <line x1="16" y1={CY} x2={W - 16} y2={CY} stroke="rgba(255,255,255,0.06)" strokeWidth="1" strokeDasharray="3 3" />

            {/* Autos cercanos (columna central, por distancia longitudinal real) */}
            {nearby.map((d) => {
              const y = yFor(d.relMeters);
              const col = cfg.showClassColors && multiClass ? (classColorCss(d.carClassColor) || proxColor(d.relMeters)) : proxColor(d.relMeters);
              return (
                <g key={d.carIdx}>
                  <rect x={CX - 8} y={y - 6} width="16" height="12" rx="3"
                    fill={col} stroke="rgba(0,0,0,0.5)" strokeWidth="1" />
                  {d.carNumber ? (
                    <text x={CX} y={y + 3.2} textAnchor="middle" fontSize="8" fontWeight="bold"
                      fill="rgba(0,0,0,0.85)" style={{ userSelect: "none" }}>{d.carNumber}</text>
                  ) : null}
                </g>
              );
            })}

            {/* Marcadores de auto AL LADO (del spotter del juego) */}
            {hasLeft && (
              <>
                <rect x="20" y={CY - 7} width="16" height="14" rx="3" fill={twoLeft ? "rgb(239,68,68)" : "rgb(249,115,22)"} stroke="rgba(0,0,0,0.5)" strokeWidth="1" />
                {twoLeft && <rect x="20" y={CY - 24} width="16" height="14" rx="3" fill="rgb(239,68,68)" stroke="rgba(0,0,0,0.5)" strokeWidth="1" />}
              </>
            )}
            {hasRight && (
              <>
                <rect x={W - 36} y={CY - 7} width="16" height="14" rx="3" fill={twoRight ? "rgb(239,68,68)" : "rgb(249,115,22)"} stroke="rgba(0,0,0,0.5)" strokeWidth="1" />
                {twoRight && <rect x={W - 36} y={CY - 24} width="16" height="14" rx="3" fill="rgb(239,68,68)" stroke="rgba(0,0,0,0.5)" strokeWidth="1" />}
              </>
            )}

            {/* Auto del player (al centro, apuntando hacia arriba) */}
            <g>
              <polygon points={`${CX},${CY - 11} ${CX + 8},${CY + 8} ${CX - 8},${CY + 8}`} fill="rgb(234,179,8)" stroke="rgba(0,0,0,0.6)" strokeWidth="1" />
            </g>
          </svg>

          {/* Distancia del más cercano */}
          {cfg.showDistance && nearest && (
            <div className="absolute bottom-1 left-1/2 -translate-x-1/2 font-mono font-bold" style={{ fontSize: `${cfg.fontSize}px`, color: proxColor(nearest.relMeters) }}>
              {nearest.relMeters >= 0 ? "▲" : "▼"} {Math.abs(nearest.relMeters).toFixed(0)}m
            </div>
          )}
          {/* Sin datos aún */}
          {!rel && (
            <div className="absolute inset-0 flex items-center justify-center text-center px-2" style={{ color: "rgba(255,255,255,0.4)", fontSize: `${cfg.fontSize - 1}px` }}>
              {telemetry.connected ? "Esperando autos…" : "Sin conexión con iRacing"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
