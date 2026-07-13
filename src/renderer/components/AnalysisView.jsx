import React, { useEffect, useMemo, useState, useCallback } from "react";
import { Trash2, Trophy, Clock, Activity, Gauge, Upload, FolderOpen, RotateCcw } from "lucide-react";
import { analyzeLap, bestLapOf, consistency } from "../lib/coach.js";

function fmtLap(s) {
  if (s == null || !isFinite(s) || s <= 0) return "—";
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(3).padStart(6, "0")}`;
}
function fmtDelta(s) {
  if (s == null || !isFinite(s)) return "—";
  return `${s >= 0 ? "+" : "−"}${Math.abs(s).toFixed(3)}`;
}
function fmtDate(ms) {
  try {
    const d = new Date(ms);
    return d.toLocaleString("es-CO", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch (_) { return ""; }
}

// Construye un path SVG desde una serie (con nulls = huecos).
function seriesPath(vals, n, yMin, yMax, W, H) {
  const span = yMax - yMin || 1;
  let d = "";
  let pen = false;
  for (let i = 0; i < n; i++) {
    const v = vals[i];
    if (v == null || !isFinite(v)) { pen = false; continue; }
    const x = (i / (n - 1)) * W;
    const y = H - ((v - yMin) / span) * H;
    d += `${pen ? " L" : " M"}${x.toFixed(1)},${y.toFixed(1)}`;
    pen = true;
  }
  return d.trim();
}

function Chart({ title, height = 110, children }) {
  return (
    <div className="rounded-lg border border-border bg-card/40 p-3">
      <div className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-2">{title}</div>
      <svg viewBox={`0 0 1000 ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
        {children}
      </svg>
    </div>
  );
}

