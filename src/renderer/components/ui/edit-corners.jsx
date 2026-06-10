import React from "react";

// Esquinas "L" reutilizables. Se posicionan absolute en las 4 esquinas del contenedor padre.
// `width` y `height` definen el tamaño de cada L (en px). `color` define el color del trazo.
export function EditCorners({ width = 14, height = 14, color = "#7dd3fc", thickness = 2 }) {
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
    </>
  );
}
