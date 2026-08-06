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

/** Derived liveness the server sends on session reads (`SessionMeta.phase`) —
 *  what this badge actually shows. Ordered live-first, with the raw statuses
 *  following in SESSION_STATE_ORDER for a record read from an endpoint that
 *  carries no phase. */
export const SESSION_PHASES = ["running", "idle", "failed", "ended"] as const;

/** Sort rank for whatever the badge is rendering — one ordering across both
 *  vocabularies, so a column showing phases sorts the way it reads. */
export const SESSION_STATE_ORDER: readonly string[] = [...SESSION_PHASES, ...SESSION_STATUSES];

export const SESSION_STATUS_GLYPH: Record<string, string> = {
  running: "●",
  ended: "○",
  active: "●",
  idle: "◐",
  completed: "✓",
  failed: "✕",
  disconnected: "○",
};

export const SESSION_STATUS_TEXT_CLASS: Record<string, string> = {
  running: "text-term-green",
  ended: "text-term-dim",
  active: "text-term-green",
  idle: "text-term-amber",
  completed: "text-term-cyan",
  failed: "text-term-red",
  disconnected: "text-term-dim",
};

export function sessionStatusColor(status: string): BadgeColor {
  switch (status) {
    case "running":
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
