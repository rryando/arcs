/**
 * Minimal terminal-style toast notifications.
 */

import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from "react";
import { cx } from "../lib/format";

type ToastKind = "info" | "success" | "error";

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToasterContextValue {
  push: (kind: ToastKind, message: string) => void;
}

const ToasterContext = createContext<ToasterContextValue | null>(null);

const KIND_STYLE: Record<ToastKind, string> = {
  info: "text-term-cyan border-term-cyan/40",
  success: "text-term-green border-term-green/40",
  error: "text-term-red border-term-red/50",
};

const KIND_GLYPH: Record<ToastKind, string> = {
  info: "i",
  success: "✓",
  error: "✗",
};

export function ToasterProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev.slice(-3), { id, kind, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4_500);
  }, []);

  return (
    <ToasterContext.Provider value={{ push }}>
      {children}
      <div className="pointer-events-none fixed right-3 bottom-8 z-50 flex w-96 flex-col gap-1">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx(
              "border bg-term-panel px-2 py-1.5 text-[12px] shadow-lg shadow-black/50",
              KIND_STYLE[t.kind],
            )}
          >
            <span className="mr-2 font-bold">{KIND_GLYPH[t.kind]}</span>
            <span className="text-term-fg">{t.message}</span>
          </div>
        ))}
      </div>
    </ToasterContext.Provider>
  );
}

export function useToaster(): ToasterContextValue {
  const ctx = useContext(ToasterContext);
  if (!ctx) throw new Error("useToaster must be used inside ToasterProvider");
  return ctx;
}
