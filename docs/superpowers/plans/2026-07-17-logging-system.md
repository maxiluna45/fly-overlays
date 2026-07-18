# Sistema de logging + visualizador in-app — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar a FlyOverlays logging persistente y rotativo (main + overlays + datos del SDK) escrito a archivo, con un visualizador dentro de la app y un modo diagnóstico, para diagnosticar bugs leyendo logs en vez de "verificar en vivo a ciegas".

**Architecture:** Un único escritor de archivos en el proceso main (electron-log). Los renderers envían entradas por IPC (`window.fly.log`) al main, que las escribe y las reemite en vivo (`log:line`) a las ventanas para el tail. Las funciones puras de formato/parseo/throttle viven en un módulo sin dependencias de Electron para poder testearlas.

**Tech Stack:** Electron 33, React 18, Vite 6, electron-log v5, `node:test` (built-in) para unit tests.

## Global Constraints

- CommonJS en `src/main/**` (usar `require`/`module.exports`), ESM/JSX en `src/renderer/**`.
- `userData` está fijado a `%APPDATA%/iFly`. Los logs van a `userData/logs`.
- La app usa `contextIsolation`: los renderers NO acceden a `fs`/`ipcRenderer` directo salvo por el `contextBridge` en `preload.js`.
- Telemetría a ~60 Hz: NUNCA loguear por frame sin throttle. Anomalías → `logThrottled`.
- Formato de línea EXACTO (contrato entre escritor y parser): `[ISO8601] [LEVEL] [scope] texto`. Ej: `[2026-07-17T14:03:01.123Z] [WARN] [irsdk] classPosition duplicada | {"pos":1,"count":2}`.
- Convención de scope existente respetada: `irsdk`, `relative`, `main`, `updater`, `overlay:<id>`, `config`, `overlay-manager`.
- electron-log va en `dependencies` (runtime del main), no en devDependencies.
- Idioma de mensajes de log y UI: español, consistente con el resto del código.

---

### Task 1: Módulo puro de formato/parseo/throttle + tests

Funciones puras sin dependencias de Electron. Es la base testeable del sistema.

**Files:**
- Create: `src/main/log-format.js`
- Create: `test/log-format.test.js`
- Modify: `package.json` (script `test` + dep `electron-log`)

**Interfaces:**
- Produces:
  - `formatLine({ scope, level, date, text }) → string` — línea con el formato del contrato. `date` es un `Date`; `level` string; `scope` string; `text` string.
  - `parseLine(line) → { ts, level, scope, text } | null` — inverso de `formatLine`; `null` si la línea no matchea (líneas de continuación/stack).
  - `createThrottle() → { shouldLog(key, nowMs, everyMs) → boolean }` — devuelve `true` la primera vez por `key` y luego solo si pasaron `everyMs`.

- [ ] **Step 1: Escribir los tests que fallan**

Crear `test/log-format.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { formatLine, parseLine, createThrottle } = require('../src/main/log-format');

test('formatLine arma el formato del contrato', () => {
  const date = new Date('2026-07-17T14:03:01.123Z');
  const line = formatLine({ scope: 'irsdk', level: 'warn', date, text: 'hola | {"a":1}' });
  assert.strictEqual(line, '[2026-07-17T14:03:01.123Z] [WARN] [irsdk] hola | {"a":1}');
});

test('parseLine es inverso de formatLine', () => {
  const date = new Date('2026-07-17T14:03:01.123Z');
  const line = formatLine({ scope: 'overlay:radar', level: 'error', date, text: 'boom' });
  const parsed = parseLine(line);
  assert.strictEqual(parsed.level, 'ERROR');
  assert.strictEqual(parsed.scope, 'overlay:radar');
  assert.strictEqual(parsed.text, 'boom');
  assert.strictEqual(parsed.ts, '2026-07-17T14:03:01.123Z');
});

test('parseLine devuelve null en líneas de continuación (stack traces)', () => {
  assert.strictEqual(parseLine('    at Object.<anonymous> (foo.js:1:1)'), null);
});

test('createThrottle deja pasar la primera vez y respeta la ventana', () => {
  const t = createThrottle();
  assert.strictEqual(t.shouldLog('k', 1000, 5000), true);   // primera
  assert.strictEqual(t.shouldLog('k', 2000, 5000), false);  // dentro de ventana
  assert.strictEqual(t.shouldLog('k', 6001, 5000), true);   // pasó la ventana
  assert.strictEqual(t.shouldLog('otra', 2000, 5000), true);// key distinta
});
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

Run: `node --test test/log-format.test.js`
Expected: FAIL con "Cannot find module '../src/main/log-format'".

- [ ] **Step 3: Implementar `src/main/log-format.js`**

```js
// Funciones puras del sistema de logging. SIN dependencias de Electron para
// poder testearlas con `node --test`. El resto del logging (archivo, IPC) se
// apoya en estas funciones.