export function AnalysisView() {
  const [sessions, setSessions] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [session, setSession] = useState(null);
  const [lapIdx, setLapIdx] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [telemetryDir, setTelemetryDir] = useState(null);

  const loadList = useCallback(async () => {
    if (!window.fly?.getRecordings) return;
    // Merge de sesiones grabadas en vivo + archivos .ibt de iRacing.
    const [live, ibt] = await Promise.all([
      window.fly.getRecordings(),
      window.fly.getIbtSessions ? window.fly.getIbtSessions() : Promise.resolve([]),
    ]);
    const merged = [
      ...(live || []).map((s) => ({ ...s, source: "live" })),
      ...(ibt || []),
    ].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    setSessions(merged);
    setSelectedId((cur) => cur || (merged[0] ? merged[0].id : null));
  }, []);

  useEffect(() => {
    loadList();
    if (!window.fly?.onRecordingsChange) return;
    const unsub = window.fly.onRecordingsChange(() => loadList());
    return unsub;
  }, [loadList]);

  useEffect(() => {
    if (!selectedId) { setSession(null); return; }
    const isIbt = selectedId.startsWith("ibt:") || selectedId.startsWith("ibtpath:");
    const getter = isIbt ? window.fly?.getIbtSession : window.fly?.getRecording;
    if (!getter) { setSession(null); return; }
    let mounted = true;
    setSession(null); // limpiar mientras carga (parsear un .ibt puede tardar)
    setLoading(true);
    getter(selectedId).then((s) => {
      if (!mounted) return;
      setSession(s);
      setLoading(false);
      // Comparar por defecto la última vuelta válida contra la mejor.
      if (s && s.laps) {
        const lastValid = [...s.laps].reverse().findIndex((l) => l.valid && l.lapTime > 0);
        setLapIdx(lastValid >= 0 ? s.laps.length - 1 - lastValid : (s.laps.length - 1));
      }
    }).catch(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [selectedId]);

  const best = useMemo(() => bestLapOf(session), [session]);
  const lap = session && session.laps && lapIdx >= 0 ? session.laps[lapIdx] : null;
  const cons = useMemo(() => consistency(session?.laps), [session]);
  const analysis = useMemo(() => (best && lap ? analyzeLap(best, lap) : null), [best, lap]);

  useEffect(() => {
    if (window.fly?.getTelemetryDir) window.fly.getTelemetryDir().then(setTelemetryDir);
  }, []);

  const handleDelete = async (id, e) => {
    e.stopPropagation();
    if (!window.fly?.deleteRecording) return;
    await window.fly.deleteRecording(id);
    if (id === selectedId) { setSelectedId(null); setSession(null); }
    loadList();
  };

  const handleImport = async () => {
    if (!window.fly?.importIbt) {
      console.warn("[analysis] window.fly.importIbt no existe — reiniciá Electron (el preload no se recarga con HMR)");
      return;
    }
    const item = await window.fly.importIbt();
    if (!item) return;
    setSessions((prev) => (prev.some((s) => s.id === item.id) ? prev : [item, ...prev]));
    setSelectedId(item.id);
  };

  const handlePickFolder = async () => {
    if (!window.fly?.pickTelemetryDir) {
      console.warn("[analysis] window.fly.pickTelemetryDir no existe — reiniciá Electron (el preload no se recarga con HMR)");
      return;
    }
    const info = await window.fly.pickTelemetryDir();
    if (info) { setTelemetryDir(info); loadList(); }
  };

  const handleResetFolder = async () => {
    if (!window.fly?.resetTelemetryDir) return;
    const info = await window.fly.resetTelemetryDir();
    if (info) { setTelemetryDir(info); loadList(); }
  };

  // Series para los gráficos (largo n = cantidad de buckets).
  const charts = useMemo(() => {
    if (!lap || !lap.samples) return null;
    const n = lap.samples.length;
    const spBest = best?.samples || [];
    const speedLap = lap.samples.map((s) => (s && s.sp != null ? s.sp * 3.6 : null));
    const speedBest = spBest.map((s) => (s && s.sp != null ? s.sp * 3.6 : null));
    const throttle = lap.samples.map((s) => (s ? s.th : null));
    const brake = lap.samples.map((s) => (s ? s.br : null));
    const delta = analysis ? analysis.deltaTrace.map((p) => p.delta) : [];

    const speedVals = [...speedLap, ...speedBest].filter((v) => v != null && isFinite(v));
    const spMin = speedVals.length ? Math.min(...speedVals) - 5 : 0;
    const spMax = speedVals.length ? Math.max(...speedVals) + 5 : 300;
    const dvals = delta.filter((v) => v != null && isFinite(v));
    const dMax = dvals.length ? Math.max(0.1, Math.max(...dvals.map(Math.abs))) : 0.5;

    return { n, speedLap, speedBest, throttle, brake, delta, spMin, spMax, dMax };
  }, [lap, best, analysis]);

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Sesiones */}
      <aside className="w-64 border-r border-border bg-card/30 flex flex-col shrink-0">
        <div className="p-3 pb-2 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <Clock className="size-3.5" /> Sesiones
          </span>
          <button
            onClick={handleImport}
            title="Importar un archivo .ibt de cualquier carpeta"
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold bg-accent/60 hover:bg-accent transition-colors"
          >
            <Upload className="size-3" /> Importar
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-1.5 pb-2 space-y-1">
          {sessions.length === 0 && (
            <div className="px-2 py-4 text-[11px] text-muted-foreground">
              No hay sesiones grabadas todavía. Salí a pista con iRacing y la app va a grabar cada vuelta automáticamente.
            </div>
          )}
          {sessions.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelectedId(s.id)}
              className={`w-full text-left px-2 py-1.5 rounded-md transition-colors group ${
                s.id === selectedId ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
              }`}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="text-xs font-semibold truncate">{s.track}</span>
                <div className="flex items-center gap-1 shrink-0">
                  {s.source === "ibt" && (
                    <span className="text-[8px] font-bold uppercase tracking-widest px-1 py-px rounded bg-sky-500/15 text-sky-300">
                      iRacing
                    </span>
                  )}
                  {s.source !== "ibt" && (
                    <Trash2
                      className="size-3 opacity-0 group-hover:opacity-60 hover:!opacity-100"
                      onClick={(e) => handleDelete(s.id, e)}
                    />
                  )}
                </div>
              </div>
              <div className="text-[10px] text-muted-foreground truncate">{s.car}</div>
              <div className="flex items-center justify-between text-[10px] text-muted-foreground mt-0.5">
                <span>{s.sessionType}{s.lapCount != null ? ` · ${s.lapCount} vueltas` : ""}</span>
                <span className="font-mono">{s.bestLap != null ? fmtLap(s.bestLap) : ""}</span>
              </div>
              <div className="text-[9px] text-muted-foreground/70">{fmtDate(s.startedAt)}</div>
            </button>
          ))}
        </div>

        {/* Carpeta de telemetría .ibt */}
        <div className="border-t border-border p-2 space-y-1">
          <div className="flex items-center gap-1 text-[9px] uppercase tracking-widest text-muted-foreground/70 font-bold">
            <FolderOpen className="size-3" /> Carpeta telemetría iRacing
          </div>
          <div className="text-[10px] text-muted-foreground font-mono break-all leading-tight" title={telemetryDir?.dir}>
            {telemetryDir?.dir || "—"}{telemetryDir?.custom ? "" : "  (default)"}
          </div>
          <div className="flex gap-1">
            <button
              onClick={handlePickFolder}
              className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold bg-accent/60 hover:bg-accent transition-colors"
            >
              <FolderOpen className="size-3" /> Cambiar
            </button>
            {telemetryDir?.custom && (
              <button
                onClick={handleResetFolder}
                title="Volver a la carpeta por defecto"
                className="flex items-center justify-center px-2 py-1 rounded-md text-[10px] font-semibold hover:bg-accent/50 transition-colors"
              >
                <RotateCcw className="size-3" />
              </button>
            )}
          </div>
        </div>
      </aside>

      {/* Detalle */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {loading ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            Cargando sesión...
          </div>
        ) : !session ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            {sessions.length === 0
              ? "No hay sesiones. Grabá una con la app en pista, o activá el logging de telemetría en iRacing (Alt+L) para importar archivos .ibt."
              : "Seleccioná una sesión para ver el análisis."}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {/* Cabecera de sesión */}
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-bold">{session.track}</h2>
                <p className="text-[11px] text-muted-foreground">{session.car} · {session.sessionType}</p>
              </div>
              {cons && (
                <div className="flex gap-4 text-right">
                  <Metric label="Mejor" value={fmtLap(cons.best)} icon={Trophy} />
                  <Metric label="Consistencia (σ)" value={`${cons.std.toFixed(3)}s`} icon={Activity} />
                  <Metric label="Spread" value={`${cons.spread.toFixed(3)}s`} icon={Gauge} />
                </div>
              )}
            </div>

            {/* Vueltas + análisis */}
            <div className="flex gap-4">
              {/* Lista de vueltas */}
              <div className="w-44 shrink-0">
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 font-bold mb-1.5">Vueltas</div>
                <div className="space-y-0.5 max-h-[260px] overflow-y-auto pr-1">
                  {session.laps.map((l, i) => {
                    const isBest = best && l === best;
                    const isSel = i === lapIdx;
                    return (
                      <button
                        key={i}
                        onClick={() => setLapIdx(i)}
                        className={`w-full flex items-center justify-between px-2 py-1 rounded text-xs font-mono transition-colors ${
                          isSel ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                        }`}
                      >
                        <span className="flex items-center gap-1">
                          {isBest && <Trophy className="size-3 text-purple-400" />}
                          L{l.lap}
                        </span>
                        <span className={l.valid ? "" : "text-red-400/70"}>
                          {fmtLap(l.lapTime)}{!l.valid && "*"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Coach + gráficos */}
              <div className="flex-1 min-w-0 space-y-4">
                {lap && best && lap !== best && analysis && (
                  <div className="text-xs text-muted-foreground">
                    Comparando <span className="text-foreground font-semibold">L{lap.lap}</span> ({fmtLap(lap.lapTime)}) vs tu mejor L{best.lap} ({fmtLap(best.lapTime)}) ·
                    <span className={analysis.deltaTotal > 0 ? "text-red-400 ml-1" : "text-emerald-400 ml-1"}>
                      {fmtDelta(analysis.deltaTotal)}s
                    </span>
                  </div>
                )}

                {/* Coach IA */}
                {analysis && analysis.tips.length > 0 && (
                  <div className="rounded-lg border border-border bg-card/40 p-3 space-y-1.5">
                    <div className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
                      <Activity className="size-3.5" /> Coach
                    </div>
                    {analysis.tips.map((t, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs">
                        <span
                          className="mt-1 size-1.5 rounded-full shrink-0"
                          style={{ background: t.severity === "high" ? "rgb(239,68,68)" : t.severity === "med" ? "rgb(234,179,8)" : "rgb(52,211,153)" }}
                        />
                        <span className="text-foreground/90">{t.text}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Gráficos */}
                {charts && (
                  <>
                    <Chart title="Delta vs mejor vuelta (s)">
                      <line x1="0" y1="55" x2="1000" y2="55" stroke="rgba(255,255,255,0.15)" strokeWidth="1" strokeDasharray="4 4" />
                      <path
                        d={seriesPath(charts.delta, charts.n, -charts.dMax, charts.dMax, 1000, 110)}
                        fill="none" stroke="rgb(125,211,252)" strokeWidth="2"
                      />
                    </Chart>

                    <Chart title="Velocidad (km/h) — vuelta vs mejor">
                      <path d={seriesPath(charts.speedBest, charts.n, charts.spMin, charts.spMax, 1000, 110)} fill="none" stroke="rgba(168,85,247,0.6)" strokeWidth="1.5" strokeDasharray="5 3" />
                      <path d={seriesPath(charts.speedLap, charts.n, charts.spMin, charts.spMax, 1000, 110)} fill="none" stroke="rgb(52,211,153)" strokeWidth="2" />
                    </Chart>

                    <Chart title="Acelerador (verde) y freno (rojo)">
                      <path d={seriesPath(charts.throttle, charts.n, 0, 1, 1000, 110)} fill="none" stroke="rgb(52,211,153)" strokeWidth="2" />
                      <path d={seriesPath(charts.brake, charts.n, 0, 1, 1000, 110)} fill="none" stroke="rgb(239,68,68)" strokeWidth="2" />
                    </Chart>
                    <div className="text-[10px] text-muted-foreground/60">
                      Eje X = distancia de la vuelta (inicio → meta). Línea punteada = tu mejor vuelta.
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function Metric({ label, value, icon: Icon }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-muted-foreground/70 flex items-center gap-1 justify-end">
        {Icon && <Icon className="size-3" />} {label}
      </div>
      <div className="text-sm font-mono font-semibold">{value}</div>
    </div>
  );
}
