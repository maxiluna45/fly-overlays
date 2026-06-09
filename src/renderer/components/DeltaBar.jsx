import React, { useEffect, useRef, useState } from "react";

const BASE_W = 600;
const BASE_H = 120;

function formatDelta(seconds) {
  if (typeof seconds !== "number" || !isFinite(seconds)) return "+0.00";
  const sign = seconds >= 0 ? "+" : "−";
  return `${sign}${Math.abs(seconds).toFixed(2)}`;
}

export function DeltaBar({ previewMode = false, injectedTelemetry = null }) {
  const [telemetry, setTelemetry] = useState({
    connected: false,
    delta: 0,
    lap: 0,
    onTrack: false,
    preview: false,
  });

  const [unlocked, setUnlocked] = useState(false);
  const [scale, setScale] = useState(1);
  const containerRef = useRef(null);

  const targetRef = useRef(0);
  const displayRef = useRef(0);
  const [renderDelta, setRenderDelta] = useState(0);
  const rafRef = useRef(null);

  // Suscripción a telemetría real (solo si window.fly existe y no hay telemetría inyectada)
  useEffect(() => {
    if (injectedTelemetry) return;
    if (typeof window === "undefined" || !window.fly) return;
    if (typeof window.fly.onTelemetry !== "function") return;
    try {
      const unsub = window.fly.onTelemetry((data) => {
        targetRef.current = data.delta || 0;
        setTelemetry((prev) => ({ ...prev, ...data }));
      });
      return unsub;
    } catch (_) {}
  }, [injectedTelemetry]);

  useEffect(() => {
    if (injectedTelemetry) {
      targetRef.current = injectedTelemetry.delta || 0;
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
    } catch (_) {
      // ResizeObserver no disponible
    }
    return () => { if (ro) ro.disconnect(); };
  }, []);

  useEffect(() => {
    const tick = () => {
      const diff = targetRef.current - displayRef.current;
      displayRef.current += diff * 0.22;
      setRenderDelta(displayRef.current);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  const max = 5;
  const clamped = Math.max(-max, Math.min(max, renderDelta));
  const fillPercent = (Math.abs(clamped) / max) * 50;
  const isGaining = renderDelta < 0;
  const isNear = Math.abs(renderDelta) < 0.05;
  const showBar = telemetry.onTrack && telemetry.connected;

  const fillColor = isNear
    ? "rgba(255,255,255,0.25)"
    : isGaining
      ? "rgba(52,211,153,0.95)"
      : "rgba(248,113,113,0.95)";

  const valueColor = isNear
    ? "var(--color-text)"
    : isGaining
      ? "var(--color-pos)"
      : "var(--color-neg)";

  const valueGlow = isNear
    ? "0 0 12px rgba(255,255,255,0.25)"
    : isGaining
      ? "0 0 16px rgba(52,211,153,0.65), 0 0 4px rgba(52,211,153,0.9)"
      : "0 0 16px rgba(248,113,113,0.65), 0 0 4px rgba(248,113,113,0.9)";

  const shouldShow =
    unlocked ||
    previewMode ||
    telemetry.preview ||
    (telemetry.onTrack && telemetry.connected);

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full select-none transition-opacity duration-300 ${
        shouldShow ? "opacity-100" : "opacity-0"
      } ${unlocked ? "cursor-grab" : ""}`}
      style={unlocked ? { WebkitAppRegion: "drag" } : undefined}
    >
      {/* EDIT MODE: solo esquinas tipo "L" + handles */}
      {unlocked && (
        <>
          {/* Esquinas minimalistas: líneas tipo "L" */}
          {[
            { pos: "top-0 left-0", borders: "border-l-2 border-t-2", corners: "top-0 left-0" },
            { pos: "top-0 right-0", borders: "border-r-2 border-t-2", corners: "top-0 right-0" },
            { pos: "bottom-0 left-0", borders: "border-l-2 border-b-2", corners: "bottom-0 left-0" },
            { pos: "bottom-0 right-0", borders: "border-r-2 border-b-2", corners: "bottom-0 right-0" },
          ].map((c, i) => {
            const [vAlign, hAlign] = c.pos.split(" ");
            const isTop = vAlign === "top-0";
            const isLeft = hAlign === "left-0";
            return (
              <div
                key={i}
                className={`absolute ${c.borders} border-accent pointer-events-none z-30`}
                style={{
                  width: "16px",
                  height: "16px",
                  top: isTop ? 0 : "auto",
                  bottom: !isTop ? 0 : "auto",
                  left: isLeft ? 0 : "auto",
                  right: !isLeft ? 0 : "auto",
                }}
              />
            );
          })}

          {/* Handles invisibles de resize en las 4 esquinas (área más grande para que sea fácil agarrarlos) */}
          {[
            "top-0 left-0 cursor-nwse-resize",
            "top-0 right-0 cursor-nesw-resize",
            "bottom-0 left-0 cursor-nesw-resize",
            "bottom-0 right-0 cursor-nwse-resize",
          ].map((cls, i) => (
            <div
              key={`h-${i}`}
              className={`absolute size-5 z-40 ${cls}`}
              style={{ WebkitAppRegion: "no-drag" }}
            />
          ))}

          {/* Hint con fondo azul sólido */}
          <div
            className="absolute top-1 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded text-[9px] font-bold tracking-widest z-50 shadow"
            style={{
              pointerEvents: "none",
              background: "rgb(59, 130, 246)",
              color: "white",
            }}
          >
            EDIT MODE · F7 TO LOCK
          </div>
        </>
      )}

      {telemetry.preview && (
        <div
          className="absolute top-1 right-1 px-1.5 py-0.5 rounded bg-yellow-500/20 border border-yellow-500/40 text-[8px] font-bold tracking-widest text-yellow-400 z-50"
          style={{ pointerEvents: "none" }}
        >
          PREVIEW
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
          <div className="w-full h-full flex flex-col items-center justify-center gap-3">
            <div className="relative w-[92%] h-3 rounded-sm overflow-hidden">
              <div
                className="absolute inset-0 rounded-sm border border-white/10"
                style={{ background: "rgba(255,255,255,0.06)", backdropFilter: "blur(8px)" }}
              />
              <div className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-px bg-white/30 z-10" />
              {showBar && !isNear && (
                <div
                  className="absolute top-0 bottom-0"
                  style={
                    isGaining
                      ? {
                          left: "50%",
                          width: `${fillPercent}%`,
                          background: `linear-gradient(90deg, ${fillColor} 0%, ${fillColor} 80%, transparent 100%)`,
                          boxShadow: `0 0 12px ${fillColor}`,
                        }
                      : {
                          right: "50%",
                          width: `${fillPercent}%`,
                          background: `linear-gradient(270deg, ${fillColor} 0%, ${fillColor} 80%, transparent 100%)`,
                          boxShadow: `0 0 12px ${fillColor}`,
                        }
                  }
                />
              )}
            </div>

            <div
              className="rounded-md bg-ink-800/85 border border-white/10 inline-flex items-center justify-center"
              style={{
                boxShadow: "0 4px 16px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,0,0,0.4) inset",
                backdropFilter: "blur(12px)",
                padding: "6px 16px",
                minWidth: "110px",
              }}
            >
              <span
                className="text-[28px] font-bold tnum tracking-tight leading-none"
                style={{ color: valueColor, textShadow: valueGlow, opacity: showBar ? 1 : 0.45 }}
              >
                {showBar ? formatDelta(renderDelta) : "+0.00"}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
