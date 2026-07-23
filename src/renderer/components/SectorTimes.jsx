import React, { useEffect, useRef, useState } from "react";
import { EditCorners } from "./ui/edit-corners.jsx";

const BASE_W = 600;
const BASE_H = 160;

const SECTOR_COUNT = 3;
const SUB_PER_SECTOR = 8;
const TOTAL_SUBS = SECTOR_COUNT * SUB_PER_SECTOR; // 24

// Colores por tono (alineados con el estándar de iRacing + paleta bo2)
//   - bo2 delta bar: #FF52E052 (verde) → #FFFFFFFF (blanco) → #FFFF7F66 (coral)
//   - iRacing sectors in-game: purple (PB) / green (mejor que last) / yellow (peor)
const TONE_COLORS = {
  empty: "rgba(255,255,255,0.06)",
  gray: "rgba(120, 130, 145, 0.85)",     // peor que last lap / sin referencia
  yellow: "rgba(234, 179, 8, 0.95)",     // iRacing yellow (peor que last)
  green: "rgba(34, 197, 94, 0.95)",      // más rápido que last lap
  purple: "rgba(168, 85, 247, 0.95)",    // PB en este micro-sector (incluye empate)
  red: "rgba(239, 68, 68, 0.95)",        // sector invalidado (off-track / cut)
};

const TONE_GLOW = {
  empty: "none",
  gray: "0 0 8px rgba(120,130,145,0.4)",
  yellow: "0 0 10px rgba(234,179,8,0.7)",
  green: "0 0 10px rgba(34,197,94,0.7)",
  purple: "0 0 12px rgba(168,85,247,0.8)",
  red: "0 0 10px rgba(239,68,68,0.7)",
};

// Tonos para el fondo del sector ENTERO cuando está completo.
// ~20% de opacidad — visible pero sin saturar.
const SECTOR_BG = {
  purple: "rgba(168, 85, 247, 0.22)",   // PB
  green:  "rgba(34, 197, 94, 0.22)",    // mejor que last
  yellow: "rgba(234, 179, 8, 0.22)",    // peor que last
  gray:   "rgba(120, 130, 145, 0.12)",  // sin referencia
};

const SECTOR_BORDER = {
  purple: "rgba(168, 85, 247, 0.55)",
  green:  "rgba(34, 197, 94, 0.55)",
  yellow: "rgba(234, 179, 8, 0.55)",
  gray:   "rgba(120, 130, 145, 0.30)",
};

const SECTOR_LABEL_COLOR = {
  purple: "rgba(216, 180, 254, 1)",
  green:  "rgba(134, 239, 172, 1)",
  yellow: "rgba(253, 224, 71, 1)",
  gray:   "rgba(255,255,255,0.7)",
};

function getMicroTone(current, last, best) {
  if (current == null) return "empty";
  // PB en este micro-sector (estricto: batiste tu mejor marca acá).
  // Empate con best también cuenta como purple (sigue siendo el más rápido
  // conocido en esta posición). Mismo criterio que usa iRacing en pantalla.
  if (best != null && isFinite(best) && best > 0 && current <= best) return "purple";
  // Más rápido que tu última vuelta en este micro-sector, pero no PB.
  if (last != null && isFinite(last) && last > 0 && current < last) return "green";
  // Peor (o igual) que tu última vuelta. iRacing muestra esto en amarillo.
  if (last != null && isFinite(last) && last > 0) return "yellow";
  // Sin referencia de vuelta previa (primera vuelta): neutro.
  return "gray";
}

// Tono del sector ENTERO. Devuelve null si el sector aún no terminó
// (algún micro-sector sin valor), o si no hay referencias para comparar.
function getSectorTone(sectorIdx, sectors) {
  const offset = sectorIdx * SUB_PER_SECTOR;
  const cur = sectors.current?.slice(offset, offset + SUB_PER_SECTOR) || [];
  const last = sectors.last?.slice(offset, offset + SUB_PER_SECTOR) || [];
  const best = sectors.best?.slice(offset, offset + SUB_PER_SECTOR) || [];

  // ¿Están los 8 micro-sectores llenos?
  const allFilled = cur.length === SUB_PER_SECTOR && cur.every((v) => v != null && v > 0 && isFinite(v));
  if (!allFilled) return null;

  const curSum = sumOf(cur);
  const bestSum = best.every((v) => v != null && v > 0 && isFinite(v)) ? sumOf(best) : null;
  const lastSum = last.every((v) => v != null && v > 0 && isFinite(v)) ? sumOf(last) : null;

  // PB en este sector (suma ≤ best, incluiyendo empate)
  if (bestSum != null && curSum <= bestSum) return "purple";
  // Mejor que tu última vuelta en este sector, pero no PB
  if (lastSum != null && curSum < lastSum) return "green";
  // Peor (o igual) que tu última vuelta
  if (lastSum != null && curSum >= lastSum) return "yellow";
  // Sin referencia de vuelta previa
  return "gray";
}

