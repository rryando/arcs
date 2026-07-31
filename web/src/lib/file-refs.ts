import type { FileRef } from "../api/client";

/**
 * Parse the editor's one-reference-per-line format: `path` or `path#anchor`.
 */
export function parseFileRefs(text: string): FileRef[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("#");
      if (separator === -1) return { path: line };
      const path = line.slice(0, separator).trim();
      const anchor = line.slice(separator + 1).trim();
      return anchor ? { path, anchor } : { path };
    });
}

/** Format file refs into stable editable text. */
export function formatFileRefs(refs: FileRef[] | undefined): string {
  return (refs ?? []).map((ref) => `${ref.path}${ref.anchor ? `#${ref.anchor}` : ""}`).join("\n");
}
