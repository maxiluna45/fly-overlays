// Mapea el ClubName de iRacing (DriverInfo.Drivers[i].ClubName) a un código
// ISO-3166-1 alpha-2 en minúsculas, usable por flag-icons (clase `fi fi-<code>`).
//
// LIMITACIÓN IMPORTANTE (leer antes de "corregir" el mapa):
//   El ClubName es la REGIÓN DEL CLUB del piloto, NO su nacionalidad real.
//   - EE.UU. no tiene un club "USA": usa estados/regiones (Michigan, Texas...),
//     así que TODOS mapean a "us".
//   - Hay clubes genuinamente multipaís (Benelux, Scandinavia, South America...)
//     sin un país único correcto. Para esos devolvemos null y la fila NO muestra
//     bandera, en vez de mostrar una incorrecta. Preferimos "sin bandera" a
//     "bandera equivocada".
//   - La nacionalidad real (bandera exacta por piloto) solo la da la Data API
//     web de iRacing (OAuth 2.0), que este proyecto no usa: la telemetría local
//     solo expone el club.
//
// Clubes desconocidos → null (fallback silencioso). Agregar entradas nuevas es
// tan simple como sumar una línea normalizada al mapa.

// Estados / regiones de EE.UU. (iRacing no tiene club "USA"): todos → us.
const US_CLUBS = [
  'california', 'carolina', 'florida', 'georgia', 'illinois', 'indiana',
  'michigan', 'mid-south', 'midwest', 'new england', 'new jersey', 'new york',
  'northwest', 'ohio', 'pennsylvania', 'plains', 'texas', 'virginias', 'west',
];

const CLUB_TO_ISO = {
  // ── País único ──
  'australia': 'au',
  'brazil': 'br',
  'brasil': 'br', // variante localizada del nombre
  'canada': 'ca',
  'finland': 'fi',
  'france': 'fr',
  'italy': 'it',
  // ── Multipaís con país dominante representativo (aproximación consciente) ──
  'uk and i': 'gb',   // Reino Unido e Irlanda → bandera GB
  'iberia': 'es',     // España y Portugal → bandera ES
  'de-at-ch': 'de',   // Alemania/Austria/Suiza → bandera DE
  // ── Pan-regionales sin país único → null (definidos abajo, ver PAN_REGIONAL) ──
};

for (const club of US_CLUBS) CLUB_TO_ISO[club] = 'us';

// Clubes que agrupan muchos países sin uno dominante: explícitamente sin
// bandera (documentado para que no se "arregle" con una bandera arbitraria).
const PAN_REGIONAL = new Set([
  'benelux', 'scandinavia', 'central-eastern europe', 'asia',
  'international', 'south america',
]);

// Normaliza el nombre de club: minúsculas, sin acentos, espacios colapsados.
function normalizeClub(club) {
  if (!club || typeof club !== 'string') return '';
  return club
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita diacríticos combinantes
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

// Devuelve el código ISO2 (minúsculas) para flag-icons, o null si no hay un
// país único razonable para ese club (desconocido o pan-regional).
function flagCodeForClub(club) {
  const key = normalizeClub(club);
  if (!key) return null;
  if (PAN_REGIONAL.has(key)) return null;
  return CLUB_TO_ISO[key] || null;
}

module.exports = { flagCodeForClub, normalizeClub };