// Delta del sector completo respecto a la referencia (best si existe, si no last).
// Devuelve null si el sector aún no terminó o no hay con qué comparar.
function getSectorDelta(sectorIdx, sectors) {
  const offset = sectorIdx * SUB_PER_SECTOR;
  const cur = sectors.current?.slice(offset, offset + SUB_PER_SECTOR) || [];
  const best = sectors.best?.slice(offset, offset + SUB_PER_SECTOR) || [];
  const last = sectors.last?.slice(offset, offset + SUB_PER_SECTOR) || [];
  const allFilled = cur.length === SUB_PER_SECTOR && cur.every((v) => v != null && v > 0 && isFinite(v));
  if (!allFilled) return null;
  const curSum = sumOf(cur);
  const bestSum = best.every((v) => v != null && v > 0 && isFinite(v)) ? sumOf(best) : null;
  const lastSum = last.every((v) => v != null && v > 0 && isFinite(v)) ? sumOf(last) : null;
  const ref = bestSum != null ? bestSum : lastSum;
  if (ref == null) return null;
  return { delta: curSum - ref, vsBest: bestSum != null };
}

function formatLapTime(seconds) {
  if (seconds == null || !isFinite(seconds) || seconds <= 0) return "--:--.---";
  const m = Math.floor(seconds / 60);
  const s = (seconds - m * 60).toFixed(3);
  return `${m}:${s.padStart(6, "0")}`;
}

function sumOf(arr) {
  return arr.reduce((acc, v) => acc + (v != null && isFinite(v) ? v : 0), 0);
}

