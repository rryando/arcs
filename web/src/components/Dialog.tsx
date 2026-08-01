/**
 * Modal dialog primitives — terminal-styled, keyboard-first.
 * ConfirmDialog: y/n. FormDialog: labeled fields + enter to submit.
 */

import { type ReactNode, useEffect, useRef } from "react";
import { cx } from "../lib/format";

export function Dialog({
  title,
  children,
  onClose,
  width = "max-w-lg",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  width?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/60 pt-[15vh]">
      <div
        className={cx(
          "w-full border border-term-border-hi bg-term-panel shadow-xl shadow-black/60",
          width,
        )}
      >
        <header className="flex items-center gap-2 border-b border-term-border px-2 py-1">
          <span className="text-term-green">▸</span>
          <h2 className="text-[12px] font-bold tracking-wide uppercase">{title}</h2>
          <span className="flex-1" />
          <span className="kbd">esc</span>
        </header>
        <div className="p-3">{children}</div>
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "confirm",
  danger = true,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "y" || e.key === "Enter") {
        e.stopPropagation();
        onConfirm();
      } else if (e.key === "n") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [onConfirm, onClose]);

  return (
    <Dialog title={title} onClose={onClose} width="max-w-md">
      <div className="text-[12px] text-term-fg">{message}</div>
      <div className="mt-4 flex items-center gap-2 text-[12px]">
        <button
          type="button"
          onClick={onConfirm}
          className={cx(
            "border px-2 py-0.5 font-bold",
            danger
              ? "border-term-red/60 text-term-red hover:bg-term-red hover:text-term-bg"
              : "border-term-green/60 text-term-green hover:bg-term-green hover:text-term-bg",
          )}
        >
          {confirmLabel} [y]
        </button>
        <button
          type="button"
          onClick={onClose}
          className="border border-term-border px-2 py-0.5 text-term-dim hover:text-term-fg"
        >
          cancel [n]
        </button>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="mb-2 block">
      <span className="mb-0.5 flex items-baseline gap-2 text-[11px] tracking-wide text-term-dim uppercase">
        {label}
        {hint && <span className="text-term-dim/70 normal-case">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

export const inputClass =
  "w-full border border-term-border bg-term-inset px-2 py-1 text-[12px] text-term-fg outline-none focus:border-term-green/60 placeholder:text-term-dim/60";

export function TextInput({
  value,
  onChange,
  placeholder,
  autoFocus,
  onEnter,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  onEnter?: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return (
    <input
      ref={ref}
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && onEnter) onEnter();
      }}
      className={inputClass}
    />
  );
}

export function SelectInput({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label?: string }>;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={inputClass}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label ?? o.value}
        </option>
      ))}
    </select>
  );
}

export function FormActions({
  submitLabel = "save",
  onSubmit,
  onCancel,
  pending,
}: {
  submitLabel?: string;
  onSubmit: () => void;
  onCancel: () => void;
  pending?: boolean;
}) {
  return (
    <div className="mt-4 flex items-center gap-2 text-[12px]">
      <button
        type="button"
        disabled={pending}
        onClick={onSubmit}
        className="border border-term-green/60 px-2 py-0.5 font-bold text-term-green hover:bg-term-green hover:text-term-bg disabled:opacity-50"
      >
        {pending ? "…" : submitLabel}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="border border-term-border px-2 py-0.5 text-term-dim hover:text-term-fg"
      >
        cancel
      </button>
    </div>
  );
}
