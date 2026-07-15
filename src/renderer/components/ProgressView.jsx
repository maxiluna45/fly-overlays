import React, { useEffect, useMemo, useState } from "react";
import { TrendingDown, Trophy } from "lucide-react";

// Vista de PROGRESO: agrupa todas tus sesiones por pista + auto y grafica la
// evolución de tu mejor vuelta en el tiempo, resaltando el récord personal (PB)
// y cuánto bajaste desde la primera. Además calcula la CONSISTENCIA de cada
// sesión (desvío estándar de las vueltas limpias) y su tendencia, y permite
// filtrar por tipo de sesión. Reusa el mismo listado que Análisis (grabaciones
// en vivo + archivos .ibt/.csv).

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

// Mismos 3 grupos que el filtro de overlays por sesión.
function classifyType(sessionType) {
  const s = sessionType || "";
  if (/race/i.test(s)) return "race";
  if (/qual/i.test(s)) return "qualify";
  return "practice";
}

const TYPE_COLOR = {
  race: "rgb(248,113,113)",      // rojo suave
  qualify: "rgb(196,181,253)",   // violeta
  practice: "rgba(125,211,252,0.95)", // celeste (el color histórico)
};

// Consistencia de una sesión: desvío estándar de las vueltas "limpias"
// (dentro de ±5% de la mediana, para excluir out-laps, tráfico y errores
// grandes). null si hay menos de 3 vueltas limpias — con tan pocas vueltas
// el número no dice nada.
function consistencyOf(lapTimes) {
  if (!Array.isArray(lapTimes)) return null;
  const sorted = lapTimes.filter((v) => v > 0 && isFinite(v)).sort((a, b) => a - b);
  if (sorted.length < 3) return null;
  const med = sorted[Math.floor(sorted.length / 2)];
  const clean = sorted.filter((v) => Math.abs(v - med) <= med * 0.05);
  if (clean.length < 3) return null;
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  const varr = clean.reduce((a, b) => a + (b - mean) ** 2, 0) / clean.length;
  return { stdev: Math.sqrt(varr), laps: clean.length, median: med };
}

export function ProgressView() {
  const [sessions, setSessions] = useState([]);
  const [typeFilter, setTypeFilter] = useState("all"); // all | race | qualify | practice

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
      const type = classifyType(s.sessionType);
      if (typeFilter !== "all" && type !== typeFilter) continue;
      const track = s.track || s.trackKey || "?";
      const car = s.car || "?";
      const key = `${(s.trackKey || s.track || "?").toLowerCase()}|${car.toLowerCase()}`;
      if (!map.has(key)) map.set(key, { track, car, items: [] });
      map.get(key).items.push({
        t: s.startedAt || 0,
        lap: s.bestLap,
        type: s.sessionType,
        typeGroup: type,
        source: s.source,
        cons: consistencyOf(s.lapTimes),
      });
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
      // Consistencia: última sesión con dato vs. la mediana de las anteriores,
      // para saber si además de rápido estás siendo más PAREJO.
      const withCons = g.items.filter((i) => i.cons);
      g.lastCons = withCons.length ? withCons[withCons.length - 1].cons : null;
      if (withCons.length >= 2) {
        const prev = withCons.slice(0, -1).map((i) => i.cons.stdev).sort((a, b) => a - b);
        g.prevConsMedian = prev[Math.floor(prev.length / 2)];
      } else {
        g.prevConsMedian = null;
      }
      return g;
    });
    arr.sort((a, b) => b.lastAt - a.lastAt);
    return arr;
  }, [sessions, typeFilter]);

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="max-w-3xl mx-auto space-y-3">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <TrendingDown className="size-4 text-emerald-400" />
          <h2 className="text-sm font-bold">Progreso</h2>
          <span className="text-[11px] text-muted-foreground">tu evolución de tiempos por pista y auto</span>
          <div className="flex-1" />
          <div className="flex border border-border rounded-md overflow-hidden">
            {[["all", "Todas"], ["race", "Race"], ["qualify", "Qualy"], ["practice", "Práctica"]].map(([v, l]) => (
              <button
                key={v}
                onClick={() => setTypeFilter(v)}
                className="px-2 py-0.5 text-[10px] font-bold transition-colors hover:bg-white/5"
                style={{ background: typeFilter === v ? "rgba(125,211,252,0.15)" : "transparent", color: typeFilter === v ? "rgb(125,211,252)" : "rgba(255,255,255,0.5)" }}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
        {groups.length === 0 && (
          <div className="text-xs text-muted-foreground">
            {typeFilter === "all"
              ? "Todavía no hay sesiones con mejor vuelta registrada. Corré y guardá (o importá) telemetría y acá vas a ver tu evolución."
              : "No hay sesiones de este tipo para mostrar."}
          </div>
        )}
        {groups.map((g, i) => <ProgressCard key={`${g.track}|${g.car}`} g={g} />)}
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

  // Tendencia de consistencia: última sesión con dato vs mediana de anteriores.
  // Umbral 10% para no declarar tendencia por ruido.
  const consTrend = g.lastCons && g.prevConsMedian != null
    ? (g.lastCons.stdev < g.prevConsMedian * 0.9 ? "better" : g.lastCons.stdev > g.prevConsMedian * 1.1 ? "worse" : "flat")
    : null;

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
                <circle cx={x(idx)} cy={y(it.lap)} r={isPB ? 4 : active ? 3.5 : 2.5} fill={isPB ? "rgb(52,211,153)" : TYPE_COLOR[it.typeGroup] || TYPE_COLOR.practice} stroke={isPB || active ? "black" : "none"} strokeWidth="1" style={{ pointerEvents: "none" }} />
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
              {it.cons && (
                <div className="text-muted-foreground">
                  consistencia ±{it.cons.stdev.toFixed(3)}s · mediana {fmtLap(it.cons.median)} · {it.cons.laps} vueltas limpias
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
      {g.lastCons && (
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mt-0.5">
          <span>Consistencia (últ. sesión): <span className="font-mono text-foreground/80">±{g.lastCons.stdev.toFixed(3)}s</span> en {g.lastCons.laps} vueltas limpias</span>
          {consTrend === "better" && <span className="text-emerald-400 font-semibold">▼ más parejo que antes</span>}
          {consTrend === "worse" && <span className="text-red-400 font-semibold">▲ más irregular que antes</span>}
          {consTrend === "flat" && <span className="text-muted-foreground/60">≈ estable</span>}
        </div>
      )}
    </div>
  );
}