// Contrato de línea: [ISO8601] [LEVEL] [scope] texto
function formatLine({ scope, level, date, text }) {
  const iso = (date instanceof Date ? date : new Date(date)).toISOString();
  const lvl = String(level || 'info').toUpperCase();
  const scp = scope || 'app';
  return `[${iso}] [${lvl}] [${scp}] ${text}`;
}

const LINE_RE = /^\[([^\]]+)\] \[([A-Z]+)\] \[([^\]]+)\] ([\s\S]*)$/;

function parseLine(line) {
  if (typeof line !== 'string') return null;
  const m = line.match(LINE_RE);
  if (!m) return null;
  return { ts: m[1], level: m[2], scope: m[3], text: m[4] };
}

// Rate-limiter por key: primera vez siempre pasa; luego cada `everyMs`.
function createThrottle() {
  const last = new Map();
  return {
    shouldLog(key, nowMs, everyMs) {
      const prev = last.get(key);
      if (prev == null || nowMs - prev >= everyMs) {
        last.set(key, nowMs);
        return true;
      }
      return false;
    },
  };
}

module.exports = { formatLine, parseLine, createThrottle };
```

- [ ] **Step 4: Correr los tests para verificar que pasan**

Run: `node --test test/log-format.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Agregar dependencia y script de test en `package.json`**

En `dependencies` agregar `"electron-log": "^5.2.0"`. En `scripts` agregar `"test": "node --test"`.

Run: `npm install`
Expected: instala electron-log sin errores.

- [ ] **Step 6: Commit**

```bash
git add src/main/log-format.js test/log-format.test.js package.json package-lock.json
git commit -m "feat(logging): módulo puro de formato/parseo/throttle + electron-log"
```

---

### Task 2: `logger.js` — escritor central (electron-log) + emit + tail + diagnóstico

El corazón del sistema en el main. Se apoya en electron-log para archivo/rotación y en `log-format.js` para el formato y throttling. Depende de Electron, así que se verifica manualmente (no unit test).

**Files:**
- Create: `src/main/logger.js`

**Interfaces:**
- Consumes: `formatLine`, `parseLine`, `createThrottle` de `./log-format`.
- Produces:
  - `initLogger({ getDiagnosticMode }) → void` — configura electron-log. `getDiagnosticMode` es una función `() → boolean`.
  - `setBroadcast(fn) → void` — registra `fn(lineString)` que el main usa para reemitir cada línea a las ventanas.
  - `emit(scope, level, text) → void` — escribe una entrada (archivo + broadcast).
  - `createLogger(scope) → { info, warn, error, debug }` — cada método acepta `(msg, data?)`; si `data` viene, se serializa como `msg | {json}`.
  - `logThrottled(key, everyMs, scope, level, msg, data?) → void`.
  - `logOnce(key, scope, level, msg, data?) → void`.
  - `getLogs({ limit = 500 } = {}) → Array<{ ts, level, scope, text }>` — últimas `limit` líneas parseadas del archivo actual.
  - `getLogFilePath() → string`, `getLogDir() → string`.
  - `applyDiagnosticLevel(bool) → void` — cambia el nivel del transporte de archivo (`info` ↔ `debug`).

- [ ] **Step 1: Implementar `src/main/logger.js`**

