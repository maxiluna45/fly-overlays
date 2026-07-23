# Exportar / Compartir vuelta — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir compartir una vuelta desde `AnalysisView` como tarjeta PNG (3 formatos, mapa OSM/satélite/SVG) y como archivo nativo `.iflylap` importable como ghost por otro usuario.

**Architecture:** La lógica pura (serializar/parsear `.iflylap`, formatear datos de tarjeta, construir la trazada del mapa) vive en módulos testeables con `node --test`. El render de imagen se hace en el renderer (SVG → `<canvas>` → PNG) y la persistencia/portapapeles vía IPC nuevos en el main. El import reusa el flujo `ibt:import`/`ibt:get` existente sumando el prefijo de id `ifly`.

**Tech Stack:** Electron 33 (main: `dialog`, `clipboard`, `nativeImage`, `fs`), React 18 (renderer, SVG), Vite, `node:test` + `node:assert` para tests.

## Global Constraints

- Tests: `node --test "test/**/*.test.js"` — usar `node:test` + `node:assert/strict`. Los tests solo pueden importar módulos **sin dependencias de Electron** (los parsers del main son CommonJS puros; los libs del renderer son ESM — ver nota por tarea).
- `node_type`/estilo: seguir el existente. Main = CommonJS (`require`/`module.exports`). Renderer = ESM (`import`/`export`).
- Comentarios en español, como el resto del codebase.
- El `sample` por bucket es `{ th, br, st, sp, g, rpm, t, gLat, gLon, yaw, lat, lon }` y hay `BUCKETS = 800`. No cambiar esa forma.
- Rama de trabajo: `feature/export-share-lap` (ya creada).
- Nada de dependencias npm nuevas.

---

### Task 1: Módulo `.iflylap` (build + parse) con round-trip

**Files:**
- Create: `src/main/ifly-lap.js`
- Test: `test/ifly-lap.test.js`

**Interfaces:**
- Produces:
  - `buildIflyLap(lap, session, meta) -> object` — arma el objeto `.iflylap` v1.
  - `parseIflyLapText(text) -> session` — parsea el JSON a la forma de sesión de `csv-parser` (`{ track, car, sessionType, sectorPcts, trackLength, startedAt, laps: [lap] }`).
  - `parseIflyLapSession(filePath) -> session` — lee el archivo y delega en `parseIflyLapText`.
  - `IFLY_LAP_VERSION = 1`.

- [ ] **Step 1: Escribir el test que falla (round-trip + validación)**

Crear `test/ifly-lap.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildIflyLap, parseIflyLapText, IFLY_LAP_VERSION } = require('../src/main/ifly-lap');

const sampleLap = {
  lap: 5,
  lapTime: 92.345,
  valid: true,
  sectors: [28.4, 31.9, 32.045],
  micros: new Array(24).fill(1.2),
  samples: [{ th: 1, br: 0, st: 0.1, sp: 55.5, g: 4, rpm: 7200, t: 0.5, gLat: 0.2, gLon: -0.1, yaw: 0.01, lat: -34.1, lon: -58.2 }, null],
};
const sampleSession = {
  track: 'Interlagos', trackKey: 'interlagos gp', trackIdIr: 219, carIdIr: 133,
  car: 'Ferrari 296 GT3', sessionType: 'Practice', trackLength: 4.309, sectorPcts: [0.33, 0.66],
};

test('buildIflyLap arma el objeto v1 con lap y meta', () => {
  const o = buildIflyLap(sampleLap, sampleSession, { driver: 'Maxi', exportedAt: 1000, appVersion: '0.7.5' });
  assert.equal(o.format, 'iflylap');
  assert.equal(o.version, IFLY_LAP_VERSION);
  assert.equal(o.track, 'Interlagos');
  assert.equal(o.carIdIr, 133);
  assert.equal(o.lap.lapTime, 92.345);
  assert.equal(o.meta.driver, 'Maxi');
});

test('round-trip: parseIflyLapText devuelve una sesión con la vuelta original', () => {
  const o = buildIflyLap(sampleLap, sampleSession, { driver: 'Maxi', exportedAt: 1000, appVersion: '0.7.5' });
  const s = parseIflyLapText(JSON.stringify(o));
  assert.equal(s.track, 'Interlagos');
  assert.equal(s.car, 'Ferrari 296 GT3');
  assert.equal(s.trackLength, 4.309);
  assert.equal(s.laps.length, 1);
  assert.deepEqual(s.laps[0].samples, sampleLap.samples);
  assert.equal(s.laps[0].lapTime, 92.345);
  assert.equal(s.laps[0].source, 'ifly');
});

test('parseIflyLapText rechaza format/version inválidos y JSON corrupto', () => {
  assert.throws(() => parseIflyLapText('{"format":"otro","version":1}'), /formato/i);
  assert.throws(() => parseIflyLapText('{"format":"iflylap","version":999}'), /versión|version/i);
  assert.throws(() => parseIflyLapText('no-json'), /JSON/);
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/main/ifly-lap'`.

