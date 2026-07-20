// Version ESM para el renderer (Vite/browser).
// Mantiene la misma logica que club-flags.js (CJS) para evitar discrepancias.

// Estados / regiones de EE.UU. (iRacing no tiene club "USA"): todos -> us.
const US_CLUBS = [
  'california', 'carolina', 'florida', 'georgia', 'illinois', 'indiana',
  'michigan', 'mid-south', 'midwest', 'new england', 'new jersey', 'new york',
  'northwest', 'ohio', 'pennsylvania', 'plains', 'texas', 'virginias', 'west',
];

const CA_CLUBS = ['canada east', 'canada west', 'eastern canada', 'western canada'];

const CLUB_TO_ISO = {
  // Paises
  'australia': 'au',
  'new zealand': 'nz',
  'brazil': 'br',
  'brasil': 'br',
  'argentina': 'ar',
  'chile': 'cl',
  'uruguay': 'uy',
  'paraguay': 'py',
  'bolivia': 'bo',
  'peru': 'pe',
  'colombia': 'co',
  'ecuador': 'ec',
  'venezuela': 've',
  'mexico': 'mx',
  'canada': 'ca',
  'spain': 'es',
  'portugal': 'pt',
  'germany': 'de',
  'austria': 'at',
  'switzerland': 'ch',
  'belgium': 'be',
  'netherlands': 'nl',
  'luxembourg': 'lu',
  'finland': 'fi',
  'france': 'fr',
  'italy': 'it',
  'united kingdom': 'gb',
  'uk': 'gb',
  'ireland': 'ie',
  'sweden': 'se',
  'norway': 'no',
  'denmark': 'dk',
  'iceland': 'is',
  'poland': 'pl',
  'czech republic': 'cz',
  'slovakia': 'sk',
  'hungary': 'hu',
  'romania': 'ro',
  'bulgaria': 'bg',
  'greece': 'gr',
  'turkey': 'tr',
  'russia': 'ru',
  'ukraine': 'ua',
  'estonia': 'ee',
  'latvia': 'lv',
  'lithuania': 'lt',
  'croatia': 'hr',
  'serbia': 'rs',
  'slovenia': 'si',
  'japan': 'jp',
  'korea': 'kr',
  'south korea': 'kr',
  'china': 'cn',
  'taiwan': 'tw',
  'hong kong': 'hk',
  'singapore': 'sg',
  'malaysia': 'my',
  'thailand': 'th',
  'indonesia': 'id',
  'philippines': 'ph',
  'india': 'in',
  'pakistan': 'pk',
  'south africa': 'za',
  'morocco': 'ma',
  'egypt': 'eg',
  'israel': 'il',
  'uae': 'ae',
  'saudi arabia': 'sa',

  // Regiones comunes de iRacing (representativas)
  'uk and i': 'gb',
  'iberia': 'es',
  'de-at-ch': 'de',
  'benelux': 'nl',
  'scandinavia': 'se',
  'central-eastern europe': 'pl',
  'south america': 'ar',
  'asia': 'jp',
  'oceania': 'au',
  'atlantic': 'us',
  'international': 'un',

  // Alias frecuentes
  'uk i': 'gb',
  'australia nz': 'au',
  'australia new zealand': 'au',
  'anz': 'au',
};

for (const club of US_CLUBS) CLUB_TO_ISO[club] = 'us';
for (const club of CA_CLUBS) CLUB_TO_ISO[club] = 'ca';

function normalizeClub(club) {
  if (!club || typeof club !== 'string') return '';
  return club
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[\/._]/g, ' ')
    .replace(/\s+-\s+/g, '-')
    .trim()
    .replace(/\s+/g, ' ');
}

function flagCodeForClub(club) {
  const key = normalizeClub(club);
  if (!key) return null;
  return CLUB_TO_ISO[key] || null;
}

export { flagCodeForClub, normalizeClub };
