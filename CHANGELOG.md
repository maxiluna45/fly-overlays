# Changelog

Todos los cambios notables de iFly se documentan en este archivo.

El formato sigue las convenciones de Keep a Changelog (keepachangelog.com) y el
versionado sigue Semantic Versioning (semver.org): MAJOR para cambios que rompen
compatibilidad, MINOR para funcionalidad nueva compatible, PATCH para correcciones.

## [0.12.1] - 2026-08-23

### Corregido
- El panel se abría completamente en negro al correr la app desde el código con
  `npm run dev`. Dos módulos del renderer (`session-match.js` y `changelog.js`)
  seguían escritos en CommonJS y el navegador no puede importar nombres sueltos
  de un módulo así: el import fallaba antes de montar nada y se llevaba puesta
  toda la ventana. En la app instalada no se notaba porque el empaquetado sí los
  convierte. Ahora son módulos ESM como el resto.

## [0.12.0] - 2026-08-22

### Agregado
- **Coach en vivo**: pestaña nueva en el panel, pensada para segunda pantalla,
  que te va corrigiendo durante una práctica contra una vuelta de referencia
  (por ejemplo un CSV de Garage 61 importado, que la app ya sabía leer).
  - **Mapa que te sigue**, estilo Google Maps: se ve sólo el pedazo de pista
    donde vas, sobre la foto satelital encendida por defecto, girando con el
    auto (o con el norte arriba, es un botón). Se elige cuánta pista mostrar:
    120, 220, 400 u 800 metros.
  - **La referencia dibujada adelante**, con las zonas de freno en rojo y las
    de acelerador a fondo en verde, para ver dónde tenés que frenar y dónde
    abrir, no sólo que te lo digan.
  - **Tu recorrido pintándose atrás** en amarillo, que se borra al cruzar meta.
  - **Avisos curva por curva** con lo que hiciste distinto: punto de frenada,
    marcha, velocidad de ápice y punto de aceleración. El aviso llega ~2,5
    segundos ANTES del punto de frenada de esa curva, que es lo único que lo
    hace útil; medido sobre vueltas reales en Snetterton, eso da entre 100 y
    150 metros de anticipación.
  - **Voz opcional** (apagada por defecto): lee el aviso con el sintetizador de
    Windows. No hay ningún modelo de IA ni conexión a un servicio: las reglas
    son umbrales sobre la telemetría y las frases están escritas a mano, con
    varias por regla para que no repita siempre lo mismo.
  - **Alcance elegible**: pista completa, un sector o una curva puntual.
  - Las curvas salen del volante de la propia referencia, así que agrupan los
    complejos (una chicana es una sola curva) y no coinciden necesariamente con
    la numeración oficial del circuito. Cuando la pista está en la base de
    Lovely, el aviso usa el nombre real de la curva.
  - Si la referencia es de otra pista, la vista lo avisa en vez de dar consejos
    que no aplican.

### Cambiado
- El emparejado de pistas con la base de curvas de Lovely pasó a un módulo
  compartido, así el análisis y el coach usan exactamente el mismo criterio.

## [0.11.0] - 2026-08-22

### Agregado
- El mapa del análisis nace con la orientación real del circuito. iRacing
  informa en cada sesión hacia dónde está girada la pista respecto del norte
  (`TrackNorthOffset`), y ahora el mapa usa ese dato en vez de arrancar siempre
  con el norte arriba: Spa nace a 268°, Oschersleben a 252° y Lime Rock a 336°.
  Las pistas nuevas ya no aparecen torcidas.
- Botón "Restablecer original" al lado del control de rotación: borra tu ajuste
  manual de ese circuito y vuelve a la orientación que informa iRacing.

### Cambiado
- La rotación que ajustás a mano sigue mandando sobre la automática y se sigue
  guardando por circuito, así que los mapas que ya tenías derechos no se mueven.
  La automática se aplica sólo donde nunca tocaste la rotación. Internamente ya
  se distingue "sin configurar" de "configurado en 0", que es lo que le permite
  al botón de restablecer saber a qué volver.

