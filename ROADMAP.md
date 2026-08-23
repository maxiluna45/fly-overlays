# Roadmap de iFly

Ideas pendientes, en orden de nada en particular. Cada entrada dice **qué
problema resuelve para el que maneja**, qué datos hacen falta y qué está
verificado y qué no.

Cuando algo se completa, se borra de acá y queda en el `CHANGELOG.md` (que es
lo que lee el usuario final). Este archivo es de trabajo: no lo lee nadie desde
la app.

Estado de cada ítem:

- `[ ]` pendiente
- `[~]` en curso
- `[?]` idea sin decidir todavía si entra

---

## [ ] Orientar el mapa solo

**Problema.** Hoy la rotación del mapa se ajusta a mano por circuito y se guarda
(`saveTrackRot` en `AnalysisView.jsx`). Cada pista nueva arranca torcida.

**Qué cambia.** El mapa nace derecho y el ajuste manual queda como corrección
opcional encima.

**Datos.** Verificado: el YAML trae la orientación real. `TrackNorthOffset` dio
1,8851 rad en Oschersleben y 0,4107 en Lime Rock.

Datos: `WeekendInfo.TrackNorthOffset` · `TrackNumTurns` · `TrackLatitude` /
`TrackLongitude`.

**Cómo se comporta.** El `TrackNorthOffset` es el valor por defecto: el mapa
nace derecho sin tocar nada. Si el usuario mueve la rotación a mano, ese valor
manual pisa al automático y se sigue guardando por circuito como hoy. Se agrega
un botón **"Restablecer original"** que borra el valor manual y vuelve al
offset del YAML.

**Notas.** Con esa regla no hace falta migrar nada: las rotaciones que ya
tenés guardadas siguen siendo overrides manuales y ningún mapa que hoy está
derecho se mueve solo. El automático aplica sólo donde no hay valor guardado,
o sea en las pistas nuevas. No rompe nada → PATCH o MINOR, no MAJOR.

Falta definir un detalle: hoy `saveTrackRot` guarda un número y "sin rotación"
es 0, que es indistinguible de "el usuario eligió 0". Hay que poder distinguir
*no configurado* de *configurado en 0* (guardar `null` / borrar la clave), o el
botón de restablecer no tiene cómo volver atrás.

---

## [?] Coach en vivo contra una referencia de Garage 61

Ventana dentro de la app (no overlay), pensada para segunda pantalla, que
durante una práctica te va corrigiendo contra una vuelta de referencia:
posición en el mapa en tiempo real, carteles grandes y avisos de audio del tipo
"abrí más la curva", "frená más tarde acá", "una marcha menos". Elegís pista
completa, un sector o una curva puntual.

### Cómo se ve

No es el mapa completo quieto: la vista **sigue al auto tipo Google Maps**.
Se muestra sólo la porción de pista donde estás, encuadrada alrededor del auto,
y el mapa se va corriendo con vos. Encima, tres capas:

1. **La referencia, adelante.** El trazado de la vuelta de Garage 61 dibujado
   sobre la pista con el mismo criterio de color que el mapa del análisis (rojo
   donde frena, verde donde acelera), así ves *dónde* deberías estar frenando y
   por dónde debería pasar el auto, no sólo que te lo digan.
2. **Tu recorrido, atrás.** Se va pintando la línea que hiciste, coloreada por
   canal igual que la referencia, para comparar tu trazada contra la de arriba
   de un vistazo. Se borra al cruzar meta y arranca de nuevo cada vuelta.
3. **El auto**, en el centro del encuadre.

Todo eso va **sobre la foto satelital, activada por defecto** en esta vista
(en el análisis hoy el fondo es opcional y arranca apagado). Manejar mirando
el asfalto real, los pianos y los puntos de referencia del costado es lo que
hace que un consejo tipo "abrí más" se entienda sin traducirlo.

Una precisión sobre la fuente, porque en el repo son dos cosas distintas: la
**foto satelital es de Esri World Imagery** (`AnalysisView.jsx:1587`), no de
OpenStreetMap; de **OSM** sale la geometría de la centerline vía Overpass
(`osm-track.js`). La vista nueva usa la foto de Esri como fondo y el contorno
de OSM encima si está disponible. Requiere conexión: sin internet hay que caer
al mapa sin foto, no dejar la vista en negro.

Es la misma máquina de dibujo que ya tiene `AnalysisView.jsx` (contorno SVG del
`trackmap-store`, trazada por lat/lon, coloreo por canal, zoom). Lo que cambia
es el encuadre: hoy el `viewBox` es el bounding box de la vuelta entera; acá el
centro es el punto actual del auto y la ventana es fija (cuántos metros de pista
mostrar, configurable).

