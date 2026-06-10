import React, { useEffect, useState, useCallback } from "react";
import {
  Layers,
  Gauge,
  Eye,
  EyeOff,
  Power,
} from "lucide-react";
import { OVERLAY_META } from "../overlay-catalog.js";
import { Button } from "./ui/button.jsx";
import { Switch } from "./ui/switch.jsx";
import { Slider } from "./ui/slider.jsx";
const MemoSlider = React.memo(Slider);
import { VerticalSlider } from "./ui/vertical-slider.jsx";
import { useToast } from "./ui/toast.jsx";
import { ErrorBoundary } from "./ui/error-boundary.jsx";

// Por ahora solo el delta bar está implementado
const IMPLEMENTED = ["delta", "sectors", "tyres", "relative"];

function formatBytes(bps) {
  if (!bps || !isFinite(bps)) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (bps >= 1024 && i < units.length - 1) {
    bps /= 1024;
    i++;
  }
  return `${bps.toFixed(1)} ${units[i]}`;
}

export function Dashboard() {
  const [config, setConfig] = useState(null);
  const [selectedId, setSelectedId] = useState("delta");
  const [preview, setPreview] = useState(false);
  const [previewShowAll, setPreviewShowAll] = useState(false);
  const [scale, setScale] = useState(0.6);
  const toast = useToast();

  const load = useCallback(async () => {
    const c = await window.fly.getConfig();
    const p = await window.fly.getPreview();
    setConfig(c);
    setPreview(p);
  }, []);

  useEffect(() => {
    load();
    const unsub = window.fly.onConfigChange((c) => setConfig(c));
    return unsub;
  }, [load]);

  useEffect(() => {
    if (window.fly?.configurePreview) {
      window.fly.configurePreview({ showAll: previewShowAll, selectedId });
    }
  }, [selectedId, previewShowAll]);

  // Updater toasts
  useEffect(() => {
    if (!window.fly?.onUpdater) return;

    const unsubs = [
      window.fly.onUpdater("checking", () => {
        toast.show({
          tone: "info",
          title: "Buscando actualizaciones...",
          duration: 2000,
        });
      }),

      window.fly.onUpdater("available", (info) => {
        toast.show({
          tone: "update",
          title: `Versión ${info.version} disponible`,
          description: "Descargando en segundo plano...",
          duration: 0,
          id: "updater-download",
        });
      }),

      window.fly.onUpdater("progress", (p) => {
        toast.update("updater-download", {
          description: `Descargando... ${Math.round(p.percent)}% · ${formatBytes(p.bytesPerSecond)}/s`,
          progress: p.percent,
        });
      }),

      window.fly.onUpdater("downloaded", (info) => {
        toast.show({
          tone: "update",
          title: `Actualización ${info.version} lista`,
          description: "Reiniciá la app para aplicar la nueva versión.",
          duration: 0,
          action: {
            label: "Reiniciar ahora",
            onClick: () => window.fly.installUpdate(),
          },
        });
      }),

      window.fly.onUpdater("error", (err) => {
        toast.show({
          tone: "error",
          title: "Error al actualizar",
          description: err.message,
          duration: 6000,
        });
      }),
    ];

    return () => unsubs.forEach((u) => u && u());
  }, [toast]);

  const handleToggle = async (id) => {
    await window.fly.toggleOverlay(id);
    await load();
  };

  const handlePreviewToggle = async () => {
    const next = await window.fly.togglePreview();
    setPreview(next);
  };

  const handlePreviewShowAllToggle = async () => {
    const next = !previewShowAll;
    setPreviewShowAll(next);
    await window.fly.configurePreview({ showAll: next, selectedId });
  };

  const handleOpacity = async (id, value) => {
    await window.fly.setOverlay(id, { opacity: value / 100 });
    await load();
  };

  const handleSettingChange = async (id, key, value) => {
    const ov = config.overlays[id] || {};
    const prevSettings = ov.settings || {};
    const nextSettings = { ...prevSettings, [key]: value };
    // Update optimista local para que la UI reaccione al instante
    setConfig((c) => c ? {
      ...c,
      overlays: {
        ...c.overlays,
        [id]: { ...c.overlays[id], settings: nextSettings },
      },
    } : c);
    await window.fly.setOverlay(id, { settings: nextSettings });
  };

  const handleReset = async (id) => {
    await window.fly.setOverlay(id, { x: null, y: null, width: 600, height: 120, opacity: 0.8 });
    await load();
  };

  if (!config) {
    return (
      <div className="h-screen bg-background text-foreground flex items-center justify-center">
        <p className="text-muted-foreground text-sm">Cargando...</p>
      </div>
    );
  }

  const ov = config.overlays[selectedId] || {};
  const meta = OVERLAY_META[selectedId];

  return (
    <div className="h-screen w-screen bg-background text-foreground flex flex-col overflow-hidden">
      {/* HEADER */}
      <header className="h-12 border-b border-border bg-card/40 flex items-center px-4 gap-3 shrink-0">
        <div className="flex items-center gap-2">
          <img src="./logo.png" alt="Fly Overlays" className="h-7 w-7 rounded-md object-contain" />
          <span className="font-bold tracking-tight text-sm">FLY OVERLAYS</span>
        </div>
        <div className="flex-1" />
        <span className="text-xs text-muted-foreground">v{APP_VERSION}</span>
      </header>

      {/* MAIN */}
      <div className="flex-1 flex overflow-hidden">
        {/* SIDEBAR */}
        <aside className="w-56 border-r border-border bg-card/30 flex flex-col shrink-0">
          <div className="p-2">
            <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <Layers className="size-3.5" />
              Overlays
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-1">
            {IMPLEMENTED.map((id) => {
              const m = OVERLAY_META[id];
              const o = config.overlays[id];
              const Icon = m.icon;
              const isActive = o?.enabled;
              const isSelected = id === selectedId;
              return (
                <button
                  key={id}
                  onClick={() => setSelectedId(id)}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors mb-0.5 ${
                    isSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                  }`}
                >
                  <Icon className="size-3.5 shrink-0" />
                  <span className="text-xs flex-1 truncate">{m.name}</span>
                  {isActive && <span className="size-1.5 rounded-full bg-rose-500 shrink-0" />}
                </button>
              );
            })}
          </div>
        </aside>

        {/* CENTER: PREVIEW */}
        <main className="flex-1 flex flex-col bg-zinc-950 relative overflow-hidden">
          <div className="flex-1 relative flex items-center justify-center p-8">
            <div
              className="absolute inset-0 opacity-40"
              style={{
                backgroundImage:
                  "linear-gradient(180deg, #1e3a5f 0%, #4a6b8a 50%, #2a3f5a 100%)",
              }}
            />
            <div
              className="absolute inset-0 opacity-30"
              style={{
                backgroundImage:
                  "radial-gradient(ellipse at 30% 20%, rgba(255,200,100,0.4) 0%, transparent 50%)",
              }}
            />

            {/* Preview del centro: SIEMPRE solo el overlay seleccionado (referencia visual estática) */}
            <div
              className="relative border-2 border-dashed border-white/10 rounded-md"
              style={{
                width: (ov.width || 600) * scale,
                height: (ov.height || 120) * scale,
                opacity: ov.opacity ?? 0.8,
              }}
            >
              <div
                className="absolute inset-0 origin-top-left"
                style={{
                  transform: `scale(${scale})`,
                  width: ov.width || 600,
                  height: ov.height || 120,
                }}
              >
                {selectedId === "delta" && <DeltaBarLite />}
                {selectedId === "sectors" && (
                  <ErrorBoundary resetKey={selectedId}>
                    <SectorLite />
                  </ErrorBoundary>
                )}
                {selectedId === "tyres" && (
                  <ErrorBoundary resetKey={selectedId}>
                    <TyresLite />
                  </ErrorBoundary>
                )}
              </div>
            </div>

            <div className="absolute bottom-2 left-2 text-[10px] text-white/40 font-mono">
              {ov.width || 600} × {ov.height || 120} @ {Math.round(scale * 100)}%
            </div>

            {/* Slider vertical de zoom — fijo a la derecha, no se mueve con el overlay */}
            <div
              className="absolute right-4 top-1/2 -translate-y-1/2 z-20"
              style={{ pointerEvents: "auto" }}
            >
              <VerticalSlider
                value={Math.round(scale * 100)}
                min={25}
                max={150}
                step={5}
                onValueChange={(v) => setScale(v / 100)}
              />
            </div>
          </div>

          <div className="h-12 border-t border-border bg-card/40 flex items-center px-3 gap-2 shrink-0">
            <span className="text-xs text-muted-foreground">
              {Object.values(config.overlays).filter((o) => o.enabled).length} activo
            </span>
            <div className="flex-1" />
            <Button
              variant={previewShowAll ? "default" : "outline"}
              size="sm"
              className="h-8 gap-1.5"
              onClick={handlePreviewShowAllToggle}
              title="Cuando Preview ON: muestra todos los overlays activos. Cuando OFF: solo el seleccionado."
            >
              <Layers className="size-3.5" />
              {previewShowAll ? "Show all" : "Show selected"}
            </Button>
            <Button
              variant={preview ? "default" : "outline"}
              size="sm"
              className="h-8 gap-1.5"
              onClick={handlePreviewToggle}
            >
              {preview ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
              {preview ? "Preview ON" : "Preview OFF"}
            </Button>
          </div>
        </main>

        {/* PROPERTIES */}
        <aside className="w-72 border-l border-border bg-card/30 flex flex-col shrink-0">
          <div className="p-4 border-b border-border">
            <h2 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
              {meta.name}
            </h2>
            <p className="text-[11px] text-muted-foreground mt-1">{meta.description}</p>
          </div>

          <div className="p-4 space-y-4 overflow-y-auto flex-1">
            <div className="flex items-center justify-between">
              <span className="text-xs">Activo</span>
              <Switch
                checked={!!ov.enabled}
                onCheckedChange={() => handleToggle(selectedId)}
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs">Opacidad</span>
                <span className="text-xs font-mono">
                  {Math.round((ov.opacity ?? 1) * 100)}%
                </span>
              </div>
              <Slider
                value={[Math.round((ov.opacity ?? 1) * 100)]}
                min={30}
                max={100}
                step={5}
                onValueChange={(v) => handleOpacity(selectedId, v[0])}
              />
            </div>

            <div className="pt-2 border-t border-border space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>Posición</span>
                <span className="font-mono">
                  {ov.x != null && ov.y != null ? `${ov.x}, ${ov.y}` : "Auto"}
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>Tamaño</span>
                <span className="font-mono">
                  {ov.width}×{ov.height}
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="w-full h-7 text-xs gap-1.5"
                onClick={() => handleReset(selectedId)}
              >
                <Power className="size-3" />
                Reset posición
              </Button>
            </div>

            {/* APPEARANCE SETTINGS */}
            <AppearanceSettings
              overlayId={selectedId}
              overlayKey={selectedId}
              settings={ov.settings || {}}
              onChange={handleSettingChange}
            />
          </div>
        </aside>
      </div>
    </div>
  );
}

// Versión "lite" del DeltaBar para el preview del dashboard.
// No usa window.fly ni onLockState — solo muestra el estado de la prop.
function DeltaBarLite() {
  const [telemetry, setTelemetry] = useState({
    connected: false,
    delta: 0,
    onTrack: false,
    preview: false,
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.fly) return;
    if (typeof window.fly.onTelemetry !== "function") return;
    const unsub = window.fly.onTelemetry((data) => {
      setTelemetry((prev) => ({ ...prev, ...data }));
    });
    return unsub;
  }, []);

  const targetRef = useRefSafe(0);
  const displayRef = useRefSafe(0);
  const [renderDelta, setRenderDelta] = useState(0);
  const rafRef = React.useRef(null);

  useEffect(() => {
    targetRef.current = telemetry.delta || 0;
  }, [telemetry.delta]);

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
  const showBar = telemetry.preview || (telemetry.onTrack && telemetry.connected);

  const fillColor = isNear
    ? "rgba(255,255,255,0.25)"
    : isGaining
      ? "rgba(52,211,153,0.95)"
      : "rgba(220, 38, 38, 0.95)";

  const valueColor = isNear
    ? "#e8eef8"
    : isGaining
      ? "#34d399"
      : "#f87171";

  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-3 p-2">
      <div className="relative w-[92%] h-3 rounded-sm overflow-hidden">
        <div
          className="absolute inset-0 rounded-sm border border-white/10"
          style={{ background: "rgba(255,255,255,0.06)" }}
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
                  }
                : {
                    right: "50%",
                    width: `${fillPercent}%`,
                    background: `linear-gradient(270deg, ${fillColor} 0%, ${fillColor} 80%, transparent 100%)`,
                  }
            }
          />
        )}
      </div>
      <div
        className="rounded-md border border-white/10 inline-flex items-center justify-center"
        style={{
          background: "rgba(11,14,20,0.85)",
          padding: "6px 16px",
          minWidth: "110px",
        }}
      >
        <span
          className="text-[28px] font-bold tnum tracking-tight leading-none"
          style={{ color: valueColor, opacity: showBar ? 1 : 0.45 }}
        >
          {showBar
            ? `${renderDelta >= 0 ? "+" : "−"}${Math.abs(renderDelta).toFixed(2)}`
            : "+0.00"}
        </span>
      </div>
    </div>
  );
}

function useRefSafe(v) {
  return React.useRef(v);
}

const SECTOR_TONE_LITE = {
  empty: "rgba(255,255,255,0.06)",
  gray: "rgba(120, 130, 145, 0.85)",
  green: "rgba(34, 197, 94, 0.95)",
  purple: "rgba(168, 85, 247, 0.95)",
};

const SECTOR_GLOW_LITE = {
  empty: "none",
  gray: "0 0 8px rgba(120,130,145,0.4)",
  green: "0 0 10px rgba(34,197,94,0.7)",
  purple: "0 0 10px rgba(168,85,247,0.7)",
};

function getMicroToneLite(cur, last, best) {
  if (cur == null) return "empty";
  if (best != null && cur <= best) return "purple";
  if (last != null && cur < last) return "green";
  return "gray";
}

function formatLapTimeLite(seconds) {
  if (seconds == null || !isFinite(seconds) || seconds <= 0) return "——.———";
  const m = Math.floor(seconds / 60);
  const s = (seconds - m * 60).toFixed(3);
  return `${m}:${s.padStart(6, "0")}`;
}

function sumArray(arr) {
  return (arr || []).reduce((acc, v) => acc + (v != null && isFinite(v) ? v : 0), 0);
}

function SectorLite() {
  const [sectors, setSectors] = useState({
    current: new Array(24).fill(null),
    last: new Array(24).fill(null),
    best: new Array(24).fill(null),
  });
  const [lapTimes, setLapTimes] = useState({
    currentLap: 0,
    bestLap: 0,
    lastLap: 0,
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.fly) return;
    if (typeof window.fly.onTelemetry !== "function") return;
    const unsub = window.fly.onTelemetry((data) => {
      if (data.sectors) {
        setSectors({
          current: Array.isArray(data.sectors.current) ? data.sectors.current : new Array(24).fill(null),
          last: Array.isArray(data.sectors.last) ? data.sectors.last : new Array(24).fill(null),
          best: Array.isArray(data.sectors.best) ? data.sectors.best : new Array(24).fill(null),
        });
      }
      if (data.lapTimes) {
        setLapTimes(data.lapTimes);
      }
    });
    return unsub;
  }, []);

  // Tiempos oficiales de iRacing (no suma de micro-sectores)
  const curLap = lapTimes.currentLap;
  const bestLap = lapTimes.bestLap;
  const lastLap = lapTimes.lastLap;

  return (
    <div
      className="w-full h-full rounded-2xl overflow-hidden relative"
      style={{
        background: "linear-gradient(180deg, rgba(20,24,32,0.85) 0%, rgba(10,13,18,0.92) 100%)",
        border: "1px solid rgba(255,255,255,0.08)",
        boxShadow: "0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,0,0,0.4) inset",
        backdropFilter: "blur(16px)",
      }}
    >
      {/* Header con tiempos */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 p-3 pb-2">
        <TimeLite label="Current" time={curLap} className="text-white" />
        <TimeLite label="Best" time={bestLap} className="text-pos" />
        <TimeLite label="Last" time={lastLap} className="text-white/80" />
        <TimeLite label="Record" time={sectors.best?.some((v) => v != null) ? bestLap : null} className="text-purple-300" />
      </div>

      <div className="mx-3 h-px" style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.12), transparent)" }} />

      {/* Body: 3 sectores en una línea, cada uno con 8 sub */}
      <div className="p-3 pt-2 flex gap-3">
        {[0, 1, 2].map((sectorIdx) => {
          const offset = sectorIdx * 8;
          return (
            <div key={sectorIdx} className="flex-1 flex flex-col gap-1.5">
              <div className="text-[11px] font-bold text-white/50 text-center">S{sectorIdx + 1}</div>
              <div className="flex gap-0.5">
                {new Array(8).fill(0).map((_, i) => {
                  const cur = sectors.current?.[offset + i] ?? null;
                  const last = sectors.last?.[offset + i] ?? null;
                  const best = sectors.best?.[offset + i] ?? null;
                  const tone = getMicroToneLite(cur, last, best);
                  return (
                    <div
                      key={i}
                      className="flex-1 h-7 rounded-sm transition-all duration-150"
                      style={{
                        background: SECTOR_TONE_LITE[tone],
                        boxShadow: SECTOR_GLOW_LITE[tone],
                        minWidth: 0,
                      }}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TimeLite({ label, time, className }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[10px] font-bold uppercase tracking-widest text-white/40 w-16">{label}</span>
      <span className={`text-[15px] font-mono tnum font-semibold ${className}`}>
        {time != null && time > 0 ? formatLapTimeLite(time) : "——.———"}
      </span>
    </div>
  );
}

// === TYRES Lite (preview para el dashboard) ===
function TyresLite() {
  const [telemetry, setTelemetry] = useState({ connected: false, onTrack: false, preview: false, tyres: null });

  useEffect(() => {
    if (typeof window === "undefined" || !window.fly) return;
    if (typeof window.fly.onTelemetry !== "function") return;
    const unsub = window.fly.onTelemetry((data) => {
      setTelemetry((prev) => ({ ...prev, ...data }));
    });
    return unsub;
  }, []);

  const tone = (c) => {
    if (c == null) return { rgb: "120, 130, 145" };
    if (c < 50) return { rgb: "59, 130, 246" };
    if (c < 70) return { rgb: "34, 197, 94" };
    if (c < 95) return { rgb: "234, 179, 8" };
    if (c < 115) return { rgb: "249, 115, 22" };
    return { rgb: "239, 68, 68" };
  };

  const tyres = telemetry.tyres || {
    LF: { tempL: 70, tempM: 75, tempR: 72, press: 160 },
    RF: { tempL: 72, tempM: 77, tempR: 74, press: 162 },
    LR: { tempL: 80, tempM: 85, tempR: 82, press: 170 },
    RR: { tempL: 82, tempM: 87, tempR: 84, press: 172 },
  };

  return (
    <div className="w-full h-full grid grid-cols-2 gap-2 p-3">
      {["LF", "RF", "LR", "RR"].map((id) => {
        const t = tyres[id] || {};
        const tL = tone(t.tempL);
        const tM = tone(t.tempM);
        const tR = tone(t.tempR);
        return (
          <div
            key={id}
            className="rounded-lg border border-white/10 flex flex-col overflow-hidden p-2"
            style={{ background: "linear-gradient(180deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.01) 100%)" }}
          >
            <div className="flex items-center justify-between text-[8px] font-mono font-bold mb-1">
              <span className="uppercase tracking-widest text-white/40">{id}</span>
              {t.press != null && (
                <span
                  style={{
                    color: t.press < 155 ? "rgba(59,130,246,1)"
                          : t.press > 175 ? "rgba(239,68,68,1)"
                          : "rgba(34,197,94,1)",
                  }}
                >
                  {Math.round(t.press)}
                </span>
              )}
            </div>
            <div className="flex-1 flex items-stretch justify-center" style={{ gap: "2px" }}>
              {[
                { l: "I", c: t.tempL, rgb: tL.rgb, w: 12 },
                { l: "C", c: t.tempM, rgb: tM.rgb, w: 16, primary: true },
                { l: "O", c: t.tempR, rgb: tR.rgb, w: 12 },
              ].map((b, i) => (
                <div key={i} className="flex flex-col items-center">
                  <div className="text-[7px] font-bold font-mono mb-0.5 text-white/40">{b.l}</div>
                  <div
                    className="flex-1 rounded-sm relative overflow-hidden flex items-center justify-center"
                    style={{
                      width: `${b.w}px`,
                      background: `linear-gradient(180deg, rgba(${b.rgb}, 1) 0%, rgba(${b.rgb}, 0.7) 100%)`,
                      boxShadow: `0 0 4px rgba(${b.rgb}, 0.5)`,
                      border: `1px solid rgba(${b.rgb}, 0.9)`,
                    }}
                  >
                    <span
                      className="font-mono font-bold leading-none"
                      style={{
                        fontSize: b.primary ? "11px" : "9px",
                        color: "white",
                        textShadow: "0 1px 2px rgba(0,0,0,0.95)",
                        lineHeight: 1,
                      }}
                    >
                      {b.c != null ? Math.round(b.c) : "—"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// === APPEARANCE SETTINGS (per overlay) ===

const SettingField = ({ label, suffix, children }) => (
  <div className="space-y-1">
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="text-[10px] font-mono text-muted-foreground">{suffix}</span>
    </div>
    {children}
  </div>
);

// Diccionario de labels legibles para los settings de cada overlay.
// Si la key no está, se muestra la key original (camelCase).
const SETTING_LABELS = {
  delta: {
    showBar: "Mostrar barra",
    showNumber: "Mostrar número",
    barHeight: "Alto de la barra",
    barWidthPercent: "Ancho de la barra",
    valueFontSize: "Tamaño del número",
    valueMinWidth: "Ancho mínimo del número",
    valuePaddingX: "Padding horizontal del número",
    valuePaddingY: "Padding vertical del número",
    gap: "Espacio entre barra y número",
  },
  sectors: {
    showHeader: "Mostrar header",
    showSubBars: "Mostrar sub-sectores",
    headerFontSize: "Tamaño del header",
    valueFontSize: "Tamaño de los tiempos",
    timeColumnWidth: "Ancho columna label",
    subBarHeight: "Alto de sub-barra",
  },
  tyres: {
    showNumbers: "Mostrar números",
    showPressure: "Mostrar presión",
    showWear: "Mostrar desgaste",
    compactMode: "Modo compacto (solo colores)",
    tempFontSize: "Tamaño números temperatura",
    pressFontSize: "Tamaño número de presión",
    wearFontSize: "Tamaño % desgaste",
    headerFontSize: "Tamaño del header",
    bandWidth: "Ancho banda lateral",
    primaryBandWidth: "Ancho banda central",
    bandGap: "Separación entre bandas",
    cellSize: "Tamaño de celda",
    cellMaxWidth: "Ancho máximo de celda",
    gap: "Espacio entre celdas",
    borderRadius: "Radio de las celdas",
    pressureUnit: "Unidad de presión",
  },
  relative: {
    showLicense: "Mostrar licencia",
    showIRating: "Mostrar iRating",
    showCarNumber: "Mostrar número de auto",
    maxRows: "Máximo de pilotos",
    rowHeight: "Alto de fila",
    fontSize: "Tamaño de fuente",
    borderRadius: "Radio del contenedor",
  },
};

function labelFor(overlayKey, k) {
  return SETTING_LABELS[overlayKey]?.[k] || k;
}

// NumSliderField es un componente independiente (definido fuera de AppearanceSettings)
// y memorizado con React.memo, así no se re-renderiza cuando cambia otro setting.
// Solo se resyncea con el `value` externo cuando cambia el `initKey` (overlayId+k)
// o cuando `value` cambia por algo externo a este control.
const NumSliderField = React.memo(function NumSliderField({ overlayId, overlayKey, k, min, max, step, unit, value, onChange }) {
  const initial = value != null ? value : min;
  const [local, setLocal] = useState(initial);
  const lastInitKey = React.useRef(`${overlayId}::${k}`);
  const lastValueRef = React.useRef(value);
  const initKey = `${overlayId}::${k}`;
  if (lastInitKey.current !== initKey) {
    lastInitKey.current = initKey;
    setLocal(initial);
    lastValueRef.current = value;
  } else if (value !== lastValueRef.current) {
    lastValueRef.current = value;
    setLocal(initial);
  }
  return (
    <SettingField label={labelFor(overlayKey, k)} suffix={`${local}${unit || ""}`}>
      <MemoSlider
        value={[local]}
        min={min}
        max={max}
        step={step || 1}
        onValueChange={(arr) => {
          setLocal(arr[0]);
          onChange(overlayId, k, arr[0]);
        }}
      />
    </SettingField>
  );
});

const ToggleField = React.memo(function ToggleField({ overlayId, overlayKey, k, label, value, onChange }) {
  const initial = value !== false;
  const [local, setLocal] = useState(initial);
  const lastInitKey = React.useRef(`${overlayId}::${k}`);
  const lastValueRef = React.useRef(value);
  const initKey = `${overlayId}::${k}`;
  if (lastInitKey.current !== initKey) {
    lastInitKey.current = initKey;
    setLocal(initial);
    lastValueRef.current = value;
  } else if (value !== lastValueRef.current) {
    lastValueRef.current = value;
    setLocal(initial);
  }
  return (
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-muted-foreground">{label || labelFor(overlayKey, k)}</span>
      <Switch
        checked={local}
        onCheckedChange={(val) => {
          setLocal(val);
          onChange(overlayId, k, val);
        }}
      />
    </div>
  );
});

function AppearanceSettings({ overlayId, overlayKey, settings = {}, onChange }) {
  const isDelta = overlayKey === "delta";
  const isSectors = overlayKey === "sectors";
  const isTyres = overlayKey === "tyres";
  const isRelative = overlayKey === "relative";
  if (!isDelta && !isSectors && !isTyres && !isRelative) return null;

  return (
    <div className="pt-2 border-t border-border space-y-3">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-bold">
        Apariencia
      </div>

      {isDelta && (
        <>
          <ToggleField overlayId={overlayId} overlayKey={overlayKey} k="showBar" value={settings.showBar} onChange={onChange} />
          <ToggleField overlayId={overlayId} overlayKey={overlayKey} k="showNumber" value={settings.showNumber} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="barHeight" min={4} max={32} step={1} unit="px" value={settings.barHeight} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="barWidthPercent" min={50} max={100} step={1} unit="%" value={settings.barWidthPercent} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="valueFontSize" min={14} max={56} step={1} unit="px" value={settings.valueFontSize} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="valueMinWidth" min={60} max={200} step={2} unit="px" value={settings.valueMinWidth} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="valuePaddingX" min={4} max={32} step={1} unit="px" value={settings.valuePaddingX} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="valuePaddingY" min={2} max={20} step={1} unit="px" value={settings.valuePaddingY} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="gap" min={0} max={32} step={1} unit="px" value={settings.gap} onChange={onChange} />
        </>
      )}

      {isSectors && (
        <>
          <ToggleField overlayId={overlayId} overlayKey={overlayKey} k="showHeader" value={settings.showHeader} onChange={onChange} />
          <ToggleField overlayId={overlayId} overlayKey={overlayKey} k="showSubBars" value={settings.showSubBars} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="headerFontSize" min={8} max={18} step={1} unit="px" value={settings.headerFontSize} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="valueFontSize" min={10} max={28} step={1} unit="px" value={settings.valueFontSize} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="timeColumnWidth" min={32} max={120} step={2} unit="px" value={settings.timeColumnWidth} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="subBarHeight" min={12} max={64} step={1} unit="px" value={settings.subBarHeight} onChange={onChange} />
        </>
      )}

      {isTyres && (
        <>
          <ToggleField overlayId={overlayId} overlayKey={overlayKey} k="showNumbers" value={settings.showNumbers} onChange={onChange} />
          <ToggleField overlayId={overlayId} overlayKey={overlayKey} k="showPressure" value={settings.showPressure} onChange={onChange} />
          <ToggleField overlayId={overlayId} overlayKey={overlayKey} k="showWear" value={settings.showWear} onChange={onChange} />
          <ToggleField overlayId={overlayId} overlayKey={overlayKey} k="compactMode" value={settings.compactMode} onChange={onChange} />
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">Unidad de presión</span>
            <div className="flex border border-border rounded-md overflow-hidden">
              {["kPa", "psi"].map((u) => (
                <button
                  key={u}
                  type="button"
                  className="px-2.5 py-1 text-[10px] font-mono font-bold transition-colors hover:bg-white/5"
                  style={{
                    background: (settings.pressureUnit || "kPa") === u ? "rgba(125, 211, 252, 0.15)" : "transparent",
                    color: (settings.pressureUnit || "kPa") === u ? "rgb(125, 211, 252)" : "rgba(255,255,255,0.5)",
                    borderRight: u === "kPa" ? "1px solid rgba(255,255,255,0.08)" : "none",
                    cursor: "pointer",
                  }}
                  onClick={() => onChange(overlayId, "pressureUnit", u)}
                >
                  {u}
                </button>
              ))}
            </div>
          </div>
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="tempFontSize" min={10} max={32} step={1} unit="px" value={settings.tempFontSize} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="pressFontSize" min={8} max={20} step={1} unit="px" value={settings.pressFontSize} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="wearFontSize" min={7} max={16} step={1} unit="px" value={settings.wearFontSize} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="headerFontSize" min={8} max={18} step={1} unit="px" value={settings.headerFontSize} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="bandWidth" min={6} max={24} step={1} unit="px" value={settings.bandWidth} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="primaryBandWidth" min={8} max={32} step={1} unit="px" value={settings.primaryBandWidth} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="bandGap" min={0} max={16} step={1} unit="px" value={settings.bandGap} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="cellSize" min={80} max={200} step={5} unit="px" value={settings.cellSize} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="cellMaxWidth" min={100} max={300} step={10} unit="px" value={settings.cellMaxWidth} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="gap" min={0} max={24} step={1} unit="px" value={settings.gap} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="borderRadius" min={0} max={24} step={1} unit="px" value={settings.borderRadius} onChange={onChange} />
        </>
      )}

      {isRelative && (
        <>
          <ToggleField overlayId={overlayId} overlayKey={overlayKey} k="showLicense" value={settings.showLicense} onChange={onChange} />
          <ToggleField overlayId={overlayId} overlayKey={overlayKey} k="showIRating" value={settings.showIRating} onChange={onChange} />
          <ToggleField overlayId={overlayId} overlayKey={overlayKey} k="showCarNumber" value={settings.showCarNumber} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="maxRows" min={4} max={30} step={1} unit="" value={settings.maxRows} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="rowHeight" min={20} max={48} step={2} unit="px" value={settings.rowHeight} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="fontSize" min={9} max={18} step={1} unit="px" value={settings.fontSize} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="borderRadius" min={0} max={20} step={1} unit="px" value={settings.borderRadius} onChange={onChange} />
        </>
      )}
    </div>
  );
}