## [0.10.0] - 2026-08-22

### Agregado
- Semáforo de incidentes en el Relative. Al lado del nombre de cada rival
  aparece un chip con los incidentes que lleva en esta sesión: verde hasta 1,
  amarillo desde 2 y rojo desde 4 (o antes, si la sesión tiene un límite bajo y
  ya se comió la mitad). Sirve para saber de un vistazo con quién no conviene
  pelear una curva. Se puede apagar desde la configuración del overlay.
- El número es el de ESTA sesión, no el historial del piloto: iRacing no
  publica el contador de los rivales. `CurDriverIncidentCount` viene en -1 para
  todos menos para vos (verificado en 25 sesiones propias), así que el dato sale
  de la tabla de resultados de la sesión, que sí trae el número por auto.

## [0.9.0] - 2026-08-22

### Agregado
- Suspensión y frenos en el análisis. En las sesiones abiertas desde un `.ibt`
  aparecen tres gráficos nuevos y una tarjeta de resumen que muestran lo que la
  velocidad y los pedales no dejan ver: en qué curva bloqueaste una rueda y
  cuál, dónde te comiste un piano o tocaste el fondo, y con qué reparto real
  entre eje delantero y trasero estás frenando.
  - El bloqueo se mide comparando la velocidad de cada rueda contra la del auto,
    y sólo cuenta cuando se sostiene ~50 ms: un pico suelto es ruido. Medido en
    sesiones propias, el MX-5 (con ABS) marca 2 bloqueos por vuelta en
    Oschersleben y el F4 (sin ABS) marca 6 en Snetterton, todos en las mismas
    curvas vuelta a vuelta.
  - Los golpes salen de la velocidad del amortiguador, que es la que delata el
    impacto: en Oschersleben el más fuerte fue de 1,40 m/s en la rueda trasera
    derecha, siempre en el mismo punto de pista.
  - El reparto de frenada es el medido en la línea, no el del setup: 64%
    delantero en el MX-5, 57% en el F4. Los autos que informan la misma presión
    en los dos ejes (verificado en el BMW M2 G87) lo dicen en vez de mostrar un
    50% inventado.
  - Las sesiones grabadas en vivo por la app todavía no guardan estos canales,
    así que el panel aparece sólo al abrir un `.ibt`.

## [0.8.0] - 2026-08-22

### Agregado
- Vista de Changelog, que se abre tocando el número de versión en el header del panel.

### Cambiado
- El overlay de Standings ahora muestra la última vuelta además de la mejor
  cuando estás en carrera, para poder leer el ritmo actual de un rival. En
  práctica y clasificación sigue mostrando solo la mejor, y el interruptor de
  "última vuelta" sigue funcionando como forzado manual.

### Corregido
- El mouse se veía trabado en todo el escritorio con la app abierta, incluso sin
  iRacing corriendo. Los overlays le pedían a Electron el reenvío de mouse move
  messages (`setIgnoreMouseEvents` con `forward`), que en Windows instala un hook
  global de mouse de bajo nivel en el main process: todo evento de mouse del
  sistema se serializaba por nuestro message loop. Medido con 5 overlays: mover
  el mouse costaba 25-32% de CPU en el main (picos de 62%) y los tirones del
  cursor pasaban de 0,019% a 0,135%. Ningún overlay escuchaba eventos de mouse,
  así que el reenvío se pagaba sin recibir nada a cambio.
- El metadata de las vueltas exportadas informaba la versión 0.7.6 fija en lugar
  de la versión real de la app.
- Un CSV importado de Garage 61 nunca aparecía como referencia para comparar
  contra una sesión de iRacing del mismo circuito y auto. El filtro comparaba el
  nombre de circuito de Garage 61 ("Motorsport Arena Oschersleben (Grand Prix)")
  contra el nombre interno de iRacing ("oschersleben gp"), que no tienen nada en
  común. Ahora se prueban todos los nombres que trae cada sesión, así que
  alcanza con que uno coincida.
