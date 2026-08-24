# Changelog

Todos los cambios notables de iFly se documentan en este archivo.

El formato sigue las convenciones de Keep a Changelog (keepachangelog.com) y el
versionado sigue Semantic Versioning (semver.org): MAJOR para cambios que rompen
compatibilidad, MINOR para funcionalidad nueva compatible, PATCH para correcciones.

## [0.16.0] - 2026-08-23

### Cambiado
- El banner del coach se reorganizó en tres partes pensadas para leerse de reojo
  manejando: a la izquierda la curva, en el medio el consejo y a la derecha la
  marcha que lleva la referencia. La tipografía es bastante más grande: el
  nombre de la curva y el consejo pasaron a un tamaño legible sin fijar la
  vista, y el número de marcha se ve enorme.
- El cuadro de la marcha **se pinta entero de golpe** cuando la referencia
  cambia: celeste al subir, naranja al bajar. Es un golpe de color de un cuarto
  de segundo para el rabillo del ojo, no algo para leer. La duración está
  medida: en la referencia de Virginia hay 32 cambios por vuelta y los más
  juntos están a 0,43 s, así que el destello dura 0,26 s y alcanza a apagarse
  entre uno y otro — en una bajada en cadena se ven golpes separados y no una
  mancha continua.
- El consejo de la curva que viene se muestra desde antes de llegar, en vez de
  aparecer sólo en el momento del aviso. Se ve venir con tiempo.

### Corregido
- La app se trababa apenas cambiaba de marcha. El código que sigue la marcha de
  la referencia usaba una variable declarada más abajo, lo que en JavaScript
  lanza un error: el aviso moría antes de anotar la marcha nueva, así que en el
  frame siguiente volvía a detectar el mismo cambio y a fallar, unas treinta
  veces por segundo. Fue un descuido del cambio anterior, no un problema de
  fondo.
- La referencia elegida se recuerda entre sesiones. Era lo primero que había que
  volver a elegir cada vez que se abría la vista.
- La voz ya no dice el nombre de la curva. Los nombres vienen en inglés y el
  sintetizador en español los pronunciaba de forma ininteligible. En pantalla se
  siguen mostrando, que es donde se leen bien.

## [0.15.0] - 2026-08-23

### Agregado
- Los cambios de marcha de la referencia se marcan sobre el mapa: un punto en el
  lugar exacto de pista donde hay que cambiar, con la marcha que pone y una
  flecha segun si sube o baja (celeste hacia arriba, naranja hacia abajo). La
  marcha exacta se sabe, no solo la direccion. En la vuelta de Virginia son 32
  cambios, 16 para cada lado.
- Aviso nuevo sobre el momento del cambio, que es distinto de la marcha: se
  puede llegar en la marcha correcta pero haber bajado 30 metros tarde. Cuando
  la marcha coincide pero el punto no, el coach dice "bajá a 3ª 20 m antes". Si
  la marcha es distinta, el consejo que corresponde sigue siendo el de la marcha.

### Cambiado
- La referencia ahora se pinta con cuatro estados del pedal en vez de dos:
  freno, sin gas, gas parcial y a fondo. Antes solo se marcaban freno y a fondo,
  asi que el gas parcial quedaba sin color y parecia que ahi no pasaba nada — en
  la vuelta de Virginia eso es el 15% del recorrido.

## [0.14.2] - 2026-08-23

### Corregido
- El mapa del coach quedaba con manchones negros que no se recuperaban nunca.
  Eran dos cosas: los pedazos de foto se soltaban por antigüedad cuando pasaban
  de 120, pero quedaba anotado que ya se habían pedido, así que al volver a esa
  zona no se volvían a pedir; y un pedazo que fallaba al bajar (un corte de red,
  un error del servidor) se quedaba negro sin reintento.
  - Ahora se sueltan por distancia al auto en vez de por antigüedad, y soltarlos
    borra la anotación: volver a pasar por ahí los vuelve a pedir.
  - Los que fallan se reintentan hasta cuatro veces, esperando cada vez el doble
    (0,4 s, 0,8 s, 1,6 s y 3,2 s).

## [0.14.1] - 2026-08-23

