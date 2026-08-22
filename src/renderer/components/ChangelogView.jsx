import React, { useMemo } from "react";
import { ArrowLeft, Sparkles } from "lucide-react";
import changelogMd from "../../../CHANGELOG.md?raw";
import { parseChangelog, formatReleaseDate } from "../lib/changelog.js";

// Color del encabezado según el tipo de cambio. Las claves están normalizadas
// (minúsculas, sin acentos) para tolerar cómo se escriba en el markdown.
const GROUP_COLOR = {
  agregado: "text-emerald-400",
  cambiado: "text-sky-300",
  corregido: "text-amber-400",
  eliminado: "text-red-400",
  seguridad: "text-purple-300",
  obsoleto: "text-muted-foreground",
};

function groupColor(title) {
  if (!title) return "text-muted-foreground";
  const key = title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return GROUP_COLOR[key] || "text-muted-foreground";
}

// Renderiza `código` entre backticks como <code>. El resto del ítem es texto
// plano: el changelog no necesita más markdown que esto.
function ItemText({ text }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
          <code
            key={i}
            className="px-1 py-0.5 rounded bg-accent/60 text-[11px] font-mono"
          >
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        )
      )}
    </>
  );
}

export function ChangelogView({ onBack }) {
  const releases = useMemo(() => parseChangelog(changelogMd), []);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="h-10 border-b border-border flex items-center px-4 gap-2 shrink-0">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-semibold text-muted-foreground cursor-pointer hover:bg-accent/50 hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-3.5" />
          Volver
        </button>
        <div className="flex items-center gap-1.5 ml-1">
          <Sparkles className="size-3.5 text-muted-foreground" />
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Novedades
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {releases.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No hay entradas en el changelog todavía.
          </p>
        ) : (
          <div className="max-w-3xl mx-auto flex flex-col gap-7">
            {releases.map((rel) => (
              <section key={rel.version}>
                <div className="flex items-baseline gap-2.5 pb-2 mb-3 border-b border-border">
                  <h2 className="text-lg font-bold tracking-tight">v{rel.version}</h2>
                  {rel.version === APP_VERSION && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-accent text-accent-foreground">
                      Instalada
                    </span>
                  )}
                  <div className="flex-1" />
                  {rel.date && (
                    <span className="text-xs text-muted-foreground">
                      {formatReleaseDate(rel.date)}
                    </span>
                  )}
                </div>

                <div className="flex flex-col gap-3.5">
                  {rel.groups.map((g, gi) => (
                    <div key={gi}>
                      {g.title && (
                        <h3
                          className={`text-[11px] font-semibold uppercase tracking-wider mb-1.5 ${groupColor(g.title)}`}
                        >
                          {g.title}
                        </h3>
                      )}
                      <ul className="flex flex-col gap-1.5">
                        {g.items.map((item, ii) => (
                          <li
                            key={ii}
                            className="text-[13px] leading-relaxed text-foreground/90 pl-4 relative"
                          >
                            <span className="absolute left-0 top-[0.55em] size-1 rounded-full bg-muted-foreground/60" />
                            <ItemText text={item} />
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