export function SectorTimes({ previewMode = false, injectedTelemetry = null, settings = {} }) {
  // Settings con defaults
  const cfg = {
    headerFontSize: 10,
    valueFontSize: 15,
    timeColumnWidth: 64,
    subBarHeight: 28,
    showHeader: true,
    showSubBars: true,
    showSectorDelta: true,
    ...settings,
  };
  const [telemetry, setTelemetry] = useState({
    connected: false,
    onTrack: false,
    preview: false,
  });
  const [sectors, setSectors] = useState({
    current: new Array(TOTAL_SUBS).fill(null),
    last: new Array(TOTAL_SUBS).fill(null),
    best: new Array(TOTAL_SUBS).fill(null),
  });
  const [lapTimes, setLapTimes] = useState({
    currentLap: 0,
    bestLap: 0,
    lastLap: 0,
    lastLapInvalid: false,
  });

  const [unlocked, setUnlocked] = useState(false);
  const [scale, setScale] = useState(1);
  const containerRef = useRef(null);
  // true una vez que el canal rápido entregó currentLapTime: a partir de ahí el
  // canal pesado no debe pisar currentLap con su copia stale (throttled a 500ms).
  const hasFastCurrentRef = useRef(false);
  // Firma de reposo: en menú/pits/auto quieto, ni los flags ni currentLapTime
  // cambian tick a tick. Si nada cambió, no tocamos el estado → no re-render.
  // Los sectores solo cambian mientras la vuelta AVANZA (currentLapTime sube),
  // así que atarlos a currentLapTime es seguro (no se pierden cruces de split).
  const lastSigRef = useRef("");

  useEffect(() => {
    if (injectedTelemetry) return;
    if (typeof window === "undefined" || !window.fly) return;
    if (typeof window.fly.onTelemetry !== "function") return;
    try {
      const unsub = window.fly.onTelemetry((data) => {
        const sig = `${!!data.connected}|${!!data.onTrack}|${!!data.preview}|${data.currentLapTime}`;
        if (sig === lastSigRef.current) return; // reposo: nada que mostrar cambió
        lastSigRef.current = sig;
        // El payload de IrsdkClient ya incluye { current, last, best }.
        // Si no lo copiamos al estado, todos los sub-sectores se quedan en null
        // y se renderizan como "empty" (gris muy claro) sin colores.
        if (data.sectors) setSectors(data.sectors);
        // currentLapTime viaja por el canal rápido (60 Hz). lapTimes.currentLap
        // llega por el canal pesado throttled a 500ms y se ve "a saltos".
        if (data.currentLapTime != null) {
          hasFastCurrentRef.current = true;
          setLapTimes((prev) => ({ ...prev, currentLap: data.currentLapTime }));
        }
        setTelemetry((prev) => ({ ...prev, ...data }));
      });
      return unsub;
    } catch (_) {}
  }, [injectedTelemetry]);

  useEffect(() => {
    if (injectedTelemetry) {
      setTelemetry((prev) => ({ ...prev, ...injectedTelemetry }));
      // El preview inyecta también sectores y tiempos: hay que copiarlos a sus
      // estados (el path real lo hace vía onTelemetry/heavy, que acá se saltea).
      if (injectedTelemetry.sectors) setSectors(injectedTelemetry.sectors);
      if (injectedTelemetry.lapTimes) setLapTimes(injectedTelemetry.lapTimes);
    }
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

  // Canal pesado: lapTimes (los sectores viajan por el canal rápido porque
  // cambian al cruzar splits, que es event-driven y debe verse al instante).
  useEffect(() => {
    if (injectedTelemetry) return;
    if (typeof window === "undefined" || !window.fly) return;
    if (typeof window.fly.onTelemetryHeavy !== "function") return;
    try {
      const unsub = window.fly.onTelemetryHeavy((data) => {
        if (data.lapTimes) {
          setLapTimes((prev) =>
            hasFastCurrentRef.current
              ? { ...data.lapTimes, currentLap: prev.currentLap }
              : data.lapTimes
          );
        }
      });
      return unsub;
    } catch (_) {}
  }, [injectedTelemetry]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w === 0 || h === 0) return;
      const s = Math.min(w / BASE_W, h / BASE_H);
      setScale(s);
    };
    update();
    let ro = null;
    try {
      ro = new ResizeObserver(update);
      ro.observe(el);
    } catch (_) {}
    return () => { if (ro) ro.disconnect(); };
  }, []);

  const shouldShow =
    unlocked || previewMode || telemetry.preview || (telemetry.onTrack && telemetry.connected);

  // Tiempos agregados
  // Usamos los tiempos oficiales de iRacing en vez de sumar micro-sectores
  // (los oficiales son exactos y se actualizan continuamente)
  const currentLap = lapTimes.currentLap;
  const bestSum = lapTimes.bestLap;
  const lastSum = lapTimes.lastLap;
  // Vuelta óptima teórica: suma de los 24 mejores micro-sectores. Solo es
  // válida cuando hay marca en TODOS (si falta alguno, la suma engañaría).
  const optimalSum = (() => {
    const best = sectors.best || [];
    if (best.length !== TOTAL_SUBS) return null;
    if (!best.every((v) => v != null && isFinite(v) && v > 0)) return null;
    return sumOf(best);
  })();

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full select-none transition-opacity duration-300 ${
        shouldShow ? "opacity-100" : "opacity-0"
      } ${unlocked ? "cursor-grab" : ""}`}
      style={unlocked ? { WebkitAppRegion: "drag" } : undefined}
    >
      {/* Esquinas "L" en edit mode */}
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
        <div
          style={{
            width: BASE_W,
            height: BASE_H,
            transform: `scale(${scale})`,
            transformOrigin: "center center",
            position: "relative",
          }}
        >
          <div
            className="w-full h-full rounded-2xl overflow-hidden relative"
            style={{
              background: "linear-gradient(180deg, rgba(20,24,32,0.85) 0%, rgba(10,13,18,0.92) 100%)",
              border: "1px solid rgba(255,255,255,0.08)",
              boxShadow: "0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,0,0,0.4) inset",
              backdropFilter: "blur(16px)",
            }}
          >
            {/* HEADER con tiempos */}
            {cfg.showHeader && (
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 p-3 pb-2">
                <LapTimeRow label="Current" time={currentLap} accent="text-white" />
                <LapTimeRow label="Best" time={bestSum} accent="" />
                <LapTimeRow
                  label="Last"
                  time={lastSum}
                  accent="text-white/80"
                  invalid={lapTimes.lastLapInvalid}
                />
                <LapTimeRow
                  label="Optimal"
                  time={optimalSum}
                  accent="text-purple-300"
                />
              </div>
            )}

            {/* Separador sutil */}
            <div
              className="mx-3 h-px"
              style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.12), transparent)" }}
            />

            {/* BODY: 3 sectores en una sola línea, cada uno con 8 subsecciones */}
            {cfg.showSubBars && (
              <div className="p-3 pt-2 flex gap-3">
              {[0, 1, 2].map((sectorIdx) => (
                <SectorColumn
                  key={sectorIdx}
                  index={sectorIdx}
                  sectors={sectors}
                  showDelta={cfg.showSectorDelta !== false}
                />
              ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function LapTimeRow({ label, time, accent, invalid = false }) {
  // Si no hay accent, usar el color de texto por defecto (blanco)
  const colorStyle = accent === "" ? { color: "var(--color-text)" } : undefined;
  const hasTime = time != null && time > 0;
  return (
    <div className="flex items-baseline gap-2">
      <span
        className="font-bold uppercase tracking-widest text-white/40"
        style={{ fontSize: 'var(--header-font-size, 10px)', width: 'var(--time-col-width, 64px)' }}
      >
        {label}
      </span>
      <span
        className={`font-mono tnum font-semibold ${accent}`}
        style={{ ...colorStyle, fontSize: 'var(--value-font-size, 15px)' }}
      >
        {hasTime ? (
          <>
            {formatLapTime(time)}
            {invalid && (
              <span
                className="ml-1 text-red-400"
                title="Vuelta inválida (off-track / cut). Tiempo calculado a partir de micro-sectores."
              >
                *
              </span>
            )}
          </>
        ) : (
          "——.———"
        )}
      </span>
    </div>
  );
}

function SectorColumn({ index, sectors, showDelta = true }) {
  const offset = index * SUB_PER_SECTOR;
  const subs = new Array(SUB_PER_SECTOR).fill(0).map((_, i) => ({
    current: sectors.current?.[offset + i] ?? null,
    last: sectors.last?.[offset + i] ?? null,
    best: sectors.best?.[offset + i] ?? null,
  }));

  // Delta del sector vs. referencia (best si existe, si no last). Lo usamos tanto
  // para el número como para el COLOR, así ambos son coherentes: no puede haber
  // "verde con +delta". Púrpura = igualás/batís tu mejor · verde = más rápido que
  // la referencia · amarillo = más lento.
  const sectorDelta = getSectorDelta(index, sectors);
  const sectorTone = sectorDelta == null ? null
    : (sectorDelta.vsBest && sectorDelta.delta <= 0.0005) ? "purple"
    : sectorDelta.delta <= -0.0005 ? "green"
    : "yellow";
  const hasTone = sectorTone != null;

  return (
    <div
      className="flex-1 flex flex-col gap-1.5 rounded-md p-1.5 transition-colors duration-300"
      style={{
        // Fondo del sector ENTERO (label + micro-sectores) cuando está completo
        background: hasTone ? SECTOR_BG[sectorTone] : "transparent",
        border: hasTone ? `1px solid ${SECTOR_BORDER[sectorTone]}` : "1px solid transparent",
      }}
    >
      {/* Label S1/S2/S3 + delta del sector — toma el color del tono al completarse */}
      <div
        className="text-[11px] font-bold text-center transition-colors duration-300 flex items-center justify-center gap-1.5"
        style={{ color: hasTone ? SECTOR_LABEL_COLOR[sectorTone] : "rgba(255,255,255,0.5)" }}
      >
        <span>S{index + 1}</span>
        {showDelta && sectorDelta && (
          <span
            className="font-mono tnum"
            style={{
              fontSize: "10px",
              color: sectorDelta.delta <= 0 ? "rgb(134, 239, 172)" : "rgb(248, 113, 113)",
            }}
            title={sectorDelta.vsBest ? "vs. mejor sector" : "vs. sector de la última vuelta"}
          >
            {sectorDelta.delta >= 0 ? "+" : "−"}{Math.abs(sectorDelta.delta).toFixed(2)}
          </span>
        )}
      </div>

      {/* 8 subsecciones */}
      <div className="flex gap-0.5">
        {subs.map((sub, i) => {
          const tone = getMicroTone(sub.current, sub.last, sub.best);
          return (
            <div
              key={i}
              className="flex-1 rounded-sm transition-colors duration-150"
              style={{
                height: 'var(--sub-bar-height, 28px)',
                background: TONE_COLORS[tone],
                boxShadow: TONE_GLOW[tone],
                minWidth: 0,
              }}
              title={
                sub.current != null
                  ? `Sub ${index + 1}.${i + 1}: ${sub.current.toFixed(3)}s${
                      sub.last != null ? ` (last ${sub.last.toFixed(3)})` : ""
                    }${sub.best != null ? ` (best ${sub.best.toFixed(3)})` : ""}`
                  : `Sub ${index + 1}.${i + 1}: no completado`
              }
            />
          );
        })}
      </div>
    </div>
  );
}
