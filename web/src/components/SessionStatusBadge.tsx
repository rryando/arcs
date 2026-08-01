/**
 * Session status glyph + badge.
 *
 * Every Tailwind class is written as a literal string in the lookup maps below.
 * Templated class names (`text-term-${x}`) are silently dropped by the Tailwind
 * scanner in plugin mode, so these maps must stay literal.
 */

import { cx } from "../lib/format";
import { Badge, type BadgeColor } from "./Badge";

export const SESSION_STATUSES = ["active", "idle", "completed", "failed", "disconnected"] as const;

export const SESSION_STATUS_GLYPH: Record<string, string> = {
  active: "●",
  idle: "◐",
  completed: "✓",
  failed: "✕",
  disconnected: "○",
};

export const SESSION_STATUS_TEXT_CLASS: Record<string, string> = {
  active: "text-term-green",
  idle: "text-term-amber",
  completed: "text-term-cyan",
  failed: "text-term-red",
  disconnected: "text-term-dim",
};

export function sessionStatusColor(status: string): BadgeColor {
  switch (status) {
    case "active":
      return "green";
    case "idle":
      return "amber";
    case "completed":
      return "cyan";
    case "failed":
      return "red";
    default:
      return "dim";
  }
}

export function SessionStatusBadge({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cx("font-bold", SESSION_STATUS_TEXT_CLASS[status] ?? "text-term-dim")}>
        {SESSION_STATUS_GLYPH[status] ?? "•"}
      </span>
      <Badge color={sessionStatusColor(status)}>{status}</Badge>
    </span>
  );
}
