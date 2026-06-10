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
import { VerticalSlider } from "./ui/vertical-slider.jsx";
import { useToast } from "./ui/toast.jsx";
import { ErrorBoundary } from "./ui/error-boundary.jsx";

// Por ahora solo el delta bar está implementado
const IMPLEMENTED = ["delta", "sectors"];

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
    await window.fly.setOverlay(id, {
      settings: { ...prevSettings, [key]: value },
    });
    setConfig((c) => c ? {
      ...c,
      overlays: {
        ...c.overlays,
        [id]: { ...c.overlays[id], settings: { ...prevSettings, [key]: value } },
      },
    } : c);
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
          <Gauge className="size-4 text-primary" />
          <span className="font-bold tracking-tight text-sm">FLY OVERLAYS</span>
        </div>
        <div className="flex-1" />
        <span className="text-xs text-muted-foreground">v0.1.0</span>
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
              overlayType={meta?.entry}
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

// === APPEARANCE SETTINGS (per overlay) ===
function AppearanceSettings({ overlayId, overlayType, settings = {}, onChange }) {
  const isDelta = overlayType === "delta.html";
  const isSectors = overlayType === "sectors.html";
  if (!isDelta && !isSectors) return null;

  const Field = ({ label, suffix, children }) => (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">{label}</span>
        <span className="text-[10px] font-mono text-muted-foreground">{suffix}</span>
      </div>
      {children}
    </div>
  );

  const NumSlider = ({ k, min, max, step = 1, unit = "" }) => {
    const v = settings[k];
    const display = v != null ? v : "—";
    return (
      <Field label={k} suffix={`${display}${unit}`}>
        <Slider
          value={[v != null ? v : min]}
          min={min}
          max={max}
          step={step}
          onValueChange={(arr) => onChange(overlayId, k, arr[0])}
        />
      </Field>
    );
  };

  const Toggle = ({ k, label }) => {
    const v = settings[k];
    return (
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">{label}</span>
        <Switch
          checked={v !== false}
          onCheckedChange={(val) => onChange(overlayId, k, val)}
        />
      </div>
    );
  };

  return (
    <div className="pt-2 border-t border-border space-y-3">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-bold">
        Apariencia
      </div>

      {isDelta && (
        <>
          <Toggle k="showBar" label="Mostrar barra" />
          <Toggle k="showNumber" label="Mostrar número" />
          <NumSlider k="barHeight" min={4} max={32} step={1} unit="px" />
          <NumSlider k="barWidthPercent" min={50} max={100} step={1} unit="%" />
          <NumSlider k="valueFontSize" min={14} max={56} step={1} unit="px" />
          <NumSlider k="valueMinWidth" min={60} max={200} step={2} unit="px" />
          <NumSlider k="valuePaddingX" min={4} max={32} step={1} unit="px" />
          <NumSlider k="valuePaddingY" min={2} max={20} step={1} unit="px" />
          <NumSlider k="gap" min={0} max={32} step={1} unit="px" />
        </>
      )}

      {isSectors && (
        <>
          <Toggle k="showHeader" label="Mostrar header" />
          <Toggle k="showSubBars" label="Mostrar sub-sectores" />
          <NumSlider k="headerFontSize" min={8} max={18} step={1} unit="px" />
          <NumSlider k="valueFontSize" min={10} max={28} step={1} unit="px" />
          <NumSlider k="timeColumnWidth" min={32} max={120} step={2} unit="px" />
          <NumSlider k="subBarHeight" min={12} max={64} step={1} unit="px" />
        </>
      )}
    </div>
  );
}
