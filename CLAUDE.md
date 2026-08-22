# iFly — instrucciones del proyecto

Overlays de iRacing con Electron + React. `src/main/` es el proceso main
(Node), `src/renderer/` es la UI (React + Vite + Tailwind). Los tests corren
con `node --test` (`npm test`), sin framework externo.

## Regla de release: todo commit lleva bump de versión y entrada en el changelog

Antes de cada commit, sin excepción:

1. **Decidir el nivel de semver** según lo que cambió (ver tabla abajo).
2. **Bumpear `version` en `package.json`.** Es la única fuente de la versión: el
   `define` de `vite.config.js` la expone al renderer como `APP_VERSION`. No
   hardcodear números de versión en ningún otro archivo.
3. **Agregar la entrada al `CHANGELOG.md`**, arriba de todo, con la fecha del
   día en formato ISO (`## [0.8.0] - 2026-08-22`) y los cambios agrupados en
   `### Agregado` / `### Cambiado` / `### Corregido` / `### Eliminado`.
4. **Incluir ambos archivos en el mismo commit** que el cambio que describen.

El test `test/changelog.test.js` falla si la release más nueva del
`CHANGELOG.md` no coincide con la versión de `package.json`, así que `npm test`
atrapa el olvido.

### Cómo elegir el nivel

| Nivel | Cuándo | Ejemplo |
|-------|--------|---------|
| MAJOR | Rompe algo con lo que el usuario ya contaba: se pierde config guardada, cambia el formato de las grabaciones o de los `.ifly-lap` exportados, desaparece un overlay o un atajo | Cambiar el esquema de `config.json` sin migración |
| MINOR | Funcionalidad nueva compatible | Un overlay nuevo, una vista nueva del panel, una opción de configuración nueva |
| PATCH | Correcciones y mejoras que no agregan funcionalidad | Arreglar un bug, mejorar rendimiento, ajustar estilos, refactors internos |

**Si el nivel no está claro, preguntarle al usuario antes de commitear.** Casos
típicos de duda que ameritan preguntar: un cambio de rendimiento que además
altera comportamiento visible; un cambio que técnicamente rompe algo pero solo
en un caso que quizá nadie usa; varios cambios de niveles distintos juntos.

Un commit que mezcla un bugfix con una feature debería ser dos commits. Si de
todos modos van juntos, gana el nivel más alto de los dos.

### Escribir las entradas del changelog

Las lee el usuario final en el panel (la vista se abre tocando la versión en el
header), así que se escriben para él, no para el equipo:

- En español, describiendo el efecto observable, no la implementación.
- Empezar por lo que el usuario nota. "El mouse se veía trabado con la app
  abierta" antes que "se quitó el flag `forward` de `setIgnoreMouseEvents`".
- La causa técnica va después, en la misma entrada, cuando explica el síntoma.
- Números medidos cuando existan; nada de "mejoras de rendimiento" a secas.
- Sin relleno: si un commit no cambia nada observable (typos en comentarios,
  formato), sigue necesitando bump de PATCH, pero la entrada puede ser una
  línea sola.

### Tags de git

**No crear tags por commit.** El tag de release lo decide el usuario cuando
agrupa varios commits para publicar. Formato sin prefijo (`0.8.0`), siguiendo
el tag más reciente del repo.