- [ ] **Step 3: Implementar `src/main/ifly-lap.js`**

```js
const fs = require('fs');

// Formato nativo de iFly para compartir UNA vuelta como ghost/referencia.
// Estructura de sesión de salida idéntica a la de csv-parser/ibt-parser para
// reusar todo el render del análisis (una sesión con una sola vuelta).
const IFLY_LAP_VERSION = 1;

function buildIflyLap(lap, session, meta = {}) {
  const s = session || {};
  return {
    format: 'iflylap',
    version: IFLY_LAP_VERSION,
    track: s.track || null,
    trackKey: s.trackKey || null,
    trackIdIr: s.trackIdIr ?? null,
    carIdIr: s.carIdIr ?? null,
    car: s.car || null,
    sessionType: s.sessionType || null,
    trackLength: s.trackLength ?? null,
    sectorPcts: Array.isArray(s.sectorPcts) ? s.sectorPcts : null,
    lap: {
      lap: lap.lap ?? 1,
      lapTime: lap.lapTime ?? 0,
      valid: lap.valid !== false,
      sectors: lap.sectors ?? null,
      micros: lap.micros ?? null,
      samples: Array.isArray(lap.samples) ? lap.samples : [],
    },
    meta: {
      driver: meta.driver || '',
      exportedAt: meta.exportedAt || 0,
      appVersion: meta.appVersion || '',
    },
  };
}

function parseIflyLapText(text) {
  let o;
  try { o = JSON.parse(text); } catch (_) { throw new Error('.iflylap no es JSON válido'); }
  if (!o || o.format !== 'iflylap') throw new Error('Archivo con formato desconocido (no es .iflylap)');
  if (o.version !== IFLY_LAP_VERSION) throw new Error(`Versión de .iflylap no soportada: ${o.version}`);
  if (!o.lap || !Array.isArray(o.lap.samples)) throw new Error('.iflylap sin muestras de vuelta');
  const lap = {
    lap: o.lap.lap ?? 1,
    lapTime: o.lap.lapTime ?? 0,
    valid: o.lap.valid !== false,
    sectors: o.lap.sectors ?? null,
    micros: o.lap.micros ?? null,
    samples: o.lap.samples,
    source: 'ifly',
    label: o.meta && o.meta.driver ? o.meta.driver : (o.track || 'iflylap'),
  };
  return {
    track: o.track || 'iflylap',
    trackKey: o.trackKey || null,
    trackIdIr: o.trackIdIr ?? null,
    carIdIr: o.carIdIr ?? null,
    car: o.car || 'iFly',
    sessionType: o.sessionType || 'Import',
    sectorPcts: Array.isArray(o.sectorPcts) ? o.sectorPcts : null,
    trackLength: o.trackLength ?? null,
    startedAt: (o.meta && o.meta.exportedAt) || 0,
    laps: [lap],
  };
}

function parseIflyLapSession(filePath) {
  const text = fs.readFileSync(filePath, 'utf-8');
  const s = parseIflyLapText(text);
  if (!s.startedAt) {
    try { s.startedAt = Math.floor(fs.statSync(filePath).mtimeMs); } catch (_) {}
  }
  return s;
}

module.exports = { buildIflyLap, parseIflyLapText, parseIflyLapSession, IFLY_LAP_VERSION };
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npm test`
Expected: PASS (3 tests de `ifly-lap.test.js`).

- [ ] **Step 5: Commit**

```bash
git add src/main/ifly-lap.js test/ifly-lap.test.js
git commit -m "feat: modulo .iflylap (build + parse) con round-trip"
```

---

### Task 2: IPC de export/import de la vuelta `.iflylap`

**Files:**
- Modify: `src/main/main.js` (handler `ibt:import` ~521-547, handler `ibt:get` ~592-626; agregar handler `export:save-lap`)
- Modify: `src/main/preload.js` (agregar `exportSaveLap`)
- Modify: `src/renderer/components/AnalysisView.jsx:856` (regex de fuente)

**Interfaces:**
- Consumes: `buildIflyLap`, `parseIflyLapSession` (Task 1).
- Produces:
  - IPC `export:save-lap` (payload `{ obj, defaultName }`) → `{ ok, path } | { ok:false, canceled|error }`.
  - `window.fly.exportSaveLap(obj, defaultName) -> Promise`.
  - id de import con prefijo `iflypath:<abspath>` y `source: 'ifly'`.

- [ ] **Step 1: Import — aceptar `.iflylap` en `ibt:import`**

En `src/main/main.js`, en el handler `ibt:import`, agregar el require arriba (junto a los otros parsers, ~línea 9):

```js
const { buildIflyLap, parseIflyLapSession } = require('./ifly-lap');
```

Reemplazar el bloque de filtros y el manejo por extensión dentro de `ibt:import`:

