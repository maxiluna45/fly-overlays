// Qué filas de la tabla se ven.
//
// Antes se cortaba en maxRows y, si el jugador no entraba en el corte, se le
// pisaba la última fila: veías del 1 al 10 y después vos, suelto, sin los autos
// con los que estás peleando. Ahora el modo compacto muestra los primeros de tu
// clase, un corte, y tu entorno; de las otras clases, sólo el podio.

const TOP = 5;      // primeros de tu clase que se ven siempre
const ALREDEDOR = 3; // cuántos por delante y por detrás tuyo
const PODIO = 3;    // de las clases que no son la tuya

// `rows` ya viene ordenado por clase y posición (lo arma el Standings).
// Devuelve la misma lista con dos tipos de fila intercalados:
//   { _classHeader: true, classId, count, ... }  cabecera de clase
//   { _separator: true }                          el corte entre bloques
export function compactRows(rows, { playerIdx = -1, compact = true } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  // Agrupar conservando el orden de aparición de cada clase.
  const orden = [];
  const porClase = new Map();
  for (const r of rows) {
    const cid = String(r._classId ?? '');
    if (!porClase.has(cid)) { porClase.set(cid, []); orden.push(cid); }
    porClase.get(cid).push(r);
  }
  const multi = orden.length > 1;
  const claseDelJugador = rows.find((r) => r.carIdx === playerIdx)?._classId;

  const out = [];
  for (const cid of orden) {
    const lista = porClase.get(cid);
    // La cabecera cuenta TODOS los de la clase, no los que se ven: el punto es
    // saber cuántos largaron, que es la pregunta que no se podía contestar.
    if (multi) out.push({ _classHeader: true, classId: cid, count: lista.length, rows: lista });
    for (const fila of visibles(lista, cid, claseDelJugador, playerIdx, compact, multi)) out.push(fila);
  }
  return out;
}

function visibles(lista, cid, claseDelJugador, playerIdx, compact, multi) {
  if (!compact) return lista;
  // Clase ajena: sólo el podio.
  if (multi && String(claseDelJugador ?? '') !== cid) return lista.slice(0, PODIO);

  const iJugador = lista.findIndex((r) => r.carIdx === playerIdx);
  // Sin jugador en esta clase (o sin identificar): los primeros y nada más.
  if (iJugador < 0) return lista.slice(0, TOP);

  const desde = Math.max(0, iJugador - ALREDEDOR);
  const hasta = Math.min(lista.length, iJugador + ALREDEDOR + 1);
  // Si el entorno pisa el top, es una lista sola y sin corte: repetir filas o
  // meter un separador entre el 5to y el 6to sería ruido.
  // Math.max: yendo 1ro el entorno termina en la 4ta y sin esto se perdia la 5ta.
  if (desde <= TOP) return lista.slice(0, Math.max(TOP, hasta));
  return [...lista.slice(0, TOP), { _separator: true }, ...lista.slice(desde, hasta)];
}

export const RECORTE = { TOP, ALREDEDOR, PODIO };