```js
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const elog = require('electron-log/main');
const { formatLine, parseLine, createThrottle } = require('./log-format');

const MAX_SIZE = 5 * 1024 * 1024; // 5 MB por archivo
const MAX_ARCHIVES = 5;           // main.log + main.1.log .. main.5.log

const throttle = createThrottle();
let _broadcast = null;
let _diagFn = () => false;

function getLogDir() {
  return path.join(app.getPath('userData'), 'logs');
}
function getLogFilePath() {
  return path.join(getLogDir(), 'main.log');
}

// Rotación manual: main.log -> main.1.log, corriendo los viejos hacia arriba y
// descartando el que supere MAX_ARCHIVES. electron-log llama a esto al superar
// maxSize (le pasa el File del log actual).
function archiveLogFn(file) {
  try {
    const p = file.path || getLogFilePath();
    const dir = path.dirname(p);
    const base = path.basename(p, '.log');
    for (let i = MAX_ARCHIVES; i >= 1; i--) {
      const src = path.join(dir, `${base}.${i}.log`);
      if (i === MAX_ARCHIVES && fs.existsSync(src)) fs.unlinkSync(src);
      const prev = i === 1 ? p : path.join(dir, `${base}.${i - 1}.log`);
      if (fs.existsSync(prev)) fs.renameSync(prev, path.join(dir, `${base}.${i}.log`));
    }
  } catch (_) {}
}

function initLogger({ getDiagnosticMode } = {}) {
  if (typeof getDiagnosticMode === 'function') _diagFn = getDiagnosticMode;
  try { fs.mkdirSync(getLogDir(), { recursive: true }); } catch (_) {}

  elog.transports.file.resolvePathFn = () => getLogFilePath();
  elog.transports.file.maxSize = MAX_SIZE;
  elog.transports.file.archiveLogFn = archiveLogFn;
  // Formato del contrato (mismo que el parser). msg.data = args pasados a elog.
  elog.transports.file.format = (msg) => {
    const scope = msg.scope || 'app';
    const text = msg.data
      .map((d) => (typeof d === 'string' ? d : JSON.stringify(d)))
      .join(' ');
    return formatLine({ scope, level: msg.level, date: msg.date, text });
  };
  // Consola: solo en dev (útil al correr `npm run dev`).
  elog.transports.console.level = process.env.NODE_ENV === 'development' ? 'debug' : false;
  applyDiagnosticLevel(_diagFn());

  // Captura global de errores no manejados en el main.
  elog.errorHandler.startCatching({ showDialog: false });
}

function applyDiagnosticLevel(diag) {
  elog.transports.file.level = diag ? 'debug' : 'info';
}

function setBroadcast(fn) { _broadcast = fn; }

function emit(scope, level, text) {
  const lvl = ['error', 'warn', 'info', 'debug'].includes(level) ? level : 'info';
  // debug solo se escribe si el nivel de archivo lo permite (modo diagnóstico).
  const scoped = elog.scope(scope);
  scoped[lvl](text);
  if (_broadcast) {
    // Reproducimos la línea para el tail en vivo (aunque debug no se persista,
    // no la reemitimos si el nivel está por debajo del umbral).
    if (lvl !== 'debug' || _diagFn()) {
      _broadcast(formatLine({ scope, level: lvl, date: new Date(), text }));
    }
  }
}

function _compose(msg, data) {
  if (data === undefined) return String(msg);
  try { return `${msg} | ${JSON.stringify(data)}`; }
  catch (_) { return `${msg} | [dato no serializable]`; }
}

function createLogger(scope) {
  return {
    info: (msg, data) => emit(scope, 'info', _compose(msg, data)),
    warn: (msg, data) => emit(scope, 'warn', _compose(msg, data)),
    error: (msg, data) => emit(scope, 'error', _compose(msg, data)),
    debug: (msg, data) => emit(scope, 'debug', _compose(msg, data)),
  };
}

function logThrottled(key, everyMs, scope, level, msg, data) {
  if (throttle.shouldLog(key, Date.now(), everyMs)) emit(scope, level, _compose(msg, data));
}
function logOnce(key, scope, level, msg, data) {
  if (throttle.shouldLog(key, Date.now(), Number.MAX_SAFE_INTEGER)) emit(scope, level, _compose(msg, data));
}

function getLogs({ limit = 500 } = {}) {
  try {
    const raw = fs.readFileSync(getLogFilePath(), 'utf-8');
    const out = [];
    for (const line of raw.split(/\r?\n/)) {
      const parsed = parseLine(line);
      if (parsed) out.push(parsed);
    }
    return out.slice(-limit);
  } catch (_) {
    return [];
  }
}

module.exports = {
  initLogger, setBroadcast, emit, createLogger, logThrottled, logOnce,
  getLogs, getLogFilePath, getLogDir, applyDiagnosticLevel,
};
```

- [ ] **Step 2: Verificación manual mínima (smoke)**

Crear un archivo temporal `scratch-log-smoke.js` en la raíz:

```js
// Smoke fuera de Electron: solo verifica que el módulo carga y compone texto.
const { formatLine } = require('./src/main/log-format');
console.log(formatLine({ scope: 'irsdk', level: 'info', date: new Date(), text: 'ok' }));
```

Run: `node scratch-log-smoke.js`
Expected: imprime una línea con el formato del contrato. Luego borrar el archivo: `rm scratch-log-smoke.js` (la verificación real de electron-log se hace en Task 10 con la app corriendo).

- [ ] **Step 3: Commit**

```bash
git add src/main/logger.js
git commit -m "feat(logging): escritor central con electron-log, tail y modo diagnóstico"
```

---

### Task 3: Persistir `diagnosticMode` en config-store

**Files:**
- Modify: `src/main/config-store.js`

**Interfaces:**
- Produces: `configStore.getDiagnosticMode() → boolean`, `configStore.setDiagnosticMode(v) → boolean`.

- [ ] **Step 1: Agregar el default**

En `src/main/config-store.js`, dentro de `DEFAULTS` (después de `recordingEnabled: true,` en la línea ~145) agregar:

