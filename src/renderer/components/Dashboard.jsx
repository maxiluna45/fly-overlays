import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  Layers,
  Gauge,
  Eye,
  EyeOff,
  Power,
  X,
  Plus,
  Pencil,
  Check,
} from "lucide-react";
import { OVERLAY_META } from "../overlay-catalog.js";
import { Relative } from "./Relative.jsx";
import { Standings } from "./Standings.jsx";
import { Radar } from "./Radar.jsx";
import { AnalysisView } from "./AnalysisView.jsx";
import { ProgressView } from "./ProgressView.jsx";
import { HotkeysView } from "./HotkeysView.jsx";
import { DeltaBar } from "./DeltaBar.jsx";
import { SectorTimes } from "./SectorTimes.jsx";
import { Button } from "./ui/button.jsx";
import { Switch } from "./ui/switch.jsx";
import { Slider } from "./ui/slider.jsx";
const MemoSlider = React.memo(Slider);
import { VerticalSlider } from "./ui/vertical-slider.jsx";
import { useToast } from "./ui/toast.jsx";
import { ErrorBoundary } from "./ui/error-boundary.jsx";

const IMPLEMENTED = ["delta", "sectors", "relative", "standings", "radar"];

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
  const [view, setView] = useState("overlays"); // 'overlays' | 'analysis'
  const [preview, setPreview] = useState(false);
  const [previewShowAll, setPreviewShowAll] = useState(false);
  const [scale, setScale] = useState(0.6);
  const [recordingEnabled, setRecordingEnabled] = useState(true);
  const toast = useToast();

  const load = useCallback(async () => {
    const c = await window.fly.getConfig();
    const p = await window.fly.getPreview();
    setConfig(c);
    setPreview(p);
    if (window.fly?.getRecordingEnabled) setRecordingEnabled(await window.fly.getRecordingEnabled());
  }, []);

  const handleRecordingToggle = async () => {
    if (!window.fly?.setRecordingEnabled) return;
    const next = await window.fly.setRecordingEnabled(!recordingEnabled);
    setRecordingEnabled(next);
  };

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
        // Sacar el toast de "Descargando..." (tiene duration:0, no se auto-cierra)
        // antes de mostrar el de "listo para reiniciar".
        toast.dismiss("updater-download");
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

  // Botón del volante → ciclar la referencia del DeltaBar. El polling vive acá
  // porque el dashboard existe durante toda la app (cerrarlo cierra todo) y su
  // ventana tiene backgroundThrottling off, así sigue leyendo el gamepad aun
  // oculto con F8. Edge-detect: dispara solo en la transición a presionado.
  const cycleBtnRef = useRef(null);
  useEffect(() => {
    cycleBtnRef.current = config?.overlays?.delta?.settings?.cycleButton || null;
  }, [config]);
  useEffect(() => {
    let prevPressed = false;
    const iv = setInterval(() => {
      const bind = cycleBtnRef.current;
      if (!bind || typeof bind.btn !== "number") return;
      let pressed = false;
      try {
        const pads = navigator.getGamepads ? navigator.getGamepads() : [];
        for (const p of pads) {
          if (!p || p.id !== bind.pad) continue;
          pressed = !!(p.buttons[bind.btn] && p.buttons[bind.btn].pressed);
          break;
        }
      } catch (_) {}
      if (pressed && !prevPressed && window.fly?.cycleDeltaRef) window.fly.cycleDeltaRef();
      prevPressed = pressed;
    }, 60);
    return () => clearInterval(iv);
  }, []);

  const handleSessionToggle = async (id, key) => {
    const ov = config.overlays[id] || {};
    const prev = { race: true, qualify: true, practice: true, ...(ov.sessions || {}) };
    const next = { ...prev, [key]: !prev[key] };
    // Update optimista local para que los chips reaccionen al instante
    setConfig((c) => c ? {
      ...c,
      overlays: {
        ...c.overlays,
        [id]: { ...c.overlays[id], sessions: next },
      },
    } : c);
    await window.fly.setOverlay(id, { sessions: next });
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
          <img src="./logo.png" alt="iFly" className="h-7 w-7 rounded-md object-contain" />
          <span className="font-bold tracking-tight text-sm">iFly</span>
        </div>
        <div className="flex items-center gap-1 ml-3">
          {[["overlays", "Overlays"], ["analysis", "Análisis"], ["progreso", "Progreso"], ["hotkeys", "Hotkeys"]].map(([v, label]) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors ${
                view === v ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <span className="text-xs text-muted-foreground">v{APP_VERSION}</span>
      </header>

      {view === "analysis" ? (
        <AnalysisView />
      ) : view === "progreso" ? (
        <ProgressView />
      ) : view === "hotkeys" ? (
        <HotkeysView />
      ) : (
      /* MAIN */
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
                  <span
                    className="px-1.5 py-px rounded text-[8px] font-bold tracking-wider shrink-0"
                    style={isActive
                      ? { background: "rgba(52,211,153,0.15)", color: "rgb(52,211,153)", border: "1px solid rgba(52,211,153,0.4)" }
                      : { background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.35)", border: "1px solid rgba(255,255,255,0.1)" }}
                  >
                    {isActive ? "ON" : "OFF"}
                  </span>
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
                {["delta", "sectors", "relative", "standings", "radar"].includes(selectedId) && (
                  <ErrorBoundary resetKey={selectedId}>
                    <OverlayPreview id={selectedId} settings={ov.settings} />
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
            <span className="text-xs text-muted-foreground shrink-0">
              {(() => {
                const n = Object.values(config.overlays).filter((o) => o.enabled).length;
                return `${n} activo${n === 1 ? "" : "s"}`;
              })()}
            </span>
            <div className="flex-1" />
            <Button
              variant={recordingEnabled ? "default" : "outline"}
              size="sm"
              className="h-8 gap-1.5"
              onClick={handleRecordingToggle}
              title={recordingEnabled
                ? "iFly graba cada vuelta automáticamente. Apagalo si ya logueás la telemetría desde iRacing (para no duplicar sesiones)."
                : "Grabación en vivo APAGADA. iFly no va a grabar sesiones."}
            >
              <span
                className="size-2.5 rounded-full"
                style={{ background: recordingEnabled ? "rgb(239,68,68)" : "rgba(255,255,255,0.3)" }}
              />
              {recordingEnabled ? "Grabando" : "Grabación off"}
            </Button>
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
            {/* Switch principal: destacado con fondo/borde según estado, porque
                es EL control del overlay y a mucha gente le pasaba de largo. */}
            <div
              className="flex items-center justify-between rounded-lg px-3 py-2.5 transition-colors"
              style={ov.enabled
                ? { background: "rgba(52,211,153,0.10)", border: "1px solid rgba(52,211,153,0.45)" }
                : { background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.15)" }}
            >
              <div className="flex items-center gap-2">
                <span
                  className="size-2 rounded-full shrink-0"
                  style={{ background: ov.enabled ? "rgb(52,211,153)" : "rgba(255,255,255,0.25)" }}
                />
                <span
                  className="text-xs font-bold tracking-wide"
                  style={{ color: ov.enabled ? "rgb(52,211,153)" : "rgba(255,255,255,0.6)" }}
                >
                  {ov.enabled ? "Overlay activo" : "Overlay desactivado"}
                </span>
              </div>
              <Switch
                checked={!!ov.enabled}
                onCheckedChange={() => handleToggle(selectedId)}
              />
            </div>

            {/* Visibilidad por tipo de sesión: en qué sesiones se muestra el
                overlay cuando está activo. En edit (F7) y preview (F9) se
                muestra siempre, para poder posicionarlo. */}
            <div className="space-y-1.5">
              <span className="text-xs">Mostrar en</span>
              <div className={`flex gap-1.5 ${!ov.enabled ? "opacity-40 pointer-events-none" : ""}`}>
                {[["race", "Race"], ["qualify", "Qualy"], ["practice", "Práctica"]].map(([key, label]) => {
                  const on = ov.sessions?.[key] !== false;
                  return (
                    <button
                      key={key}
                      onClick={() => handleSessionToggle(selectedId, key)}
                      title={on ? `Se muestra en ${label}` : `Oculto en ${label}`}
                      className={`flex-1 px-2 py-1 rounded-md text-[11px] font-semibold border transition-colors ${
                        on
                          ? "bg-accent text-accent-foreground border-transparent"
                          : "bg-transparent text-muted-foreground border-border hover:bg-accent/30"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
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

            {/* DRIVER TAGS (Relative / Standings) */}
            {(selectedId === "relative" || selectedId === "standings") && <DriverTagsManager />}
          </div>
        </aside>
      </div>
      )}
    </div>
  );
}

// Simulación EN MOVIMIENTO para los previews (cuando no hay sesión en vivo).
// Anima el relative (gaps que respiran, autos que se acercan/alejan), los
// sectores (la vuelta que se va llenando) y el delta, para que el preview se vea
// como una carrera en curso — usando los COMPONENTES REALES.
function simRelative(t) {
  const base = enrichRelativeMock();
  const drivers = base.drivers.map((d, i) => {
    if (d.isPlayer) return { ...d, relDelta: 0, relMeters: 0, gapToPlayer: 0 };
    const rd = (d.relDelta || 0) + Math.sin(t * 0.5 + i * 0.9) * 1.4;
    return { ...d, relDelta: rd, relMeters: rd * 8, gapToPlayer: Math.abs(rd), isAhead: rd > 0 };
  });
  return { ...base, trackLength: 5000, drivers };
}
function simSectors(t) {
  const prog = Math.floor((t * 3) % 26); // barre la vuelta: 0..25
  const mk = (fn) => Array.from({ length: 24 }, (_, i) => fn(i));
  return {
    sectors: {
      best: mk(() => 1.0),
      last: mk(() => 1.05),
      current: mk((i) => (i <= prog ? (i % 3 === 0 ? 0.98 : i % 3 === 1 ? 1.02 : 1.09) : null)),
    },
    lapTimes: { currentLap: Math.min(prog + 1, 24) * 3.8, bestLap: 91.8, lastLap: 92.5, lastLapInvalid: false },
  };
}
function simFrame(id, t) {
  const base = { connected: true, onTrack: true, preview: true };
  if (id === "delta") return { ...base, delta: Math.sin(t * 0.7) * 0.5 - 0.05, deltaRate: Math.cos(t * 0.7) * 0.2, refLapTime: 92.3, deltaRefs: {} };
  if (id === "sectors") return { ...base, ...simSectors(t) };
  if (id === "radar") return { ...base, carLeftRight: [1, 2, 3, 4][Math.floor(t / 1.5) % 4], relative: simRelative(t) };
  return { ...base, relative: simRelative(t) }; // relative / standings
}

// Preview UNIFICADO: renderiza el COMPONENTE REAL del overlay con sus settings
// reales. Prefiere la sesión en vivo si está conectada; si no, corre una
// SIMULACIÓN EN MOVIMIENTO. Así es idéntico al overlay real y nunca queda vacío.
function OverlayPreview({ id, settings }) {
  const [telemetry, setTelemetry] = useState(() => simFrame(id, 0));
  const needsHeavy = id === "relative" || id === "standings" || id === "radar" || id === "sectors";
  const liveRef = React.useRef({ connected: false, onTrack: false });

  useEffect(() => {
    if (typeof window === "undefined" || !window.fly?.onTelemetry) return;
    return window.fly.onTelemetry((data) => { liveRef.current = { ...liveRef.current, ...data }; });
  }, []);
  useEffect(() => {
    if (!needsHeavy || typeof window === "undefined" || !window.fly?.onTelemetryHeavy) return;
    return window.fly.onTelemetryHeavy((data) => { liveRef.current = { ...liveRef.current, ...data }; });
  }, [needsHeavy]);

  // Reloj de la simulación (~12 fps). Preferimos la sesión REAL en vivo si está
  // conectada y en pista; si no, mostramos la simulación en movimiento.
  useEffect(() => {
    let t = 0;
    const iv = setInterval(() => {
      t += 0.08;
      const L = liveRef.current;
      const liveActive = L && L.connected && (L.onTrack || (L.relative && L.relative.drivers && L.relative.drivers.length));
      setTelemetry(liveActive ? { ...L } : simFrame(id, t));
    }, 80);
    return () => clearInterval(iv);
  }, [id]);

  const common = { previewMode: true, injectedTelemetry: telemetry, settings: settings || {} };
  if (id === "delta") return <DeltaBar {...common} />;
  if (id === "sectors") return <SectorTimes {...common} />;
  if (id === "relative") return <Relative {...common} />;
  if (id === "standings") return <Standings {...common} />;
  if (id === "radar") return <Radar {...common} />;
  return null;
}

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

  // DeltaBarLite no usa campos pesados, no se suscribe al canal heavy.

  const targetRef = useRefSafe(0);
  const displayRef = useRefSafe(0);
  const [renderDelta, setRenderDelta] = useState(0);
  const rafRef = React.useRef(null);

  useEffect(() => {
    targetRef.current = telemetry.delta || 0;
  }, [telemetry.delta]);

  useEffect(() => {
    const lastSetValueRef = { current: 0 };
    // Suavizado exponencial por tiempo (consistente entre 60/120/144 Hz).
    const TAU = 0.12;
    let lastTs = 0;
    const tick = (ts) => {
      const dt = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : 1 / 60;
      lastTs = ts;
      const alpha = 1 - Math.exp(-dt / TAU);
      const diff = targetRef.current - displayRef.current;
      const next = displayRef.current + diff * alpha;
      displayRef.current = next;
      if (Math.abs(next - lastSetValueRef.current) >= 0.005) {
        lastSetValueRef.current = next;
        setRenderDelta(next);
      }
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
  // true una vez que el canal rápido entregó currentLapTime: a partir de ahí el
  // canal pesado no debe pisar currentLap con su copia stale (throttled a 500ms).
  const hasFastCurrentRef = useRef(false);

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
      if (data.currentLapTime != null) {
        hasFastCurrentRef.current = true;
        setLapTimes((prev) => ({ ...prev, currentLap: data.currentLapTime }));
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !window.fly) return;
    if (typeof window.fly.onTelemetryHeavy !== "function") return;
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
        <TimeLite
          label="Optimal"
          time={
            sectors.best?.length === 24 && sectors.best.every((v) => v != null && isFinite(v) && v > 0)
              ? sumArray(sectors.best)
              : null
          }
          className="text-purple-300"
        />
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
                      className="flex-1 h-7 rounded-sm transition-colors duration-150"
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

// === RELATIVE Lite (preview para el dashboard) ===
// Mock data hardcodeada para que el preview muestre cómo se ve el overlay
// real cuando no hay sesión de iRacing corriendo.
const RELATIVE_MOCK = {
  playerIdx: 7,
  totalInClass: 12,
  totalOverall: 24,
  drivers: [
    { carIdx: 1, classPosition: 1, name: "Tre Blohm",      carNumber: "9",  irating: 14500, licString: "A 4.6", licLevel: 5, licSubLevel: 4.6, licColor: 5, carClassColor: 1, lastLapTime: 96.7, bestLapTime: 95.1, gapToPlayer: 22.5, isAhead: true,  onTrack: true, onPit: false, offTrack: false, out: false, isFastest: true },
    { carIdx: 2, classPosition: 2, name: "Max Josten",     carNumber: "12", irating:  1850, licString: "D 3.4", licLevel: 2, licSubLevel: 3.4, licColor: 2, carClassColor: 1, lastLapTime: 97.2, bestLapTime: 95.4, gapToPlayer: 16.0, isAhead: true,  onTrack: true, onPit: false, offTrack: false, out: false },
    { carIdx: 3, classPosition: 3, name: "Henrique Silva", carNumber: "10", irating:  2400, licString: "D 2.7", licLevel: 2, licSubLevel: 2.7, licColor: 2, carClassColor: 1, lastLapTime: 98.4, bestLapTime: 96.2, gapToPlayer:  3.2, isAhead: true,  onTrack: true, onPit: false, offTrack: false, out: false },
    { carIdx: 4, classPosition: 4, name: "Joao Rocha",     carNumber: "7",  irating:  3200, licString: "C 3.9", licLevel: 3, licSubLevel: 3.9, licColor: 3, carClassColor: 1, lastLapTime: 98.9, bestLapTime: 96.5, gapToPlayer:  1.1, isAhead: true,  onTrack: true, onPit: false, offTrack: false, out: false },
    { carIdx: 5, classPosition: 5, name: "Suleiman Himmo", carNumber: "23", irating:  1100, licString: "R 2.1", licLevel: 1, licSubLevel: 2.1, licColor: 1, carClassColor: 1, lastLapTime: 99.3, bestLapTime: 97.1, gapToPlayer:  0.4, isAhead: true,  onTrack: true, onPit: false, offTrack: false, out: false },
    { carIdx: 6, classPosition: 6, name: "Jose Ferrada",   carNumber: "17", irating:  6700, licString: "B 4.2", licLevel: 4, licSubLevel: 4.2, licColor: 4, carClassColor: 1, lastLapTime: 99.7, bestLapTime: 96.8, gapToPlayer:  0.0, isAhead: false, onTrack: true, onPit: false, offTrack: false, out: false },
    { carIdx: 7, classPosition: 7, name: "Maximiliano Luna2", carNumber: "62", irating: 1500, licString: "D 2.3", licLevel: 2, licSubLevel: 2.3, licColor: 2, carClassColor: 1, lastLapTime: 100.1, bestLapTime: 97.5, gapToPlayer:  0.0, isAhead: false, onTrack: true, onPit: false, offTrack: true, out: false, isPlayer: true },
    { carIdx: 8, classPosition: 8, name: "Anders Krog",    carNumber: "44", irating:  2800, licString: "D 3.7", licLevel: 2, licSubLevel: 3.7, licColor: 2, carClassColor: 1, lastLapTime: 100.4, bestLapTime: 98.0, gapToPlayer:  1.2, isAhead: false, onTrack: true, onPit: false, offTrack: false, out: false },
    { carIdx: 9, classPosition: 9, name: "Marc Vidal",     carNumber: "8",  irating:  1400, licString: "R 1.8", licLevel: 1, licSubLevel: 1.8, licColor: 1, carClassColor: 1, lastLapTime: 101.0, bestLapTime: 98.6, gapToPlayer:  6.7, isAhead: false, onTrack: true, onPit: false, offTrack: false, out: false },
    { carIdx: 10, classPosition: 10, name: "Park Joon",     carNumber: "21", irating:  1700, licString: "D 2.9", licLevel: 2, licSubLevel: 2.9, licColor: 2, carClassColor: 1, lastLapTime: 101.8, bestLapTime: 99.2, gapToPlayer:  8.0, isAhead: false, onTrack: true, onPit: false, offTrack: false, out: false },
  ],
  session: {
    type: "Practice",
    time: 1525,         // 25:25
    timeRemain: 2075,   // 34:35
    timeTotal: 3600,    // 1h00m
    lapsTotal: 0,
    lapCurrent: 4,
    lapsMax: 0,
    incidents: 2,
    maxIncidents: 17,
  },
};

// Enriquece el mock estático con los campos del esquema actual (relDelta con
// signo, lapDelta, f2Time, isPlayerClass) para que los previews de Relative y
// Standings usen el mismo camino de render que la sesión real.
function enrichRelativeMock() {
  return {
    ...RELATIVE_MOCK,
    drivers: RELATIVE_MOCK.drivers.map((d, i) => ({
      ...d,
      isPlayerClass: true,
      lapDelta: 0,
      f2Time: i * 1.2,
      relDelta: d.isPlayer ? 0 : (d.isAhead ? (d.gapToPlayer || 0) : -(d.gapToPlayer || 0)),
    })),
  };
}

function RelativeLite() {
  const [telemetry, setTelemetry] = useState({ connected: false, onTrack: false, preview: false, relative: null });

  useEffect(() => {
    if (typeof window === "undefined" || !window.fly) return;
    if (typeof window.fly.onTelemetry !== "function") return;
    const unsub = window.fly.onTelemetry((data) => {
      setTelemetry((prev) => ({ ...prev, ...data }));
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !window.fly) return;
    if (typeof window.fly.onTelemetryHeavy !== "function") return;
    const unsub = window.fly.onTelemetryHeavy((data) => {
      if (data.relative) {
        setTelemetry((prev) => ({ ...prev, relative: data.relative }));
      }
    });
    return unsub;
  }, []);

  // Fallback al mock: si después de 1.5s la sesión real no está mandando
  // relative con datos (sesión cerrada, sin pilotos, etc.), mostramos el mock
  // para que el preview nunca quede vacío.
  useEffect(() => {
    const t = setTimeout(() => {
      setTelemetry((prev) => {
        const hasReal = prev.relative && Array.isArray(prev.relative.drivers) && prev.relative.drivers.length > 0;
        if (hasReal) return prev;
        return { ...prev, relative: enrichRelativeMock(), preview: true };
      });
    }, 1500);
    return () => clearTimeout(t);
  }, []);

  return <Relative settings={{ rowsAbove: 3, rowsBelow: 3 }} injectedTelemetry={telemetry} previewMode />;
}

// === STANDINGS Lite (preview para el dashboard) ===
function StandingsLite() {
  const [telemetry, setTelemetry] = useState({ connected: false, onTrack: false, preview: false, relative: null });

  useEffect(() => {
    if (typeof window === "undefined" || !window.fly) return;
    if (typeof window.fly.onTelemetry !== "function") return;
    const unsub = window.fly.onTelemetry((data) => setTelemetry((prev) => ({ ...prev, ...data })));
    return unsub;
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !window.fly) return;
    if (typeof window.fly.onTelemetryHeavy !== "function") return;
    const unsub = window.fly.onTelemetryHeavy((data) => {
      if (data.relative) setTelemetry((prev) => ({ ...prev, relative: data.relative }));
    });
    return unsub;
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      setTelemetry((prev) => {
        const hasReal = prev.relative && Array.isArray(prev.relative.drivers) && prev.relative.drivers.length > 0;
        if (hasReal) return prev;
        return { ...prev, relative: enrichRelativeMock(), preview: true };
      });
    }, 1500);
    return () => clearTimeout(t);
  }, []);

  return <Standings injectedTelemetry={telemetry} previewMode />;
}

// === RADAR Lite (preview para el dashboard) ===
function RadarLite() {
  const [telemetry, setTelemetry] = useState({ connected: false, onTrack: false, preview: false, relative: null, carLeftRight: 0 });

  useEffect(() => {
    if (typeof window === "undefined" || !window.fly) return;
    if (typeof window.fly.onTelemetry !== "function") return;
    return window.fly.onTelemetry((data) => setTelemetry((p) => ({ ...p, ...data })));
  }, []);
  useEffect(() => {
    if (typeof window === "undefined" || !window.fly) return;
    if (typeof window.fly.onTelemetryHeavy !== "function") return;
    return window.fly.onTelemetryHeavy((data) => { if (data.relative) setTelemetry((p) => ({ ...p, relative: data.relative })); });
  }, []);
  // Mock si no hay sesión real con autos.
  useEffect(() => {
    const t = setTimeout(() => {
      setTelemetry((prev) => {
        const hasReal = prev.relative && Array.isArray(prev.relative.drivers) && prev.relative.drivers.some((d) => d.relMeters != null);
        if (hasReal) return prev;
        return {
          ...prev, preview: true, carLeftRight: 3,
          relative: {
            playerIdx: 0, trackLength: 5000,
            drivers: [
              { carIdx: 0, relMeters: 0, onTrack: true, carNumber: "" },
              { carIdx: 1, relMeters: 14, onTrack: true, carNumber: "7", carClassColor: 0 },
              { carIdx: 2, relMeters: -28, onTrack: true, carNumber: "14", carClassColor: 0 },
              { carIdx: 3, relMeters: 2, onTrack: true, carNumber: "3", carClassColor: 0 },
            ],
          },
        };
      });
    }, 1500);
    return () => clearTimeout(t);
  }, []);

  return <Radar injectedTelemetry={telemetry} previewMode />;
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

// Gestor de etiquetas de pilotos (amigos/peligrosos/streamers). Se muestran en
// Relative y Standings junto al nombre del piloto (match por nombre).
const TAG_COLORS = ["#38bdf8", "#22c55e", "#ef4444", "#eab308", "#a855f7", "#f97316"];
function DriverTagsManager() {
  const [tags, setTags] = React.useState([]);
  const [editingId, setEditingId] = React.useState(null); // null = agregando nueva
  const [name, setName] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [color, setColor] = React.useState(TAG_COLORS[0]);
  const [saved, setSaved] = React.useState(false); // confirmación "Guardado ✓"
  const savedTimer = React.useRef(null);

  const load = React.useCallback(() => {
    if (window.fly?.getDriverTags) window.fly.getDriverTags().then((t) => setTags(Array.isArray(t) ? t : []));
  }, []);
  // Cargamos al montar y cada vez que la ventana recupera foco (por si se
  // editaron desde otro lado), así la lista nunca queda desactualizada.
  React.useEffect(() => {
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);
  React.useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);

  const flashSaved = () => {
    setSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), 1800);
  };
  // Escribe a disco vía IPC y confirma. La lista ES el estado persistido.
  const persist = async (next) => {
    setTags(next);
    if (window.fly?.setDriverTags) { await window.fly.setDriverTags(next); flashSaved(); }
  };

  const resetForm = () => { setEditingId(null); setName(""); setLabel(""); setColor(TAG_COLORS[0]); };
  const startEdit = (t) => { setEditingId(t.id); setName(t.name); setLabel(t.label); setColor(t.color || TAG_COLORS[0]); };
  const save = () => {
    const nm = name.trim(), lb = (label.trim() || "TAG").toUpperCase().slice(0, 8);
    if (nm.length < 3) return;
    if (editingId) {
      persist(tags.map((t) => (t.id === editingId ? { ...t, name: nm, label: lb, color } : t)));
    } else {
      persist([...tags, { id: `t${Date.now()}`, name: nm, label: lb, color }]);
    }
    resetForm();
  };
  const remove = (id) => { if (editingId === id) resetForm(); persist(tags.filter((t) => t.id !== id)); };

  const canSave = name.trim().length >= 3;

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Etiquetas de pilotos</div>
        {/* Estado de persistencia: confirma que quedó guardado en disco. */}
        {saved
          ? <span className="flex items-center gap-1 text-[9px] font-semibold text-emerald-400"><Check className="size-3" /> Guardado</span>
          : <span className="text-[9px] text-muted-foreground/50">{tags.length} guardada{tags.length === 1 ? "" : "s"}</span>}
      </div>
      <p className="text-[10px] text-muted-foreground/70 leading-tight">
        Marcá pilotos por nombre (amigo, peligroso, streamer…). Aparecen junto al nombre en Relative y Standings. Se guardan al presionar <span className="font-semibold text-foreground/80">Guardar</span> y quedan persistidas.
      </p>

      {/* Lista de etiquetas guardadas: editar o quitar cada una. */}
      <div className="space-y-1">
        {tags.length === 0 && <div className="text-[10px] text-muted-foreground/60">Sin etiquetas todavía.</div>}
        {tags.map((t) => (
          <div key={t.id} className={`flex items-center gap-1.5 text-[11px] rounded-md px-1 py-0.5 ${editingId === t.id ? "bg-accent/50" : ""}`}>
            <span className="font-bold uppercase px-1 rounded-sm shrink-0" style={{ fontSize: "8px", background: `${t.color}33`, color: t.color, border: `1px solid ${t.color}66` }}>{t.label}</span>
            <span className="flex-1 truncate text-foreground/90" title={t.name}>{t.name}</span>
            <button onClick={() => startEdit(t)} title="Editar" className="text-muted-foreground/60 hover:text-sky-400 shrink-0"><Pencil className="size-3" /></button>
            <button onClick={() => remove(t.id)} title="Quitar" className="text-muted-foreground/60 hover:text-red-400 shrink-0"><X className="size-3" /></button>
          </div>
        ))}
      </div>

      {/* Formulario de alta / edición. */}
      <div className="space-y-1.5 rounded-md border border-border bg-card/40 p-2">
        <div className="text-[9px] uppercase tracking-widest text-muted-foreground/70">{editingId ? "Editar etiqueta" : "Nueva etiqueta"}</div>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre del piloto (ej. John Smith)"
          onKeyDown={(e) => { if (e.key === "Enter" && canSave) save(); }}
          className="w-full bg-background border border-border rounded-md text-[11px] px-2 py-1 text-foreground" />
        <div className="flex items-center gap-1.5">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Etiqueta" maxLength={8}
            onKeyDown={(e) => { if (e.key === "Enter" && canSave) save(); }}
            className="flex-1 min-w-0 bg-background border border-border rounded-md text-[11px] px-2 py-1 text-foreground" />
          <div className="flex items-center gap-1 shrink-0">
            {TAG_COLORS.map((c) => (
              <button key={c} onClick={() => setColor(c)} title={c}
                className="size-4 rounded-full border" style={{ background: c, borderColor: color === c ? "white" : "transparent" }} />
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={save} disabled={!canSave}
            className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold bg-emerald-600/80 hover:bg-emerald-600 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            {editingId ? <><Check className="size-3" /> Guardar cambios</> : <><Plus className="size-3" /> Guardar etiqueta</>}
          </button>
          {editingId && (
            <button onClick={resetForm}
              className="px-2 py-1 rounded-md text-[10px] font-semibold bg-accent/60 hover:bg-accent transition-colors">
              Cancelar
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Diccionario de labels legibles para los settings de cada overlay.
// Si la key no está, se muestra la key original (camelCase).
const SETTING_LABELS = {
  delta: {
    showBar: "Mostrar barra",
    showNumber: "Mostrar número",
    showTrend: "Indicador de tendencia",
    showPrediction: "Vuelta proyectada",
    range: "Rango de la barra (±s)",
    deltaReference: "Referencia del delta",
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
    showSectorDelta: "Delta por sector",
    headerFontSize: "Tamaño del header",
    valueFontSize: "Tamaño de los tiempos",
    timeColumnWidth: "Ancho columna label",
    subBarHeight: "Alto de sub-barra",
  },
  standings: {
    showLicense: "Mostrar licencia",
    showIRating: "Mostrar iRating",
    showCarNumber: "Mostrar número de auto",
    showBestLap: "Mostrar best lap",
    showLastLap: "Mostrar last lap",
    showPositionChange: "Cambio de posición (vs qualy)",
    maxRows: "Máximo de filas",
    rowHeight: "Alto de fila",
    fontSize: "Tamaño de fuente",
    borderRadius: "Radio del contenedor",
  },
  relative: {
    showLicense: "Mostrar licencia",
    showIRating: "Mostrar iRating",
    showCarNumber: "Mostrar número de auto",
    showLaps: "Mostrar last lap",
    rowsAbove: "Rivales arriba",
    rowsBelow: "Rivales abajo",
    rowHeight: "Alto de fila",
    fontSize: "Tamaño de fuente",
    borderRadius: "Radio del contenedor",
  },
  radar: {
    range: "Alcance (metros)",
    showClassColors: "Colorear por clase",
    showDistance: "Mostrar distancia del más cercano",
    fontSize: "Tamaño de fuente",
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

// Selector de formato de nombre (full / apellido / iniciales).
function NameFormatField({ overlayId, value, onChange }) {
  const cur = value || "full";
  return (
    <div className="space-y-1">
      <span className="text-[11px] text-muted-foreground">Formato de nombre</span>
      <div className="flex border border-border rounded-md overflow-hidden">
        {[["full", "Completo"], ["short", "Apellido"], ["initials", "Iniciales"]].map(([val, label], i) => (
          <button
            key={val}
            type="button"
            className="flex-1 px-2 py-1 text-[10px] font-mono font-bold transition-colors hover:bg-white/5"
            style={{
              background: cur === val ? "rgba(125,211,252,0.15)" : "transparent",
              color: cur === val ? "rgb(125,211,252)" : "rgba(255,255,255,0.5)",
              borderRight: i < 2 ? "1px solid rgba(255,255,255,0.08)" : "none",
              cursor: "pointer",
            }}
            onClick={() => onChange(overlayId, "nameFormat", val)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function AppearanceSettings({ overlayId, overlayKey, settings = {}, onChange }) {
  const isDelta = overlayKey === "delta";
  const isSectors = overlayKey === "sectors";
  const isRelative = overlayKey === "relative";
  const isStandings = overlayKey === "standings";
  const isRadar = overlayKey === "radar";
  if (!isDelta && !isSectors && !isRelative && !isStandings && !isRadar) return null;

  return (
    <div className="pt-2 border-t border-border space-y-3">
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-bold">
        Apariencia
      </div>

      {isDelta && (
        <>
          <ToggleField overlayId={overlayId} overlayKey={overlayKey} k="showBar" value={settings.showBar} onChange={onChange} />
          <ToggleField overlayId={overlayId} overlayKey={overlayKey} k="showNumber" value={settings.showNumber} onChange={onChange} />
          <ToggleField overlayId={overlayId} overlayKey={overlayKey} k="showTrend" value={settings.showTrend} onChange={onChange} />
          <ToggleField overlayId={overlayId} overlayKey={overlayKey} k="showPrediction" value={settings.showPrediction} onChange={onChange} />
          <div className="space-y-1">
            <span className="text-[11px] text-muted-foreground">Referencia del delta</span>
            <div className="grid grid-cols-2 gap-1">
              {[
                ["sessionBest", "Tu mejor (sesión)"],
                ["fieldBest", "Mejor de la sesión"],
                ["lastLap", "Vuelta anterior"],
                ["personalBest", "Personal"],
                ["optimal", "Óptima"],
              ].map(([val, label]) => {
                // Configs viejas pueden tener 'auto' guardado: se trata como sessionBest.
                const cur = settings.deltaReference && settings.deltaReference !== "auto"
                  ? settings.deltaReference : "sessionBest";
                const active = cur === val;
                return (
                  <button
                    key={val}
                    type="button"
                    className="px-2 py-1 text-[10px] font-mono font-bold rounded-md border transition-colors hover:bg-white/5"
                    style={{
                      background: active ? "rgba(125, 211, 252, 0.15)" : "transparent",
                      color: active ? "rgb(125, 211, 252)" : "rgba(255,255,255,0.5)",
                      borderColor: active ? "rgba(125, 211, 252, 0.4)" : "rgba(255,255,255,0.08)",
                      cursor: "pointer",
                    }}
                    onClick={() => onChange(overlayId, "deltaReference", val)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="range" min={1} max={10} step={1} unit="s" value={settings.range} onChange={onChange} />
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
          <ToggleField overlayId={overlayId} overlayKey={overlayKey} k="showSectorDelta" value={settings.showSectorDelta} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="headerFontSize" min={8} max={18} step={1} unit="px" value={settings.headerFontSize} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="valueFontSize" min={10} max={28} step={1} unit="px" value={settings.valueFontSize} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="timeColumnWidth" min={32} max={120} step={2} unit="px" value={settings.timeColumnWidth} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="subBarHeight" min={12} max={64} step={1} unit="px" value={settings.subBarHeight} onChange={onChange} />
        </>
      )}

      {isStandings && (
        <>
          <ToggleField overlayId={overlayId} overlayKey={overlayKey} k="showLicense" value={settings.showLicense} onChange={onChange} />
          <ToggleField overlayId={overlayId} overlayKey={overlayKey} k="showIRating" value={settings.showIRating} onChange={onChange} />
          <ToggleField overlayId={overlayId} overlayKey={overlayKey} k="showCarNumber" value={settings.showCarNumber} onChange={onChange} />
          <ToggleField overlayId={overlayId} overlayKey={overlayKey} k="showBestLap" value={settings.showBestLap} onChange={onChange} />
          <ToggleField overlayId={overlayId} overlayKey={overlayKey} k="showLastLap" value={settings.showLastLap} onChange={onChange} />
          <ToggleField overlayId={overlayId} overlayKey={overlayKey} k="showPositionChange" value={settings.showPositionChange} onChange={onChange} />
          <NameFormatField overlayId={overlayId} value={settings.nameFormat} onChange={onChange} />
          <div className="space-y-1">
            <span className="text-[11px] text-muted-foreground">Columna de gap (carrera)</span>
            <div className="flex border border-border rounded-md overflow-hidden">
              {[["leader", "Al líder"], ["interval", "Intervalo"]].map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  className="flex-1 px-2.5 py-1 text-[10px] font-mono font-bold transition-colors hover:bg-white/5"
                  style={{
                    background: (settings.gapMode || "leader") === val ? "rgba(125, 211, 252, 0.15)" : "transparent",
                    color: (settings.gapMode || "leader") === val ? "rgb(125, 211, 252)" : "rgba(255,255,255,0.5)",
                    borderRight: val === "leader" ? "1px solid rgba(255,255,255,0.08)" : "none",
                    cursor: "pointer",
                  }}
                  onClick={() => onChange(overlayId, "gapMode", val)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="maxRows" min={5} max={40} step={1} unit="" value={settings.maxRows} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="rowHeight" min={18} max={40} step={1} unit="px" value={settings.rowHeight} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="fontSize" min={9} max={18} step={1} unit="px" value={settings.fontSize} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="borderRadius" min={0} max={20} step={1} unit="px" value={settings.borderRadius} onChange={onChange} />
        </>
      )}

      {isRelative && (
        <>
          <ToggleField overlayId={overlayId} overlayKey={overlayKey} k="showLicense" value={settings.showLicense} onChange={onChange} />
          <ToggleField overlayId={overlayId} overlayKey={overlayKey} k="showIRating" value={settings.showIRating} onChange={onChange} />
          <ToggleField overlayId={overlayId} overlayKey={overlayKey} k="showCarNumber" value={settings.showCarNumber} onChange={onChange} />
          <ToggleField overlayId={overlayId} overlayKey={overlayKey} k="showLaps" value={settings.showLaps} onChange={onChange} />
          <NameFormatField overlayId={overlayId} value={settings.nameFormat} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="rowsAbove" min={0} max={6} step={1} unit="" value={settings.rowsAbove} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="rowsBelow" min={0} max={6} step={1} unit="" value={settings.rowsBelow} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="rowHeight" min={20} max={48} step={2} unit="px" value={settings.rowHeight} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="fontSize" min={9} max={18} step={1} unit="px" value={settings.fontSize} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="borderRadius" min={0} max={20} step={1} unit="px" value={settings.borderRadius} onChange={onChange} />
        </>
      )}

      {isRadar && (
        <>
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="range" min={20} max={150} step={5} unit="m" value={settings.range} onChange={onChange} />
          <ToggleField overlayId={overlayId} overlayKey={overlayKey} k="showClassColors" value={settings.showClassColors} onChange={onChange} />
          <ToggleField overlayId={overlayId} overlayKey={overlayKey} k="showDistance" value={settings.showDistance} onChange={onChange} />
          <NumSliderField overlayId={overlayId} overlayKey={overlayKey} k="fontSize" min={9} max={20} step={1} unit="px" value={settings.fontSize} onChange={onChange} />
        </>
      )}
    </div>
  );
}