```js
    const res = await dialog.showOpenDialog(parent, {
      title: 'Importar telemetría (.ibt de iRacing, .csv o .iflylap)',
      filters: [
        { name: 'Telemetría (.ibt, .csv, .iflylap)', extensions: ['ibt', 'csv', 'iflylap'] },
        { name: 'iRacing telemetry (.ibt)', extensions: ['ibt'] },
        { name: 'CSV', extensions: ['csv'] },
        { name: 'iFly lap (.iflylap)', extensions: ['iflylap'] },
      ],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const full = res.filePaths[0];
    const low = full.toLowerCase();
    if (low.endsWith('.iflylap')) {
      try {
        const s = parseIflyLapSession(full);
        return { id: `iflypath:${full}`, source: 'ifly', imported: true, file: path.basename(full),
          track: s.track, car: s.car, sessionType: s.sessionType, startedAt: s.startedAt, lapCount: 1, bestLap: s.laps[0].lapTime || null };
      } catch (err) { console.error('[ifly] import error:', err.message); return null; }
    }
    if (low.endsWith('.csv')) {
      const meta = parseCsvMeta(full);
      if (!meta) return null;
      return { id: `csvpath:${full}`, source: 'csv', imported: true, file: path.basename(full), ...meta };
    }
    const meta = parseIbtMeta(full);
    if (!meta) return null;
    return { id: `ibtpath:${full}`, source: 'ibt', imported: true, file: path.basename(full), ...meta };
```

- [ ] **Step 2: Import — resolver `iflypath:` en `ibt:get`**

En el handler `ibt:get`, agregar una rama antes de `if (!full) return null;`:

```js
  } else if (id.startsWith('iflypath:')) {
    const p = id.slice(9);
    if (p.toLowerCase().endsWith('.iflylap') && fs.existsSync(p)) { full = p; kind = 'ifly'; }
  }
```

Y en el `try` de parseo, contemplar el kind `ifly`:

```js
  try {
    const session = kind === 'csv' ? parseCsvSession(full)
      : kind === 'ifly' ? parseIflyLapSession(full)
      : parseIbtSession(full);
    return { id, source: kind, ...session };
  } catch (err) {
```

- [ ] **Step 3: Export — handler `export:save-lap`**

El renderer pasa `{ obj: { lap, session, meta }, defaultName }`; el main arma el `.iflylap`
con `buildIflyLap` (Task 1) y lo escribe. Agregar cerca de los otros handlers de `ibt:*`:

```js
ipcMain.handle('export:save-lap', async (_e, payload) => {
  try {
    const parent = dashboardWindow && !dashboardWindow.isDestroyed() ? dashboardWindow : null;
    const defaultName = (payload && payload.defaultName) || 'vuelta.iflylap';
    const res = await dialog.showSaveDialog(parent, {
      title: 'Guardar vuelta de referencia (.iflylap)',
      defaultPath: defaultName,
      filters: [{ name: 'iFly lap', extensions: ['iflylap'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    const { lap, session, meta } = payload.obj || {};
    const obj = buildIflyLap(lap, session, meta);
    fs.writeFileSync(res.filePath, JSON.stringify(obj), 'utf-8');
    return { ok: true, path: res.filePath };
  } catch (err) {
    console.error('[export] save-lap error:', err.message);
    return { ok: false, error: err.message };
  }
});
```

- [ ] **Step 4: Preload + regex de fuente**

En `src/main/preload.js`, dentro de `exposeInMainWorld('fly', { ... })`, agregar:

```js
  exportSaveLap: (obj, defaultName) => ipcRenderer.invoke('export:save-lap', { obj, defaultName }),
```

En `src/renderer/components/AnalysisView.jsx:856` cambiar:

```js
    const isFile = /^(ibt|csv|ifly)/.test(selectedId); // .ibt/.csv/.iflylap escaneados o importados
```

- [ ] **Step 5: Verificación manual**

Run: `npm run dev`
Verificar: (a) importar un `.iflylap` (generado a mano con la forma del Task 1) lo muestra en el listado y se puede seleccionar/usar como ghost; (b) `ibt:import` sigue aceptando `.ibt`/`.csv` sin cambios.

- [ ] **Step 6: Commit**

```bash
git add src/main/main.js src/main/preload.js src/renderer/components/AnalysisView.jsx
git commit -m "feat: import/export de vuelta .iflylap via IPC"
```

---

### Task 3: Campo `displayName` en la config

**Files:**
- Modify: `src/main/config-store.js` (merge en load ~195-201, agregar `setDisplayName` ~después de 255)
- Modify: `src/main/main.js` (handler `settings:set-display-name`)
- Modify: `src/main/preload.js` (`setDisplayName`)

**Interfaces:**
- Produces: `configStore.get().displayName` (string, default `''`), `configStore.setDisplayName(name)`, IPC `settings:set-display-name`, `window.fly.setDisplayName(name)`.