### Corregido
- La trazada real ya aparece a los dos segundos de estar en pista. Antes había
  que completar una vuelta entera antes de que se mostrara, porque la posición
  se calibraba únicamente al cruzar meta. Eso lo había puesto para bajar el
  error, pero en la práctica significaba que a ritmo tranquilo —donde una vuelta
  puede llevar tres minutos— la trazada casi nunca llegaba a aparecer, y si algo
  reiniciaba la cuenta en el camino no aparecía nunca.
  - Ahora la calibración se fija en cuanto se recorrió un octavo de vuelta y se
    sigue afinando con cada muestra. Verificado en una sesión real en pista:
    calibra a los 2 segundos y la posición cae entre 1,4 y 5,6 metros de la
    línea de la referencia, que es la diferencia de trazada esperable dentro del
    ancho del asfalto.
  - El indicador del mapa muestra el avance de la calibración en porcentaje en
    vez de pedir que cruces meta.

## [0.14.0] - 2026-08-23

### Agregado
- Control de volumen para los avisos del coach, con selector de voz y un botón
  para escuchar una prueba. Arranca en 140% y llega hasta 300%.
- La voz se escucha mucho más fuerte y más clara. La voz del navegador reproduce
  el audio ella misma y no lo entrega, así que no había forma de subirla del
  100% ni de procesarla; ahora el audio se genera aparte y se le aplica lo mismo
  que a una radio de carrera: se aprovecha todo el rango (venía usando la mitad),
  se realza la banda de las consonantes y se comprime para levantar el nivel
  medio, que es de lo que depende el volumen que uno percibe.
  - Medido con las dos voces del sistema y frases reales del coach: al 100% el
    nivel medio sube entre 7 y 10 dB respecto de antes, y en el 140% que viene
    por defecto entre 10 y 13 dB, sin una sola muestra recortada. O sea que el
    ajuste por defecto ya suena unas tres veces más fuerte que antes.
  - Arriba del 200% empieza a saturar, pero con un limitador suave: la
    distorsión que aparece es la de una radio, no el chasquido del recorte
    digital.
  - Las frases de la vuelta se preparan al cruzar meta, así que suenan al
    instante en vez de tardar el medio segundo que cuesta generarlas.

### Corregido
- La trazada se quedaba en modo paralelo y el contador de avisos en cero. La
  calibración de la posición se calculaba a partir de las mismas muestras que se
  usan para dibujar, y esas muestras se descartan en cualquier discontinuidad,
  así que la calibración se iba con ellas. Ahora se calcula aparte, sumando
  frame a frame, y no se pierde por eso.
- El pie del mapa muestra cuánto le falta a la calibración y si hubo reinicios
  con su motivo, para no tener que adivinar por qué falta la trazada.

## [0.13.6] - 2026-08-23

### Corregido
- La trazada volvía a quedarse en modo paralelo después de andar un rato. La
  culpa era de una comprobación que agregué el día anterior: daba la calibración
  por rota cuando la posición se alejaba del trazado, y saltaba también en casos
  en que estaba bien. Se eliminó, y la razón de fondo es que no hacía falta: el
  desfase se vuelve a medir en **cada** cruce de meta, así que un salto de
  posición que no venga avisado se corrige solo en la vuelta siguiente.
- Queda la detección explícita, que es la que importa y sí está verificada:
  entrar a boxes o salir del mundo descartan la calibración, que es lo que pasa
  cuando volvés a boxes, te resetean o pedís un tow.
- La calibración ahora se conforma con un tercio de vuelta en vez de media. Si
  perdiste un tramo (un paso por boxes, un rato fuera de pista) antes no se
  recuperaba hasta una vuelta entera limpia.

## [0.13.5] - 2026-08-23

### Corregido
- La trazada se quedaba dibujada en paralelo a la referencia y no volvía nunca a
  la posición real. Era un efecto del arreglo anterior: cuando la calibración se
  daba por rota, también se borraban las muestras de la vuelta, que son
  justamente lo que hace falta para recalibrar al cruzar meta. Sin ellas la
  cobertura nunca alcanzaba el mínimo y la vista quedaba en modo paralelo para
  siempre.
  - Ahora se distinguen los dos casos. Si hubo teletransporte de verdad (boxes,
    reset, tow) las muestras sí se descartan, porque las de antes y las de
    después del salto no son comparables. Si sólo se detecta una desviación, se
    descarta el desfase pero se conservan las muestras, y la calibración se
    recupera en el siguiente cruce de meta.
  - La desviación además tiene que sostenerse medio segundo para contar, así un
    punto ruidoso de la referencia no tira abajo la calibración de la vuelta.
