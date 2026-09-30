// Color de la clase de auto: índice de paleta de iRacing o entero RGB de 24 bits.
//
// Vive acá y no en cada overlay porque el Relative y el Standings tienen que
// pintar la misma clase del mismo color: la barra de la fila en uno y la
// cabecera de clase en el otro. Estaba duplicado en los dos componentes.
const CLASS_PALETTE = { 1: "#f6c915", 2: "#3b82f6", 3: "#ef4444", 4: "#22c55e", 5: "#a855f7", 6: "#f97316", 7: "#06b6d4" };

export function classColorCss(c) {
  if (c == null || c === 0) return null;
  if (c > 0 && c <= 16) return CLASS_PALETTE[c] || "rgb(160,160,170)";
  const hex = (c & 0xffffff).toString(16).padStart(6, "0");
  return `#${hex}`;
}

// Mismo color con transparencia, para fondos y degradados.
export function classColorAlpha(c, alpha) {
  const base = classColorCss(c);
  if (!base) return null;
  const a = Math.max(0, Math.min(1, alpha));
  const hex = Math.round(a * 255).toString(16).padStart(2, "0");
  return base.startsWith("#") && base.length === 7 ? `${base}${hex}` : base;
}
