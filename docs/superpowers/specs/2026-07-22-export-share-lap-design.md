# Exportar / Compartir una vuelta — Diseño

**Fecha:** 22/07/2026
**Estado:** aprobado (brainstorming) — pendiente de plan de implementación

## Problema de negocio y audiencia

**Audiencia:** el usuario de iFly (piloto de iRacing) y sus amigos/seguidores.

**Problema:** hoy una buena vuelta se queda dentro de la app. No hay forma de (a) mostrarla
en redes/WhatsApp de manera atractiva, ni (b) pasarle a un amigo una vuelta de referencia
para que la use como ghost en su propio iFly. Falta el "último metro" social del análisis:
sacar la vuelta afuera.

**Objetivo:** agregar a `AnalysisView` una función de **Exportar / Compartir** sobre la vuelta
seleccionada, con dos capacidades:

1. **Tarjeta (imagen)** lista para redes/WhatsApp, en 3 formatos.
2. **Vuelta de referencia** en archivo nativo `.iflylap`, importable por otro usuario de iFly.

## Alcance

**Entra:**
- Botón "Compartir" en la vuelta seleccionada de `AnalysisView`, que abre un panel con las dos
  acciones.
- Generación de una tarjeta PNG en tres formatos: **1080×1920** (9:16), **1080×1080** (1:1),
  **1920×1080** (16:9), con preview en vivo y selección de formato.
- Fuente de mapa de la tarjeta **seleccionable**: OSM (default) / satélite / SVG estilizado
  (fallback), mostrando solo las disponibles para la pista.
- Contenido de tarjeta "estándar": mapa (trazada coloreada por velocidad + contorno), tiempo de
  vuelta grande, tiempos por sector, badge (PB / válida), nombre del piloto, auto, pista, fecha,
  wordmark iFLY.
- Entrega de la imagen por **copiar al portapapeles** y **guardar PNG**.
- Export/import de una vuelta como archivo nativo `.iflylap` (JSON), con round-trip fiel dentro
  de iFly (buckets, micro-sectores y sectores exactos).
- Refactor puntual: extraer la construcción de segmentos/trazada del mapa a `lib/track-render.js`
  para compartirla entre `AnalysisView` y la tarjeta.

**No entra (fuera de alcance):**
- Compartir imagen de gomas/combustible u otros overlays.
- Publicación directa a redes vía API (Instagram/Twitter): solo copiar/guardar; el usuario pega.
- Sincronización con Garage 61 (feature aparte, ya identificada).
- Export en CSV compatible (se descartó a favor del nativo `.iflylap`).

## Supuestos y decisiones resueltas

- **Mapa de la tarjeta:** fuente **seleccionable**, igual que en `AnalysisView`:
  - **OpenStreetMap** (default): trazado real (`highway=raceway`) con la línea de carrera
    coloreada por velocidad encima, alineada con el ajuste afín que ya usa `AnalysisView`.
  - **Satélite** (Esri): foto satelital como fondo + la línea de carrera encima (scrim oscuro
    para contraste, como el `MapPanel`).
  - **SVG estilizado:** fallback cuando OSM/satélite no están disponibles para esa pista.
  - **Fallback automático:** si la fuente elegida no tiene datos (`NO_GEOMETRY` / sin tiles), la
    tarjeta cae al SVG estilizado para que **siempre** genere algo usable. Solo se ofrecen en el
    selector las fuentes efectivamente disponibles (mismo criterio que `MapSourceSwitch`).
  - La geometría OSM y los tiles satelitales se obtienen vía `osm-track.js` / el flujo de tiles
    existente (cacheados; pueden requerir fetch la primera vez para esa pista).
- **Export con satélite y canvas "tainting":** los tiles de Esri son remotos; dibujarlos directo
  en un `<canvas>` puede contaminarlo (CORS) y romper `toBlob()`. Por eso, para el render de la
  imagen los tiles necesarios se **embeben como data URLs** (traídos por el main, sin CORS)
  antes de serializar el SVG. Sin esto, la exportación satelital fallaría.
- **Extensión:** `.iflylap` (JSON por dentro). Marca el archivo como propio de iFly.
- **Nombre del piloto:** campo `displayName` **opcional** en Ajustes, editable al momento de
  exportar; default vacío. No se toma el nombre real de iRacing automáticamente — el usuario
  decide qué poner (evita filtrar PII sin intención; ver Ley 1581/2012 para datos personales).
