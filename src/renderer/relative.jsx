import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Relative } from "./components/Relative.jsx";
import "./styles/global.css";

function RelativeApp() {
  const [settings, setSettings] = useState({});
  useEffect(() => {
    if (typeof window === "undefined" || !window.fly) return;
    let mounted = true;
    window.fly.getConfig().then((cfg) => {
      if (!mounted) return;
      const ov = cfg?.overlays?.relative || {};
      setSettings(ov.settings || {});
    });
    const unsub = window.fly.onConfigChange((cfg) => {
      if (!mounted) return;
      const ov = cfg?.overlays?.relative || {};
      setSettings(ov.settings || {});
    });
    return () => {
      mounted = false;
      if (typeof unsub === "function") unsub();
    };
  }, []);
  return <Relative settings={settings} />;
}

const root = createRoot(document.getElementById("root"));
root.render(<RelativeApp />);
