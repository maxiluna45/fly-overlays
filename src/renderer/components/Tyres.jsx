import React, { useEffect, useRef, useState } from "react";
import { EditCorners } from "./ui/edit-corners.jsx";

// === Color thresholds for temperature (°C) ===
function tempTone(c) {
  if (c == null || !isFinite(c)) return null;
  if (c < 50) return { rgb: "59, 130, 246", name: "cold" };      // blue
  if (c < 70) return { rgb: "34, 197, 94", name: "cool" };       // green
  if (c < 95) return { rgb: "234, 179, 8", name: "optimal" };    // yellow
  if (c < 115) return { rgb: "249, 115, 22", name: "hot" };      // orange
  return { rgb: "239, 68, 68", name: "critical" };               // red
}

function pressTone(p, target) {
  if (p == null || !isFinite(p) || target == null || !isFinite(target) || target <= 0) {
    return { ratio: 0.5, rgb: "120, 130, 145", label: "--", state: "ok" };
  }
  const ratio = p / target;
  if (ratio < 0.92) return { ratio, rgb: "59, 130, 246", label: "LOW", state: "low" };
  if (ratio > 1.08) return { ratio, rgb: "239, 68, 68", label: "HIGH", state: "high" };
  if (ratio < 0.96 || ratio > 1.04) return { ratio, rgb: "234, 179, 8", label: "±", state: "warn" };
  return { ratio, rgb: "34, 197, 94", label: "OK", state: "ok" };
}

const TYRE_LABELS = {
  LF: { pos: "Del. Izq" },
  RF: { pos: "Del. Der" },
  LR: { pos: "Tras. Izq" },
  RR: { pos: "Tras. Der" },
};

