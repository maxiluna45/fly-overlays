import React, { useEffect, useRef, useState } from "react";
import { EditCorners } from "./ui/edit-corners.jsx";

// Colores de licencia iRacing (hex aproximado por level 1-8)
// 1=Rookie, 2=D, 3=C, 4=B, 5=A, 6=P, 7=W, 8=NE
const LIC_COLORS = {
  1: "rgb(255, 255, 255)", // Rookie - blanco
  2: "rgb(255, 255, 0)",   // D - amarillo
  3: "rgb(255, 0, 0)",     // C - rojo
  4: "rgb(0, 0, 255)",     // B - azul
  5: "rgb(0, 255, 0)",     // A - verde
  6: "rgb(255, 0, 255)",   // P - magenta
  7: "rgb(255, 165, 0)",   // W - naranja
  8: "rgb(0, 255, 255)",   // NE - cyan
};

// Colores de clase iRacing (5 colores disponibles)
// Devuelve el color hex como string para usar inline
function carClassColorToCss(licColor) {
  // iRacing class colors: 0=?, 1, 2, 3, 4, 5
  // Aproximaciones
  const colors = {
    0: "rgb(60, 60, 60)",
    1: "rgb(34, 197, 94)",   // green
    2: "rgb(59, 130, 246)",  // blue
    3: "rgb(249, 115, 22)",  // orange
    4: "rgb(168, 85, 247)",  // purple
    5: "rgb(239, 68, 68)",   // red
  };
  return colors[licColor] || colors[1];
}

function licColorToCss(licColor) {
  return LIC_COLORS[licColor] || "rgb(120, 120, 120)";
}

function formatGap(seconds) {
  if (seconds == null || !isFinite(seconds)) return "—";
  if (seconds < -99) return "-99.0";
  if (seconds > 99) return "+99.0";
  const sign = seconds < 0 ? "-" : "+";
  const abs = Math.abs(seconds);
  if (abs < 60) return `${sign}${abs.toFixed(1)}`;
  // Si supera 60s, formato "1:23.4" pero iRacing lo muestra en formato "1k", "2k"
  // Para relative real iRacing usa "1L" (1 lap), pero vamos a usar "k" o segundos
  return `${sign}${abs.toFixed(1)}`;
}

