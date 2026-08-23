// Parser del CHANGELOG.md del repo. El markdown es la única fuente: sirve para
// el repo y, parseado acá, alimenta la vista de Changelog del panel.
//
// CommonJS a propósito (igual que club-flags.js): así lo pueden requerir los
// tests de `node --test` y Vite lo resuelve igual gracias a
// build.commonjsOptions.include, que ya cubre src/renderer/lib/.
//
// Formato esperado (Keep a Changelog):
//   ## [0.8.0] - 2026-08-22
//   ### Agregado
//   - Un cambio, que puede seguir
//     en la línea de abajo indentado.

// Encabezado de release: "## [0.8.0] - 2026-08-22", con corchetes y fecha
// opcionales. La versión es lo único obligatorio.
const RELEASE_RE = /^##\s+\[?(\d+\.\d+\.\d+[^\]\s]*)\]?\s*(?:[-–]\s*(\S+))?/;
const GROUP_RE = /^###\s+(.+?)\s*$/;
const ITEM_RE = /^[-*]\s+(.*)$/;

function parseChangelog(markdown) {
  if (!markdown || typeof markdown !== 'string') return [];

  const releases = [];
  let release = null;   // release en curso
  let group = null;     // grupo (### Agregado) en curso
  let item = null;      // índice del ítem en curso, para unir continuaciones

  const pushGroup = () => {
    if (group && group.items.length) release.groups.push(group);
    group = null;
    item = null;
  };

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();

    const relMatch = raw.match(RELEASE_RE);
    if (relMatch) {
      if (release) pushGroup();
      release = { version: relMatch[1], date: relMatch[2] || null, groups: [] };
      releases.push(release);
      continue;
    }

    // Todo lo anterior a la primera release (título, preámbulo) se ignora.
    if (!release) continue;

    const groupMatch = raw.match(GROUP_RE);
    if (groupMatch) {
      pushGroup();
      group = { title: groupMatch[1], items: [] };
      continue;
    }

    const itemMatch = line.match(ITEM_RE);
    if (itemMatch) {
      // Ítems sueltos sin "### Grupo" arriba: van a un grupo sin título.
      if (!group) group = { title: null, items: [] };
      group.items.push(itemMatch[1].trim());
      item = group.items.length - 1;
      continue;
    }

    // Línea indentada que continúa el ítem anterior (no una línea en blanco).
    if (line && item !== null && group && /^\s/.test(raw)) {
      group.items[item] = `${group.items[item]} ${line}`;
      continue;
    }

    // Línea en blanco: corta la continuación, pero no el grupo.
    if (!line) item = null;
  }
  if (release) pushGroup();

  return releases;
}

// Las fechas se escriben ISO en el markdown (estándar de Keep a Changelog) y se
// muestran DD/MM/AAAA en la UI. Si no es una fecha ISO, se devuelve tal cual.
function formatReleaseDate(date) {
  if (!date) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

export { parseChangelog, formatReleaseDate };
