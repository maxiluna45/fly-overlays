import React from "react";
import { createRoot } from "react-dom/client";
import { Dashboard } from "./components/Dashboard.jsx";
import { ToastProvider } from "./components/ui/toast.jsx";
import "./styles/global.css";

const root = createRoot(document.getElementById("root"));
root.render(
  <ToastProvider>
    <Dashboard />
  </ToastProvider>
);
