import React, { useEffect, useMemo, useState } from "react";
import { TrendingDown, Trophy } from "lucide-react";

// Vista de PROGRESO: agrupa todas tus sesiones por pista + auto y grafica la
// evolución de tu mejor vuelta en el tiempo, resaltando el récord personal (PB)
// y cuánto bajaste desde la primera. Reusa el mismo listado que Análisis
// (grabaciones en vivo + archivos .ibt/.csv), del que sólo necesita el bestLap.

function fmtLap(s) {
  if (s == null || !isFinite(s) || s <= 0) return "—";
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(3).padStart(6, "0")}`;
}
function fmtDate(ms) {
  try { return new Date(ms).toLocaleDateString("es-CO", { day: "2-digit", month: "2-digit", year: "numeric" }); }
  catch (_) { return ""; }
}

export function ProgressView() {
  const [sessions, setSessions] = useState([]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (!window.fly?.getRecordings) return;
      const [live, ibt] = await Promise.all([
        window.fly.getRecordings(),
        window.fly.getIbtSessions ? window.fly.getIbtSessions() : Promise.resolve([]),
      ]);
      if (!alive) return;
      setSessions([...(live || []).map((s) => ({ ...s, source: "live" })), ...(ibt || [])]);
    };
    load();
    if (window.fly?.onRecordingsChange) {
      const un = window.fly.onRecordingsChange(load);
      return () => { alive = false; un && un(); };
    }
    return () => { alive = false; };
  }, []);

  const groups = useMemo(() => {
    const map = new Map();
    for (const s of sessions) {
      if (!(s.bestLap > 0)) continue;
      // Solo sesiones PROPIAS: iRacing (.ibt) y grabadas en vivo. Los CSV suelen
      // ser vueltas de referencia ajenas, no cuentan para tu progreso.
      if (s.source === "csv") continue;
      const track = s.track || s.trackKey || "?";
      const car = s.car || "?";
      const key = `${(s.trackKey || s.track || "?").toLowerCase()}|${car.toLowerCase()}`;
      if (!map.has(key)) map.set(key, { track, car, items: [] });
      map.get(key).items.push({ t: s.startedAt || 0, lap: s.bestLap, type: s.sessionType, source: s.source });
    }
    const arr = [...map.values()].map((g) => {
      g.items.sort((a, b) => a.t - b.t);
      const laps = g.items.map((i) => i.lap);
      g.pb = Math.min(...laps);
      g.pbAt = (g.items.find((i) => i.lap === g.pb) || {}).t;
      g.first = g.items[0].lap;
      g.last = g.items[g.items.length - 1].lap;
      g.improve = g.first - g.pb; // cuánto bajaste desde la primera sesión
      g.lastAt = g.items[g.items.length - 1].t;
      return g;
    });
    arr.sort((a, b) => b.lastAt - a.lastAt);
    return arr;
  }, [sessions]);

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="max-w-3xl mx-auto space-y-3">
        <div className="flex items-center gap-2 mb-1">
          <TrendingDown className="size-4 text-emerald-400" />
          <h2 className="text-sm font-bold">Progreso</h2>
          <span className="text-[11px] text-muted-foreground">tu evolución de tiempos por pista y auto</span>
        </div>
        {groups.length === 0 && (
          <div className="text-xs text-muted-foreground">Todavía no hay sesiones con mejor vuelta registrada. Corré y guardá (o importá) telemetría y acá vas a ver tu evolución.</div>
        )}
        {groups.map((g, i) => <ProgressCard key={i} g={g} />)}
      </div>
    </div>
  );
}

function ProgressCard({ g }) {
  const W = 520, H = 90, PADX = 10, PADY = 12;
  const laps = g.items.map((i) => i.lap);
  const lo = Math.min(...laps), hi = Math.max(...laps);
  const span = (hi - lo) || 1;
  const n = g.items.length;
  const x = (idx) => (n <= 1 ? W / 2 : PADX + (idx / (n - 1)) * (W - 2 * PADX));
  const y = (lap) => PADY + ((lap - lo) / span) * (H - 2 * PADY); // vuelta menor = más arriba
  const pts = g.items.map((it, idx) => `${x(idx).toFixed(1)},${y(it.lap).toFixed(1)}`).join(" ");
  const [hov, setHov] = useState(null); // índice del punto bajo el cursor

  return (
    <div className="rounded-lg border border-border bg-card/40 p-3">
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold truncate">{g.track}</div>
          <div className="text-[11px] text-muted-foreground truncate">{g.car} · {n} sesion{n === 1 ? "" : "es"}</div>
        </div>
        <div className="text-right shrink-0">
          <div className="flex items-center gap-1 justify-end text-emerald-400 font-mono font-bold text-sm"><Trophy className="size-3.5" /> {fmtLap(g.pb)}</div>
          <div className="text-[10px] text-muted-foreground">PB · {fmtDate(g.pbAt)}</div>
        </div>
      </div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full block" style={{ height: 90 }}>
          {n > 1 && <polyline points={pts} fill="none" stroke="rgba(125,211,252,0.8)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
          {g.items.map((it, idx) => {
            const isPB = it.lap === g.pb;
            const active = hov === idx;
            return (
              <g key={idx}>
                {/* área de hover generosa (invisible) para captar el mouse fácil */}
                <circle cx={x(idx)} cy={y(it.lap)} r={9} fill="transparent"
                  onMouseEnter={() => setHov(idx)} onMouseLeave={() => setHov((h) => (h === idx ? null : h))} style={{ cursor: "pointer" }} />
                <circle cx={x(idx)} cy={y(it.lap)} r={isPB ? 4 : active ? 3.5 : 2.5} fill={isPB ? "rgb(52,211,153)" : "rgba(125,211,252,0.95)"} stroke={isPB || active ? "black" : "none"} strokeWidth="1" style={{ pointerEvents: "none" }} />
              </g>
            );
          })}
        </svg>
        {hov != null && (() => {
          const it = g.items[hov];
          const dPB = it.lap - g.pb;
          const prev = g.items[hov - 1];
          const dPrev = prev ? it.lap - prev.lap : null;
          const leftPct = (x(hov) / W) * 100;
          const topPx = (y(it.lap) / H) * 90;
          return (
            <div className="absolute z-50 pointer-events-none rounded-md border border-border px-2 py-1 shadow-lg text-[10px] whitespace-nowrap"
              style={{ left: `${leftPct}%`, top: topPx - 8, transform: "translate(-50%,-100%)", background: "rgba(20,22,28,0.97)" }}>
              <div className="font-mono font-bold text-foreground text-[11px]">{fmtLap(it.lap)}</div>
              <div className="text-muted-foreground">{fmtDate(it.t)}{it.type ? ` · ${it.type}` : ""}</div>
              <div style={{ color: dPB <= 0.0005 ? "rgb(52,211,153)" : "rgb(125,211,252)" }}>
                {dPB <= 0.0005 ? "◆ Récord personal" : `vs PB +${dPB.toFixed(3)}s`}
              </div>
              {dPrev != null && (
                <div style={{ color: dPrev < -0.0005 ? "rgb(52,211,153)" : dPrev > 0.0005 ? "rgb(248,113,113)" : "rgba(255,255,255,0.6)" }}>
                  vs anterior {dPrev > 0 ? "+" : dPrev < 0 ? "−" : "±"}{Math.abs(dPrev).toFixed(3)}s
                </div>
              )}
            </div>
          );
        })()}
      </div>
      <div className="flex items-center justify-between text-[10px] text-muted-foreground mt-1">
        <span>Primera: <span className="font-mono text-foreground/80">{fmtLap(g.first)}</span></span>
        {g.improve > 0.001
          ? <span className="text-emerald-400 font-semibold">▼ {g.improve.toFixed(3)}s desde la primera</span>
          : <span className="text-muted-foreground/60">sin mejora aún</span>}
        <span>Última: <span className="font-mono text-foreground/80">{fmtLap(g.last)}</span></span>
      </div>
    </div>
  );
}
