/** Small formatting helpers. */

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = Date.now() - then;
  const abs = Math.abs(diff);

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (abs < minute) return "now";
  if (abs < hour) return `${Math.round(diff / minute)}m ago`;
  if (abs < day) return `${Math.round(diff / hour)}h ago`;
  if (abs < 30 * day) return `${Math.round(diff / day)}d ago`;
  return new Date(then).toISOString().slice(0, 10);
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
