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

## [ ] Coach en vivo: lo que quedó afuera de la v1

La vista ya está (mapa que sigue al auto sobre satelital, referencia adelante,
recorrido atrás, avisos anticipados por curva con voz opcional). Falta:

- **"Tomala más abierta".** Hoy no hay ninguna regla sobre la trazada en sí, sólo
  sobre pedales, marcha y velocidad. Con el GPS de las dos vueltas se puede
  medir la distancia lateral entre tu línea y la de la referencia en cada punto
  y avisar "te estás abriendo/cerrando N metros acá". Es la regla que más se
  parece a lo que pide un coach de verdad.
- **Numeración de curvas.** Las curvas se detectan por el volante de la
  referencia, así que una chicana cuenta como una y los números no coinciden con
  los del circuito salvo que la pista esté en la base de Lovely.
- **Elegir qué vuelta de la referencia usar.** Hoy agarra la más rápida de la
  sesión elegida, sin preguntar.
- **Bajar la referencia sola.** Sigue siendo manual: exportás el CSV de Garage 61
  y lo importás. No hay integración con su API.
- **Probar la vista con iRacing corriendo.** El motor está verificado con
  replays de .ibt reales y la vista monta sin errores, pero el mapa en vivo, la
  voz y el encuadre todavía no se manejaron en pista.