```js
  // Modo diagnóstico: sube el logging a nivel DEBUG y activa snapshots de salud
  // muestreados. Off por defecto (solo se prende para reproducir un bug).
  diagnosticMode: false,
```

- [ ] **Step 2: Preservar el valor al cargar**

En `_load()`, dentro del objeto `return { ... }` (después de `recordingEnabled: ...` en la línea ~186) agregar:

```js
          diagnosticMode: parsed.diagnosticMode === true,
```

- [ ] **Step 3: Agregar getter/setter**

Después de `setRecordingEnabled(...)` (línea ~269) agregar:

```js
  getDiagnosticMode() {
    return this.data.diagnosticMode === true;
  }

  setDiagnosticMode(v) {
    this.data.diagnosticMode = !!v;
    this._save();
    this._emit();
    return this.data.diagnosticMode;
  }
```

- [ ] **Step 4: Verificar sintaxis**

Run: `node --check src/main/config-store.js`
Expected: sin salida (OK).

- [ ] **Step 5: Commit**

```bash
git add src/main/config-store.js
git commit -m "feat(logging): persistir flag diagnosticMode en config"
```

---

### Task 4: Wiring en `main.js` — init, IPC, handlers globales, broadcast

**Files:**
- Modify: `src/main/main.js`

**Interfaces:**
- Consumes: `logger.js` (todas sus exports), `configStore.get/setDiagnosticMode`.
- Produces (IPC): `log:write`, `log:tail`, `log:open-folder`, `diag:get`, `diag:set`; evento `log:line` a las ventanas.

- [ ] **Step 1: Importar el logger arriba**

En `src/main/main.js`, después de la línea `const trackmapStore = require('./trackmap-store');` (línea 10) agregar:

```js
const logger = require('./logger');
const log = logger.createLogger('main');
```

- [ ] **Step 2: Inicializar el logger apenas se crea el configStore**

En `app.whenReady().then(() => {` justo después de `configStore = new ConfigStore();` (línea 144) agregar:

```js
  logger.initLogger({ getDiagnosticMode: () => configStore.getDiagnosticMode() });
  logger.setBroadcast((line) => {
    const { BrowserWindow } = require('electron');
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('log:line', line);
    }
  });
  log.info('app iniciada', { version: app.getVersion() });
```

- [ ] **Step 3: Handlers globales del proceso main**

Justo después de `migrateUserData();` (línea 67) agregar (usa `console` porque el logger todavía no está inicializado tan temprano; el `errorHandler` de electron-log tomará estos una vez inicializado, pero dejamos un backstop):

```js
process.on('uncaughtException', (err) => {
  try { require('./logger').emit('main', 'error', `uncaughtException: ${err && err.stack || err}`); }
  catch (_) { console.error('[main] uncaughtException:', err); }
});
process.on('unhandledRejection', (reason) => {
  try { require('./logger').emit('main', 'error', `unhandledRejection: ${reason && reason.stack || reason}`); }
  catch (_) { console.error('[main] unhandledRejection:', reason); }
});
```

- [ ] **Step 4: Agregar los IPC handlers**

Después del bloque `tags:get`/`tags:set` (línea ~413) agregar:

```js
// === Logs / diagnóstico ===
ipcMain.handle('log:write', (_e, entry) => {
  if (!entry || typeof entry !== 'object') return false;
  const scope = typeof entry.scope === 'string' ? entry.scope : 'renderer';
  const level = entry.level || 'info';
  const text = typeof entry.text === 'string' ? entry.text : String(entry.text ?? '');
  logger.emit(scope, level, text);
  return true;
});
ipcMain.handle('log:tail', (_e, opts) => logger.getLogs(opts || {}));
ipcMain.handle('log:open-folder', () => { shell.openPath(logger.getLogDir()); return true; });
ipcMain.handle('diag:get', () => (configStore ? configStore.getDiagnosticMode() : false));
ipcMain.handle('diag:set', (_e, v) => {
  const next = configStore.setDiagnosticMode(v);
  logger.applyDiagnosticLevel(next);
  logger.emit('main', 'info', `modo diagnóstico ${next ? 'ON' : 'OFF'}`);
  return next;
});
```

- [ ] **Step 5: Rutear los console.* clave del main al logger**

Reemplazar (mismo texto, distinto destino) estos usos en `main.js`:
- Línea ~289 `console.log(\`[main] forzando aparición...\`)` → `log.info(\`forzando aparición de ${n} overlay(s)\`);`
- Línea ~296 `console.log(\`[main] preview mode: ...\`)` → `log.info(\`preview mode: ${enabled ? 'ON' : 'OFF'}\`);`
- Línea ~315 `console.error(\`[main] no se pudo registrar hotkey...\`)` → `log.error(\`no se pudo registrar hotkey ${name}=${acc}\`, { error: err.message });`

