import * as React from "react";
import { cn } from "@/lib/utils";

const ToggleGroup = React.forwardRef(
  ({ className, value, onValueChange, items, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          "inline-flex h-9 items-center rounded-md border border-input bg-transparent p-0.5",
          className
        )}
        {...props}
      >
        {items.map((item) => {
          const isActive = value === item.value;
          return (
            <button
              key={item.value}
              type="button"
              onClick={() => onValueChange?.(item.value)}
              className={cn(
                "inline-flex h-8 items-center justify-center rounded-sm px-3 text-xs font-medium transition-all",
                isActive
                  ? "bg-primary text-primary-foreground shadow"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    );
  }
);
ToggleGroup.displayName = "ToggleGroup";

export { ToggleGroup };
