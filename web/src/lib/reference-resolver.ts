/**
 * Resolve a document-section reference to a navigable URL.
 *
 * Pure and dependency-free so the test suite can exercise it without a DOM.
 * Both the session panel's reference cards and the MarkdownViewer ✉ flow carry
 * a `SessionTurnSource`-shaped payload; resolving it here means click-through
 * lands on the exact section a reference quoted — the document preselected
 * (`?doc=`) and the heading scrolled into view (`#sectionId`).
 */

/** Identity of the document a section was quoted from — the UI shape of the
 *  server's `SessionTurnSource`, typed per call site so only the fields a kind
 *  actually uses are settable. */
export type ReferenceSource =
  | { kind: "overview"; label: string; doc?: string }
  | { kind: "knowledge" | "plan"; label: string; id?: string };

export interface ReferenceTarget {
  /** Full navigable route, e.g. `/p/arcs?doc=tasks`. */
  path: string;
  /** Heading anchor within the document, e.g. `#current-state`. */
  hash: string;
}

/** Discriminated by `kind` so impossible states cannot compile: overview
 *  sources carry a doc tab id, knowledge/plan sources carry an entry id —
 *  neither field is ever optional for its own kind. */
export type ResolveReferenceInput =
  | {
      slug: string;
      kind: "overview";
      /** Doc tab id for overview sources (?doc=), e.g. "tasks". */
      doc: string;
      /** The heading id within the document, rendered as `#sectionId`. */
      sectionId: string;
    }
  | {
      slug: string;
      kind: "knowledge" | "plan";
      /** Knowledge entry or plan normalizedId. */
      id: string;
      sectionId: string;
    };

export function resolveReference(input: ResolveReferenceInput): ReferenceTarget {
  const hash = `#${input.sectionId}`;
  switch (input.kind) {
    case "overview":
      return { path: `/p/${input.slug}?doc=${input.doc}`, hash };
    case "knowledge":
      return { path: `/p/${input.slug}/knowledge/${input.id}`, hash };
    case "plan":
      return { path: `/p/${input.slug}/plans/${input.id}`, hash };
  }
}