export function Tyres({ previewMode = false, injectedTelemetry = null, settings = {} }) {
  const cfg = {
    showNumbers: true,
    showPressure: true,
    showWear: true,
    compactMode: false,
    cellSize: 110,
    gap: 10,
    borderRadius: 14,
    ...settings,
  };

  const [telemetry, setTelemetry] = useState({
    connected: false,
    onTrack: false,
    preview: false,
    tyres: emptyTyres(),
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

  // Ya no usamos scale/zoom. El layout es 100% responsivo.

  const shouldShow = unlocked || previewMode || telemetry.preview || (telemetry.onTrack && telemetry.connected);
  const tyres = telemetry.tyres || emptyTyres();
  // Target de presión "óptima" para los thresholds de color.
  // Se mantiene en kPa internamente; la conversión a psi se hace al mostrar.
  const setPressKpa = telemetry.tyrePressTarget || 165;

  // Helpers de conversión (kPa es la unidad nativa de iRacing)
  const KPA_TO_PSI = 0.1450377;
  const usePsi = cfg.pressureUnit === "psi";
  const convertPress = (kpa) => usePsi ? kpa * KPA_TO_PSI : kpa;
  const pressUnit = usePsi ? "psi" : "kPa";

  // Stats globales
  const allTemps = [];
  for (const id of ["LF", "RF", "LR", "RR"]) {
    const t = tyres[id];
    if (!t) continue;
    if (t.tempL != null) allTemps.push(t.tempL);
    if (t.tempM != null) allTemps.push(t.tempM);
    if (t.tempR != null) allTemps.push(t.tempR);
  }
  const avgTemp = allTemps.length > 0 ? allTemps.reduce((a, b) => a + b, 0) / allTemps.length : null;
  const maxTemp = allTemps.length > 0 ? Math.max(...allTemps) : null;
  const minTemp = allTemps.length > 0 ? Math.min(...allTemps) : null;

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

      <div
        className="absolute inset-0 flex items-center justify-center"
        style={{ pointerEvents: "none" }}
      >
        <div className="w-full h-full p-3">
          <div
            className="w-full h-full rounded-2xl overflow-hidden relative p-3 flex flex-col"
            style={{
              background: "linear-gradient(180deg, rgba(20,24,32,0.88) 0%, rgba(8,11,16,0.95) 100%)",
              border: "1px solid rgba(255,255,255,0.08)",
              boxShadow: "0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,0,0,0.4) inset",
              backdropFilter: "blur(16px)",
            }}
          >
            {/* Header */}
            {cfg.showNumbers && (
              <div
                className="flex items-center justify-between px-2 mb-2 font-mono"
                style={{ fontSize: `${cfg.headerFontSize || 10}px` }}
              >
                <div className="flex items-center gap-3 text-white/50">
                  <span className="font-bold tracking-widest">TYRES</span>
                  {avgTemp != null && (
                    <>
                      <span>AVG</span>
                      <span
                        className="font-bold"
                        style={{ color: `rgba(${tempTone(avgTemp)?.rgb || "255,255,255"}, 1)` }}
                      >
                        {Math.round(avgTemp)}°
                      </span>
                    </>
                  )}
                </div>
                {maxTemp != null && minTemp != null && (
                  <div className="flex items-center gap-3 text-white/50">
                    <span>MIN</span>
                    <span style={{ color: `rgba(${tempTone(minTemp)?.rgb || "255,255,255"}, 1)` }} className="font-bold">
                      {Math.round(minTemp)}°
                    </span>
                    <span>MAX</span>
                    <span style={{ color: `rgba(${tempTone(maxTemp)?.rgb || "255,255,255"}, 1)` }} className="font-bold">
                      {Math.round(maxTemp)}°
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Grid 2x2 */}
            <div
              className="grid grid-cols-2 flex-1"
              style={{ gap: `${cfg.gap}px` }}
            >
              <TyreCell id="LF" tyre={tyres.LF} cfg={cfg} targetPress={setPressKpa} pressUnit={pressUnit} convertPress={convertPress} />
              <TyreCell id="RF" tyre={tyres.RF} cfg={cfg} targetPress={setPressKpa} pressUnit={pressUnit} convertPress={convertPress} />
              <TyreCell id="LR" tyre={tyres.LR} cfg={cfg} targetPress={setPressKpa} pressUnit={pressUnit} convertPress={convertPress} />
              <TyreCell id="RR" tyre={tyres.RR} cfg={cfg} targetPress={setPressKpa} pressUnit={pressUnit} convertPress={convertPress} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function emptyTyres() {
  return {
    LF: { tempL: 70, tempM: 75, tempR: 72, press: 160, wearL: 0.1, wearM: 0.08, wearR: 0.12 },
    RF: { tempL: 72, tempM: 77, tempR: 74, press: 162, wearL: 0.1, wearM: 0.08, wearR: 0.12 },
    LR: { tempL: 80, tempM: 85, tempR: 82, press: 170, wearL: 0.1, wearM: 0.08, wearR: 0.12 },
    RR: { tempL: 82, tempM: 87, tempR: 84, press: 172, wearL: 0.1, wearM: 0.08, wearR: 0.12 },
  };
}

// === Celda individual ===
// Vista desde ABAJO (la huella contra el piso):
//   3 franjas verticales: INNER (extremo interior) | CENTER (centro) | OUTER (extremo exterior)
//   Cada franja se "llena" con el color de su temperatura.
//   Encima: el número grande de la temp de la franja (con su color)
//   Debajo: la presión + wear en formato compacto
function TyreCell({ id, tyre, cfg, targetPress, pressUnit = "kPa", convertPress = (x) => x }) {
  const { tempL, tempM, tempR, press, wearL, wearM, wearR, freshTemp, freshPress, freshWear } = tyre || {};
  const toneL = tempTone(tempL);
  const toneM = tempTone(tempM);
  const toneR = tempTone(tempR);

  // Opacidad basada en freshness de temperatura.
  // < 2s  = recién actualizado, opacidad 1.0
  // 2-10s = un poco viejo, opacidad 0.7
  // > 10s = stale, opacidad 0.35
  const tempOpacity =
    freshTemp == null ? 0.35 :
    freshTemp < 2 ? 1.0 :
    freshTemp < 10 ? 0.7 :
    0.35;

  const wearAvg = (
    (Number.isFinite(wearL) ? wearL : 1) +
    (Number.isFinite(wearM) ? wearM : 1) +
    (Number.isFinite(wearR) ? wearR : 1)
  ) / 3;
  const freshness = Number.isFinite(wearAvg) ? Math.max(0, 1 - wearAvg) : 1;
  const pressInfo = pressTone(press, targetPress);

  // Indicador "LIVE/STALE" para mostrar en header
  const isLive = freshTemp != null && freshTemp < 5;
  const isStale = freshTemp == null || freshTemp > 10;

  return (
    <div
      className="relative flex flex-col overflow-hidden"
      style={{
        borderRadius: `${cfg.borderRadius}px`,
        background: "linear-gradient(180deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.01) 100%)",
        border: `1px solid ${isStale ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.06)"}`,
        minWidth: 0,
        minHeight: 0,
      }}
    >
      {/* Header de la celda: posición + freshness indicator + wear% */}
      <div
        className="flex items-center justify-between pt-1.5 text-[8px] font-mono font-bold"
        style={{ maxWidth: `${cfg.cellMaxWidth || 160}px`, margin: "0 auto", width: "100%" }}
      >
        <div className="flex items-center gap-1">
          <span className="uppercase tracking-widest text-white/40">
            {TYRE_LABELS[id].pos}
          </span>
          {/* Indicador LIVE/STALE muy chico al costado del label */}
          {isLive && (
            <span
              className="text-[7px] font-bold tracking-wider px-1 rounded-sm"
              style={{
                color: "rgba(34, 197, 94, 1)",
                background: "rgba(34, 197, 94, 0.12)",
              }}
              title={`Actualizado hace ${freshTemp.toFixed(1)}s`}
            >
              LIVE
            </span>
          )}
          {isStale && (
            <span
              className="text-[7px] font-bold tracking-wider px-1 rounded-sm"
              style={{
                color: "rgba(255, 255, 255, 0.4)",
                background: "rgba(255, 255, 255, 0.05)",
              }}
              title={freshTemp == null ? "Sin datos del simulador" : `Último update hace ${freshTemp.toFixed(0)}s`}
            >
              STALE
            </span>
          )}
        </div>
        {cfg.showWear && (
          <span
            style={{
              color: freshness > 0.7 ? "rgba(34, 197, 94, 1)"
                    : freshness > 0.4 ? "rgba(234, 179, 8, 1)"
                    : "rgba(239, 68, 68, 1)",
              fontSize: `${cfg.wearFontSize || 9}px`,
            }}
          >
            {Math.round(freshness * 100)}%
          </span>
        )}
      </div>

      {/* Cuerpo: 3 franjas verticales pegadas como un slick real.
          El orden depende del lado del auto:
          - Lado izquierdo (LF, LR): outer está hacia la izquierda del neumático
            (afuera del auto). Orden: O | C | I
          - Lado derecho (RF, RR): outer está hacia la derecha (afuera).
            Orden: I | C | O */}
      {(() => {
        const isLeftSide = id === "LF" || id === "LR";
        const left = isLeftSide
          ? { l: "O", c: tempR, t: toneR }
          : { l: "I", c: tempL, t: toneL };
        const right = isLeftSide
          ? { l: "I", c: tempL, t: toneL }
          : { l: "O", c: tempR, t: toneR };
        return (
          <div
            className="flex-1 flex items-stretch justify-center py-1.5 transition-opacity duration-300"
            style={{
              gap: `${cfg.bandGap ?? 2}px`,
              maxWidth: `${cfg.cellMaxWidth || 160}px`,
              margin: "0 auto",
              width: "100%",
              opacity: tempOpacity,
            }}
          >
            <Band label={left.l} temp={left.c} tone={left.t} cfg={cfg} position="left" />
            <Band label="C" temp={tempM} tone={toneM} cfg={cfg} primary />
            <Band label={right.l} temp={right.c} tone={right.t} cfg={cfg} position="right" />
          </div>
        );
      })()}

      {/* Footer: presión (target del garage, no en vivo) */}
      {cfg.showPressure && (
        <div className="flex items-center justify-between px-2.5 pb-1.5">
          <div className="flex items-center gap-1.5">
            <div className="relative w-14 h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.08)" }}>
              <div
                className="absolute top-0 bottom-0 w-px"
                style={{ left: "50%", background: "rgba(255,255,255,0.4)" }}
              />
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.min(100, pressInfo.ratio * 50)}%`,
                  background: `rgba(${pressInfo.rgb}, 1)`,
                  boxShadow: `0 0 6px rgba(${pressInfo.rgb}, 0.7)`,
                }}
              />
            </div>
            <span
              className="font-mono font-bold"
              style={{
                color: `rgba(${pressInfo.rgb}, 1)`,
                fontSize: `${cfg.pressFontSize || 10}px`,
              }}
            >
              {press != null ? Math.round(convertPress(press)) : "—"} {pressUnit}
            </span>
          </div>
          {/* Label "SET" para aclarar que es el target del garage, no en vivo */}
          <span
            className="text-[7px] font-bold tracking-widest px-1 rounded-sm uppercase"
            style={{
              color: "rgba(255, 255, 255, 0.4)",
              background: "rgba(255, 255, 255, 0.05)",
            }}
            title="Presión objetivo del setup (no se actualiza en vivo)"
          >
            SET
          </span>
        </div>
      )}
    </div>
  );
}

// === Franja individual (Inner / Center / Outer) — VISTA DESDE ABAJO ===
// Línea vertical coloreada con el número ADENTRO de la franja.
// Border-radius asimétrico: las laterales curvan en sus esquinas externas
// (lejos del centro), y el central queda plano (radio 0).
function Band({ label, temp, tone, cfg, position = "left", primary = false }) {
  const displayTemp = temp != null && isFinite(temp) ? Math.round(temp) : null;
  const colorRgb = tone?.rgb || "120, 130, 145";

  const bandW = primary ? (cfg.primaryBandWidth || 18) : (cfg.bandWidth || 14);
  // Si la banda es muy fina para el tamaño pedido, achicamos la fuente
  // en vez de rotar (mantiene legibilidad).
  const requestedFontSize = primary ? (cfg.tempFontSize || 15) : Math.max(8, (cfg.tempFontSize || 15) - 4);
  const fontSize = Math.min(requestedFontSize, bandW - 2);
  const cornerR = primary ? 0 : Math.max(4, Math.min(12, bandW / 2 + 1));

  // Border-radius asimétrico: la lateral izquierda curva en su lado izquierdo,
  // la lateral derecha curva en su lado derecho, el centro no curva nada.
  let borderRadius;
  if (primary) {
    borderRadius = "0px";
  } else if (position === "left") {
    borderRadius = `${cornerR}px 0 0 ${cornerR}px`;
  } else {
    borderRadius = `0 ${cornerR}px ${cornerR}px 0`;
  }

  return (
    <div className="flex flex-col items-center" style={{ minWidth: 0 }}>
      {/* Label superior (I/C/O) */}
      <div
        className="font-bold font-mono mb-1"
        style={{
          fontSize: "8px",
          color: "rgba(255,255,255,0.35)",
          letterSpacing: "0.05em",
        }}
      >
        {label}
      </div>

      {/* Franja coloreada con número ADENTRO */}
      <div
        className="relative overflow-hidden flex-1"
        style={{
          width: `${bandW}px`,
          minWidth: `${bandW}px`,
          background: `linear-gradient(180deg, rgba(${colorRgb}, 1) 0%, rgba(${colorRgb}, 0.7) 100%)`,
          boxShadow: `0 0 ${primary ? 8 : 5}px rgba(${colorRgb}, 0.7)`,
          border: `1px solid rgba(${colorRgb}, 0.9)`,
          borderRadius,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* Highlight especular fino al costado */}
        <div
          className="absolute top-0 bottom-0 pointer-events-none"
          style={{
            left: "15%",
            width: "1px",
            background: "linear-gradient(180deg, rgba(255,255,255,0.4) 0%, transparent 100%)",
          }}
        />

        {/* Número de temperatura ADENTRO de la franja */}
        {cfg.showNumbers && !cfg.compactMode && (
          <span
            className="font-mono font-bold leading-none relative"
            style={{
              fontSize: `${fontSize}px`,
              color: "white",
              textShadow: "0 1px 1px rgba(0,0,0,0.95)",
              whiteSpace: "nowrap",
              lineHeight: 1,
              // Renderizado más nítido en pantallas HiDPI
              WebkitFontSmoothing: "antialiased",
              MozOsxFontSmoothing: "grayscale",
            }}
          >
            {displayTemp != null ? displayTemp : "—"}
          </span>
        )}
      </div>
    </div>
  );
}
