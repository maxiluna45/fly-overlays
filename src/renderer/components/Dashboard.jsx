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

// Por ahora solo el delta bar está implementado
const IMPLEMENTED = ["delta"];

export function Dashboard() {
  const [config, setConfig] = useState(null);
  const [selectedId, setSelectedId] = useState("delta");
  const [preview, setPreview] = useState(false);
  const [scale, setScale] = useState(0.6);

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

  const handleToggle = async (id) => {
    await window.fly.toggleOverlay(id);
    await load();
  };

  const handlePreviewToggle = async () => {
    const next = await window.fly.togglePreview();
    setPreview(next);
  };

  const handleOpacity = async (id, value) => {
    await window.fly.setOverlay(id, { opacity: value / 100 });
    await load();
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
                <DeltaBarLite />
              </div>
            </div>

            <div className="absolute bottom-2 left-2 text-[10px] text-white/40 font-mono">
              {ov.width || 600} × {ov.height || 120} @ {Math.round(scale * 100)}%
            </div>
          </div>

          <div className="h-12 border-t border-border bg-card/40 flex items-center px-3 gap-2 shrink-0">
            <span className="text-xs text-muted-foreground">
              {Object.values(config.overlays).filter((o) => o.enabled).length} activo
            </span>
            <div className="flex-1" />
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
      : "rgba(248,113,113,0.95)";

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
