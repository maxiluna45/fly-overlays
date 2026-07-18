import React from "react";
import { flagCodeForClub } from "../../lib/club-flags.js";

// Bandera del país del club del piloto, vía flag-icons (clase `fi fi-<code>`).
// Si el club no mapea a un país único (pan-regional como South America /
// Scandinavia, o desconocido), NO mostramos una bandera real —no atribuimos un
// país incorrecto— pero sí un placeholder neutro DEL MISMO TAMAÑO, para que la
// columna del nombre quede alineada con las filas que sí tienen bandera.
// Ver src/renderer/lib/club-flags.js para la limitación de fondo (el ClubName
// es la región del club, no la nacionalidad real del piloto).
//
// `overrideCode` (ISO2) fuerza una bandera ignorando el club: se usa para la
// fila del propio player, cuya nacionalidad configura a mano (el club "South
// America" no distingue países). Ver el setting "Mi país" en el Dashboard.
export const Flag = React.memo(function Flag({ club, size = 14, title, overrideCode }) {
  const code = overrideCode ? String(overrideCode).toLowerCase() : flagCodeForClub(club);
  const w = Math.round((size * 4) / 3); // relación 4:3 de flag-icons/flags/4x3
  const base = {
    width: `${w}px`,
    height: `${size}px`,
    borderRadius: "2px",
  };

  // Sin país conocido → recuadro atenuado que ocupa el mismo espacio.
  if (!code) {
    return (
      <span
        className="flex-shrink-0"
        title={club ? `${club} (sin bandera)` : "País desconocido"}
        style={{
          ...base,
          background: "rgba(255,255,255,0.06)",
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.10)",
        }}
      />
    );
  }

  return (
    <span
      className={`fi fi-${code} flex-shrink-0`}
      title={title || club}
      style={{
        ...base,
        boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.35)", // borde sutil para banderas claras
        backgroundSize: "cover",
      }}
    />
  );
});
