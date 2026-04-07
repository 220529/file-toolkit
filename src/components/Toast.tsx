import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { cn } from "../utils/cn";

interface ToastItem {
  id: number;
  type: "success" | "error" | "info" | "warning";
  message: string;
}

interface ToastContextType {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
  warning: (message: string) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

let toastId = 0;

const toneClasses = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  error: "border-rose-200 bg-rose-50 text-rose-800",
  info: "border-blue-200 bg-blue-50 text-blue-800",
  warning: "border-amber-200 bg-amber-50 text-amber-800",
};

const icons = {
  success: "✓",
  error: "!",
  info: "i",
  warning: "•",
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const addToast = useCallback((type: ToastItem["type"], message: string) => {
    const id = ++toastId;
    setToasts((current) => [...current, { id, type, message }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id));
    }, 3200);
  }, []);

  const value = useMemo<ToastContextType>(
    () => ({
      success: (message) => addToast("success", message),
      error: (message) => addToast("error", message),
      info: (message) => addToast("info", message),
      warning: (message) => addToast("warning", message),
    }),
    [addToast]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-5 top-5 z-[120] flex w-[min(380px,calc(100vw-32px))] flex-col gap-3">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              "pointer-events-auto animate-slide-in rounded-2xl border px-4 py-3 shadow-[0_20px_60px_rgba(15,23,42,0.12)] backdrop-blur",
              toneClasses[toast.type]
            )}
          >
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-white/80 text-sm font-semibold shadow-[0_8px_18px_rgba(15,23,42,0.08)]">
                {icons[toast.type]}
              </div>
              <div className="min-w-0 flex-1 text-sm leading-6">{toast.message}</div>
              <button
                onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))}
                className="text-sm text-slate-400 transition hover:text-slate-700"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return context;
}