- El pie del mapa ahora muestra cuántas muestras propias hay acumuladas y dice
  "calibrando" en lugar de "sin trazada", para que se vea si le falta vuelta o
  si hay algo mal.

## [0.13.4] - 2026-08-23

### Corregido
- Al volver a boxes el auto quedaba dibujado en el medio del campo y no se
  recuperaba más. iRacing teletransporta el auto cuando volvés a boxes, te
  resetean o pedís un tow, y como la posición se reconstruye integrando la
  velocidad, un salto sin velocidad de por medio es invisible: de ahí en
  adelante todo quedaba corrido por la distancia del teletransporte. Ahora la
  calibración se descarta al entrar a boxes o salir del mundo, y se vuelve a
  medir en el próximo cruce de meta.
- Además hay una comprobación que no depende de la causa: si la posición se va
  más de 40 metros del trazado —imposible incluso yéndose largo—, la calibración
  se da por rota y se remide. Cubre cualquier salto que no venga marcado.

## [0.13.3] - 2026-08-23

### Corregido
- En el coach, la trazada quedaba corrida un par de metros hacia un costado y no
  se acomodaba nunca, la línea de la vuelta anterior no se borraba al cruzar
  meta y el contador de avisos se quedaba en cero. Los tres síntomas eran el
  mismo problema: todo eso pasaba al cruzar la línea, y el evento de "vuelta
  completada" del que dependía no llega en la primera pasada cuando saliste de
  boxes, porque no hay vuelta anterior cronometrada. Ahora el cruce se detecta
  por la propia distancia de vuelta, que siempre está.
- Las muestras del pit lane se descartan. Ahí iRacing cuenta la distancia sobre
  el recorrido de boxes y no sobre el trazado, así que ubicaban el auto en un
  lugar de la pista donde no estaba: medido saliendo de boxes en Oschersleben,
  metían 350 metros de error y dibujaban una trazada que cruzaba la pista.
- La calibración de la posición se hacía con la lista de muestras ya vaciada, así
  que no corregía nada. Era la causa de que la trazada no se acomodara nunca.
- La trazada real ahora aparece recién cuando se calibró con una vuelta entera;
  hasta entonces la leyenda dice "calibrando: cruzá meta una vez" y el auto se
  ubica por distancia de vuelta. Calibrar con media vuelta (la de salida de
  boxes) daba más de 100 metros de error, y mostrarlo era peor que esperar.
  Medido tras el arreglo: 1,3-1,9 m en la primera vuelta completa y 0,1-0,9 m en
  las siguientes.

## [0.13.2] - 2026-08-23

### Cambiado
- Nota interna: la regla de tags del proyecto decía un formato que no era el que
  usa el repo. Sin efecto en la app.

## [0.13.1] - 2026-08-23

### Corregido
- La trazada del coach se iba corriendo hacia el final de la vuelta. Medí de
  dónde venía el error y no era lo que parecía: la integración en sí acumula
  muy poco (entre 0,2 y 1,6 metros en una vuelta entera). El grueso venía de
  cómo se ancla esa trazada a la referencia.
  - Antes se anclaba en **un solo punto**, el del cruce de meta. La geometría de
    la referencia está guardada en 800 tramos, que en Spa son unos 9 metros cada
    uno, así que ese punto puede estar varios metros corrido y desplazaba la
    vuelta entera.
  - Ahora se ajusta con **toda la vuelta**: se promedia el desfase sobre los ~800
    tramos, con lo que el error de un tramo suelto se cancela. Contra el GPS
    real de archivos propios, el error medio pasó de 4,8-8,7 m a 0,9-1,4 m, y en
    el último tramo de la vuelta —justo donde se notaba— de 5,3-8,6 m a
    0,5-1,6 m.