- [ ] **Step 1: config-store — persistir `displayName`**

En `config-store.js`, en el objeto que arma `_load()` (donde están `telemetryDir`, `sessionLabels`, etc., ~195-201) agregar:

```js
          displayName: typeof parsed.displayName === 'string' ? parsed.displayName : '',
```

Y agregar el setter después de `setTelemetryDir` (~255):

```js
  setDisplayName(name) {
    this.data.displayName = typeof name === 'string' ? name.slice(0, 40) : '';
    this._save();
    this._emit();
    return this.data.displayName;
  }
```

- [ ] **Step 2: IPC + preload**

En `main.js` (cerca de `config:get`):

```js
ipcMain.handle('settings:set-display-name', (_e, name) => configStore.setDisplayName(name));
```

En `preload.js`:

```js
  setDisplayName: (name) => ipcRenderer.invoke('settings:set-display-name', name),
```

- [ ] **Step 3: Verificación manual**

Run: `npm run dev`
Verificar en la consola del renderer: `await window.fly.setDisplayName('Maxi')` devuelve `'Maxi'`, y `(await window.fly.getConfig()).displayName === 'Maxi'`.

- [ ] **Step 4: Commit**

```bash
git add src/main/config-store.js src/main/main.js src/main/preload.js
git commit -m "feat: displayName persistente en config"
```

---

### Task 4: Refactor `lib/track-render.js` (trazada compartida)

**Files:**
- Create: `src/renderer/lib/track-render.js`
- Test: `test/track-render.test.js`
- Modify: `src/renderer/components/AnalysisView.jsx` (consumir el módulo en `MapPanel`)

**Interfaces:**
- Produces (funciones puras, ESM):
  - `speedColor(sp, spMin, spMax) -> string` (hsl azul→rojo).
  - `buildTrackSegments(mapPath) -> segments[]` — recibe el array `mapPath` (puntos `{x,y,hue,th,br}` o null por bucket) y devuelve segmentos Bézier `{x1,y1,x2,y2,c1x,c1y,c2x,c2y,hue}` (misma lógica Catmull-Rom que hoy vive en `MapPanel.segs`).
  - Reexporta `fitAffine`, `applyAffine`, `fitSimilarity`, `applySim` (movidas desde `AnalysisView`).

**Nota de test (ESM):** `node --test` corre CommonJS por defecto. Para testear un módulo ESM del renderer, el archivo de test usa `import()` dinámico. Alternativa aceptada: escribir `track-render.js` como ESM y el test con `const mod = await import('../src/renderer/lib/track-render.js')`. Node ejecuta archivos `.test.js` con soporte ESM vía import dinámico sin config extra.

- [ ] **Step 1: Test de `buildTrackSegments` y `speedColor`**

Crear `test/track-render.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('buildTrackSegments conecta puntos consecutivos y saltea huecos grandes', async () => {
  const { buildTrackSegments } = await import('../src/renderer/lib/track-render.js');
  const path = new Array(10).fill(null);
  path[0] = { x: 0, y: 0, hue: 200 };
  path[1] = { x: 1, y: 1, hue: 200 };
  path[2] = { x: 2, y: 2, hue: 200 };
  // hueco grande entre idx 2 y 9 (>6) → no se conecta
  path[9] = { x: 9, y: 9, hue: 0 };
  const segs = buildTrackSegments(path);
  assert.equal(segs.length, 2); // 0-1 y 1-2, no 2-9
  assert.ok('c1x' in segs[0] && 'x2' in segs[0]);
});

test('speedColor mapea min→azul y max→rojo', async () => {
  const { speedColor } = await import('../src/renderer/lib/track-render.js');
  assert.match(speedColor(0, 0, 100), /^hsl\(/);
  assert.notEqual(speedColor(0, 0, 100), speedColor(100, 0, 100));
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npm test`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Crear `src/renderer/lib/track-render.js`**

Mover desde `AnalysisView.jsx` las funciones `fitSimilarity`, `applySim`, `fitAffine`, `applyAffine` (líneas ~146-210) y extraer la construcción de segmentos que hoy vive en `MapPanel` (`segs = useMemo(...)`, líneas ~514-539). Escribir:

