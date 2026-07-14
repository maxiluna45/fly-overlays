const fs = require('fs');
const path = require('path');
const https = require('https');
const { app } = require('electron');

// Geometría REAL de circuitos desde OpenStreetMap (© OpenStreetMap contributors,
// ODbL). El Lat/Lon de la telemetría de iRacing son coordenadas GEOGRÁFICAS
// reales (verificado: Spa da 50.43N/5.97E, Snetterton 52.46N/0.95E), así que la
// centerline `highway=raceway` de OSM está en el MISMO espacio que la línea GPS
// del auto → se superponen sin ninguna transformación de alineado.
//
// OSM mapea la pista como línea central (no polígono de asfalto): devolvemos la
// centerline en [lon,lat]; el ancho (bordes) se aproxima en el renderer.
// Cacheamos por pista en userData/osm-tracks (una consulta por circuito).

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

function dir() {
  const d = path.join(app.getPath('userData'), 'osm-tracks');
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
}
const safe = (s) => (s || 'track').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80) || 'track';

// POST a un endpoint de Overpass con la query. Devuelve el JSON parseado o error.
function overpassFetch(query, endpoint) {
  return new Promise((resolve, reject) => {
    const body = 'data=' + encodeURIComponent(query);
    const u = new URL(endpoint);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'iFly-analysis/0.4 (personal telemetry app)',
      },
      timeout: 60000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

async function overpassWithFallback(query) {
  let lastErr = null;
  for (const ep of ENDPOINTS) {
    try { return await overpassFetch(query, ep); }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('overpass failed');
}

// Une segmentos (ways) por coincidencia de extremos → la polilínea contigua más
// larga (el circuito principal; descarta pit lane/ramales sueltos).
function stitch(segments, eps = 2e-5) {
  const near = (a, b) => Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
  const rem = segments.map((s) => s.slice());
  const lines = [];
  while (rem.length) {
    let line = rem.shift();
    let changed = true;
    while (changed && rem.length) {
      changed = false;
      for (let i = 0; i < rem.length; i++) {
        const s = rem[i], head = line[0], tail = line[line.length - 1];
        if (near(tail, s[0])) { line.push(...s.slice(1)); rem.splice(i, 1); changed = true; break; }
        if (near(tail, s[s.length - 1])) { line.push(...s.reverse().slice(1)); rem.splice(i, 1); changed = true; break; }
        if (near(head, s[s.length - 1])) { line.unshift(...s.slice(0, -1)); rem.splice(i, 1); changed = true; break; }
        if (near(head, s[0])) { line.unshift(...s.reverse().slice(0, -1)); rem.splice(i, 1); changed = true; break; }
      }
    }
    lines.push(line);
  }
  // La más larga (por cantidad de puntos) = circuito principal.
  lines.sort((a, b) => b.length - a.length);
  return lines[0] || [];
}

function parseWays(json) {
  const ways = (json.elements || []).filter((e) => e.type === 'way' && Array.isArray(e.geometry) && e.geometry.length > 1);
  // Excluimos SOLO lo que no es superficie de pista (pit lane, paddock, karting,
  // accesos). Mantenemos todos los tramos de circuito —incluidos layouts
  // alternativos— para no recortar nada al dibujar (aunque sobre algún tramo).
  const isPit = (w) => /pit|paddock|kart|access|service|support/i.test((w.tags && w.tags.name) || '');
  const main = ways.filter((w) => !isPit(w));
  const use = main.length ? main : ways;
  return use.map((w) => w.geometry.map((p) => [p.lon, p.lat]));
}

// Devuelve la geometría cacheada o la descarga de OSM. bbox = {latMin,lonMin,latMax,lonMax}.
async function getForBBox({ latMin, lonMin, latMax, lonMax, key }) {
  const k = safe(key);
  const file = path.join(dir(), `${k}.json`);
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (_) {}
  if (![latMin, lonMin, latMax, lonMax].every((v) => typeof v === 'number' && isFinite(v))) {
    return { error: 'NO_BBOX' };
  }
  // Margen ~250 m para no cortar el circuito en el borde del bbox.
  const padLat = 0.0025, padLon = 0.0035;
  const q = `[out:json][timeout:60];(way["highway"="raceway"](${latMin - padLat},${lonMin - padLon},${latMax + padLat},${lonMax + padLon}););out geom;`;
  try {
    const json = await overpassWithFallback(q);
    const segs = parseWays(json);
    if (!segs.length) { const r = { key: k, error: 'NO_GEOMETRY', fetchedAt: Date.now() }; try { fs.writeFileSync(file, JSON.stringify(r)); } catch (_) {} return r; }
    const centerline = stitch(segs);
    const result = {
      key: k,
      source: 'osm',
      attribution: '© OpenStreetMap contributors',
      fetchedAt: Date.now(),
      centerline, // [[lon,lat], ...] del circuito principal (contiguo más largo)
      segments: segs, // TODOS los tramos de pista (cada uno [[lon,lat],...]) — el
                      // dibujo usa todos para no dejar tramos afuera si el stitch falla.
    };
    try { fs.writeFileSync(file, JSON.stringify(result)); } catch (_) {}
    return result;
  } catch (err) {
    return { error: 'FETCH_FAILED', message: String(err && err.message || err) };
  }
}

module.exports = { getForBBox, dir };
