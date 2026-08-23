import lovelyTracks from "../assets/lovely-tracks.json"; // curvas + sectores por pista (© Lovely Sim Racing, CC BY-NC-SA)

// Emparejar el nombre de pista de iRacing con la base de Lovely es tolerante a
// propósito: las claves varían el orden ("snetterton circuit 300" vs
// "snetterton 300 circuit") y el nombre de iRacing viene a veces con el display
// name y a veces con el interno.

const nrm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
// Prefijos genéricos que hacen colisionar nombres distintos (ej. "Circuit de
// Spa" vs "Circuit de Barcelona" comparten "circuitde"). Se quitan sólo si son
// prefijo, así queda la parte distintiva.
const GEN = ["circuitde", "circuito", "circuit", "autodromonazionale", "autodromointernacional", "autodromo", "autodrome", "the"];
const strip = (s) => { for (const p of GEN) if (s.startsWith(p)) return s.slice(p.length); return s; };
const cp = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
function lcs(a, b) {
  const nA = a.length, nB = b.length;
  let prev = new Array(nB + 1).fill(0);
  for (let i = 1; i <= nA; i++) {
    const cur = new Array(nB + 1).fill(0);
    for (let j = 1; j <= nB; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[nB];
}
const digits = (s) => (s.match(/\d+/g) || []);

// Datos de Lovely para una pista (curvas con nombre y límites de sector), o
// null si ninguna clave se parece lo suficiente.
export function findLovelyTrack(trackKey, trackName) {
  const target = strip(nrm(trackKey || trackName));
  if (!target) return null;
  const tracks = lovelyTracks.tracks;
  if (tracks[target]) return tracks[target];
  // Prefijo común ×3 (prioriza la base distintiva, ej "snetterton") +
  // subsecuencia común (desambigua la config: "2000 full" vs "2000 moto") +
  // bonus fuerte por número de config coincidente.
  const dt = digits(target);
  let best = null, bestScore = 0;
  for (const kRaw in tracks) {
    const k = strip(kRaw);
    let score = cp(k, target) * 3 + lcs(k, target);
    if (k.includes(target) || target.includes(k)) score += Math.min(k.length, target.length);
    const dk = digits(k);
    if (dt.length && dk.length && dt.some((d) => dk.includes(d))) score += 50;
    if (score > bestScore) { bestScore = score; best = tracks[kRaw]; }
  }
  return bestScore >= 12 ? best : null;
}

// Curvas con nombre, indexadas por fracción de vuelta. `[]` si no hay datos.
export function lovelyCorners(trackData) {
  if (!trackData || !Array.isArray(trackData.turns) || !trackData.turns.length) return [];
  return trackData.turns.map((t, i) => ({ pct: t.s, pctEnd: t.e, label: t.name || `T${i + 1}` }));
}

// Nombre de la curva de Lovely que cae dentro de un tramo detectado, para poder
// decir "Eau Rouge" en vez de "curva 3". Si hay varias (una chicana entera), se
// devuelve la primera. `null` si la pista no está en la base.
export function labelForRange(corners, pctStart, pctEnd) {
  if (!corners || !corners.length) return null;
  const inside = corners.filter((c) => c.pct >= pctStart && c.pct < pctEnd);
  if (inside.length === 1) return inside[0].label;
  if (inside.length > 1) return `${inside[0].label} / ${inside[inside.length - 1].label}`;
  // Ninguna adentro: la más cercana, si está a menos de un 1,5% de vuelta.
  let best = null, bestD = Infinity;
  for (const c of corners) {
    const d = Math.min(Math.abs(c.pct - pctStart), Math.abs(c.pct - pctEnd));
    if (d < bestD) { bestD = d; best = c; }
  }
  return bestD <= 0.015 ? best.label : null;
}