(Los demás `console.error` de `[ibt]`/`[updater]` se pueden migrar igual, pero no es bloqueante para esta tarea.)

- [ ] **Step 6: Verificar sintaxis**

Run: `node --check src/main/main.js`
Expected: sin salida (OK).

- [ ] **Step 7: Commit**

```bash
git add src/main/main.js
git commit -m "feat(logging): init logger, IPC de logs/diag y handlers globales en main"
```

---

### Task 5: API del preload

**Files:**
- Modify: `src/main/preload.js`

**Interfaces:**
- Produces (en `window.fly`): `log(entry)`, `getLogs(opts)`, `onLogLine(cb)`, `openLogsFolder()`, `getDiagnosticMode()`, `setDiagnosticMode(v)`. Y captura global de errores del renderer.

- [ ] **Step 1: Agregar métodos al bridge**

En `src/main/preload.js`, dentro de `contextBridge.exposeInMainWorld('fly', { ... })`, antes de la línea `installUpdate: ...` (línea 86) agregar:

```js
  // Logs / diagnóstico
  log: (entry) => ipcRenderer.invoke('log:write', entry),
  getLogs: (opts) => ipcRenderer.invoke('log:tail', opts),
  onLogLine: (callback) => {
    const listener = (_event, line) => callback(line);
    ipcRenderer.on('log:line', listener);
    return () => ipcRenderer.removeListener('log:line', listener);
  },
  openLogsFolder: () => ipcRenderer.invoke('log:open-folder'),
  getDiagnosticMode: () => ipcRenderer.invoke('diag:get'),
  setDiagnosticMode: (v) => ipcRenderer.invoke('diag:set', v),
```

- [ ] **Step 2: Capturar errores globales de CADA ventana renderer**

El preload corre en todos los renderers (overlays + panel), así que instalamos los handlers acá una sola vez. Al final del archivo, después del cierre `});` de `exposeInMainWorld` (línea 89) agregar:

```js
// Captura global de errores del renderer → log al main. Se ejecuta en cada
// ventana (overlays y panel). El scope lleva el overlayId para saber cuál falló.
(() => {
  const scope = overlayId ? `overlay:${overlayId}` : 'panel';
  const send = (level, text) => {
    try { ipcRenderer.invoke('log:write', { scope, level, text }); } catch (_) {}
  };
  window.addEventListener('error', (e) => {
    send('error', `window.onerror: ${e.message} @ ${e.filename}:${e.lineno}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    send('error', `unhandledrejection: ${(r && r.stack) || r}`);
  });
})();
```

- [ ] **Step 3: Verificar sintaxis**

Run: `node --check src/main/preload.js`
Expected: sin salida (OK).

- [ ] **Step 4: Commit**

```bash
git add src/main/preload.js
git commit -m "feat(logging): API de logs en preload + captura global de errores del renderer"
```

---

### Task 6: Instrumentar `irsdk-client.js` (SDK + sanidad del Relative)

**Files:**
- Modify: `src/main/irsdk-client.js`

**Interfaces:**
- Consumes: `logger.createLogger`, `logger.logThrottled`.

- [ ] **Step 1: Crear el logger del módulo**

Al inicio de `src/main/irsdk-client.js`, después de los `require` existentes (buscar la primera línea que no sea `require`), agregar:

```js
const { createLogger, logThrottled } = require('./logger');
const log = createLogger('irsdk');
```

- [ ] **Step 2: Rutear los logs de conexión existentes**

Reemplazar los `console.log`/`console.error` del ciclo de conexión (líneas ~443-515) por sus equivalentes del logger, conservando el texto. Ejemplos:
- `console.log(\`[irsdk][pid:${process.pid}] SDK iniciado\`)` → `log.info('SDK iniciado', { pid: process.pid });`
- `console.error(\`[irsdk][pid:${process.pid}] Error al conectar:\`, err.message)` → `log.error('error al conectar', { pid: process.pid, error: err.message });`
- `console.log(\`[irsdk][pid:${process.pid}] ✓ Conectado — recibiendo datos\`)` → `log.info('conectado, recibiendo datos', { pid: process.pid });`
- `console.log(\`[irsdk][pid:${process.pid}] iRacing cerrado, reconectando...\`)` → `log.info('iRacing cerrado, reconectando');`
- `console.log(\`[irsdk][pid:${process.pid}] ✗ Desconectado\`)` → `log.info('desconectado', { pid: process.pid });`

- [ ] **Step 3: Loguear anomalías de forma de datos en `_readCarIdxArray`**

En `_readCarIdxArray` (línea ~1591), en la rama que detecta escalar (después de `// Vino escalar:` línea ~1602) agregar antes del `const out = ...`:

```js
    logThrottled(`caridx-scalar:${key}`, 10000, 'irsdk', 'warn',
      'CarIdx* llegó como escalar (no array por auto)', { key });
```

Y en la rama de array corto (dentro de `if (raw.length < n)` línea ~1595) agregar antes del `return out;`:

```js
      logThrottled(`caridx-short:${key}`, 10000, 'irsdk', 'warn',
        'CarIdx* más corto que la cantidad de autos', { key, len: raw.length, n });
```

- [ ] **Step 4: Loguear sanidad del Relative antes del `return` de `getRelative()`**

En `getRelative()`, justo antes de `return { playerIdx, ... }` (línea ~1570), agregar:

```js
          // Sanidad para diagnóstico: posiciones duplicadas o playerIdx perdido
          // (la clase de bug del relative desordenado/duplicado).
          if (playerIdx < 0 || !drivers.some((d) => d.carIdx === playerIdx)) {
            logThrottled('rel-noplayer', 5000, 'relative', 'warn',
              'playerIdx no está en la lista de drivers', { playerIdx, drivers: drivers.length });
          }
          {
            const byPos = {};
            for (const d of drivers) if (d.classPosition > 0) byPos[d.classPosition] = (byPos[d.classPosition] || 0) + 1;
            const dups = Object.entries(byPos).filter(([, c]) => c > 1);
            if (dups.length) {
              logThrottled('rel-duppos', 5000, 'relative', 'warn',
                'classPosition duplicada en el relative', { dups, sessionState });
            }
            if (drivers.length > 1 && drivers.filter((d) => d.carIdx !== playerIdx).every((d) => d.relDelta == null)) {
              logThrottled('rel-nodelta', 5000, 'relative', 'warn',
                'relDelta null para todos los rivales', { drivers: drivers.length });
            }
          }
```

- [ ] **Step 5: Reemplazar el catch silencioso de `getRelative()`**

En `getRelative()`, el `catch (err) { // ignore }` (línea ~1580) reemplazarlo por:

```js
      } catch (err) {
        logThrottled('rel-exc', 5000, 'relative', 'error', 'excepción en getRelative', { error: err.message });
      }
```

- [ ] **Step 6: Verificar sintaxis**

Run: `node --check src/main/irsdk-client.js`
Expected: sin salida (OK).

- [ ] **Step 7: Commit**

```bash
git add src/main/irsdk-client.js
git commit -m "feat(logging): instrumentar SDK y sanidad del relative en irsdk-client"
```

---

### Task 7: Reenviar errores de React (ErrorBoundary) al logger

**Files:**
- Modify: `src/renderer/components/ui/error-boundary.jsx`

**Interfaces:**
- Consumes: `window.fly.log`.

- [ ] **Step 1: Reenviar en `componentDidCatch`**

En `src/renderer/components/ui/error-boundary.jsx`, reemplazar el cuerpo de `componentDidCatch` (líneas 13-15) por:

```js
  componentDidCatch(error, info) {
    console.error("[ErrorBoundary]", error.message, info.componentStack);
    try {
      const scope = window.fly?.overlayId ? `overlay:${window.fly.overlayId}` : "panel";
      window.fly?.log?.({
        scope,
        level: "error",
        text: `ErrorBoundary: ${error.message} | ${(info.componentStack || "").split("\\n").slice(0, 4).join(" ")}`,
      });
    } catch (_) {}
  }
```

- [ ] **Step 2: Verificación**

Run: `npm run build:renderer`
Expected: build de vite sin errores (valida que el JSX compila).

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/ui/error-boundary.jsx
git commit -m "feat(logging): ErrorBoundary reenvía errores de render al logger"
```

---

### Task 8: Componente `LogView.jsx` (visualizador)

**Files:**
- Create: `src/renderer/components/LogView.jsx`

**Interfaces:**
- Consumes: `window.fly.getLogs`, `onLogLine`, `openLogsFolder`, `getDiagnosticMode`, `setDiagnosticMode`.
- Produces: `export function LogView()`.

- [ ] **Step 1: Implementar el componente**

Crear `src/renderer/components/LogView.jsx`:

```jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, Copy, Trash2, Search } from "lucide-react";

const LEVELS = ["error", "warn", "info", "debug"];
const LEVEL_COLOR = {
  ERROR: "text-red-400",
  WARN: "text-amber-400",
  INFO: "text-sky-300",
  DEBUG: "text-muted-foreground",
};

// Parser de línea idéntico al contrato del main (formatLine/parseLine).
const LINE_RE = /^\[([^\]]+)\] \[([A-Z]+)\] \[([^\]]+)\] ([\s\S]*)$/;
function parse(line) {
  const m = typeof line === "string" && line.match(LINE_RE);
  if (!m) return null;
  return { ts: m[1], level: m[2], scope: m[3], text: m[4] };
}