```js
// Trazada del mapa compartida entre el análisis (MapPanel) y la tarjeta (ShareCard).
// Funciones PURAS: reciben datos y devuelven paths/segmentos, sin React ni DOM.

export function speedColor(sp, spMin, spMax) {
  const span = (spMax - spMin) || 1;
  const t = Math.max(0, Math.min(1, (sp - spMin) / span));
  // azul (240) → rojo (0)
  const hue = 240 - t * 240;
  return `hsl(${Math.round(hue)},85%,55%)`;
}

// mapPath: array de largo BUCKETS con { x, y, hue, th?, br? } o null.
// Devuelve segmentos Bézier cúbicos (Catmull-Rom, tensión 1/6) uniendo puntos
// válidos consecutivos; saltea huecos > 6 buckets (posible dropout).
export function buildTrackSegments(mapPath) {
  const out = [];
  if (!Array.isArray(mapPath)) return out;
  const pts = [];
  for (let i = 0; i < mapPath.length; i++) if (mapPath[i]) pts.push({ i, p: mapPath[i] });
  for (let k = 1; k < pts.length; k++) {
    const prv = pts[k - 1], cur = pts[k];
    if (cur.i - prv.i > 6) continue;
    const a = prv.p, b = cur.p;
    const p0 = (pts[k - 2] || prv).p, p3 = (pts[k + 1] || cur).p;
    const c1x = a.x + (b.x - p0.x) / 6, c1y = a.y + (b.y - p0.y) / 6;
    const c2x = b.x - (p3.x - a.x) / 6, c2y = b.y - (p3.y - a.y) / 6;
    out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, c1x, c1y, c2x, c2y, hue: b.hue, th: b.th, br: b.br });
  }
  return out;
}

// Ajuste de similitud 2D (Umeyama): src → dst. { s, cos, sin, tx, ty, err }.
export function fitSimilarity(src, dst) { /* mover cuerpo tal cual desde AnalysisView */ }
export function applySim(T, x, y) { /* idem */ }
export function fitAffine(src, dst) { /* mover cuerpo tal cual desde AnalysisView */ }
export function applyAffine(T, x, y) { /* idem */ }
```

**Al mover `fitSimilarity/applySim/fitAffine/applyAffine`, copiar el cuerpo EXACTO desde `AnalysisView.jsx:146-210` (no reescribir la matemática).**

- [ ] **Step 4: Consumir el módulo en `AnalysisView.jsx`**

En `AnalysisView.jsx`:
1. Borrar las definiciones locales de `fitSimilarity`, `applySim`, `fitAffine`, `applyAffine` (movidas).
2. Agregar al tope: `import { buildTrackSegments, fitSimilarity, applySim, fitAffine, applyAffine, speedColor } from "../lib/track-render.js";`
3. En `MapPanel`, reemplazar el cuerpo del `useMemo` de `segs` por: `const segs = useMemo(() => (showLap ? buildTrackSegments(mapPath) : []), [mapPath, showLap]);` — manteniendo el mapeo de `dv`/`gr` que hoy hace el `useMemo` **fuera** de `buildTrackSegments` (la parte de comparación/grip queda en `AnalysisView` porque depende de `mapDelta`/`gripLap`; solo se comparte la geometría base). Si el `dv`/`gr` se calculaba dentro, envolver: construir con `buildTrackSegments` y luego `.map` para inyectar `dv`/`gr` por índice.

- [ ] **Step 5: Correr tests + verificación visual**

Run: `npm test` → PASS.
Run: `npm run dev` → el mapa del análisis se ve **idéntico** a antes (sin regresión): trazada por velocidad, comparación, grip, satélite y OSM.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/lib/track-render.js test/track-render.test.js src/renderer/components/AnalysisView.jsx
git commit -m "refactor: extraer trazada del mapa a lib/track-render (compartida con ShareCard)"
```

---

### Task 5: Datos de la tarjeta (`lib/share-card-data.js`)

**Files:**
- Create: `src/renderer/lib/share-card-data.js`
- Test: `test/share-card-data.test.js`

**Interfaces:**
- Produces (ESM, puro):
  - `fmtLapTime(sec) -> string` (`m:ss.mmm`).
  - `fmtSector(sec) -> string`.
  - `buildCardModel({ lap, session, best, displayName }) -> { time, sectors:[{label,value}], badge, driver, car, track, date, isPB }`.
  - `FORMATS = { story: {w:1080,h:1920}, square: {w:1080,h:1080}, wide: {w:1920,h:1080} }`.

- [ ] **Step 1: Test**

Crear `test/share-card-data.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('fmtLapTime formatea m:ss.mmm', async () => {
  const { fmtLapTime } = await import('../src/renderer/lib/share-card-data.js');
  assert.equal(fmtLapTime(92.345), '1:32.345');
  assert.equal(fmtLapTime(0), '—');
});

