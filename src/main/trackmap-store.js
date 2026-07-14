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
// Prefijos genéricos que hacen colisionar pistas distintas (ej. "Circuit de
// Spa" vs "Circuit de Barcelona" comparten "circuitde"). Se quitan SOLO si son
// prefijo, así queda la parte distintiva ("spa…" vs "barcelona…").
const GENERIC_PREFIXES = ['circuitde', 'circuito', 'circuit', 'autodromonazionale', 'autodromointernacional', 'autodromo', 'autodrome', 'the'];
const stripGeneric = (s) => { for (const p of GENERIC_PREFIXES) if (s.startsWith(p)) return s.slice(p.length); return s; };
// Subsecuencia común más larga (desambigua config: "2000 full" vs "2000 moto",
// y cruza nombres con distinto orden como "spa 2024 up" vs "spa grand prix").
function lcsLen(a, b) {
  const nA = a.length, nB = b.length;
  let prev = new Array(nB + 1).fill(0);
  for (let i = 1; i <= nA; i++) {
    const cur = new Array(nB + 1).fill(0);
    for (let j = 1; j <= nB; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[nB];
}
function bestKeyMatch(trackName, keys) {
  const target = stripGeneric(norm(trackName));
  if (!target) return null;
  const commonPrefix = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
  const digits = (s) => (s.match(/\d+/g) || []);
  const dt = digits(target);
  let best = null, bestScore = 0;
  for (const kRaw of keys) {
    const k = stripGeneric(norm(kRaw));
    if (k === target) return kRaw; // match exacto tras normalizar/strip
    // Prefijo común ×3 (prioriza la base distintiva) + LCS + bonus por config.
    let score = commonPrefix(k, target) * 3 + lcsLen(k, target);
    if (k.includes(target) || target.includes(k)) score += Math.min(k.length, target.length);
    const dk = digits(k);
    if (dt.length && dk.length && dt.some((d) => dk.includes(d))) score += 50;
    if (score > bestScore) { bestScore = score; best = kRaw; }
  }
  return bestScore >= 12 ? best : null;
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