export function LogView() {
  const [lines, setLines] = useState([]);        // {ts, level, scope, text}
  const [diag, setDiag] = useState(false);
  const [levelFilter, setLevelFilter] = useState({ error: true, warn: true, info: true, debug: true });
  const [scopeFilter, setScopeFilter] = useState("");
  const [query, setQuery] = useState("");
  const [autoscroll, setAutoscroll] = useState(true);
  const bottomRef = useRef(null);

  useEffect(() => {
    let mounted = true;
    window.fly?.getLogs?.({ limit: 1000 }).then((rows) => {
      if (mounted) setLines(Array.isArray(rows) ? rows : []);
    });
    window.fly?.getDiagnosticMode?.().then((v) => mounted && setDiag(!!v));
    const unsub = window.fly?.onLogLine?.((line) => {
      const p = parse(line);
      if (p) setLines((prev) => [...prev.slice(-4000), p]);
    });
    return () => { mounted = false; if (typeof unsub === "function") unsub(); };
  }, []);

  useEffect(() => {
    if (autoscroll) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [lines, autoscroll]);

  const scopes = useMemo(
    () => Array.from(new Set(lines.map((l) => l.scope))).sort(),
    [lines]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return lines.filter((l) => {
      if (!levelFilter[l.level.toLowerCase()]) return false;
      if (scopeFilter && l.scope !== scopeFilter) return false;
      if (q && !(`${l.scope} ${l.text}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [lines, levelFilter, scopeFilter, query]);

  const toggleDiag = async () => {
    const next = await window.fly?.setDiagnosticMode?.(!diag);
    setDiag(!!next);
  };
  const copyAll = () => {
    const txt = filtered.map((l) => `[${l.ts}] [${l.level}] [${l.scope}] ${l.text}`).join("\n");
    navigator.clipboard?.writeText(txt);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background text-foreground">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border flex-wrap">
        <button
          onClick={toggleDiag}
          className={`px-2.5 py-1 rounded-md text-xs font-semibold ${diag ? "bg-amber-500 text-black" : "bg-accent text-accent-foreground"}`}
          title="Sube el logging a DEBUG y activa snapshots"
        >
          Modo diagnóstico: {diag ? "ON" : "OFF"}
        </button>
        <div className="flex items-center gap-1">
          {LEVELS.map((lv) => (
            <button
              key={lv}
              onClick={() => setLevelFilter((f) => ({ ...f, [lv]: !f[lv] }))}
              className={`px-2 py-1 rounded text-[11px] font-mono uppercase ${levelFilter[lv] ? "bg-accent text-accent-foreground" : "text-muted-foreground opacity-50"}`}
            >
              {lv}
            </button>
          ))}
        </div>
        <select
          value={scopeFilter}
          onChange={(e) => setScopeFilter(e.target.value)}
          className="bg-card border border-border rounded px-2 py-1 text-xs"
        >
          <option value="">todos los módulos</option>
          {scopes.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <div className="flex items-center gap-1 bg-card border border-border rounded px-2 py-1">
          <Search size={13} className="text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="buscar..."
            className="bg-transparent text-xs outline-none w-40"
          />
        </div>
        <label className="flex items-center gap-1 text-xs text-muted-foreground ml-1">
          <input type="checkbox" checked={autoscroll} onChange={(e) => setAutoscroll(e.target.checked)} />
          auto-scroll
        </label>
        <div className="flex-1" />
        <button onClick={copyAll} className="p-1.5 rounded hover:bg-accent" title="Copiar visible"><Copy size={15} /></button>
        <button onClick={() => setLines([])} className="p-1.5 rounded hover:bg-accent" title="Limpiar vista"><Trash2 size={15} /></button>
        <button onClick={() => window.fly?.openLogsFolder?.()} className="p-1.5 rounded hover:bg-accent" title="Abrir carpeta de logs"><FolderOpen size={15} /></button>
      </div>

      {/* Lista */}
      <div className="flex-1 overflow-auto font-mono text-[11px] leading-relaxed px-4 py-2">
        {filtered.length === 0 ? (
          <div className="text-muted-foreground text-xs py-8 text-center">Sin líneas para los filtros actuales.</div>
        ) : (
          filtered.map((l, i) => (
            <div key={i} className="whitespace-pre-wrap break-words">
              <span className="text-muted-foreground">{l.ts.slice(11, 23)}</span>{" "}
              <span className={`font-bold ${LEVEL_COLOR[l.level] || ""}`}>{l.level.padEnd(5)}</span>{" "}
              <span className="text-violet-300">[{l.scope}]</span>{" "}
              <span>{l.text}</span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verificación**

Run: `npm run build:renderer`
Expected: build sin errores.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/LogView.jsx
git commit -m "feat(logging): visualizador de logs in-app (LogView)"
```

---

### Task 9: Tab "Diagnóstico" en el Dashboard

**Files:**
- Modify: `src/renderer/components/Dashboard.jsx`

**Interfaces:**
- Consumes: `LogView`.

- [ ] **Step 1: Importar LogView**

En `src/renderer/components/Dashboard.jsx`, después de `import { HotkeysView } from "./HotkeysView.jsx";` (línea 19) agregar:

```js
import { LogView } from "./LogView.jsx";
```

- [ ] **Step 2: Agregar la tab al header**

En el array de tabs (línea 242), agregar `"Diagnóstico"` como última entrada:

```js
          {[["overlays", "Overlays"], ["analysis", "Análisis"], ["progreso", "Progreso"], ["hotkeys", "Hotkeys"], ["diagnostico", "Diagnóstico"]].map(([v, label]) => (
```

- [ ] **Step 3: Renderizar LogView**

En la cadena de vistas (línea ~262), después de la rama `view === "hotkeys" ? (<HotkeysView />)` agregar la rama:

```jsx
      ) : view === "diagnostico" ? (
        <LogView />
```

(Queda: `... view === "hotkeys" ? (<HotkeysView />) : view === "diagnostico" ? (<LogView />) : (` seguido del bloque `/* MAIN */`.)

- [ ] **Step 4: Verificación**

Run: `npm run build:renderer`
Expected: build sin errores.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/Dashboard.jsx
git commit -m "feat(logging): tab Diagnóstico en el panel"
```

---

### Task 10: Verificación end-to-end (dev + build)

**Files:** ninguno (verificación).

- [ ] **Step 1: Correr los unit tests**

Run: `npm test`
Expected: los tests de `log-format` pasan.

- [ ] **Step 2: Verificar sintaxis de todo el main**

Run: `node --check src/main/logger.js && node --check src/main/main.js && node --check src/main/irsdk-client.js && node --check src/main/preload.js && node --check src/main/config-store.js`
Expected: sin salida (todo OK).

- [ ] **Step 3: Prueba en dev**

Run: `npm run dev`
Verificar manualmente:
1. Abrir el panel → tab **Diagnóstico** → deben aparecer líneas (al menos `[main] app iniciada`).
2. Existe el archivo `%APPDATA%/iFly/logs/main.log` con líneas en el formato del contrato.
3. Prender **Modo diagnóstico** → aparecen líneas DEBUG; apagarlo → dejan de aparecer.
4. Botón **Abrir carpeta de logs** → abre `%APPDATA%/iFly/logs`.
5. Con iRacing abierto (o preview F9), los eventos de conexión del SDK aparecen con scope `irsdk`. Si se dispara una anomalía del relative, aparece 1 línea `warn` (throttled), no 60/seg.
6. Forzar un error en un overlay (temporalmente `throw new Error("test")` en un render) → aparece con scope `overlay:<id>`; revertir el throw.

- [ ] **Step 4: Prueba en build empaquetado**

Run: `npm run dist`
Instalar el `.exe` de `release/`, abrir la app y repetir los puntos 1, 2 y 4 del Step 3 sobre la app instalada (confirma que la ruta de logs y el visualizador funcionan fuera de dev).

- [ ] **Step 5: Commit final (si hubo ajustes)**

```bash
git add -A
git commit -m "test(logging): verificación end-to-end del sistema de logging"
```

---

## Self-Review (cobertura del spec)

- Escritor único en main (electron-log) → Task 2, 4. ✅
- Renderers vía IPC → Task 4 (`log:write`), 5 (preload). ✅
- `createLogger`/`logThrottled`/`logOnce` → Task 2. ✅
- Captura global (main + renderer) → Task 4 (main), 5 (renderer), 7 (React). ✅
- Rotación + retención → Task 2 (`archiveLogFn`, `MAX_SIZE`, `MAX_ARCHIVES`). ✅
- Instrumentación SDK + sanidad relative + catch silenciosos → Task 6. ✅
- Modo diagnóstico (persistencia + nivel + UI) → Task 3, 4 (`diag:*`), 8 (toggle). ✅
- Visualizador (tail, filtros, búsqueda, abrir carpeta, copiar, limpiar) → Task 8, 9. ✅
- Formato parseable consistente escritor/visor → Task 1 (`formatLine`), reusado en Task 2 y 8. ✅
- Verificación dev + build → Task 10. ✅

Notas de consistencia: el regex `LINE_RE` y el formato `[ISO] [LEVEL] [scope] texto` son idénticos en `log-format.js` (Task 1) y `LogView.jsx` (Task 8). `emit(scope, level, text)`, `getLogs({limit})` y los canales IPC (`log:write`, `log:tail`, `log:open-folder`, `diag:get`, `diag:set`, evento `log:line`) se usan con la misma firma en Tasks 2/4/5/8.