test('buildCardModel arma el modelo con badge PB cuando la vuelta es la mejor', async () => {
  const { buildCardModel } = await import('../src/renderer/lib/share-card-data.js');
  const lap = { lapTime: 92.3, valid: true, sectors: [28.4, 31.9, 32.0] };
  const m = buildCardModel({ lap, session: { car: 'F296', track: 'Interlagos' }, best: lap, displayName: 'Maxi' });
  assert.equal(m.time, '1:32.300');
  assert.equal(m.isPB, true);
  assert.equal(m.sectors.length, 3);
  assert.equal(m.driver, 'Maxi');
  assert.equal(m.car, 'F296');
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npm test` → FAIL (módulo inexistente).

- [ ] **Step 3: Implementar `src/renderer/lib/share-card-data.js`**

```js
export const FORMATS = {
  story:  { w: 1080, h: 1920, label: 'Historia 9:16' },
  square: { w: 1080, h: 1080, label: 'Cuadrada 1:1' },
  wide:   { w: 1920, h: 1080, label: 'Apaisada 16:9' },
};

export function fmtLapTime(sec) {
  if (sec == null || !isFinite(sec) || sec <= 0) return '—';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

export function fmtSector(sec) {
  if (sec == null || !isFinite(sec) || sec <= 0) return '—';
  return sec.toFixed(3);
}

export function buildCardModel({ lap, session, best, displayName }) {
  const s = session || {};
  const sectors = Array.isArray(lap.sectors)
    ? lap.sectors.map((v, i) => ({ label: `S${i + 1}`, value: fmtSector(v) }))
    : [];
  const isPB = !!(best && lap && best.lapTime === lap.lapTime);
  return {
    time: fmtLapTime(lap.lapTime),
    sectors,
    badge: isPB ? 'PB' : (lap.valid ? 'VÁLIDA' : 'INVÁLIDA'),
    isPB,
    driver: displayName || '',
    car: s.car || '',
    track: s.track || '',
    date: s.startedAt ? new Date(s.startedAt).toLocaleDateString('es-CO') : '',
  };
}
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/lib/share-card-data.js test/share-card-data.test.js
git commit -m "feat: modelo de datos de la tarjeta de compartir"
```

---

### Task 6: Render SVG→PNG + IPC de imagen (guardar/copiar)

**Files:**
- Create: `src/renderer/lib/render-svg-to-png.js`
- Modify: `src/main/main.js` (handlers `export:save-image`, `export:copy-image`; require de `clipboard`, `nativeImage`)
- Modify: `src/main/preload.js` (`exportSaveImage`, `exportCopyImage`)

**Interfaces:**
- Produces:
  - `svgToPngBlob(svgEl, w, h) -> Promise<Blob>` (renderer).
  - `blobToArrayBuffer(blob) -> Promise<ArrayBuffer>`.
  - IPC `export:save-image` (`{ buffer, defaultName }`) y `export:copy-image` (`{ buffer }`).
  - `window.fly.exportSaveImage(buffer, name)`, `window.fly.exportCopyImage(buffer)`.

- [ ] **Step 1: Util de render (renderer)**

Crear `src/renderer/lib/render-svg-to-png.js`:

```js
// Serializa un <svg> del DOM y lo rasteriza a PNG del tamaño (w×h) exacto.
// IMPORTANTE: cualquier <image> dentro del SVG (tiles satelitales) debe estar
// embebido como data URL antes de llamar acá, o el canvas se "contamina"
// (CORS) y toBlob() falla.
export function svgToPngBlob(svgEl, w, h) {
  return new Promise((resolve, reject) => {
    try {
      const xml = new XMLSerializer().serializeToString(svgEl);
      const svg64 = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob devolvió null (¿canvas contaminado?)'))), 'image/png');
      };
      img.onerror = () => reject(new Error('no se pudo cargar el SVG como imagen'));
      img.src = svg64;
    } catch (err) { reject(err); }
  });
}

export function blobToArrayBuffer(blob) {
  return blob.arrayBuffer();
}
```

- [ ] **Step 2: IPC de imagen (main)**

En `main.js`, asegurar el require: `const { app, BrowserWindow, ipcMain, globalShortcut, dialog, shell, clipboard, nativeImage } = require('electron');` (agregar `clipboard, nativeImage` a la desestructuración existente de la línea 1).

Agregar handlers:

```js
ipcMain.handle('export:save-image', async (_e, payload) => {
  try {
    const parent = dashboardWindow && !dashboardWindow.isDestroyed() ? dashboardWindow : null;
    const res = await dialog.showSaveDialog(parent, {
      title: 'Guardar imagen de la vuelta',
      defaultPath: (payload && payload.defaultName) || 'iFly.png',
      filters: [{ name: 'PNG', extensions: ['png'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(res.filePath, Buffer.from(payload.buffer));
    return { ok: true, path: res.filePath };
  } catch (err) { console.error('[export] save-image:', err.message); return { ok: false, error: err.message }; }
});

ipcMain.handle('export:copy-image', (_e, payload) => {
  try {
    const img = nativeImage.createFromBuffer(Buffer.from(payload.buffer));
    if (img.isEmpty()) return { ok: false, error: 'imagen vacía' };
    clipboard.writeImage(img);
    return { ok: true };
  } catch (err) { console.error('[export] copy-image:', err.message); return { ok: false, error: err.message }; }
});
```

- [ ] **Step 3: Preload**

En `preload.js`:

```js
  exportSaveImage: (buffer, defaultName) => ipcRenderer.invoke('export:save-image', { buffer, defaultName }),
  exportCopyImage: (buffer) => ipcRenderer.invoke('export:copy-image', { buffer }),
```

- [ ] **Step 4: Verificación manual (smoke con SVG dummy)**

Run: `npm run dev`, y en la consola del renderer probar `svgToPngBlob` con un `<svg>` simple montado → obtener un Blob PNG > 0 bytes; `window.fly.exportCopyImage(await (await svgToPngBlob(...)).arrayBuffer())` devuelve `{ ok: true }` y se puede pegar en WhatsApp.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/lib/render-svg-to-png.js src/main/main.js src/main/preload.js
git commit -m "feat: render SVG->PNG + IPC guardar/copiar imagen"
```

---

### Task 7: `ShareCard.jsx` (tarjeta SVG, 3 formatos, selector de mapa)

**Files:**
- Create: `src/renderer/components/ShareCard.jsx`

**Interfaces:**
- Consumes: `buildTrackSegments`, `speedColor`, `fitAffine`, `applyAffine` (Task 4); `buildCardModel`, `FORMATS` (Task 5).
- Produces: `<ShareCard ref={svgRef} model={...} segments={...} outlineD={...} tiles={...} format="square" />` — renderiza un `<svg width={w} height={h}>` con el mapa (según fuente) + tiempo + sectores + badge + meta + wordmark iFLY. Expone el nodo `<svg>` vía `ref` para que Task 8 lo rasterice.

**Nota:** este componente es **visual**; se verifica a ojo. Se entrega una implementación base funcional para el formato `square`; los formatos `story` y `wide` reusan el mismo subárbol de contenido reacomodando posiciones (mismo `model`, distinto layout). No es un placeholder: es el mismo contenido con coordenadas por formato.

- [ ] **Step 1: Implementar `ShareCard.jsx` (base + layout square)**

```jsx
import React, { forwardRef } from "react";
import { FORMATS } from "../lib/share-card-data.js";

// Tarjeta SVG para compartir una vuelta. El <svg> se expone por ref para
// rasterizarlo a PNG (ver render-svg-to-png). `mapEls` es el subárbol del mapa
// ya construido por el contenedor (segmentos de trazada + outline/tiles según
// fuente), para no duplicar la lógica de alineado acá.
export const ShareCard = forwardRef(function ShareCard({ model, mapEls, format = "square" }, ref) {
  const F = FORMATS[format] || FORMATS.square;
  const { w, h } = F;
  const vertical = format === "story";
  // Zona del mapa según formato.
  const map = vertical
    ? { x: 60, y: 120, w: w - 120, h: h * 0.5 }
    : { x: 60, y: 90, w: w * 0.52, h: h - 260 };
  const stats = vertical
    ? { x: 60, y: map.y + map.h + 40 }
    : { x: map.x + map.w + 60, y: 140 };
  return (
    <svg ref={ref} width={w} height={h} viewBox={`0 0 ${w} ${h}`} xmlns="http://www.w3.org/2000/svg" style={{ background: "#0b0e14" }}>
      <rect x="0" y="0" width={w} height={h} fill="#0b0e14" />
      <text x="60" y="70" fill="#38bdf8" fontSize="40" fontWeight="800" fontFamily="sans-serif">iFLY</text>
      {/* Mapa (subárbol ya alineado, escalado al viewport del mapa) */}
      <g transform={`translate(${map.x},${map.y})`}>{mapEls}</g>
      {/* Tiempo */}
      <text x={stats.x} y={stats.y} fill="#fff" fontSize="96" fontWeight="800" fontFamily="sans-serif">{model.time}</text>
      <text x={stats.x} y={stats.y + 44} fill={model.isPB ? "#34d399" : "#94a3b8"} fontSize="30" fontWeight="700" fontFamily="sans-serif">▸ {model.badge}</text>
      {/* Sectores */}
      {model.sectors.map((s, i) => (
        <text key={i} x={stats.x} y={stats.y + 110 + i * 42} fill="#cbd5e1" fontSize="34" fontFamily="monospace">{s.label}  {s.value}</text>
      ))}
      {/* Meta */}
      <text x={stats.x} y={h - 120} fill="#e2e8f0" fontSize="34" fontWeight="700" fontFamily="sans-serif">{model.track}</text>
      <text x={stats.x} y={h - 80} fill="#94a3b8" fontSize="28" fontFamily="sans-serif">{model.car}</text>
      <text x={stats.x} y={h - 44} fill="#64748b" fontSize="26" fontFamily="sans-serif">{[model.driver, model.date].filter(Boolean).join(" · ")}</text>
    </svg>
  );
});
```

- [ ] **Step 2: Verificación visual (montaje temporal)**

Montar `ShareCard` temporalmente en `AnalysisView` con datos de una vuelta real y `mapEls` = los segmentos ya construidos (color por velocidad) escalados a `map.w×map.h`. Verificar los 3 formatos (pasar `format` "story"/"square"/"wide") y que el texto no se desborde.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/ShareCard.jsx
git commit -m "feat: componente ShareCard (tarjeta SVG, 3 formatos)"
```

---

### Task 8: `SharePanel` en AnalysisView (wiring final)

**Files:**
- Modify: `src/renderer/components/AnalysisView.jsx` (botón "Compartir" en la vuelta seleccionada + panel)

**Interfaces:**
- Consumes: todo lo anterior (`ShareCard`, `buildCardModel`, `svgToPngBlob`, `blobToArrayBuffer`, `buildIflyLap` via IPC, `window.fly.export*`, `window.fly.getOsmTrack`, `window.fly.getConfig`).

- [ ] **Step 1: Estado y datos**

En `AnalysisView`, agregar estado: `const [shareOpen, setShareOpen] = useState(false);`, `const [shareFormat, setShareFormat] = useState('square');`, `const [shareMapSource, setShareMapSource] = useState('osm');`, `const [displayName, setDisplayName] = useState('');`. Cargar `displayName` en un `useEffect` con `window.fly.getConfig().then(c => setDisplayName(c?.displayName || ''))`.

- [ ] **Step 2: Construir el modelo y el subárbol del mapa**

Con la vuelta seleccionada `lap`, `session`, `best`: `const cardModel = useMemo(() => buildCardModel({ lap, session, best, displayName }), [lap, session, best, displayName]);`. Para `mapEls`: reusar los puntos alineados que ya calcula `MapPanel` (extraer a un helper `buildMapPath(samples, osmTrack, source, box)` en `track-render.js` si hace falta) y `buildTrackSegments`, coloreando con `speedColor`. Fuente del mapa según `shareMapSource` con **fallback a 'svg'** si OSM/tiles no disponibles (reusar la lógica de disponibilidad de `AnalysisView`).

- [ ] **Step 3: Botón "Compartir" + panel**

Agregar un botón `Compartir` junto al header de la vuelta seleccionada que abre un panel con: selector de formato (`FORMATS`), selector de fuente de mapa (solo las disponibles), preview del `ShareCard`, y botones **Copiar**, **Guardar PNG**, **Exportar .iflylap**, más un input para `displayName` (guarda con `window.fly.setDisplayName`).

- [ ] **Step 4: Acciones**

```jsx
const svgRef = React.useRef(null);
const doCopy = async () => {
  const { w, h } = FORMATS[shareFormat];
  const blob = await svgToPngBlob(svgRef.current, w, h);
  const buf = await blob.arrayBuffer();
  const r = await window.fly.exportCopyImage(buf);
  // toast: r.ok ? 'Copiado' : error
};
const doSave = async () => {
  const { w, h } = FORMATS[shareFormat];
  const blob = await svgToPngBlob(svgRef.current, w, h);
  const buf = await blob.arrayBuffer();
  await window.fly.exportSaveImage(buf, `iFly - ${session.track} - ${cardModel.time}.png`);
};
const doExportLap = async () => {
  // El main arma el .iflylap con buildIflyLap (ver Task 2, Step 3); acá solo
  // pasamos { lap, session, meta } + el nombre por defecto.
  await window.fly.exportSaveLap({ lap, session, meta: { driver: displayName, exportedAt: Date.now(), appVersion: '0.7.5' } },
    `${session.track} - ${session.car} - ${cardModel.time}.iflylap`);
};
```

Nota: `window.fly.exportSaveLap(obj, defaultName)` (Task 2) envía `{ obj, defaultName }`; el handler ya llama `buildIflyLap(obj.lap, obj.session, obj.meta)`.

- [ ] **Step 5: Deshabilitar cuando no hay mapa/samples**

Si `!lap || !Array.isArray(lap.samples) || !lap.samples.some(Boolean)`, deshabilitar "Compartir" con `title` explicativo.

- [ ] **Step 6: Verificación manual (end-to-end)**

Run: `npm run dev`. Con una sesión real: abrir Compartir → probar los 3 formatos × (OSM / satélite / SVG) → **Copiar** (pegar en WhatsApp), **Guardar PNG** (abre el archivo), **Exportar .iflylap** → reimportarlo (Task 2) y usarlo como ghost. Verificar el fallback a SVG en una pista sin OSM.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/AnalysisView.jsx src/main/main.js
git commit -m "feat: panel Compartir en AnalysisView (imagen + .iflylap)"
```

---

## Notas de cierre

- **Tiles satelitales embebidos:** en el Step 2 de Task 8, si `shareMapSource === 'sat'`, los `<image>` del mapa deben usar data URLs (no URLs remotas de Esri) antes de rasterizar. Si el flujo actual de tiles entrega URLs remotas, agregar en el main un `export:tile-data-url` que descargue el tile y lo devuelva como data URL, y resolverlos antes de montar el `ShareCard` para export. Si eso agrega mucho alcance, entregar primero OSM+SVG y sumar satélite en un commit aparte dentro de esta misma rama.
- **displayName y PII:** default vacío; el usuario decide qué poner. No se toma el nombre real de iRacing automáticamente.
