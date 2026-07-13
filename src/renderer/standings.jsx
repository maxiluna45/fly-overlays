import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Standings } from "./components/Standings.jsx";
import "./styles/global.css";

function StandingsApp() {
  const [settings, setSettings] = useState({});
  useEffect(() => {
    if (typeof window === "undefined" || !window.fly) return;
    let mounted = true;
    window.fly.getConfig().then((cfg) => {
      if (!mounted) return;
      const ov = cfg?.overlays?.standings || {};
      setSettings(ov.settings || {});
    });
    const unsub = window.fly.onConfigChange((cfg) => {
      if (!mounted) return;
      const ov = cfg?.overlays?.standings || {};
      setSettings(ov.settings || {});
    });
    return () => {
      mounted = false;
      if (typeof unsub === "function") unsub();
    };
  }, []);
  return <Standings settings={settings} />;
}

const root = createRoot(document.getElementById("root"));
root.render(<StandingsApp />);
