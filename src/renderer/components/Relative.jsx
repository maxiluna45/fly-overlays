import React, { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { EditCorners } from "./ui/edit-corners.jsx";

// Colores oficiales de licencia iRacing (1-8).
// 1=Rookie · 2=D · 3=C · 4=B · 5=A · 6=P · 7=W · 8=NE
const LIC_COLORS = {
  1: { bg: "rgb(255, 255, 255)", fg: "rgb(20,20,28)" }, // Rookie - blanco
  2: { bg: "rgb(255, 215, 0)",   fg: "rgb(20,20,28)" }, // D - amarillo
  3: { bg: "rgb(239, 68, 68)",   fg: "rgb(255,255,255)" }, // C - rojo
  4: { bg: "rgb(59, 130, 246)",  fg: "rgb(255,255,255)" }, // B - azul
  5: { bg: "rgb(34, 197, 94)",   fg: "rgb(255,255,255)" }, // A - verde
  6: { bg: "rgb(168, 85, 247)",  fg: "rgb(255,255,255)" }, // P - púrpura
  7: { bg: "rgb(249, 115, 22)",  fg: "rgb(255,255,255)" }, // W - naranja
  8: { bg: "rgb(34, 211, 238)",  fg: "rgb(20,20,28)" }, // NE - cyan
};

const LIC_LETTER = { 1: "R", 2: "D", 3: "C", 4: "B", 5: "A", 6: "P", 7: "W", 8: "P" };

function licBg(level) {
  const c = LIC_COLORS[level];
  return c ? c.bg : "rgb(120,120,120)";
}
function licFg(level) {
  const c = LIC_COLORS[level];
  return c ? c.fg : "white";
}

// Resuelve el Safety Rating real. El SDK de iRacing a veces lo manda como
// entero sin decimal (238 = 2.38), otras veces como float (2.38). Además,
// si licSubLevel es 0 o inválido, lo parseamos de licString ("D 2.38").
function resolveSR(d) {
  let sr = d?.licSubLevel;
  if (!sr || sr <= 0 || !isFinite(sr)) {
    sr = parseFloat((d?.licString || "").split(" ")[1]) || 0;
  }
  // Si viene como entero grande (≥10), dividir por 100 (238 → 2.38).
  if (sr > 10) sr = sr / 100;
  return sr;
}

// Resuelve la clase de licencia priorizando la fuente más confiable.
//   1) d.licString (formateado, ej "D 2.3") — es lo que muestra la UI de
//      iRacing, así que es la fuente de verdad. Parseamos la primera letra.
//   2) d.licLevel (numérico 1-7) — el SDK a veces devuelve un valor
//      incorrecto (ej: D como 6/Pro), así que solo es fallback.
function resolveLicLevel(d) {
  if (d?.licString && typeof d.licString === "string") {
    const letter = d.licString.charAt(0).toUpperCase();
    const map = { R: 1, D: 2, C: 3, B: 4, A: 5, P: 6, W: 7 };
    if (map[letter]) return map[letter];
  }
  const lvl = d?.licLevel;
  if (lvl && lvl >= 1 && lvl <= 7) return lvl;
  return 2; // fallback razonable: D
}

// Colores de Safety Rating iRacing (rangos oficiales).
// SR < 3.00: rojo · 3.00-3.99: naranja · 4.00-4.99: azul · 5.00+: verde
function srColor(sr) {
  if (!sr || sr <= 0) return { bg: "rgb(80,80,90)", fg: "white" };
  if (sr < 3.0)  return { bg: "rgb(239, 68, 68)",  fg: "white" };
  if (sr < 4.0)  return { bg: "rgb(249, 115, 22)", fg: "white" };
  if (sr < 5.0)  return { bg: "rgb(59, 130, 246)", fg: "white" };
  return { bg: "rgb(34, 197, 94)", fg: "white" };
}

function formatIrating(ir) {
  if (!ir || ir <= 0) return "—";
  return `${(ir / 1000).toFixed(1)}k`;
}

function formatGap(seconds) {
  if (seconds == null || !isFinite(seconds)) return "—";
  // Sin signo: la posición de la fila (arriba/abajo) ya indica si va
  // adelante o atrás. Siempre blanco bold.
  const abs = Math.abs(seconds);
  if (abs < 60) return abs.toFixed(1);
  const m = Math.floor(abs / 60);
  const s = abs - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

function formatLap(seconds) {
  if (seconds == null || !isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60) return seconds.toFixed(1);
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

function formatClock(seconds) {
  if (seconds == null || !isFinite(seconds) || seconds < 0) return "00:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatTimeRemain(seconds) {
  if (seconds == null || !isFinite(seconds) || seconds <= 0) return "0m";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

// Color de incidents según qué tan cerca del límite está.
// Sin límite (max=0): blanco neutro. Cerca del límite: amarillo. En/pasado: rojo.
function incidentColor(current, max) {
  if (current == null || current <= 0) return "rgba(255,255,255,0.55)";
  if (max > 0) {
    if (current >= max) return "rgb(239, 68, 68)";
    if (current >= max * 0.8) return "rgb(249, 115, 22)";
    if (current >= max * 0.5) return "rgb(234, 179, 8)";
  }
  return "rgba(255,255,255,0.7)";
}

export function Relative({ previewMode = false, injectedTelemetry = null, settings = {} }) {
  const cfg = useMemo(() => ({
    // 3 competidores arriba + vos + 3 abajo = 7 filas total
    rowsAbove: 3,
    rowsBelow: 3,
    showIRating: true,
    showLicense: true,
    showCarNumber: true,
    fontSize: 11,
    rowHeight: 26,
    borderRadius: 8,
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

  // ⚠️ FIX: este useEffect faltaba — los otros componentes (DeltaBar, Sectors)
  // lo tienen. Sin él, cuando se le pasa `injectedTelemetry` desde el Dashboard
  // (vía RelativeLite), los dos useEffect anteriores hacen early-return
  // y nadie consume los datos → el componente se queda con relative=null.
  useEffect(() => {
    if (injectedTelemetry) {
      setTelemetry((prev) => ({ ...prev, ...injectedTelemetry }));
    }
  }, [injectedTelemetry]);

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

  // Ordenar por posición de clase (1 al frente, N al fondo).
  const sorted = useMemo(() => {
    return [...drivers].sort((a, b) => (a.classPosition || 99) - (b.classPosition || 99));
  }, [drivers]);

  const playerRowIdx = sorted.findIndex((d) => d.carIdx === playerIdx);

  // Centrar la vista en el player: N arriba + vos + M abajo. Si está cerca
  // de los extremos, se ajusta para no mostrar filas vacías arriba/abajo.
  // Si no hay drivers (sesión vacía / SDK sin data), fabricamos una fila "self"
  // mínima para que el overlay nunca quede visualmente muerto.
  const visibleDrivers = useMemo(() => {
    if (sorted.length === 0) {
      return [{
        carIdx: playerIdx >= 0 ? playerIdx : 0,
        classPosition: 1,
        name: previewMode ? "Maximiliano Luna2" : "—",
        carNumber: "—",
        irating: 0,
        licString: "",
        licLevel: 2,
        licSubLevel: 0,
        carClassColor: 1,
        gapToPlayer: 0,
        lastLapTime: 0,
        bestLapTime: 0,
        onTrack: true,
        onPit: false,
        offTrack: false,
        out: false,
        isPlayer: true,
      }];
    }
    if (playerRowIdx < 0) return sorted.slice(0, cfg.rowsAbove + 1 + cfg.rowsBelow);
    const total = cfg.rowsAbove + 1 + cfg.rowsBelow;
    let start = playerRowIdx - cfg.rowsAbove;
    let end = start + total;
    if (start < 0) {
      start = 0;
      end = Math.min(sorted.length, total);
    } else if (end > sorted.length) {
      end = sorted.length;
      start = Math.max(0, end - total);
    }
    return sorted.slice(start, end);
  }, [sorted, playerRowIdx, cfg.rowsAbove, cfg.rowsBelow, playerIdx, previewMode]);

  // Strength of Field = promedio de iRating de los pilotos en clase
  const sof = useMemo(() => {
    if (drivers.length === 0) return null;
    const sum = drivers.reduce((acc, d) => acc + (d.irating || 0), 0);
    return sum / drivers.length;
  }, [drivers]);

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
            borderRadius: `${cfg.borderRadius ?? 8}px`,
            background: "rgba(14,16,22,0.92)",
            border: "1px solid rgba(255,255,255,0.06)",
            boxShadow: "0 8px 28px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.04)",
            backdropFilter: "blur(12px)",
            fontSize: `${cfg.fontSize}px`,
          }}
        >
          {/* Header: SoF (izq) + Incidents (der) */}
          <div
            className="flex items-center justify-between px-2.5 py-1.5 border-b font-mono"
            style={{
              borderColor: "rgba(255,255,255,0.06)",
              fontSize: `${cfg.fontSize}px`,
            }}
          >
            {/* Top-left: SoF */}
            <div className="flex items-baseline gap-1.5" style={{ color: "rgba(255,255,255,0.7)" }}>
              <span
                className="font-bold tracking-widest"
                style={{ color: "rgba(255,255,255,0.45)", fontSize: `${cfg.fontSize - 1}px` }}
              >
                SoF
              </span>
              <span
                className="font-bold"
                style={{ color: "rgba(255,255,255,0.85)" }}
              >
                {sof != null ? formatIrating(sof) : "—"}
              </span>
            </div>

            {/* Top-right: Incidents con icono X */}
            <div
              className="flex items-center gap-1"
              title={`Incidentes: ${session.incidents || 0}${session.maxIncidents > 0 ? ` / máx ${session.maxIncidents}` : " (sin límite)"}`}
            >
              <X
                size={Math.max(10, cfg.fontSize)}
                strokeWidth={3}
                style={{ color: incidentColor(session.incidents, session.maxIncidents) }}
              />
              <span
                className="font-bold"
                style={{ color: incidentColor(session.incidents, session.maxIncidents) }}
              >
                {session.incidents || 0}
              </span>
              <span style={{ color: "rgba(255,255,255,0.35)" }}>
                {session.maxIncidents > 0 ? `/${session.maxIncidents}` : "/-"}
              </span>
            </div>
          </div>

          {/* Lista */}
          <div className="flex-1 overflow-hidden flex flex-col">
            {visibleDrivers.map((d) => (
              <DriverRow
                key={d.carIdx}
                driver={d}
                isPlayer={d.carIdx === playerIdx}
                cfg={cfg}
              />
            ))}
            {visibleDrivers.length === 0 && (
              <div
                className="flex-1 flex items-center justify-center"
                style={{ color: "rgba(255,255,255,0.4)", fontSize: `${cfg.fontSize}px` }}
              >
                {telemetry.connected ? "Esperando datos..." : "Sin conexión con iRacing"}
              </div>
            )}
            {/* Fila "self" mínima cuando no hay drivers — así el overlay
                nunca queda visualmente vacío, incluso si el SDK no está
                exponiendo CarIdx* todavía. */}
            {visibleDrivers.length > 0 && sorted.length === 0 && (
              <div
                className="flex items-center justify-center py-2 text-[10px] tracking-widest"
                style={{ color: "rgba(255,255,255,0.35)" }}
              >
                {telemetry.connected ? "SIN PILOTOS EN CLASE" : "iRACING NO CONECTADO"}
              </div>
            )}
          </div>

          {/* Footer: sesión+tiempo (izq) + lap (der) */}
          <div
            className="flex items-center justify-between px-2.5 py-1 border-t font-mono"
            style={{
              borderColor: "rgba(255,255,255,0.06)",
              color: "rgba(255,255,255,0.6)",
              fontSize: `${cfg.fontSize - 1}px`,
            }}
          >
            <div className="flex items-center gap-2">
              <span className="font-bold tracking-widest" style={{ color: "rgba(255,255,255,0.75)" }}>
                {session.type ? session.type.toUpperCase() : "PRACTICE"}
              </span>
              {session.time > 0 && (
                <>
                  <span style={{ color: "rgba(255,255,255,0.3)" }}>·</span>
                  <span>{formatClock(session.time)}</span>
                </>
              )}
              {session.timeTotal > 0 && (
                <>
                  <span style={{ color: "rgba(255,255,255,0.3)" }}>/</span>
                  <span style={{ color: "rgba(255,255,255,0.45)" }}>{formatTimeRemain(session.timeTotal)}</span>
                </>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <span style={{ color: "rgba(255,255,255,0.45)" }}>Lap</span>
              <span className="font-bold" style={{ color: "rgba(255,255,255,0.85)" }}>
                {session.lapCurrent || 0}
              </span>
              {session.lapsTotal > 0 && (
                <span style={{ color: "rgba(255,255,255,0.4)" }}>/{session.lapsTotal}</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// DriverRow
// ──────────────────────────────────────────────────────────────────────────

const DriverRow = React.memo(function DriverRow({ driver, isPlayer, cfg }) {
  const d = driver;
  const isLeader = d.classPosition === 1;
  // Resuelve la clase real del piloto (a veces LicLevel viene mal del SDK
  // pero LicString — el string que muestra iRacing — es la fuente confiable).
  const licLevel = resolveLicLevel(d);

  // Background: player con gradient ámbar (Racelabs), líder con tinte cian,
  // resto alterna muy sutil.
  const rowBg = isPlayer
    ? "linear-gradient(90deg, rgba(234,179,8,0.28) 0%, rgba(234,179,8,0.12) 70%, rgba(234,179,8,0.04) 100%)"
    : isLeader
    ? "linear-gradient(90deg, rgba(125,211,252,0.10) 0%, rgba(125,211,252,0.02) 100%)"
    : d.classPosition % 2 === 0
    ? "rgba(255,255,255,0.015)"
    : "rgba(255,255,255,0.04)";

  const stripe = isPlayer
    ? "rgb(234, 179, 8)"
    : isLeader
    ? "rgb(125, 211, 252)"
    : "transparent";

  // Gap: solo el valor absoluto en blanco bold. La fila ya está ordenada
  // por posición (arriba = adelante, abajo = atrás), no hacen falta
  // signos ni colores. El dash gris tenue marca tu propia fila.
  const gap = d.gapToPlayer;
  const gapColor = isPlayer
    ? "rgba(255,255,255,0.35)"
    : gap == null
    ? "rgba(255,255,255,0.35)"
    : "white";

  const nameColor = isPlayer
    ? "white"
    : d.out
    ? "rgba(255,200,80,0.55)"
    : "rgba(255,255,255,0.92)";

  // SR box: color según rango oficial de iRacing.
  // El SDK a veces manda el SR como entero (238 = 2.38), otras como float.
  // resolveSR normaliza ambos casos.
  const sr = resolveSR(d);
  const srC = srColor(sr);

  return (
    <div
      className="relative flex items-center px-2.5 gap-2"
      style={{
        background: rowBg,
        height: `${cfg.rowHeight}px`,
        borderLeft: `3px solid ${stripe}`,
        fontSize: `${cfg.fontSize}px`,
        color: "white",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {/* Posición */}
      <span
        className="font-mono font-bold text-right flex-shrink-0"
        style={{
          color: isLeader ? "rgb(125, 211, 252)" : isPlayer ? "white" : "rgba(255,255,255,0.6)",
          width: "20px",
          fontSize: `${cfg.fontSize + 1}px`,
        }}
      >
        {d.classPosition || "—"}
      </span>

      {/* Car number (estilo Racelabs) */}
      {cfg.showCarNumber && d.carNumber && (
        <span
          className="font-mono flex-shrink-0"
          style={{
            color: "rgba(255,255,255,0.55)",
            fontSize: `${cfg.fontSize - 1}px`,
            minWidth: "20px",
            textAlign: "left",
          }}
        >
          {d.carNumber}
        </span>
      )}

      {/* Separador + nombre */}
      <div className="flex-1 flex items-center min-w-0 gap-1.5">
        <span
          className="flex-shrink-0 font-mono"
          style={{ color: "rgba(255,255,255,0.3)" }}
        >
          /
        </span>
        <span
          className="truncate font-semibold"
          style={{ color: nameColor, fontSize: `${cfg.fontSize + 0.5}px` }}
          title={d.name}
        >
          {d.name}
        </span>
        {d.out && (
          <span
            className="font-bold tracking-widest px-1 rounded-sm flex-shrink-0"
            style={{
              fontSize: "8px",
              background: "rgba(234, 179, 8, 0.18)",
              color: "rgb(234, 179, 8)",
              height: "13px",
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            OUT
          </span>
        )}
        {!d.out && d.onPit && (
          <span
            className="font-bold tracking-widest px-1 rounded-sm flex-shrink-0"
            style={{
              fontSize: "8px",
              background: "rgba(249, 115, 22, 0.18)",
              color: "rgb(249, 115, 22)",
              height: "13px",
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            PIT
          </span>
        )}
        {!d.out && d.offTrack && (
          <span
            className="font-bold tracking-widest px-1 rounded-sm flex-shrink-0"
            style={{
              fontSize: "8px",
              background: "rgba(239, 68, 68, 0.18)",
              color: "rgb(239, 68, 68)",
              height: "13px",
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            OFF
          </span>
        )}
      </div>

      {/* License class (D, A, P...) en color iRacing */}
      {cfg.showLicense && (
        <div
          className="font-mono font-bold text-center flex-shrink-0"
          style={{
            background: licBg(licLevel),
            color: licFg(licLevel),
            width: "18px",
            height: "18px",
            fontSize: `${cfg.fontSize}px`,
            borderRadius: "3px",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.25)",
          }}
          title={d.licString}
        >
          {LIC_LETTER[licLevel] || "?"}
        </div>
      )}

      {/* Safety Rating (2.3, 3.8, etc) en su color por rango */}
      {cfg.showLicense && (
        <div
          className="font-mono font-bold text-center flex-shrink-0"
          style={{
            background: srC.bg,
            color: srC.fg,
            minWidth: "24px",
            height: "18px",
            padding: "0 4px",
            fontSize: `${cfg.fontSize - 1}px`,
            borderRadius: "3px",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.25)",
          }}
        >
          {sr > 0 ? sr.toFixed(1) : "—"}
        </div>
      )}

      {/* iRating en caja negra */}
      {cfg.showIRating && (
        <div
          className="font-mono font-bold text-center flex-shrink-0"
          style={{
            background: "rgb(15, 15, 18)",
            color: "white",
            minWidth: "32px",
            height: "18px",
            padding: "0 5px",
            fontSize: `${cfg.fontSize - 1}px`,
            borderRadius: "3px",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          {formatIrating(d.irating)}
        </div>
      )}

      {/* Gap al player (segundos y décimas) */}
      <span
        className="font-mono font-bold text-right flex-shrink-0"
        style={{
          color: gapColor,
          fontSize: `${cfg.fontSize + 0.5}px`,
          width: "52px",
        }}
      >
        {isPlayer ? "—.—" : formatGap(gap)}
      </span>
    </div>
  );
}, (prev, next) => {
  return (
    prev.driver.classPosition === next.driver.classPosition &&
    prev.driver.gapToPlayer === next.driver.gapToPlayer &&
    prev.driver.onPit === next.driver.onPit &&
    prev.driver.offTrack === next.driver.offTrack &&
    prev.driver.out === next.driver.out &&
    prev.driver.licLevel === next.driver.licLevel &&
    prev.driver.licSubLevel === next.driver.licSubLevel &&
    prev.driver.licString === next.driver.licString &&
    prev.driver.irating === next.driver.irating &&
    prev.driver.carNumber === next.driver.carNumber &&
    prev.driver.name === next.driver.name &&
    prev.isPlayer === next.isPlayer &&
    prev.cfg === next.cfg
  );
});
