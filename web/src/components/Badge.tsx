/**
 * Colored inline badges for kinds / statuses / priorities.
 */

import type { ReactNode } from "react";
import { cx } from "../lib/format";

const COLORS = {
  green: "text-term-green border-term-green/40",
  amber: "text-term-amber border-term-amber/40",
  red: "text-term-red border-term-red/40",
  cyan: "text-term-cyan border-term-cyan/40",
  magenta: "text-term-magenta border-term-magenta/40",
  blue: "text-term-blue border-term-blue/40",
  dim: "text-term-dim border-term-border",
} as const;

export type BadgeColor = keyof typeof COLORS;

export function Badge({
  color = "dim",
  children,
  className,
}: {
  color?: BadgeColor;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-block border px-1 text-[10px] leading-4 tracking-wide whitespace-nowrap uppercase",
        COLORS[color],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function kindColor(kind: string): BadgeColor {
  switch (kind) {
    case "gotcha":
      return "red";
    case "lesson":
      return "amber";
    case "pattern":
      return "cyan";
    case "architecture":
      return "magenta";
    case "module":
      return "blue";
    case "feature":
      return "green";
    case "decision":
      return "magenta";
    case "reference":
      return "dim";
    default:
      return "dim";
  }
}

export function statusColor(status: string): BadgeColor {
  switch (status) {
    case "in_progress":
      return "amber";
    case "done":
    case "active":
      return "green";
    case "blocked":
    case "cancelled":
      return "red";
    case "planned":
      return "cyan";
    case "proposed":
    case "backlog":
      return "dim";
    case "archived":
      return "dim";
    default:
      return "dim";
  }
}

export function priorityColor(priority: string): BadgeColor {
  switch (priority) {
    case "critical":
      return "red";
    case "high":
      return "amber";
    case "medium":
      return "cyan";
    case "low":
      return "dim";
    default:
      return "dim";
  }
}

export function typeColor(type: string): BadgeColor {
  switch (type) {
    case "knowledge":
      return "green";
    case "task":
      return "cyan";
    case "plan":
      return "amber";
    case "project":
      return "magenta";
    case "file":
      return "dim";
    default:
      return "dim";
  }
}
