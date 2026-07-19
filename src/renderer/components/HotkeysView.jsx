import React, { useEffect, useRef, useState } from "react";
import { Keyboard, Gamepad2 } from "lucide-react";
import { Switch } from "./ui/switch.jsx";

// Apartado HOTKEYS: administra todos los bindings de la app en un solo lugar,
// separados por categoría. Teclado: atajos globales de Electron (funcionan con
// iRacing en foco). Volante/joystick: botones vía Gamepad API (el polling
// global vive en Dashboard, que existe durante toda la app).

// Convierte un KeyboardEvent en un accelerator de Electron. Devuelve null si
// la tecla no es representable (o es solo un modificador). Escape se maneja
// aparte (cancela la escucha).
function toAccelerator(e) {
  const mods = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  const k = e.key;
  let key = null;
  if (/^F\d{1,2}$/.test(k)) key = k;
  else if (/^[a-zA-Z]$/.test(k)) key = k.toUpperCase();
  else if (/^[0-9]$/.test(k)) key = k;
  else {
    const MAP = {
      " ": "Space",
      ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
      Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
      Insert: "Insert", Delete: "Delete", "+": "Plus",
    };
    key = MAP[k] ?? null;
  }
  if (!key) return null;
  // Una letra o número "pelado" como atajo GLOBAL bloquearía esa tecla en todo
  // el sistema (no podrías escribirla en ningún programa). Exigimos modificador.
  if (mods.length === 0 && /^[A-Z0-9]$/.test(key)) return { needsModifier: true };
  return [...mods, key].join("+");
}

// Definición de las categorías y sus bindings de teclado (key = config.hotkeys).
const CATEGORIES = [
  {
    title: "Overlays",
    items: [
      { key: "toggleLock", label: "Mover overlays", desc: "Entra/sale del edit mode para posicionar y redimensionar" },
      { key: "forceShow", label: "Forzar mostrar", desc: "Trae todos los overlays activos al frente (recovery)" },
      { key: "preview", label: "Modo preview", desc: "Overlays con datos sintéticos, sin iRacing" },
    ],
  },
  {
    title: "Panel",
    items: [
      { key: "openPanel", label: "Abrir/cerrar panel", desc: "Muestra u oculta esta ventana" },
    ],
  },
  {
    title: "Delta Bar",
    items: [
      { key: "cycleDeltaRef", label: "Ciclar referencia del delta", desc: "Tu mejor (sesión) → mejor de la sesión → vuelta anterior → personal → óptima" },
    ],
    wheelBind: true, // esta categoría también muestra el binding de botón de volante
  },
];

export function HotkeysView() {
  const [config, setConfig] = useState(null);
  const [listening, setListening] = useState(null); // key del hotkey en escucha
  const [msg, setMsg] = useState(null); // { tone: 'error'|'ok', text }

  useEffect(() => {
    let alive = true;
    if (!window.fly?.getConfig) return;
    window.fly.getConfig().then((c) => { if (alive) setConfig(c); });
    const un = window.fly.onConfigChange((c) => { if (alive) setConfig(c); });
    return () => { alive = false; un && un(); };
  }, []);

  // Escucha de teclado para re-bindear. Escape cancela.
  useEffect(() => {
    if (!listening) return;
    const onKey = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { setListening(null); return; }
      const acc = toAccelerator(e);
      if (acc == null) return; // modificador solo o tecla no soportada: seguir escuchando
      if (acc.needsModifier) {
        setMsg({ tone: "error", text: "Una letra/número sola bloquearía esa tecla en TODO el sistema. Combinala con Ctrl/Alt/Shift, o usá una tecla F." });
        return;
      }
      const res = await window.fly.setHotkey(listening, acc);
      setListening(null);
      setMsg(res?.ok
        ? { tone: "ok", text: `Asignado ${acc}` }
        : { tone: "error", text: res?.error || "No se pudo asignar" });
    };
    window.addEventListener("keydown", onKey, true);
    const t = setTimeout(() => setListening(null), 10000);
    return () => { window.removeEventListener("keydown", onKey, true); clearTimeout(t); };
  }, [listening]);

  // Auto-ocultar el mensaje de feedback.
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 4000);
    return () => clearTimeout(t);
  }, [msg]);

  if (!config) return null;
  const hk = config.hotkeys || {};

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="max-w-3xl mx-auto space-y-4">
        <div className="flex items-center gap-2">
          <Keyboard className="size-4 text-sky-400" />
          <h2 className="text-sm font-bold">Hotkeys</h2>
          <span className="text-[11px] text-muted-foreground">atajos globales — funcionan con iRacing en primer plano</span>
          <div className="flex-1" />
          {msg && (
            <span className={`text-[11px] font-semibold ${msg.tone === "ok" ? "text-emerald-400" : "text-red-400"}`}>
              {msg.text}
            </span>
          )}
        </div>

        {CATEGORIES.map((cat) => (
          <div key={cat.title} className="rounded-lg border border-border bg-card/40 p-3 space-y-1">
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-bold mb-2">
              {cat.title}
            </div>
            {cat.items.map((item) => (
              <div key={item.key} className="flex items-center gap-3 py-1.5 border-b border-border/50 last:border-0">
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold">{item.label}</div>
                  <div className="text-[10px] text-muted-foreground truncate">{item.desc}</div>
                </div>
                <kbd
                  className="px-2 py-1 rounded-md bg-muted/60 border border-border font-mono text-[11px] font-bold shrink-0"
                  style={listening === item.key ? { borderColor: "rgb(125,211,252)", color: "rgb(125,211,252)" } : undefined}
                >
                  {listening === item.key ? "..." : (hk[item.key] || "—")}
                </kbd>
                <button
                  type="button"
                  className="px-2 py-1 text-[10px] font-bold rounded-md border transition-colors hover:bg-white/5 shrink-0"
                  style={{
                    background: listening === item.key ? "rgba(125,211,252,0.15)" : "transparent",
                    color: listening === item.key ? "rgb(125,211,252)" : "rgba(255,255,255,0.6)",
                    borderColor: "rgba(255,255,255,0.12)",
                  }}
                  onClick={() => { setMsg(null); setListening((v) => (v === item.key ? null : item.key)); }}
                >
                  {listening === item.key ? "Apretá una tecla (Esc cancela)" : "Detectar"}
                </button>
              </div>
            ))}
            {cat.wheelBind && <WheelBindRow config={config} />}
          </div>
        ))}

        <p className="text-[10px] text-muted-foreground">
          Tip: si tu volante no aparece como joystick, mapeá un botón a la tecla del atajo desde el
          software del volante (G HUB, Fanatec, SimHub, etc.).
        </p>
      </div>
    </div>
  );
}

