// Mosaico de tiles satelitales alrededor del auto, para el mapa del coach.
//
// El mapa se pasea por el circuito, así que no se pueden tener todos los tiles
// cargados a la vez: hay que ir pidiendo los de la zona y soltar los lejanos.
// Eso tiene dos trampas que dejaban el mapa con agujeros negros permanentes:
//
//   1. Soltar el tile pero recordar que "ya se pidió". Al volver a esa zona no
//      se volvía a pedir nunca y quedaba en negro. Acá el descarte borra el
//      registro, así que volver a pasar lo vuelve a pedir.
//   2. Un tile que falla al bajar (un corte de red, un 500 del servidor) se
//      quedaba negro para siempre. Para eso está `attempt`: la vista lo usa
//      para reintentar unas cuantas veces con espera creciente.

const TILE_PX = 256;

// Rango de índices de tile que cubre un cuadrado de lado 2·half centrado en
// (cx, cy), en píxeles absolutos de Web Mercator.
export function tileBounds(cx, cy, half, size = TILE_PX) {
  return {
    x0: Math.floor((cx - half) / size),
    x1: Math.floor((cx + half) / size),
    y0: Math.floor((cy - half) / size),
    y1: Math.floor((cy + half) / size),
  };
}

export function inBounds(tile, b) {
  return tile.tx >= b.x0 && tile.tx <= b.x1 && tile.ty >= b.y0 && tile.ty <= b.y1;
}

// Pone al día el mapa de tiles: agrega los que hacen falta para la vista y
// suelta los que quedaron lejos. Muta `map` y devuelve true si algo cambió (la
// vista sólo re-renderiza cuando cambió).
//
// `keepFactor` es cuánto más grande que la zona visible es la zona que se
// conserva. Con 1 se soltarían tiles que están justo al borde y volverían a
// pedirse en el frame siguiente; con un margen holgado, el ir y venir normal no
// genera pedidos de más.
export function syncTiles(map, { cx, cy, half, keepFactor = 3, makeTile, maxTiles = 600 }) {
  const need = tileBounds(cx, cy, half);
  const keep = tileBounds(cx, cy, half * keepFactor);
  let changed = false;

  for (let tx = need.x0; tx <= need.x1; tx++) {
    for (let ty = need.y0; ty <= need.y1; ty++) {
      const k = `${tx}/${ty}`;
      if (map.has(k)) continue;
      map.set(k, { k, tx, ty, attempt: 0, ...makeTile(tx, ty) });
      changed = true;
    }
  }

  for (const [k, t] of map) {
    if (!inBounds(t, keep)) { map.delete(k); changed = true; }
  }

  // Tope de seguridad: si algo hiciera crecer el mapa sin control, se sueltan
  // los que estén más lejos del centro (y se podrán volver a pedir).
  if (map.size > maxTiles) {
    const byDist = [...map.values()]
      .map((t) => ({ t, d: Math.hypot(t.tx * TILE_PX - cx, t.ty * TILE_PX - cy) }))
      .sort((a, b) => b.d - a.d);
    for (const { t } of byDist.slice(0, map.size - maxTiles)) { map.delete(t.k); changed = true; }
  }

  return changed;
}

// URL del reintento. La primera vez se usa la URL tal cual, para aprovechar el
// caché del navegador; en los reintentos se le agrega un parámetro para que no
// devuelva la respuesta fallida que quedó cacheada.
export function tileUrl(base, attempt) {
  if (!attempt) return base;
  return `${base}${base.includes('?') ? '&' : '?'}r=${attempt}`;
}
