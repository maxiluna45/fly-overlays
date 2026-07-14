const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Store de mapas de pista en SVG que el usuario deja manualmente en una carpeta
// (%APPDATA%/iFly/trackmaps). Se emparejan con la sesión por nombre de archivo
// (comparado contra el nombre del circuito). La alineación del SVG con la línea
// GPS se resuelve en el renderer (auto-detección de baseline + sentido).

function dir() {
  const d = path.join(app.getPath('userData'), 'trackmaps');
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
}

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Empareja el nombre de pista contra un conjunto de claves normalizadas. Los
// nombres de iRacing varían entre el display ("Snetterton Racing Circuit") y el
// interno con config ("snetterton 300"), y las claves de geometría vienen del
// nombre+config ("snettertoncircuit300"). Puntuamos por prefijo común + si
// coincide algún número de config, y exigimos un prefijo mínimo para evitar
// falsos positivos.
function bestKeyMatch(trackName, keys) {
  const target = norm(trackName);
  if (!target) return null;
  if (keys.includes(target)) return target;
  const commonPrefix = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
  const digits = (s) => (s.match(/\d+/g) || []);
  const dt = digits(target);
  let best = null, bestScore = 0;
  for (const k of keys) {
    let score = commonPrefix(k, target);
    // Alguno contiene al otro → coincidencia fuerte del nombre base.
    if (k.includes(target) || target.includes(k)) score = Math.max(score, Math.min(k.length, target.length));
    // Config coincidente (mismo número, ej. 300) desempata entre layouts.
    const dk = digits(k);
    if (dt.length && dk.length && dt.some((d) => dk.includes(d))) score += 50;
    if (score > bestScore) { bestScore = score; best = k; }
  }
  return bestScore >= 6 ? best : null;
}

// Geometría bundleada (irdashies/iRacing, uso personal — permiso de tariknz).
// Lazy-load para no pagar el parse al arranque.
let _geo = null;
function geometry() {
  if (_geo === null) {
    try { _geo = require('./data/track-geometry.json'); } catch (_) { _geo = { tracks: {} }; }
  }
  return _geo;
}
// Busca la geometría por nombre. Devuelve { svg, centerline } donde svg dibuja
// los dos bordes (inside + outside) y centerline es la línea central ordenada
// desde la meta en el sentido de manejo (para ubicar por LapDistPct, como irdashies).
function geometryForTrack(trackName) {
  const g = geometry();
  const key = bestKeyMatch(trackName, Object.keys(g.tracks));
  const t = key ? g.tracks[key] : null;
  if (!t) return null;
  if (!t.i && !t.o) return null;
  const paths = [t.i, t.o].filter(Boolean).map((d) => `<path d="${d}"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg">${paths}</svg>`;
  return { svg, centerline: Array.isArray(t.c) ? t.c : null };
}

// Busca la pista: primero un .svg que el usuario haya dejado (override),
// si no, la geometría bundleada.
function getForTrack(trackName) {
  // 1) SVG manual del usuario (tiene prioridad).
  let files = [];
  try { files = fs.readdirSync(dir()).filter((f) => f.toLowerCase().endsWith('.svg')); } catch (_) { files = []; }
  const byKey = {};
  for (const f of files) byKey[norm(f.replace(/\.svg$/i, ''))] = f;
  const mkey = bestKeyMatch(trackName, Object.keys(byKey));
  if (mkey) {
    try { return { svg: fs.readFileSync(path.join(dir(), byKey[mkey]), 'utf8'), file: byKey[mkey], source: 'manual' }; } catch (_) {}
  }
  // 2) Geometría bundleada (con línea central para ubicar por LapDistPct).
  const geo = geometryForTrack(trackName);
  if (geo) return { svg: geo.svg, centerline: geo.centerline, source: 'bundled' };
  return { error: 'NO_MATCH' };
}

module.exports = { dir, getForTrack };
