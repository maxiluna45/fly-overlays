import React, { useEffect, useRef, useState } from "react";

const BASE_W = 600;
const BASE_H = 160;

const SECTOR_COUNT = 3;
const SUB_PER_SECTOR = 8;
const TOTAL_SUBS = SECTOR_COUNT * SUB_PER_SECTOR; // 24

// Colores por tono (más vibrantes y modernos)
const TONE_COLORS = {
  empty: "rgba(255,255,255,0.06)",
  gray: "rgba(120, 130, 145, 0.85)",
  green: "rgba(34, 197, 94, 0.95)",
  purple: "rgba(168, 85, 247, 0.95)",
};

const TONE_GLOW = {
  empty: "none",
  gray: "0 0 8px rgba(120,130,145,0.4)",
  green: "0 0 10px rgba(34,197,94,0.7)",
  purple: "0 0 10px rgba(168,85,247,0.7)",
};

function getMicroTone(current, last, best) {
  if (current == null) return "empty";
  if (best != null && current <= best) return "purple";
  if (last != null && current < last) return "green";
  return "gray";
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

export function SectorTimes({ previewMode = false, injectedTelemetry = null }) {
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
  });

  const [unlocked, setUnlocked] = useState(false);
  const [scale, setScale] = useState(1);
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
    if (injectedTelemetry) {
      setTelemetry((prev) => ({ ...prev, ...injectedTelemetry }));
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

  useEffect(() => {
    if (typeof window === "undefined" || !window.fly) return;
    if (typeof window.fly.onTelemetry !== "function") return;
    const unsub = window.fly.onTelemetry((data) => {
      if (data.sectors) {
        setSectors({
          current: Array.isArray(data.sectors.current) ? data.sectors.current : new Array(TOTAL_SUBS).fill(null),
          last: Array.isArray(data.sectors.last) ? data.sectors.last : new Array(TOTAL_SUBS).fill(null),
          best: Array.isArray(data.sectors.best) ? data.sectors.best : new Array(TOTAL_SUBS).fill(null),
        });
      }
      if (data.lapTimes) {
        setLapTimes(data.lapTimes);
      }
    });
    return unsub;
  }, []);

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

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full select-none transition-opacity duration-300 ${
        shouldShow ? "opacity-100" : "opacity-0"
      } ${unlocked ? "cursor-grab" : ""}`}
      style={unlocked ? { WebkitAppRegion: "drag" } : undefined}
    >
      {/* Esquinas "L" en edit mode */}
      {unlocked &&
        [
          { top: 0, left: 0, br: false, bl: true, tr: false, tl: true },
          { top: 0, right: 0, br: false, bl: false, tr: true, tl: true },
          { bottom: 0, left: 0, br: true, bl: false, tr: false, tl: true },
          { bottom: 0, right: 0, br: true, bl: true, tr: true, tl: false },
        ].map((c, i) => (
          <div
            key={i}
            className="absolute pointer-events-none z-30"
            style={{
              width: "16px",
              height: "16px",
              top: c.top || "auto",
              bottom: c.bottom || "auto",
              left: c.left ?? "auto",
              right: c.right ?? "auto",
              borderTop: c.tl || c.tr ? "2px solid #7dd3fc" : "none",
              borderBottom: c.bl || c.br ? "2px solid #7dd3fc" : "none",
              borderLeft: c.tl || c.bl ? "2px solid #7dd3fc" : "none",
              borderRight: c.tr || c.br ? "2px solid #7dd3fc" : "none",
            }}
          />
        ))}

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
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 p-3 pb-2">
              <LapTimeRow label="Current" time={currentLap} accent="text-white" />
              <LapTimeRow label="Best" time={bestSum} accent="" />
              <LapTimeRow label="Last" time={lastSum} accent="text-white/80" />
              <LapTimeRow
                label="Record"
                time={bestSum > 0 ? bestSum : null}
                accent="text-purple-300"
              />
            </div>

            {/* Separador sutil */}
            <div
              className="mx-3 h-px"
              style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.12), transparent)" }}
            />

            {/* BODY: 3 sectores en una sola línea, cada uno con 8 subsecciones */}
            <div className="p-3 pt-2 flex gap-3">
              {[0, 1, 2].map((sectorIdx) => (
                <SectorColumn
                  key={sectorIdx}
                  index={sectorIdx}
                  sectors={sectors}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function LapTimeRow({ label, time, accent }) {
  // Si no hay accent, usar el color de texto por defecto (blanco)
  const colorStyle = accent === "" ? { color: "var(--color-text)" } : undefined;
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[10px] font-bold uppercase tracking-widest text-white/40 w-16">
        {label}
      </span>
      <span
        className={`text-[15px] font-mono tnum font-semibold ${accent}`}
        style={colorStyle}
      >
        {time != null && time > 0 ? formatLapTime(time) : "——.———"}
      </span>
    </div>
  );
}

function SectorColumn({ index, sectors }) {
  const offset = index * SUB_PER_SECTOR;
  const subs = new Array(SUB_PER_SECTOR).fill(0).map((_, i) => ({
    current: sectors.current?.[offset + i] ?? null,
    last: sectors.last?.[offset + i] ?? null,
    best: sectors.best?.[offset + i] ?? null,
  }));

  return (
    <div className="flex-1 flex flex-col gap-1.5">
      {/* Label S1/S2/S3 */}
      <div className="text-[11px] font-bold text-white/50 text-center">S{index + 1}</div>

      {/* 8 subsecciones */}
      <div className="flex gap-0.5">
        {subs.map((sub, i) => {
          const tone = getMicroTone(sub.current, sub.last, sub.best);
          return (
            <div
              key={i}
              className="flex-1 h-7 rounded-sm transition-all duration-150"
              style={{
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
