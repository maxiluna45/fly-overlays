import { Gauge, Layers, ListOrdered, Trophy } from "lucide-react";

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
  relative: {
    name: "Relative",
    description: "Clasificación en tiempo real",
    icon: ListOrdered,
  },
  standings: {
    name: "Standings",
    description: "Tabla completa del field",
    icon: Trophy,
  },
};
