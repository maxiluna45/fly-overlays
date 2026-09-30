import React from "react";

// Esquinas "L" reutilizables. Se posicionan absolute en las 4 esquinas del contenedor padre.
// `width` y `height` definen el tamaño de cada L (en px). `color` define el color del trazo.
// Los handles NO son decoracion: llevan `-webkit-app-region: no-drag` y son lo
// que permite agarrar la ventana para redimensionarla. En edit mode el
// contenedor raiz de cada overlay se marca entero como `drag`, o sea que la
// region de arrastre cubre el 100% de la ventana y tapa los bordes por los que
// Windows redimensiona; sin un hueco `no-drag` no queda de donde agarrarla.
//
// Esto vivia suelto en el JSX del DeltaBar, y era la unica diferencia entre el
// --el unico overlay que se podia mover y redimensionar-- y los otros cuatro,
// que renderizaban solo las "L" decorativas (pointerEvents: none) y quedaban
// clavados. Ahora que esta aca, lo hereda cualquier overlay nuevo.
export function EditCorners({ width = 14, height = 14, color = "#7dd3fc", thickness = 2, handle = 20 }) {
  const corners = [
    { position: "top-0 left-0",     sides: ["top", "left"] },
    { position: "top-0 right-0",    sides: ["top", "right"] },
    { position: "bottom-0 left-0",  sides: ["bottom", "left"] },
    { position: "bottom-0 right-0", sides: ["bottom", "right"] },
  ];
  return (
    <>
      {corners.map((c, i) => {
        const style = {
          position: "absolute",
          width: `${width}px`,
          height: `${height}px`,
          pointerEvents: "none",
          zIndex: 30,
        };
        if (c.sides.includes("top")) style.top = 0;
        if (c.sides.includes("bottom")) style.bottom = 0;
        if (c.sides.includes("left")) style.left = 0;
        if (c.sides.includes("right")) style.right = 0;
        if (c.sides.includes("top")) style.borderTop = `${thickness}px solid ${color}`;
        if (c.sides.includes("bottom")) style.borderBottom = `${thickness}px solid ${color}`;
        if (c.sides.includes("left")) style.borderLeft = `${thickness}px solid ${color}`;
        if (c.sides.includes("right")) style.borderRight = `${thickness}px solid ${color}`;
        return <div key={i} style={style} />;
      })}

      {/* Handles invisibles de resize: el hueco no-drag de cada esquina. */}
      {[
        { pos: { top: 0, left: 0 }, cursor: "nwse-resize" },
        { pos: { top: 0, right: 0 }, cursor: "nesw-resize" },
        { pos: { bottom: 0, left: 0 }, cursor: "nesw-resize" },
        { pos: { bottom: 0, right: 0 }, cursor: "nwse-resize" },
      ].map((h, i) => (
        <div
          key={`rh-${i}`}
          style={{
            position: "absolute",
            ...h.pos,
            width: `${handle}px`,
            height: `${handle}px`,
            zIndex: 40,
            cursor: h.cursor,
            WebkitAppRegion: "no-drag",
          }}
        />
      ))}
    </>
  );
}
