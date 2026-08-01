/**
 * Panel — bordered box with a terminal-style title bar.
 */

import type { ReactNode } from "react";
import { cx } from "../lib/format";

export function Panel({
  title,
  hint,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={cx("flex min-h-0 flex-col border border-term-border bg-term-panel", className)}
    >
      {title !== undefined && (
        <header className="flex items-center gap-2 border-b border-term-border px-2 py-1">
          <span className="text-term-green">▸</span>
          <h2 className="text-[12px] font-bold tracking-wide text-term-fg uppercase">{title}</h2>
          {hint && <span className="text-[11px] text-term-dim">{hint}</span>}
          <span className="flex-1" />
          {actions}
        </header>
      )}
      <div className={cx("min-h-0 flex-1 overflow-auto", bodyClassName)}>{children}</div>
    </section>
  );
}