- **Render de imagen sin dependencias nuevas:** SVG serializado → `<canvas>` del tamaño destino →
  `canvas.toBlob('image/png')`.
- El `sample` por bucket ya es idéntico entre grabación en vivo (`session-recorder.js`) y `.ibt`
  (`ibt-parser.js`): `{ th, br, st, sp, g, rpm, t, gLat, gLon, yaw, lat, lon }`. La tarjeta y el
  `.iflylap` consumen esa estructura tal cual.

## Arquitectura

### A) Tarjeta (imagen)

**Componente nuevo `src/renderer/components/ShareCard.jsx`:**
- Recibe `{ lap, session, format, displayName, mapSource, osmTrack, tiles }` y renderiza la
  tarjeta como un **SVG** a la resolución fija del formato elegido.
- Base del mapa según `mapSource`: **OSM** (default) / **satélite** (tiles Esri como fondo) /
  **SVG estilizado** (fallback), con la línea de carrera coloreada por velocidad encima. El
  selector solo muestra las fuentes disponibles para la pista.
- Para el export con satélite, los `tiles` llegan ya embebidos como data URLs (ver Supuestos).
- Reusa la trazada del mapa desde el módulo compartido `lib/track-render.js` (ver Refactor).
- Layout por formato (reflow del mismo contenido):
  - **9:16:** mapa arriba (protagonista), tiempo grande, sectores y meta abajo.
  - **1:1:** mapa a la izquierda, stats a la derecha, meta al pie.
  - **16:9:** mapa a la izquierda, stats a la derecha (más ancho), meta al pie.

**Refactor `lib/track-render.js` (nuevo):**
- Extrae de `AnalysisView.jsx` la construcción de segmentos de la trazada + color por velocidad
  (la lógica hoy embebida en `MapPanel`/`TrackLayer`) y el **alineado afín de la línea GPS al
  trazado de OSM** (`fitAffine`/`applyAffine`), como funciones puras que reciben `samples` (+
  geometría de OSM) y devuelven los paths/segmentos, el outline de pista y el `viewBox`.
- `AnalysisView` pasa a consumir ese módulo (sin cambio de comportamiento visible); `ShareCard`
  lo usa para dibujar el mismo trazado con base OSM.

**Flujo de render a PNG (en el renderer):**
1. Se monta `ShareCard` (oculto/offscreen) con el formato elegido.
2. Se serializa su SVG a string y se carga en un `Image` vía data URL.
3. Se dibuja en un `<canvas>` del tamaño destino (1080×1920 / 1080×1080 / 1920×1080).
4. `canvas.toBlob('image/png')` → `Blob` → `ArrayBuffer`.

**Entrega:**
- *Copiar:* `ArrayBuffer` → `window.fly.exportCopyImage(buffer)` → IPC `export:copy-image` →
  main: `clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(buffer)))`.
- *Guardar:* `ArrayBuffer` + nombre por defecto → `window.fly.exportSaveImage(buffer, name)` →
  IPC `export:save-image` → main: `dialog.showSaveDialog` (filtro `.png`) + `fs.writeFile`.
  Nombre por defecto: `iFly - {pista} - {tiempo}.png`.

### B) Vuelta de referencia (`.iflylap`)

**Export (renderer → main):**
- Se arma el objeto:
  ```json
  {
    "format": "iflylap",
    "version": 1,
    "track": "...", "trackKey": "...", "trackIdIr": 0, "carIdIr": 0,
    "car": "...", "sessionType": "...", "trackLength": 0, "sectorPcts": [],
    "lap": { "lap": 0, "lapTime": 0, "valid": true, "sectors": [], "micros": [], "samples": [] },
    "meta": { "driver": "", "exportedAt": 0, "appVersion": "" }
  }
  ```
- `window.fly.exportSaveLap(json, name)` → IPC `export:save-lap` → main: `dialog.showSaveDialog`
  (filtro `.iflylap`) + `fs.writeFile`. Nombre por defecto: `{pista} - {auto} - {tiempo}.iflylap`.

**Import (main):**
- Nuevo `parseIflyLap(filePath)` (junto a `ibt-parser`/`csv-parser`): lee y valida el JSON y
  devuelve la **misma forma de sesión** que `getRecording`/`getIbtSession` — una sesión con una
  sola vuelta — para reusar todo el render de `AnalysisView` (incluido usarla como ghost).
