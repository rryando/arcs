/**
 * Pure shortcut-matching core (no React) — unit-testable.
 *
 * Key ids: "g", "/", "?", "j", "enter", "escape", "ctrl+s", "ctrl+k", ...
 * Sequences: "g k" means press g then k within the buffer window.
 */

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export interface Binding {
  /** Single key ("j", "ctrl+s") or sequence ("g k"). */
  keys: string;
  description: string;
  run: () => void;
  /** Group label for the help overlay. */
  group?: string;
  /** Allow firing while focus is inside an input/editor. */
  allowInInput?: boolean;
  /** Higher-priority exact matches win (local view bindings beat globals). */
  priority?: number;
}

/** Normalize a keyboard event into a key id, or null for pure-modifier presses. */
export function eventToKey(e: KeyEventLike): string | null {
  const key = e.key.toLowerCase();
  if (key === "control" || key === "meta" || key === "alt" || key === "shift") return null;

  let named = key;
  if (key === " ") named = "space";
  else if (key === "escape") named = "escape";
  else if (key === "enter") named = "enter";
  else if (key === "arrowdown") named = "down";
  else if (key === "arrowup") named = "up";
  else if (key === "arrowleft") named = "left";
  else if (key === "arrowright") named = "right";

  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  // Shift is significant for named keys (shift+tab) and letters (G vs g),
  // but not for symbols where it's already encoded ("?" is shift+/).
  if (e.shiftKey && (named.length > 1 || /^[a-z]$/.test(named))) parts.push("shift");
  parts.push(named);
  return parts.join("+");
}

export type MatchResult =
  | { kind: "matched"; binding: Binding }
  | { kind: "partial" }
  | { kind: "none" };

/**
 * Matches a key buffer (recent keys, oldest first) against bindings.
 * Exact full-sequence match wins; otherwise reports whether any binding's
 * sequence starts with the buffer (partial — keep buffering).
 */
export function matchBindings(
  bindings: readonly Binding[],
  buffer: readonly string[],
): MatchResult {
  const joined = buffer.join(" ");

  let anyPartial = false;
  let exact: Binding | null = null;
  for (const binding of bindings) {
    const seq = binding.keys.split(" ");
    const seqJoined = binding.keys;

    if (
      seqJoined === joined &&
      (exact === null || (binding.priority ?? 0) > (exact.priority ?? 0))
    ) {
      exact = binding;
    }
    if (seq.length > buffer.length && seq.slice(0, buffer.length).join(" ") === joined) {
      anyPartial = true;
    }
  }
  if (exact) return { kind: "matched", binding: exact };
  return anyPartial ? { kind: "partial" } : { kind: "none" };
}

/** Returns true when the event target is an editable element. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  // CodeMirror keeps its contenteditable nested inside .cm-editor.
  return target.closest(".cm-editor") !== null;
}
