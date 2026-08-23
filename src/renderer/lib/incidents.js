// Semáforo de incidentes para el Relative: convierte los incidentes que un
// rival lleva EN ESTA SESIÓN en un color que se lee de reojo a 200 km/h.
//
// Por qué "en esta sesión" y no la carrera deportiva del piloto: iRacing no
// publica el contador de los demás. `Drivers[].CurDriverIncidentCount` viene
// en -1 para todos menos para vos (verificado en 25 .ibt propios). Lo que sí
// trae valores reales por auto es la tabla de resultados de la sesión en curso
// (`ResultsPositions[].Incidents`), que es de donde sale este número — y que
// además es el dato que importa: con quién no conviene pelear una curva HOY.

// Cortes absolutos. Elegidos para que el amarillo aparezca cuando el rival ya
// tuvo más de un roce (no un 4x suelto, que le pasa a cualquiera) y el rojo
// cuando viene claramente en problemas.
const WARN_AT = 2;
const RISK_AT = 4;
// Escalada relativa al límite de la sesión: en una carrera con límite 17x,
// llegar a la mitad es rojo aunque el número absoluto todavía sea bajo.
const RISK_FRACTION = 0.5;
const WARN_FRACTION = 0.25;

export const INCIDENT_COLORS = {
  clean: "rgb(74, 222, 128)",  // verde
  warn: "rgb(234, 179, 8)",    // amarillo
  risk: "rgb(239, 68, 68)",    // rojo
};

// Devuelve null cuando no hay dato (así la fila no muestra un chip vacío).
export function incidentLevel(count, { limit = 0 } = {}) {
  if (count == null || !isFinite(count) || count < 0) return null;
  const lim = limit > 0 ? limit : 0;
  if (count >= RISK_AT || (lim && count >= lim * RISK_FRACTION)) return "risk";
  if (count >= WARN_AT || (lim && count >= lim * WARN_FRACTION)) return "warn";
  return "clean";
}

export function incidentColor(count, opts) {
  const lvl = incidentLevel(count, opts);
  return lvl ? INCIDENT_COLORS[lvl] : null;
}

export function incidentTitle(name, count, { limit = 0 } = {}) {
  if (count == null || count < 0) return "";
  const lim = limit > 0 ? ` de ${limit} permitidos` : "";
  return `${name}: ${count}x en esta sesión${lim}`;
}
