# Changelog

Todos los cambios notables de iFly se documentan en este archivo.

El formato sigue las convenciones de Keep a Changelog (keepachangelog.com) y el
versionado sigue Semantic Versioning (semver.org): MAJOR para cambios que rompen
compatibilidad, MINOR para funcionalidad nueva compatible, PATCH para correcciones.

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
