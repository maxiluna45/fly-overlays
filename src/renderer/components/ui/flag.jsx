import React from "react";
import { flagCodeForClub } from "../../lib/club-flags.js";

// Bandera del país del club del piloto, vía flag-icons (clase `fi fi-<code>`).
// Si el club no mapea a un país único (pan-regional como South America /
// Scandinavia, o desconocido), flagCodeForClub devuelve null y no renderizamos
// nada: la fila queda sin bandera sin romper el layout ni mostrar un país
// incorrecto. Ver src/renderer/lib/club-flags.js para la limitación de fondo
// (el ClubName es la región del club, no la nacionalidad real del piloto).
export const Flag = React.memo(function Flag({ club, size = 14, title }) {
  const code = flagCodeForClub(club);
  if (!code) return null;
  const w = Math.round((size * 4) / 3); // relación 4:3 de flag-icons/flags/4x3
  return (
    <span
      className={`fi fi-${code} flex-shrink-0`}
      title={title || club}
      style={{
        width: `${w}px`,
        height: `${size}px`,
        borderRadius: "2px",
        boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.35)", // borde sutil para banderas claras
        backgroundSize: "cover",
      }}
    />
  );
});