// Binding de botón de volante/joystick para ciclar la referencia del delta.
// "Detectar" escucha la próxima pulsación de cualquier botón de cualquier
// dispositivo. NOTA: Chromium expone los gamepads a la página recién después
// de una pulsación con la ventana enfocada — por eso el bindeo se hace acá.
function WheelBindRow({ config }) {
  const [listening, setListening] = useState(false);
  const settings = config?.overlays?.delta?.settings || {};
  const value = settings.cycleButton || null;
  const enabled = !!settings.wheelInputEnabled;

  const save = async (binding) => {
    const s = { ...(config?.overlays?.delta?.settings || {}), cycleButton: binding };
    await window.fly.setOverlay("delta", { settings: s });
  };

  const setEnabled = async (val) => {
    setListening(false); // cortar cualquier escucha en curso al cambiar el modo
    const s = { ...(config?.overlays?.delta?.settings || {}), wheelInputEnabled: val };
    await window.fly.setOverlay("delta", { settings: s });
  };

  useEffect(() => {
    // Sin opt-in NO tocamos la Gamepad API (protege el FFB del volante).
    if (!listening || !enabled) return;
    const prev = new Map(); // gamepad.index → [pressed...] para detectar transición
    const iv = setInterval(() => {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const p of pads) {
        if (!p) continue;
        const before = prev.get(p.index) || [];
        for (let i = 0; i < p.buttons.length; i++) {
          if (p.buttons[i].pressed && !before[i]) {
            save({ pad: p.id, btn: i });
            setListening(false);
            return;
          }
        }
        prev.set(p.index, p.buttons.map((b) => b.pressed));
      }
    }, 50);
    const t = setTimeout(() => setListening(false), 10000);
    return () => { clearInterval(iv); clearTimeout(t); };
  }, [listening, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="py-1.5 space-y-2">
      {/* Toggle opt-in: leer el volante por Gamepad API (riesgo de FFB). */}
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold flex items-center gap-1.5">
            <Gamepad2 className="size-3.5 text-muted-foreground" />
            Leer botón del volante (Gamepad API)
          </div>
          <div className="text-[10px] text-muted-foreground">
            Cicla la referencia del delta desde un botón del volante, sin teclado.
          </div>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </div>

      {/* Aviso de FFB: siempre visible, para que la decisión sea informada. */}
      <div
        className="text-[10px] leading-snug rounded-md px-2 py-1.5 border"
        style={{
          background: "rgba(249,115,22,0.08)",
          borderColor: "rgba(249,115,22,0.25)",
          color: "rgba(255,255,255,0.7)",
        }}
      >
        ⚠️ En algunos volantes (Logitech G29/G27, etc.) esto puede{" "}
        <span className="font-semibold text-orange-300">cortar el force feedback</span> en iRacing,
        porque el navegador abre el volante por DirectInput. Alternativa sin riesgo:{" "}
        <span className="font-semibold">mapeá un botón a una tecla en G HUB</span> y usá el atajo de
        teclado de arriba ({config?.hotkeys?.cycleDeltaRef || "F10"}).
      </div>

      {/* Fila de bindeo: solo cuando el opt-in está activo. */}
      {enabled && (
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-muted-foreground flex-1 min-w-0 truncate">
            Botón asignado
          </span>
          <span className="text-[10px] font-mono truncate text-foreground/80 max-w-[180px] shrink-0">
            {listening ? "Apretá un botón..." : value ? `Botón ${value.btn} · ${value.pad}` : "—"}
          </span>
          <button
            type="button"
            className="px-2 py-1 text-[10px] font-bold rounded-md border transition-colors hover:bg-white/5 shrink-0"
            style={{
              background: listening ? "rgba(125,211,252,0.15)" : "transparent",
              color: listening ? "rgb(125,211,252)" : "rgba(255,255,255,0.6)",
              borderColor: "rgba(255,255,255,0.12)",
            }}
            onClick={() => setListening((v) => !v)}
          >
            {listening ? "Cancelar" : "Detectar"}
          </button>
          {value && !listening && (
            <button
              type="button"
              className="px-2 py-1 text-[10px] font-bold rounded-md border border-white/10 text-white/50 hover:bg-white/5 shrink-0"
              onClick={() => save(null)}
            >
              Quitar
            </button>
          )}
        </div>
      )}
    </div>
  );
}