- El flujo de "Importar" que hoy acepta `.ibt`/`.csv` (`ibt:import` en `main.js`) suma el filtro
  `.iflylap` y despacha al parser correcto según extensión.
- En `AnalysisView`, el discriminador de fuente `/^(ibt|csv)/.test(selectedId)` pasa a
  `/^(ibt|csv|ifly)/` y el getter correspondiente resuelve la sesión importada.

## Componentes y contratos (resumen)

| Unidad | Qué hace | Depende de |
|---|---|---|
| `ShareCard.jsx` | Renderiza la tarjeta SVG a resolución fija por formato + selector de fuente de mapa | `lib/track-render.js`, datos de vuelta/sesión, geometría OSM (`window.fly.getOsmTrack`) y tiles satelitales embebidos |
| `lib/track-render.js` | Segmentos de trazada + color por velocidad + alineado afín a OSM (puro) | samples, geometría OSM |
| `SharePanel` (en `AnalysisView`) | UI: elegir formato, preview, copiar/guardar, exportar `.iflylap` | `window.fly.export*` |
| `parseIflyLap` (main) | Valida `.iflylap` → forma de sesión | fs |
| IPC main | `export:copy-image`, `export:save-image`, `export:save-lap`, filtro import `.iflylap` | electron `clipboard`, `dialog`, `nativeImage`, `fs` |

## Flujo de datos

1. Usuario selecciona una vuelta en `AnalysisView` → clic "Compartir".
2. **Imagen:** elige formato → `ShareCard` renderiza SVG → canvas → PNG → Copiar / Guardar.
3. **Vuelta:** clic "Exportar .iflylap" → JSON → guardar archivo.
4. **Amigo:** "Importar" el `.iflylap` → `parseIflyLap` → aparece como sesión de una vuelta →
   se puede fijar como ghost/referencia.

## Manejo de errores

- Vuelta sin `samples` suficientes / sin mapa: deshabilitar "Compartir" con tooltip explicativo.
- OSM sin geometría (`NO_GEOMETRY`) o tiles satelitales no disponibles/fetch fallido: la tarjeta
  cae al SVG estilizado sin error visible (solo cambia la base del mapa), y esa fuente no se
  ofrece en el selector.
- Si falla el embebido de tiles como data URLs para el export satelital: se avisa y se ofrece
  exportar con OSM o SVG en su lugar (no se exporta un canvas contaminado a medias).
- `showSaveDialog` cancelado: no-op silencioso.
- `.iflylap` malformado o de versión desconocida al importar: se rechaza con mensaje claro; nunca
  se cuelga el listado (mismo criterio que el parseo tolerante de `.ibt`).
- Portapapeles no disponible: fallback a "Guardar PNG" con aviso.

## Testing

- **Unit (`parseIflyLap`):** round-trip export→import devuelve una vuelta igual al original salvo
  redondeo; rechazo de `format`/`version` inválidos y de JSON corrupto.
- **Unit (armado de tarjeta):** formato de tiempo (`m:ss.mmm`), sectores y badge a partir de una
  vuelta de ejemplo.
- **Manual:** los 3 formatos de imagen (proporción y legibilidad) × las 3 fuentes de mapa
  (OSM / satélite / SVG), incluyendo el export satelital con tiles embebidos (que el PNG no salga
  en blanco por canvas contaminado); una pista sin OSM (fallback a SVG); copiar-y-pegar en
  WhatsApp; guardar PNG; e importar un `.iflylap` en una instancia "de amigo" y usarlo como ghost.

## Estimación de esfuerzo (orientativa)

- `lib/track-render.js` (refactor extractivo) + adaptar `AnalysisView`: ~medio día.
- `ShareCard.jsx` + 3 layouts + render SVG→PNG + selector de fuente de mapa (OSM/satélite/SVG) +
  embebido de tiles como data URLs para el export satelital: ~1,5 días.
- IPC de entrega (copiar/guardar imagen y vuelta) + `preload`: ~medio día.
- `parseIflyLap` + integración al import + discriminador de fuente: ~medio día.
- `SharePanel` (UI) + campo `displayName` en Ajustes: ~medio día.
- Tests + verificación manual: ~medio día.

Total aproximado: **~3,5–4 días** de trabajo enfocado. Es una estimación, no un compromiso.