Detalles que hay que resolver del encuadre:

- **Orientación.** Para que "arriba" sea hacia dónde vas hace falta el rumbo.
  Hoy `irsdk-client.js` lee `YawRate` pero no `Yaw`: hay que agregarlo, o —
  más estable, sin tembleque — derivar el rumbo de la geometría de la pista en
  el punto donde estás. Falta decidir si el mapa rota con el auto o el auto rota
  sobre un mapa fijo con norte arriba; lo primero se lee mejor de reojo, lo
  segundo marea menos.
- **Tiles.** El mosaico satelital se baja una vez por pista y cubre el bounding
  box de la vuelta entera (hoy se limita a ~130 tiles eligiendo el zoom), así
  que el encuadre puede pasearse por encima sin pedir nada más. Ojo con el
  zoom: si la ventana muestra 200 m de pista, el nivel de detalle que hoy
  alcanza para ver la vuelta completa se va a ver borroso de cerca — hay que
  medirlo y probablemente bajar un par de niveles de zoom, con más tiles.
- **Rendimiento.** No re-renderizar el SVG entero a 60 Hz. Las capas estáticas
  (contorno, referencia) se memoizan una vez por vuelta, como ya se hace en
  `AnalysisView.jsx`, y sólo se actualiza el `transform` del encuadre y la punta
  de tu trazada.
- **Posición en vivo.** `Lat` y `Lon` ya se leen en `irsdk-client.js`. Si el GPS
  tiembla, la alternativa es posicionar por `LapDistPct` sobre la geometría
  guardada, que es lo que hace `reference-lap-store.js`.

**Veredicto: se puede, y sin API de IA generativa.** Las piezas ya existen en el
repo:

- La telemetría propia llega a 60 Hz con `LapDistPct`, velocidad, freno,
  acelerador, marcha y ángulo de volante (`irsdk-client.js`).
- `csv-parser.js` ya importa exports de Garage 61 y los normaliza a 800 bins por
  distancia con velocidad, freno, acelerador, volante, marcha y RPM. Esa es
  exactamente la referencia que necesita el coach.
- `reference-lap-store.js` ya hace lo mismo con tus propias vueltas.

Comparar vivo contra referencia es indexar los dos por `LapDistPct` y restar.
Las reglas son deterministas y se escriben a mano:

| Regla | Cómo se detecta |
|-------|-----------------|
| Frenás antes | punto donde `brake > umbral` está N metros antes que en la referencia |
| Frenás poco | pico de `brake` menor y `speed` mayor en el ápice |
| Marcha de más | `gear` mayor que la referencia en la ventana de la curva |
| Curva cerrada de más | pico de `SteeringWheelAngle` mayor con menos velocidad de salida |
| Acelerás tarde | punto de `throttle > 0.9` posterior al de la referencia |

**Lo que hay que resolver antes de empezar:**

1. **Segmentar curvas.** Las reglas necesitan saber dónde empieza y termina cada
   curva. Se puede derivar de la propia referencia (ventanas donde el volante o
   la aceleración lateral pasan un umbral) y numerarlas contra `TrackNumTurns`.
   Sin esto no hay coach.
2. **Anticipación.** El aviso tiene que llegar *antes* de la curva, no después.
   Con velocidad y distancia se calcula cuántos metros antes disparar cada
   mensaje. Un aviso tarde es peor que ninguno.
3. **No saturar.** Un consejo por curva como máximo, con cooldown y priorizando
   la pérdida de tiempo más grande. Cinco carteles seguidos no los lee nadie.
4. **Audio.** Clips pregrabados o el sintetizador de voz de Windows vía
   `SpeechSynthesis` (funciona offline en Electron). Ambos son deterministas. La
   variedad sale de tener varias frases por regla y rotarlas, no de un modelo.
5. **La referencia importa más que el coach.** Una vuelta de G61 de otro auto o
   con otro setup da consejos que no transfieren. Hay que filtrar por auto y
   avisar cuando la referencia no coincide con lo que estás manejando.
6. **Importar la referencia sigue siendo manual.** Hoy la app arma la URL de
   Garage 61 y abre el navegador (`garage61:url` en `main.js`); el CSV lo bajás
   vos. No hay integración con su API. Eso no bloquea la feature, pero define el
   flujo: elegir un archivo, no un botón mágico.

**Nombre.** No llamarla "radar": ya existe el overlay `radar.jsx` (proximidad).

**Alcance mínimo para una v1.** Una pista, una referencia importada, tres reglas
(punto de frenada, marcha, punto de aceleración), mapa que sigue al auto con
referencia y trazada propia, carteles en pantalla sin audio. Si eso ya sirve manejando, se amplía.
