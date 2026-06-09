import * as React from "react";
import { cn } from "@/lib/utils";

// Slider vertical minimalista (sin Radix, más simple para una sola dirección)
export const VerticalSlider = React.forwardRef(
  ({ className, value = 0, min = 0, max = 100, step = 1, onValueChange }, ref) => {
    const trackRef = React.useRef(null);
    const dragging = React.useRef(false);

    const pct = ((value - min) / (max - min)) * 100;

    const updateFromY = (clientY) => {
      const el = trackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const ratio = 1 - (clientY - rect.top) / rect.height; // invertido: arriba = max
      const clamped = Math.max(0, Math.min(1, ratio));
      const newValue = min + clamped * (max - min);
      const stepped = Math.round(newValue / step) * step;
      if (onValueChange) onValueChange(stepped);
    };

    const handlePointerDown = (e) => {
      e.preventDefault();
      dragging.current = true;
      updateFromY(e.clientY);
      const move = (ev) => {
        if (dragging.current) updateFromY(ev.clientY);
      };
      const up = () => {
        dragging.current = false;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };

    return (
      <div
        className={cn(
          "flex flex-col items-center gap-2 select-none px-2 py-3 rounded-full",
          "bg-zinc-900/60 border border-white/10 backdrop-blur-sm",
          className
        )}
        ref={ref}
      >
        <span className="text-[10px] font-mono text-white/60 tnum">
          {Math.round(value)}%
        </span>
        <div
          ref={trackRef}
          onPointerDown={handlePointerDown}
          className="relative w-1.5 h-32 bg-white/10 rounded-full cursor-pointer"
        >
          <div
            className="absolute left-0 right-0 bottom-0 bg-white/40 rounded-full"
            style={{ height: `${pct}%`, transition: dragging.current ? "none" : "height 0.1s" }}
          />
          <div
            className="absolute left-1/2 -translate-x-1/2 size-3 rounded-full bg-white shadow-md border border-white/20 cursor-grab active:cursor-grabbing"
            style={{ bottom: `calc(${pct}% - 6px)`, transition: dragging.current ? "none" : "bottom 0.1s" }}
          />
        </div>
      </div>
    );
  }
);
VerticalSlider.displayName = "VerticalSlider";
