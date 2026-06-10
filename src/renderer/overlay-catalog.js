import { Gauge, Layers, CircleDot, ListOrdered } from "lucide-react";

export const OVERLAY_META = {
  delta: {
    name: "Delta Bar",
    description: "Diferencia vs best lap",
    icon: Gauge,
  },
  sectors: {
    name: "Sector Times",
    description: "Micro-sectores vs vuelta anterior y best",
    icon: Layers,
  },
  tyres: {
    name: "Tyres",
    description: "Temperatura y presión de neumáticos",
    icon: CircleDot,
  },
  relative: {
    name: "Relative",
    description: "Clasificación en tiempo real",
    icon: ListOrdered,
  },
};
