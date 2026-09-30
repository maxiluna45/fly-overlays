// Orden de carrera con memoria de los autos que ya no están.
//
// iRacing borra de la memoria compartida a los autos que se van al garage o se
// desconectan (CarIdxTrackSurface pasa a -1), pero esos autos siguen
// clasificados en el resultado. Si la posición se recalcula sólo con los autos
// visibles, cada abandono corre un lugar a todos los de atrás y el número que ve
// el jugador mejora solo. Al final de una carrera, cuando los de adelante van
// terminando y saliendo, eso hacía imposible saber en qué posición se termina.
//
// Acá se guarda el mayor progreso visto de cada auto (vueltas completadas más
// fracción de la vuelta en curso) y el instante en que lo alcanzó. El que
// desaparece se queda con su último valor y sigue ocupando su lugar.

// Criterio de orden, que es el de iRacing:
//   1. más vueltas completadas, adelante;
//   2. a igual vuelta, el que terminó le gana al que no;
//   3. entre dos que terminaron, el que cruzó primero;
//   4. entre dos en carrera, el que está más adelante en la vuelta.
function compareCars(a, b) {
  const la = Math.floor(a.prog), lb = Math.floor(b.prog);
  if (la !== lb) return lb - la;
  if (!!a.finished !== !!b.finished) return a.finished ? -1 : 1;
  if (a.finished && b.finished) return a.finishedAt - b.finishedAt;
  if (b.prog !== a.prog) return b.prog - a.prog;
  return a.carIdx - b.carIdx; // desempate estable, para que no baile el orden
}

// Anota lo que se ve de los autos presentes en este frame. `cars` son los autos
// visibles ({ carIdx, cls, prog }); los que faltan quedan como estaban.
// `checkered` avisa que ya ondea la bandera: desde ese momento, el primer cruce
// de meta de cada auto es su llegada, y su progreso se congela ahí para que la
// vuelta de enfriamiento no lo siga sumando por encima de los que ya llegaron.
function rememberProgress(memory, cars, now, { checkered = false } = {}) {
  const m = memory || {};
  if (!Array.isArray(cars)) return m;
  for (const c of cars) {
    if (!c || c.carIdx == null) continue;
    const prog = c.prog;
    if (prog == null || !isFinite(prog) || prog < 0) continue;
    const prev = m[c.carIdx];
    if (!prev) {
      m[c.carIdx] = { carIdx: c.carIdx, cls: c.cls, prog, at: now, finished: false, finishedAt: 0 };
      continue;
    }
    if (c.cls != null) prev.cls = c.cls;
    if (prev.finished) continue; // ya llegó: su progreso no se toca más
    if (prog <= prev.prog) continue;
    // Cruzó la meta con la bandera afuera: esa es su llegada.
    if (checkered && Math.floor(prog) > Math.floor(prev.prog)) {
      prev.finished = true;
      prev.finishedAt = now;
    }
    prev.prog = prog;
    prev.at = now;
  }
  return m;
}

// { carIdx: posición en su clase }, contando también a los que ya no se ven.
function positionsByClass(memory) {
  const out = {};
  const byCls = {};
  for (const k in memory) {
    const e = memory[k];
    if (!e) continue;
    (byCls[e.cls] || (byCls[e.cls] = [])).push(e);
  }
  for (const cls in byCls) {
    byCls[cls].sort(compareCars).forEach((e, i) => { out[e.carIdx] = i + 1; });
  }
  return out;
}

// Cuántos autos de esa clase hay en la carrera, incluidos los que se fueron.
function countInClass(memory, cls) {
  let n = 0;
  for (const k in memory) if (memory[k] && memory[k].cls === cls) n++;
  return n;
}

module.exports = { rememberProgress, positionsByClass, countInClass, compareCars };
