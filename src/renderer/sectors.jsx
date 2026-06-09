import React from "react";
import { createRoot } from "react-dom/client";
import { SectorTimes } from "./components/SectorTimes.jsx";
import "./styles/global.css";

const root = createRoot(document.getElementById("root"));
root.render(<SectorTimes />);