- La integración pasó de regla del rectángulo a la del trapecio. A 60 Hz apenas
  cambia, pero cuando se pierde algún frame el intervalo se agranda y ahí el
  rectángulo se equivoca: a 30 Hz el error medio del F4 baja de 1,35 a 0,85 m.

## [0.13.0] - 2026-08-23

### Agregado
- El coach ahora dibuja **tu trazada real**, no una línea paralela de adorno. Se
  ve por dónde pasás de verdad: si te abrís de más en la entrada, si cortás el
  vértice, si salís más ancho que la referencia.
  - iRacing no publica la posición del auto en vivo, pero sí la velocidad
    (adelante y lateral) y el rumbo respecto del norte. Integrando eso 60 veces
    por segundo la trazada se reconstruye sola.
  - Contrastado contra el GPS real de archivos `.ibt` propios, sobre vueltas
    enteras de entre 110 y 192 segundos: el error medio fue de 0,01 m en el F4
    de Snetterton, 0,25 m en el M2 de Spa, 0,37 m en el GR86 de Spa y 0,68 m en
    el MX-5 de Oschersleben, con un máximo de 1,5 m. Para referencia, un
    circuito de GP tiene unos 12 m de ancho.
  - La posición se re-ancla a la referencia en cada cruce de meta, así el error
    no se arrastra de una vuelta a la siguiente.
  - El rumbo del mapa también sale de ahí, así que la vista gira con el auto sin
    depender de ningún canal nuevo.

## [0.12.3] - 2026-08-23

### Corregido
- El mapa del coach no aparecía nunca estando en pista, y se quedaba en
  "esperando a que salgas a pista". La causa es una limitación de iRacing, no un
  error de cuentas: **la memoria compartida en vivo no publica la posición del
  auto**. Medido con el sim corriendo, expone 333 variables y ninguna es `Lat`,
  `Lon` ni `Alt`; esas sólo aparecen en los archivos `.ibt`. El mapa ahora ubica
  el auto por distancia de vuelta sobre la geometría de la referencia, así que
  funciona con cualquier referencia que traiga posición (un CSV de Garage 61 o
  un `.ibt`).
- El auto se movía a saltos, unas 4 veces por segundo. Se ubicaba en uno de los
  800 bins de la vuelta, y en una pista de 5 km eso es un salto cada 6,5 metros.
  Ahora la posición se interpola entre bins y el movimiento es continuo.
- Tu trazada se dibujaba exactamente encima de la referencia, dando a entender
  que ibas calcándola. Como iRacing no da posición lateral, no hay forma de
  saber por dónde vas dentro del asfalto: ahora tu vuelta va dibujada en una
  banda paralela a la de la referencia, coloreada por TUS pedales, con una
  leyenda que lo aclara. Comparar las dos bandas muestra quién frena antes y
  quién abre el acelerador antes, que es lo que importa.

### Cambiado
- El aviso grande deja de decir "completá una vuelta" cuando ya hay avisos
  calculados: ahora dice cuántas curvas tienen algo para corregir.
- El pie del mapa muestra frames recibidos, cuánta pista se conoce y cuántos
  avisos hay listos, para no tener que adivinar por qué falta algo.

## [0.12.2] - 2026-08-23

### Corregido
- El coach avisaba "la referencia es de otra pista" estando en la pista
  correcta. Comparaba los nombres tal cual, y el mismo circuito llega escrito de
  varias formas: la vuelta de Garage 61 decía "Virginia International Raceway
  (Full Course)" y la sesión en vivo "Virginia International Raceway". Ahora usa
  la misma regla tolerante con la que el Análisis decide si una vuelta sirve de
  referencia.
- El coach detectaba muy pocas curvas en los circuitos con eses. Un tramo se
  cortaba sólo cuando soltabas el volante, así que una ese entera contaba como
  una sola curva: en Virginia salían 5 curvas y la primera medía 1100 metros,
  imposible de usar para anclar un consejo. Ahora el tramo también se corta
  cuando el volante cambia de lado. Virginia pasa de 5 a 14 curvas (17 reales),
  Oschersleben de 8 a 12 (14 reales) y Snetterton de 10 a 12, que son las 12 que
  tiene.

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
