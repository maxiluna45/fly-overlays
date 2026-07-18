import React, { useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, Copy, Trash2, Search } from "lucide-react";

const LEVELS = ["error", "warn", "info", "debug"];
const LEVEL_COLOR = {
  ERROR: "text-red-400",
  WARN: "text-amber-400",
  INFO: "text-sky-300",
  DEBUG: "text-muted-foreground",
};

// Parser de línea idéntico al contrato del main (formatLine/parseLine).
const LINE_RE = /^\[([^\]]+)\] \[([A-Z]+)\] \[([^\]]+)\] ([\s\S]*)$/;
function parse(line) {
  const m = typeof line === "string" && line.match(LINE_RE);
  if (!m) return null;
  return { ts: m[1], level: m[2], scope: m[3], text: m[4] };
}

export function LogView() {
  const [lines, setLines] = useState([]);        // {ts, level, scope, text}
  const [diag, setDiag] = useState(false);
  const [levelFilter, setLevelFilter] = useState({ error: true, warn: true, info: true, debug: true });
  const [scopeFilter, setScopeFilter] = useState("");
  const [query, setQuery] = useState("");
  const [autoscroll, setAutoscroll] = useState(true);
  const bottomRef = useRef(null);

  useEffect(() => {
    let mounted = true;
    window.fly?.getLogs?.({ limit: 1000 }).then((rows) => {
      if (mounted) setLines(Array.isArray(rows) ? rows : []);
    });
    window.fly?.getDiagnosticMode?.().then((v) => mounted && setDiag(!!v));
    const unsub = window.fly?.onLogLine?.((line) => {
      const p = parse(line);
      if (p) setLines((prev) => [...prev.slice(-4000), p]);
    });
    return () => { mounted = false; if (typeof unsub === "function") unsub(); };
  }, []);

  useEffect(() => {
    if (autoscroll) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [lines, autoscroll]);

  const scopes = useMemo(
    () => Array.from(new Set(lines.map((l) => l.scope))).sort(),
    [lines]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return lines.filter((l) => {
      if (!levelFilter[l.level.toLowerCase()]) return false;
      if (scopeFilter && l.scope !== scopeFilter) return false;
      if (q && !(`${l.scope} ${l.text}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [lines, levelFilter, scopeFilter, query]);

  const toggleDiag = async () => {
    const next = await window.fly?.setDiagnosticMode?.(!diag);
    setDiag(!!next);
  };
  const copyAll = () => {
    const txt = filtered.map((l) => `[${l.ts}] [${l.level}] [${l.scope}] ${l.text}`).join("\n");
    navigator.clipboard?.writeText(txt);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background text-foreground">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border flex-wrap">
        <button
          onClick={toggleDiag}
          className={`px-2.5 py-1 rounded-md text-xs font-semibold ${diag ? "bg-amber-500 text-black" : "bg-accent text-accent-foreground"}`}
          title="Sube el logging a DEBUG y activa snapshots"
        >
          Modo diagnóstico: {diag ? "ON" : "OFF"}
        </button>
        <div className="flex items-center gap-1">
          {LEVELS.map((lv) => (
            <button
              key={lv}
              onClick={() => setLevelFilter((f) => ({ ...f, [lv]: !f[lv] }))}
              className={`px-2 py-1 rounded text-[11px] font-mono uppercase ${levelFilter[lv] ? "bg-accent text-accent-foreground" : "text-muted-foreground opacity-50"}`}
            >
              {lv}
            </button>
          ))}
        </div>
        <select
          value={scopeFilter}
          onChange={(e) => setScopeFilter(e.target.value)}
          className="bg-card border border-border rounded px-2 py-1 text-xs"
        >
          <option value="">todos los módulos</option>
          {scopes.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <div className="flex items-center gap-1 bg-card border border-border rounded px-2 py-1">
          <Search size={13} className="text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="buscar..."
            className="bg-transparent text-xs outline-none w-40"
          />
        </div>
        <label className="flex items-center gap-1 text-xs text-muted-foreground ml-1">
          <input type="checkbox" checked={autoscroll} onChange={(e) => setAutoscroll(e.target.checked)} />
          auto-scroll
        </label>
        <div className="flex-1" />
        <button onClick={copyAll} className="p-1.5 rounded hover:bg-accent" title="Copiar visible"><Copy size={15} /></button>
        <button onClick={() => setLines([])} className="p-1.5 rounded hover:bg-accent" title="Limpiar vista"><Trash2 size={15} /></button>
        <button onClick={() => window.fly?.openLogsFolder?.()} className="p-1.5 rounded hover:bg-accent" title="Abrir carpeta de logs"><FolderOpen size={15} /></button>
      </div>

      {/* Lista */}
      <div className="flex-1 overflow-auto font-mono text-[11px] leading-relaxed px-4 py-2">
        {filtered.length === 0 ? (
          <div className="text-muted-foreground text-xs py-8 text-center">Sin líneas para los filtros actuales.</div>
        ) : (
          filtered.map((l, i) => (
            <div key={i} className="whitespace-pre-wrap break-words">
              <span className="text-muted-foreground">{l.ts.slice(11, 23)}</span>{" "}
              <span className={`font-bold ${LEVEL_COLOR[l.level] || ""}`}>{l.level.padEnd(5)}</span>{" "}
              <span className="text-violet-300">[{l.scope}]</span>{" "}
              <span>{l.text}</span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
