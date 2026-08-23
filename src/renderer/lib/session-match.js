// ¿Dos sesiones son comparables entre sí? Decide qué aparece en el desplegable
// "Referencia" del análisis.
//
// CommonJS a propósito (igual que club-flags.js): así lo pueden requerir los
// tests de `node --test`, y Vite lo resuelve por build.commonjsOptions.include.
//
// El problema que resuelve: cada fuente nombra los circuitos distinto.
//   - iRacing (.ibt / grabación): trackKey = nombre interno ("oschersleben gp")
//                                 track    = display ("Motorsport Arena Oschersleben")
//   - CSV de Garage 61:           track    = display con layout
//                                            ("Motorsport Arena Oschersleben (Grand Prix)")
//                                 trackKey = no existe
//
// Comparar "el primer nombre que cada una tenga" hacía que un CSV se midiera
// contra el nombre INTERNO de iRacing, dos sistemas de nombres sin nada en
// común: ningún CSV aparecía nunca como referencia de una sesión de iRacing.
// Por eso se prueban todos los nombres que trae cada sesión y basta con que un
// par coincida.

const norm = (x) => (x || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Prefijos que no identifican al circuito y que cada fuente pone o no.
const GEN_PREFIX = [
  'circuitde', 'circuito', 'circuit', 'autodromonazionale',
  'autodromointernacional', 'autodromo', 'autodrome', 'the',
];

const stripGen = (s) => {
  s = norm(s);
  for (const p of GEN_PREFIX) if (s.startsWith(p)) return s.slice(p.length);
  return s;
};

// Mismo auto: tolerante a los prefijos del catálogo de iRacing
// ("Global Mazda MX-5 Cup" vs "Mazda MX-5 Cup").
function sameCar(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i >= 6;
}

// Mismo circuito: tras quitar prefijos genéricos, si una base (primer bloque de
// letras) es prefijo de la otra (≥3), o hay contención o prefijo común ≥5.
function sameTrack(a, b) {
  a = stripGen(a); b = stripGen(b);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const base = (s) => (s.match(/^[a-z]+/) || [''])[0];
  const ba = base(a), bb = base(b);
  if (ba.length >= 3 && bb.length >= 3 && (ba.startsWith(bb) || bb.startsWith(ba))) return true;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i >= 5;
}

// Todos los nombres con los que una sesión puede identificar su circuito. Se
// prueban todos porque cada fuente completa unos y no otros.
const trackNames = (s) => (s ? [s.trackKey, s.track].filter(Boolean) : []);

// ¿Alguna combinación de nombres coincide? Un CSV aporta su display y una
// sesión de iRacing aporta interno + display, así que el par (display, display)
// es el que los une.
function sameTrackAny(a, b) {
  const na = trackNames(a), nb = trackNames(b);
  return na.some((x) => nb.some((y) => sameTrack(x, y)));
}

// `candidate` sirve como referencia de `current`. El llamador se encarga de
// excluir la sesión misma (por id).
function isComparableReference(candidate, current) {
  if (!candidate || !current) return false;
  if (!sameTrackAny(candidate, current)) return false;
  // Los CSV se importan a propósito para comparar y su nombre de auto viene de
  // otro catálogo, así que no se exige que el auto coincida.
  if (candidate.source === 'csv' || current.source === 'csv') return true;
  return sameCar(candidate.car, current.car);
}

export { norm, sameCar, sameTrack, sameTrackAny, trackNames, isComparableReference };
