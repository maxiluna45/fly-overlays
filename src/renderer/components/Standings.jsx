import React, { useEffect, useMemo, useRef, useState } from "react";
import { EditCorners } from "./ui/edit-corners.jsx";
import { Flag } from "./ui/flag.jsx";

// Colores de licencia iRacing (1-7). Mismo criterio que Relative.
const LIC_COLORS = {
  1: { bg: "rgb(255,255,255)", fg: "rgb(20,20,28)" },
  2: { bg: "rgb(255,215,0)", fg: "rgb(20,20,28)" },
  3: { bg: "rgb(239,68,68)", fg: "rgb(255,255,255)" },
  4: { bg: "rgb(59,130,246)", fg: "rgb(255,255,255)" },
  5: { bg: "rgb(34,197,94)", fg: "rgb(255,255,255)" },
  6: { bg: "rgb(168,85,247)", fg: "rgb(255,255,255)" },
  7: { bg: "rgb(249,115,22)", fg: "rgb(255,255,255)" },
};
const LIC_LETTER = { 1: "R", 2: "D", 3: "C", 4: "B", 5: "A", 6: "P", 7: "W" };

function resolveLicLevel(d) {
  if (d?.licString && typeof d.licString === "string") {
    const letter = d.licString.charAt(0).toUpperCase();
    const map = { R: 1, D: 2, C: 3, B: 4, A: 5, P: 6, W: 7 };
    if (map[letter]) return map[letter];
  }
  const lvl = d?.licLevel;
  if (lvl && lvl >= 1 && lvl <= 7) return lvl;
  return 2;
}

// Color de clase (índice de paleta o entero RGB de 24 bits).
const CLASS_PALETTE = { 1: "#f6c915", 2: "#3b82f6", 3: "#ef4444", 4: "#22c55e", 5: "#a855f7", 6: "#f97316", 7: "#06b6d4" };
function classColorCss(c) {
  if (c == null || c === 0) return null;
  if (c > 0 && c <= 16) return CLASS_PALETTE[c] || "rgb(160,160,170)";
  const hex = (c & 0xffffff).toString(16).padStart(6, "0");
  return `#${hex}`;
}

function formatIrating(ir) {
  if (!ir || ir <= 0) return "—";
  return `${(ir / 1000).toFixed(1)}k`;
}

// Nombre según formato configurado: full | short (apellido, inicial) | initials.
function fmtName(d, format) {
  if (format === "initials" && d.initials) return d.initials;
  if (format === "short" && d.abbrev) return d.abbrev;
  return d.name;
}

// Cambio proyectado de iRating (solo carrera oficial).
function RatingChange({ value, fontSize }) {
  if (value == null || !isFinite(value)) return null;
  const zero = value === 0;
  const color = zero ? "rgba(255,255,255,0.4)" : value > 0 ? "rgb(74,222,128)" : "rgb(248,113,113)";
  const arrow = zero ? "–" : value > 0 ? "▲" : "▼";
  return (
    <span className="font-mono font-bold text-right flex-shrink-0" style={{ color, width: "32px", fontSize: `${fontSize - 2}px` }} title="Cambio proyectado de iRating">
      {zero ? "–" : `${arrow}${Math.abs(value)}`}
    </span>
  );
}

