# Sistema de logging a archivos rotativos + visualizador in-app

**Fecha:** 17/07/2026
**Estado:** Aprobado, listo para plan de implementación

## Contexto

### Problema de negocio
Hoy la única forma de detectar y corregir errores en los overlays de FlyOverlays
es: (1) ver un error en el juego, (2) describirlo de memoria, (3) buscar la causa
en el código a ciegas, sin certeza de qué lo provoca. Esto hace la corrección
lenta, especulativa y dependiente de "verificalo en vivo en iRacing".

Los `console.log/error/warn` actuales se pierden al cerrar la app y no son
accesibles en la versión empaquetada. Además hay `try/catch` que silencian
errores (`catch (_) {}`), que son puntos ciegos exactos donde se originan bugs.

### Objetivo
Un sistema de logging persistente, rotativo y accesible (incluso en la app
buildeada) que registre el comportamiento de los overlays y los datos crudos que
salen del SDK de iRacing, para poder determinar la causa exacta de un error
leyendo logs — e incluso detectar errores que el usuario no notó.

### Audiencia
El propio usuario (desarrollador/piloto), corriendo la app empaquetada mientras
usa iRacing. No es telemetría remota: los logs son locales y se consultan a mano.

## Decisiones tomadas (brainstorming)
- **Base técnica:** `electron-log` (rotación, rutas, captura de excepciones).
- **Control de ruido a 60Hz:** niveles + modo diagnóstico toggle (INFO por
  defecto; DEBUG on-demand).
- **Acceso:** visualizador dentro de la app **y** botón para abrir la carpeta.
- **Alcance:** todo en una sola entrega.
- **Contexto de uso:** el usuario solo corre single-class (ver instrumentación
  del Relative).

## Arquitectura

### Un solo escritor de archivos (main)
`electron-log` corre **solo en el proceso main** como único escritor. Los
renderers (5-6 ventanas de overlay + panel) **no** escriben al archivo: envían
sus entradas por IPC al main, que las escribe. Esto evita condiciones de carrera
sobre el mismo archivo y mantiene la app con `contextIsolation` sin la fricción
de la integración renderer→main de electron-log.

```
overlay/panel renderer ──window.fly.log(entry)──▶ ipcMain 'log:write' ──▶ logger.js ──▶ electron-log ──▶ archivo
main (irsdk, updater, etc.) ─────────────────────────────────────────────▶ logger.js ──▶ electron-log ──▶ archivo
```

### Módulo `src/main/logger.js` (nuevo)
Envuelve electron-log y expone:
- `createLogger(scope)` → `{ info, warn, error, debug }`. El `scope` (ej.
  `'irsdk'`, `'relative'`, `'overlay:radar'`) se antepone, respetando la
  convención `[módulo]` ya usada en el código.
- `logThrottled(key, everyMs, level, msg, data)` — **crítico para 60Hz**: una
  anomalía que se repetiría cada frame se loguea 1 vez cada `everyMs`. Guarda el
  último timestamp por `key` en un `Map`.
- `logOnce(key, level, msg, data)` — loguea una sola vez por `key` (para eventos
  de "esto no debería pasar nunca" por sesión).
- `setDiagnosticMode(bool)` / `getDiagnosticMode()` — cambia el nivel del
  transporte de archivo entre `info` y `debug`. Persistido en `config.json`.
- Inicializa captura global: `uncaughtException` y `unhandledRejection`.
- Formato de línea fijo y parseable: `[ISO8601] [LEVEL] [scope] mensaje | {json}`.

### Rotación y retención
- `maxSize` = 5 MB por archivo.
- ~5 archivos de historial (`main.log`, `main.1.log`, … via `archiveLogFn`).
- Ubicación: `userData/logs` (con el `userData` fijado a `iFly`, queda en
  `%APPDATA%/iFly/logs`).
- Constantes de tamaño/retención centralizadas en `logger.js`.

## Instrumentación (qué se loguea)

### `src/main/irsdk-client.js`
- **Ciclo de conexión** (connect/disconnect/reconnect): rutear los `console.log`
  existentes al logger (nivel info).
- **Anomalías de forma de datos del SDK** (nivel warn, throttled):
  - En `_readCarIdxArray`: cuando una `CarIdx*` llega como escalar en vez de
    array, o como array más corto que `n`.
  - `EstTime` de todos los autos en 0, `LapDistPct` fuera de `[0,1)`, `playerIdx`
    inválido, `CarClassEstLapTime` ausente.
- **Sanidad del Relative** (nivel warn, throttled) — la clase de bug ya corregida:
  - `classPosition` duplicados dentro de una clase.
  - `relDelta` null para todos los no-player.
  - `playerIdx` no encontrado en la lista.
- Reemplazar los `catch (_) {}` relevantes (en `getRelative`, `getTelemetry`) por
  `catch (e) { log.error(...) }`.