function formatRaceTime(seconds) {
  if (seconds == null || !isFinite(seconds) || seconds < 0) return "00:00:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatTimeRemain(seconds) {
  if (seconds == null || !isFinite(seconds) || seconds <= 0) return "0m";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function classLicenseAbbrev(licString) {
  if (!licString) return "";
  return licString; // ej: "A 4.6"
}

export function Relative({ previewMode = false, injectedTelemetry = null, settings = {} }) {
  const cfg = useMemo(() => ({
    showIRating: true,
    showLicense: true,
    showLaps: true,
    showCarNumber: true,
    maxRows: 12,
    borderRadius: 8,
    rowHeight: 28,
    fontSize: 11,
    ...settings,
  }), [settings]);

  const [telemetry, setTelemetry] = useState({
    connected: false,
    onTrack: false,
    preview: false,
    relative: null,
  });

  const [unlocked, setUnlocked] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    if (injectedTelemetry) return;
    if (typeof window === "undefined" || !window.fly) return;
    if (typeof window.fly.onTelemetry !== "function") return;
    try {
      const unsub = window.fly.onTelemetry((data) => {
        setTelemetry((prev) => ({ ...prev, ...data }));
      });
      return unsub;
    } catch (_) {}
  }, [injectedTelemetry]);

  // Canal pesado: relative (~1 Hz). El resto (connected, onTrack, preview)
  // llega por el canal rápido en el effect de arriba.
  useEffect(() => {
    if (injectedTelemetry) return;
    if (typeof window === "undefined" || !window.fly) return;
    if (typeof window.fly.onTelemetryHeavy !== "function") return;
    try {
      const unsub = window.fly.onTelemetryHeavy((data) => {
        if (data.relative) {
          setTelemetry((prev) => ({ ...prev, relative: data.relative }));
        }
      });
      return unsub;
    } catch (_) {}
  }, [injectedTelemetry]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.fly) return;
    if (typeof window.fly.onLockState !== "function") return;
    try {
      const unsub = window.fly.onLockState((s) => setUnlocked(!!s.unlocked));
      if (typeof window.fly.getLockState === "function") {
        window.fly.getLockState().then((s) => setUnlocked(!!s.unlocked));
      }
      return unsub;
    } catch (_) {}
  }, []);

  const shouldShow = unlocked || previewMode || telemetry.preview || (telemetry.onTrack && telemetry.connected);
  const relative = telemetry.relative;
  const drivers = relative?.drivers || [];
  const session = relative?.session || { type: "Practice", time: 0, timeRemain: 0, lapCurrent: 0, lapsTotal: 0 };

  const playerIdx = relative?.playerIdx ?? -1;

  // Ordenar por posición de clase. Memoizado: sólo se reordena si cambia
  // el array de drivers (≈ 1 Hz) o el playerIdx.
  const sorted = useMemo(() => {
    return [...drivers].sort((a, b) => a.classPosition - b.classPosition);
  }, [drivers]);

  // Encontrar al player en la lista ordenada
  const playerRowIdx = sorted.findIndex((d) => d.carIdx === playerIdx);

  // Si hay player, mostrar N arriba + N abajo (centrado en player)
  const visibleDrivers = useMemo(() => {
    if (playerRowIdx >= 0 && cfg.maxRows > 0) {
      const before = Math.floor(cfg.maxRows / 2);
      const after = cfg.maxRows - before - 1;
      const start = Math.max(0, playerRowIdx - before);
      const end = Math.min(sorted.length, start + cfg.maxRows);
      const adjustedStart = Math.max(0, end - cfg.maxRows);
      return sorted.slice(adjustedStart, end);
    }
    if (cfg.maxRows > 0) return sorted.slice(0, cfg.maxRows);
    return sorted;
  }, [sorted, playerRowIdx, cfg.maxRows]);

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full select-none transition-opacity duration-300 ${
        shouldShow ? "opacity-100" : "opacity-0"
      } ${unlocked ? "cursor-grab" : ""}`}
      style={unlocked ? { WebkitAppRegion: "drag" } : undefined}
    >
      {unlocked && <EditCorners />}

      {telemetry.preview && (
        <div
          className="absolute top-1 right-1 px-1.5 py-0.5 rounded bg-yellow-500/20 border border-yellow-500/40 text-[8px] font-bold tracking-widest text-yellow-400 z-50"
          style={{ pointerEvents: "none" }}
        >
          PREVIEW
        </div>
      )}

      {unlocked && (
        <div
          className="absolute top-1 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded text-[9px] font-bold tracking-widest z-50 shadow"
          style={{ pointerEvents: "none", background: "rgb(59, 130, 246)", color: "white" }}
        >
          EDIT MODE · F7 TO LOCK
        </div>
      )}

      <div className="absolute inset-0 flex flex-col p-2">
        <div
          className="flex flex-col overflow-hidden"
          style={{
            borderRadius: `${cfg.borderRadius}px`,
            background: "linear-gradient(180deg, rgba(20,24,32,0.92) 0%, rgba(8,11,16,0.96) 100%)",
            border: "1px solid rgba(255,255,255,0.08)",
            boxShadow: "0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,0,0,0.4) inset",
            backdropFilter: "blur(16px)",
            fontSize: `${cfg.fontSize}px`,
          }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between px-2 py-1.5 text-[9px] font-bold tracking-widest border-b border-white/5"
            style={{ color: "rgba(255,255,255,0.6)" }}
          >
            <div className="flex items-center gap-2">
              <span>RELATIVE</span>
              {relative && relative.totalInClass > 0 && (
                <span style={{ color: "rgba(255,255,255,0.4)" }}>
                  × {relative.totalInClass}/{relative.totalOverall}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 text-[9px] font-mono" style={{ color: "rgba(255,255,255,0.5)" }}>
              {session.type === "Race" ? (
                <>
                  <span>RACE</span>
                  <span>{formatRaceTime(session.time)}</span>
                  <span style={{ color: "rgba(255,255,255,0.3)" }}>/</span>
                  <span>{formatTimeRemain(session.timeRemain)}</span>
                </>
              ) : (
                <>
                  <span>{session.type.toUpperCase()}</span>
                  <span style={{ color: "rgba(255,255,255,0.3)" }}>·</span>
                  <span>L{session.lapCurrent}</span>
                </>
              )}
            </div>
          </div>

          {/* Lista de pilotos */}
          <div className="flex-1 overflow-hidden flex flex-col">
            {visibleDrivers.map((d, i) => (
              <DriverRow
                key={d.carIdx}
                driver={d}
                index={i}
                isPlayer={d.carIdx === playerIdx}
                cfg={cfg}
              />
            ))}
            {visibleDrivers.length === 0 && (
              <div
                className="flex-1 flex items-center justify-center text-[10px]"
                style={{ color: "rgba(255,255,255,0.4)" }}
              >
                {telemetry.connected ? "Esperando datos..." : "Sin conexión con iRacing"}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Fila memoizada: sólo se re-renderiza si cambian los campos que afectan lo
// que se ve (posición, gap, status, isPlayer). La cfg ya viene memoizada
// desde el padre. Sin esta memo, en un re-render del padre a 60 Hz el JSX
// de 12+ filas se reconstruye aunque ningún piloto haya cambiado.
const DriverRow = React.memo(function DriverRow({ driver, index, isPlayer, cfg }) {
  const d = driver;
  const isLeader = d.classPosition === 1;
  const rowBg = isPlayer
    ? "rgba(255,255,255,0.18)"
    : isLeader
    ? "rgba(125, 211, 252, 0.12)"
    : index % 2 === 0
    ? "rgba(255,255,255,0.02)"
    : "rgba(255,255,255,0.05)";
  const posColor = isLeader
    ? "rgb(125, 211, 252)"
    : "rgba(255,255,255,0.6)";

  return (
    <div
      className="flex items-center px-2 gap-2"
      style={{
        background: rowBg,
        height: `${cfg.rowHeight}px`,
        borderLeft: `3px solid ${isPlayer ? "rgb(255,255,255)" : isLeader ? "rgb(125, 211, 252)" : "transparent"}`,
        fontSize: `${cfg.fontSize}px`,
        color: "white",
      }}
    >
      {/* Posición de clase */}
      <span
        className="font-mono font-bold w-4 text-right"
        style={{ color: posColor }}
      >
        {d.classPosition}
      </span>

      {/* Tag de licencia con iR */}
      {cfg.showLicense && (
        <div
          className="flex items-center justify-center rounded-sm font-mono font-bold text-[9px] flex-shrink-0"
          style={{
            background: licColorToCss(d.licColor),
            color: d.licColor >= 4 ? "white" : "black",
            width: cfg.showIRating ? 38 : 18,
            height: "16px",
            gap: "2px",
          }}
        >
          {cfg.showIRating ? (
            <>
              <span>{d.licLevel}</span>
              <span style={{ opacity: 0.6 }}>·</span>
              <span>{Math.round((d.irating || 0) / 1000)}k</span>
            </>
          ) : (
            <span>{d.licLevel}</span>
          )}
        </div>
      )}

      {/* Car number */}
      {cfg.showCarNumber && d.carNumber && (
        <span
          className="font-mono font-bold text-[10px] flex-shrink-0"
          style={{ color: "rgba(255,255,255,0.7)" }}
        >
          {d.carNumber}
        </span>
      )}

      {/* Nombre */}
      <span
        className="flex-1 truncate font-medium"
        style={{
          color: isPlayer ? "white" : d.out ? "rgba(255,255,68,0.5)" : "white",
        }}
      >
        {d.name}
      </span>

      {/* Status indicator */}
      {d.out && (
        <span
          className="text-[8px] font-bold tracking-widest px-1.5 py-0.5 rounded"
          style={{ background: "rgba(255, 200, 0, 0.2)", color: "rgb(255, 200, 0)" }}
        >
          OUT
        </span>
      )}
      {d.onPit && !d.out && !d.offTrack && (
        <span
          className="text-[8px] font-bold tracking-widest px-1.5 py-0.5 rounded"
          style={{ background: "rgba(255, 165, 0, 0.2)", color: "rgb(255, 165, 0)" }}
        >
          PIT
        </span>
      )}
      {d.offTrack && (
        <span
          className="text-[8px] font-bold tracking-widest px-1.5 py-0.5 rounded"
          style={{ background: "rgba(239, 68, 68, 0.2)", color: "rgb(239, 68, 68)" }}
          title="Fuera de pista"
        >
          OFF
        </span>
      )}

      {/* Gap al player */}
      <span
        className="font-mono font-bold text-[11px] flex-shrink-0 min-w-[50px] text-right"
        style={{
          color: isPlayer
            ? "rgba(255,255,255,0.5)"
            : (d.gapToPlayer ?? 0) < 0
            ? "rgb(34, 197, 94)"
            : (d.gapToPlayer ?? 0) > 0
            ? "rgb(239, 68, 68)"
            : "rgba(255,255,255,0.5)",
        }}
      >
        {isPlayer ? "—" : formatGap(d.gapToPlayer)}
      </span>
    </div>
  );
}, (prev, next) => {
  // Custom comparator: sólo re-render si cambió algo visible.
  return (
    prev.driver.classPosition === next.driver.classPosition &&
    prev.driver.gapToPlayer === next.driver.gapToPlayer &&
    prev.driver.onPit === next.driver.onPit &&
    prev.driver.offTrack === next.driver.offTrack &&
    prev.driver.out === next.driver.out &&
    prev.driver.licLevel === next.driver.licLevel &&
    prev.driver.irating === next.driver.irating &&
    prev.driver.carNumber === next.driver.carNumber &&
    prev.driver.name === next.driver.name &&
    prev.driver.licColor === next.driver.licColor &&
    prev.isPlayer === next.isPlayer &&
    prev.index === next.index &&
    prev.cfg === next.cfg
  );
});