function formatLap(seconds) {
  if (seconds == null || !isFinite(seconds) || seconds <= 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, "0")}`;
}

// Gap para mostrar. Puede ser tiempo (segundos) o vueltas ("+1L").
function formatGap(seconds) {
  if (seconds == null || !isFinite(seconds)) return "";
  if (Math.abs(seconds) < 0.001) return "—";
  const abs = Math.abs(seconds);
  if (abs < 60) return `${seconds < 0 ? "−" : "+"}${abs.toFixed(1)}`;
  const m = Math.floor(abs / 60);
  const s = abs - m * 60;
  return `${seconds < 0 ? "−" : "+"}${m}:${s.toFixed(1).padStart(4, "0")}`;
}

export function Standings({ previewMode = false, injectedTelemetry = null, settings = {} }) {
  const cfg = useMemo(() => ({
    showLicense: true,
    showIRating: true,
    showCarNumber: true,
    showFlag: true,
    showBestLap: true,
    // 'leader' = gap al líder de clase · 'interval' = intervalo al de adelante
    gapMode: "leader",
    maxRows: 24,
    rowHeight: 24,
    fontSize: 11,
    borderRadius: 8,
    ...settings,
  }), [settings]);

  const [telemetry, setTelemetry] = useState({ connected: false, onTrack: false, preview: false, relative: null });
  const [unlocked, setUnlocked] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    if (injectedTelemetry) return;
    if (typeof window === "undefined" || !window.fly) return;
    if (typeof window.fly.onTelemetry !== "function") return;
    try {
      // Del canal rápido (60 Hz) solo usamos 3 flags; el contenido real llega
      // por el canal heavy. Sin cambios → prev → sin re-render.
      const unsub = window.fly.onTelemetry((data) => {
        setTelemetry((p) => {
          const connected = !!data.connected;
          const onTrack = !!data.onTrack;
          const preview = !!data.preview;
          if (p.connected === connected && p.onTrack === onTrack && p.preview === preview) return p;
          return { ...p, connected, onTrack, preview };
        });
      });
      return unsub;
    } catch (_) {}
  }, [injectedTelemetry]);

  useEffect(() => {
    if (injectedTelemetry) setTelemetry((p) => ({ ...p, ...injectedTelemetry }));
  }, [injectedTelemetry]);

  useEffect(() => {
    if (injectedTelemetry) return;
    if (typeof window === "undefined" || !window.fly) return;
    if (typeof window.fly.onTelemetryHeavy !== "function") return;
    try {
      const unsub = window.fly.onTelemetryHeavy((data) => {
        if (data.relative) setTelemetry((p) => ({ ...p, relative: data.relative }));
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
  const session = relative?.session || { type: "Practice", incidents: 0, maxIncidents: 0 };
  const playerIdx = relative?.playerIdx ?? -1;
  const isRace = /race/i.test(session.type || "");

  const multiClass = useMemo(
    () => new Set(drivers.map((d) => d.carClassId)).size > 1,
    [drivers]
  );

  // Filas ordenadas por posición de clase, con gap calculado.
  const rows = useMemo(() => {
    if (drivers.length === 0) return [];

    // Agrupar por clase y ordenar cada grupo por classPosition (fallback pos/best).
    const byClass = {};
    for (const d of drivers) (byClass[d.carClassId] ??= []).push(d);

    const out = [];
    // Clase del player primero, luego el resto.
    const classIds = Object.keys(byClass).sort((a, b) => {
      const pa = byClass[a].some((d) => d.carIdx === playerIdx) ? -1 : 0;
      const pb = byClass[b].some((d) => d.carIdx === playerIdx) ? -1 : 0;
      return pa - pb;
    });

    for (const cid of classIds) {
      const list = byClass[cid].slice().sort((a, b) => {
        const ca = a.classPosition || 999;
        const cb = b.classPosition || 999;
        if (ca !== cb) return ca - cb;
        return (a.bestLapTime || 1e9) - (b.bestLapTime || 1e9);
      });

      // Referencias para el gap.
      const leader = list[0];
      const classFastestBest = Math.min(...list.map((d) => (d.bestLapTime > 0 ? d.bestLapTime : Infinity)));

      list.forEach((d, idx) => {
        let gap = null;
        let lapsDown = 0;
        if (isRace) {
          // Gap por F2Time (tiempo detrás del líder). Interval = respecto al de adelante.
          const base = cfg.gapMode === "interval" && idx > 0 ? list[idx - 1] : leader;
          if (d.f2Time > 0 || base.f2Time > 0) {
            gap = (d.f2Time || 0) - (base.f2Time || 0);
          }
          // Vueltas abajo respecto al líder (si el payload trae lapDelta útil no lo usamos acá;
          // derivamos de posiciones/tiempos grandes)
          if (gap != null && gap >= (classFastestBest > 0 ? classFastestBest : 60)) {
            lapsDown = Math.floor(gap / (classFastestBest > 0 ? classFastestBest : 60));
          }
        } else {
          // Práctica/Qualy: gap por best lap vs el más rápido de la clase.
          if (d.bestLapTime > 0 && isFinite(classFastestBest)) {
            gap = d.bestLapTime - classFastestBest;
          }
        }
        const posChange = isRace && d.qualClassPos > 0 && d.classPosition > 0 ? d.qualClassPos - d.classPosition : null;
        out.push({ ...d, _gap: gap, _lapsDown: lapsDown, _classId: cid, _isClassLeader: idx === 0, _posChange: posChange });
      });
    }

    // Limitar filas: prioriza la clase del player, pero garantiza que el player esté.
    const capped = out.slice(0, cfg.maxRows);
    if (playerIdx >= 0 && !capped.some((d) => d.carIdx === playerIdx)) {
      const self = out.find((d) => d.carIdx === playerIdx);
      if (self) { capped[capped.length - 1] = self; }
    }
    return capped;
  }, [drivers, playerIdx, isRace, cfg.gapMode, cfg.maxRows]);

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
        <div className="absolute top-1 right-1 px-1.5 py-0.5 rounded bg-yellow-500/20 border border-yellow-500/40 text-[8px] font-bold tracking-widest text-yellow-400 z-50" style={{ pointerEvents: "none" }}>
          PREVIEW
        </div>
      )}
      {unlocked && (
        <div className="absolute top-1 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded text-[9px] font-bold tracking-widest z-50 shadow" style={{ pointerEvents: "none", background: "rgb(59,130,246)", color: "white" }}>
          EDIT MODE · F7 TO LOCK
        </div>
      )}

      <div className="absolute inset-0 flex flex-col p-2">
        <div
          className="flex flex-col overflow-hidden flex-1"
          style={{
            borderRadius: `${cfg.borderRadius ?? 8}px`,
            background: "rgba(14,16,22,0.92)",
            border: "1px solid rgba(255,255,255,0.06)",
            boxShadow: "0 8px 28px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.04)",
            backdropFilter: "blur(12px)",
            fontSize: `${cfg.fontSize}px`,
          }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between px-2.5 py-1.5 border-b font-mono"
            style={{ borderColor: "rgba(255,255,255,0.06)", fontSize: `${cfg.fontSize}px` }}
          >
            <span className="font-bold tracking-widest" style={{ color: "rgba(255,255,255,0.75)" }}>
              {(session.type || "PRACTICE").toUpperCase()}
            </span>
            <span style={{ color: "rgba(255,255,255,0.45)" }}>
              {isRace ? (cfg.gapMode === "interval" ? "INTERVAL" : "GAP LÍDER") : "GAP BEST"}
            </span>
          </div>

          {/* Filas */}
          <div className="flex-1 overflow-hidden flex flex-col">
            {rows.length === 0 ? (
              <div className="flex-1 flex items-center justify-center" style={{ color: "rgba(255,255,255,0.4)", fontSize: `${cfg.fontSize}px` }}>
                {telemetry.connected ? "Esperando datos..." : "Sin conexión con iRacing"}
              </div>
            ) : (
              rows.map((d, i) => (
                <StandingsRow
                  key={`s-${d.carIdx}-${i}`}
                  driver={d}
                  isPlayer={d.carIdx === playerIdx}
                  cfg={cfg}
                  multiClass={multiClass}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const StandingsRow = React.memo(function StandingsRow({ driver: d, isPlayer, cfg, multiClass }) {
  const licLevel = resolveLicLevel(d);
  const lic = LIC_COLORS[licLevel] || { bg: "rgb(120,120,120)", fg: "white" };
  const classColor = multiClass ? classColorCss(d.carClassColor) : null;

  const rowBg = isPlayer
    ? "linear-gradient(90deg, rgba(234,179,8,0.28) 0%, rgba(234,179,8,0.10) 70%, rgba(234,179,8,0.03) 100%)"
    : d._isClassLeader
    ? "rgba(125,211,252,0.06)"
    : (d.classPosition % 2 === 0 ? "rgba(255,255,255,0.015)" : "rgba(255,255,255,0.04)");

  const stripe = isPlayer ? "rgb(234,179,8)" : classColor || "transparent";

  const gapText = d._lapsDown > 0 ? `+${d._lapsDown}L` : formatGap(d._gap);

  return (
    <div
      className="relative flex items-center px-2 gap-1.5"
      style={{
        background: rowBg,
        height: `${cfg.rowHeight}px`,
        borderLeft: `3px solid ${stripe}`,
        fontSize: `${cfg.fontSize}px`,
        color: "white",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {/* Posición de clase */}
      <span
        className="font-mono font-bold text-right flex-shrink-0"
        style={{ width: "20px", color: d._isClassLeader ? "rgb(125,211,252)" : isPlayer ? "white" : "rgba(255,255,255,0.6)" }}
      >
        {d.classPosition || "—"}
      </span>

      {/* Cambio de posición vs qualy (solo carrera) */}
      {cfg.showPositionChange && d._posChange != null && (
        <span
          className="font-mono font-bold text-center flex-shrink-0"
          style={{ width: "22px", fontSize: `${cfg.fontSize - 2}px`, color: d._posChange > 0 ? "rgb(74,222,128)" : d._posChange < 0 ? "rgb(248,113,113)" : "rgba(255,255,255,0.4)" }}
          title="Posiciones ganadas/perdidas vs clasificación"
        >
          {d._posChange === 0 ? "–" : `${d._posChange > 0 ? "▲" : "▼"}${Math.abs(d._posChange)}`}
        </span>
      )}

      {/* Número de auto */}
      {cfg.showCarNumber && (
        <span className="font-mono flex-shrink-0" style={{ color: "rgba(255,255,255,0.5)", minWidth: "22px", fontSize: `${cfg.fontSize - 1}px` }}>
          #{d.carNumber}
        </span>
      )}

      {/* Bandera del país del club (antes del nombre) */}
      {cfg.showFlag && <Flag club={d.club} size={cfg.fontSize + 1} />}

      {/* Nombre + tags */}
      <div className="flex-1 flex items-center min-w-0 gap-1">
        <span
          className="truncate font-semibold"
          style={{ color: isPlayer ? "white" : d.out ? "rgba(255,200,80,0.55)" : "rgba(255,255,255,0.92)" }}
          title={d.name}
        >
          {fmtName(d, cfg.nameFormat)}
        </span>
        {d.tag && d.tag.label && (
          <span
            className="font-bold tracking-wide px-1 rounded-sm flex-shrink-0 uppercase"
            style={{ fontSize: "8px", background: `${d.tag.color}33`, color: d.tag.color, border: `1px solid ${d.tag.color}66` }}
            title={`Etiqueta: ${d.tag.label}`}
          >
            {d.tag.label}
          </span>
        )}
        {d.onPit && (
          <span className="font-bold tracking-widest px-1 rounded-sm flex-shrink-0" style={{ fontSize: "8px", background: "rgba(249,115,22,0.18)", color: "rgb(249,115,22)" }}>
            PIT
          </span>
        )}
      </div>

      {/* Licencia */}
      {cfg.showLicense && (
        <div
          className="font-mono font-bold text-center flex-shrink-0"
          style={{ background: lic.bg, color: lic.fg, width: "16px", height: "16px", fontSize: `${cfg.fontSize - 1}px`, borderRadius: "3px", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
          title={d.licString}
        >
          {LIC_LETTER[licLevel] || "?"}
        </div>
      )}

      {/* iRating */}
      {cfg.showIRating && (
        <span className="font-mono flex-shrink-0 text-right" style={{ width: "34px", color: "rgba(255,255,255,0.75)", fontSize: `${cfg.fontSize - 1}px` }}>
          {formatIrating(d.irating)}
        </span>
      )}

      {/* iRating proyectado (carrera oficial) */}
      {cfg.showIRating && d.iratingChange != null && (
        <RatingChange value={d.iratingChange} fontSize={cfg.fontSize} />
      )}

      {/* Best lap */}
      {cfg.showBestLap && (
        <span className="font-mono flex-shrink-0 text-right" style={{ width: "58px", color: "rgba(255,255,255,0.85)", fontSize: `${cfg.fontSize - 1}px` }}>
          {formatLap(d.bestLapTime)}
        </span>
      )}

      {/* Last lap */}
      {cfg.showLastLap && (
        <span className="font-mono flex-shrink-0 text-right" style={{ width: "58px", color: "rgba(255,255,255,0.6)", fontSize: `${cfg.fontSize - 1}px` }}>
          {formatLap(d.lastLapTime)}
        </span>
      )}

      {/* Gap */}
      <span
        className="font-mono font-bold flex-shrink-0 text-right"
        style={{ width: "52px", color: isPlayer ? "rgba(255,255,255,0.9)" : d._lapsDown > 0 ? "rgb(248,113,113)" : "rgba(255,255,255,0.8)" }}
      >
        {isPlayer && (d._gap == null || Math.abs(d._gap) < 0.001) ? "—" : gapText}
      </span>
    </div>
  );
}, (prev, next) => {
  const a = prev.driver, b = next.driver;
  return (
    a.classPosition === b.classPosition &&
    a._gap === b._gap &&
    a._lapsDown === b._lapsDown &&
    a._posChange === b._posChange &&
    a.bestLapTime === b.bestLapTime &&
    a.lastLapTime === b.lastLapTime &&
    a.irating === b.irating &&
    a.iratingChange === b.iratingChange &&
    a.name === b.name &&
    a.club === b.club &&
    a.onPit === b.onPit &&
    a.out === b.out &&
    a.carClassColor === b.carClassColor &&
    (a.tag?.label || "") === (b.tag?.label || "") &&
    (a.tag?.color || "") === (b.tag?.color || "") &&
    prev.isPlayer === next.isPlayer &&
    prev.multiClass === next.multiClass &&
    prev.cfg === next.cfg
  );
});