- **Snapshots de salud** (solo en modo diagnóstico, muestreados ~cada 500ms, no
  por frame): resumen de `{ playerIdx, #drivers, sessionState, #posDuplicadas,
  #estTimeCero }`.

### `src/main/main.js` y `overlay-manager.js`
- Rutear los `console.error`/`console.log` existentes (updater, hotkeys, ibt,
  config, migración, inyección de overlays) al logger con su scope.

### Renderers (overlays + panel)
- Enganchar `componentDidCatch` del `ErrorBoundary` existente
  (`src/renderer/components/ui/error-boundary.jsx`) para reenviar a
  `window.fly.log`.
- Handlers globales `window.onerror` y `window.onunhandledrejection` por ventana,
  etiquetados con `window.fly.overlayId` (scope `overlay:<id>`).

## Modo diagnóstico
- **Off por defecto** → nivel de archivo `info`.
- **On** → nivel de archivo `debug` + snapshots muestreados. Se prende al ir a
  reproducir un bug.
- Persistido en `config.json`. Indicador visible en el visualizador de que está
  activo.

## Visualizador in-app

### Ubicación
Nueva tab **"Diagnóstico"** en el header del panel
(`src/renderer/components/Dashboard.jsx`), como última pestaña después de
"Hotkeys" — presente pero no prominente.

### Componente `src/renderer/components/LogView.jsx` (nuevo)
- **Live tail**: el main empuja líneas nuevas por IPC (`onLogLine`); carga
  inicial del final del archivo vía `getLogs`.
- **Filtros**: por nivel (error/warn/info/debug), por scope/módulo, y búsqueda de
  texto libre.
- **Toggle "Modo diagnóstico"** (llama `setDiagnosticMode`).
- **Botones**: "Abrir carpeta de logs" (`shell.openPath`), "Copiar", "Limpiar
  vista".
- Coloreado por nivel; fuente monoespaciada.
- Parseo de líneas con el formato fijo definido en `logger.js`.

### API del preload (`src/main/preload.js`)
Métodos nuevos:
- `log(entry)` → `ipcRenderer.invoke('log:write', entry)`.
- `getLogs(opts)` → `ipcRenderer.invoke('log:tail', opts)` (últimas N líneas).
- `onLogLine(cb)` → suscripción a `log:line`.
- `openLogsFolder()` → `ipcRenderer.invoke('log:open-folder')`.
- `getDiagnosticMode()` / `setDiagnosticMode(v)` → `diag:get` / `diag:set`.

### IPC del main (`src/main/main.js`)
Handlers: `log:write`, `log:tail`, `log:open-folder`, `diag:get`, `diag:set`; y
emisión de `log:line` a las ventanas suscriptas cuando se escribe una línea.

## Archivos afectados

| Archivo | Cambio |
|---|---|
| `src/main/logger.js` | **nuevo** — wrapper electron-log + throttling + scopes + rotación |
| `src/main/main.js` | IPC de logs/diag; handlers globales; rutear console.* |
| `src/main/irsdk-client.js` | instrumentación SDK + sanidad Relative + reemplazo de catch silenciosos |
| `src/main/overlay-manager.js` | rutear console.* al logger |
| `src/main/config-store.js` | persistir flag `diagnosticMode` |
| `src/main/preload.js` | métodos `log`, `getLogs`, `onLogLine`, `openLogsFolder`, `get/setDiagnosticMode` |
| `src/renderer/components/LogView.jsx` | **nuevo** — visualizador |
| `src/renderer/components/Dashboard.jsx` | tab "Diagnóstico" + render de `LogView` |
| `src/renderer/components/ui/error-boundary.jsx` | reenviar errores al logger |
| `package.json` | dependencia `electron-log` |

## Verificación
1. **Unit tests** (funciones puras): el rate-limiter (`logThrottled`) y el parser
   de líneas de log. Framework: el que ya use el repo; si no hay, un script de
   test mínimo.
2. **Manual (dev, `npm run dev`)**:
   - Forzar un error en un overlay → aparece en el archivo y en el visualizador
     con scope `overlay:<id>`.
   - Prender "Modo diagnóstico" → aparecen líneas DEBUG y snapshots.
   - Provocar una anomalía de datos (ej. preview/mock con posiciones duplicadas)
     → aparece una entrada `warn` throttled, no 60 por segundo.
3. **Build (`npm run dist`)**: confirmar que la carpeta de logs existe en
   `%APPDATA%/iFly/logs`, que el visualizador lista líneas y que "Abrir carpeta
   de logs" funciona en la app empaquetada.

## Fuera de alcance (YAGNI)
- Telemetría/envío remoto de logs.
- Configuración de nivel por módulo (solo global INFO/DEBUG).
- Exportar/comprimir logs desde la UI (la carpeta ya es accesible).
