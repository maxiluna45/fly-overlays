import * as React from "react";
import { cn } from "@/lib/utils";
import { X, Download, CheckCircle2, AlertCircle, Info } from "lucide-react";

const ICONS = {
  info: Info,
  success: CheckCircle2,
  error: AlertCircle,
  update: Download,
};

const TONE_CLASSES = {
  info: "border-border bg-card text-foreground",
  success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-50",
  error: "border-red-500/30 bg-red-500/10 text-red-50",
  update: "border-blue-500/30 bg-blue-500/10 text-blue-50",
};

const ToastContext = React.createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = React.useState([]);

  const dismiss = React.useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = React.useCallback(
    (toast) => {
      const id = toast.id || Math.random().toString(36).slice(2);
      const t = { id, duration: 5000, tone: "info", ...toast };
      setToasts((prev) => {
        const exists = prev.some((x) => x.id === id);
        if (exists) {
          return prev.map((x) => (x.id === id ? { ...x, ...toast } : x));
        }
        return [...prev, t];
      });
      if (t.duration > 0) {
        setTimeout(() => dismiss(id), t.duration);
      }
      return id;
    },
    [dismiss]
  );

  const update = React.useCallback((id, patch) => {
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...patch } : t))
    );
  }, []);

  const value = React.useMemo(
    () => ({ show, dismiss, update }),
    [show, dismiss, update]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm w-full pointer-events-none">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }) {
  const Icon = ICONS[toast.tone] || Info;
  return (
    <div
      className={cn(
        "pointer-events-auto rounded-lg border shadow-lg backdrop-blur-md p-3 flex items-start gap-3 animate-in slide-in-from-right",
        TONE_CLASSES[toast.tone] || TONE_CLASSES.info
      )}
    >
      <Icon className="size-4 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        {toast.title && (
          <div className="text-sm font-semibold">{toast.title}</div>
        )}
        {toast.description && (
          <div className="text-xs opacity-80 mt-0.5">{toast.description}</div>
        )}
        {toast.progress !== undefined && (
          <div className="mt-2 h-1 bg-white/10 rounded-full overflow-hidden">
            <div
              className="h-full bg-current transition-all duration-200"
              style={{ width: `${Math.round(toast.progress)}%` }}
            />
          </div>
        )}
        {toast.action && (
          <button
            onClick={() => {
              toast.action.onClick();
              onDismiss();
            }}
            className="mt-2 text-xs font-semibold underline underline-offset-2 opacity-90 hover:opacity-100 cursor-pointer"
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        onClick={onDismiss}
        className="opacity-50 hover:opacity-100 transition-opacity cursor-pointer"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

export function useToast() {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error("useToast debe usarse dentro de <ToastProvider>");
  return ctx;
}
