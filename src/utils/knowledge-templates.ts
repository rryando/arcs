/**
 * Knowledge body templates — single source of truth for structured,
 * fillable skeletons per knowledge kind.
 *
 * Consumed by the `arcs knowledge template` CLI command and the
 * knowledge-health validator. Pure module: no fs, no I/O, no side effects.
 */

import type { KnowledgeKind } from "./storage-utils.js";

/**
 * One authored section of a knowledge-body template.
 */
export interface TemplateSection {
  /** Markdown heading text (rendered as `## <heading>`). */
  heading: string;
  /** Short author-guidance sentence, rendered as a deletable HTML comment. */
  hint: string;
}

/**
 * Structured body template per knowledge kind. Headings are stable
 * contracts; hints are guidance the author replaces with real content.
 */
export const KNOWLEDGE_TEMPLATES: Record<KnowledgeKind, TemplateSection[]> = {
  gotcha: [
    {
      heading: "Symptom",
      hint: "What you observed — the error, surprising output, or failing behaviour.",
    },
    {
      heading: "Root cause",
      hint: "The underlying reason this happens, stated mechanistically.",
    },
    {
      heading: "Fix or workaround",
      hint: "The concrete change or sidestep that resolves it.",
    },
    {
      heading: "Trigger",
      hint: "The conditions under which this bites again, so it can be recognised early.",
    },
  ],
  lesson: [
    {
      heading: "Expectation",
      hint: "What you believed would happen before the work.",
    },
    {
      heading: "What happened",
      hint: "The actual outcome that diverged from the expectation.",
    },
    {
      heading: "Why",
      hint: "The reason for the gap between expectation and reality.",
    },
    {
      heading: "Next time",
      hint: "The behaviour change this lesson commits you to.",
    },
  ],
  pattern: [
    {
      heading: "When to use",
      hint: "The recurring situation this pattern solves.",
    },
    {
      heading: "Shape",
      hint: "The structure of the solution — the moving parts and how they fit.",
    },
    {
      heading: "Example",
      hint: "A concrete instance, ideally referencing real code in this repo.",
    },
    {
      heading: "When not to use",
      hint: "Cases where this pattern is the wrong tool and what to reach for instead.",
    },
  ],
  architecture: [
    {
      heading: "Structure",
      hint: "The major components and how they are arranged and connected.",
    },
    {
      heading: "Invariant or constraint",
      hint: "A property that must always hold for the design to remain sound.",
    },
    {
      heading: "Failure mode",
      hint: "How the structure breaks down when the invariant is violated.",
    },
  ],
  decision: [
    {
      heading: "Decision",
      hint: "The choice that was made, stated as a single clear sentence.",
    },
    {
      heading: "Rationale and forces",
      hint: "Why this choice, and the pressures that shaped it.",
    },
    {
      heading: "Alternatives rejected",
      hint: "The options considered and the reason each was set aside.",
    },
    {
      heading: "Consequences",
      hint: "What this decision now commits the project to, good and bad.",
    },
  ],
  module: [
    {
      heading: "Purpose",
      hint: "What this module exists to do, in one sentence.",
    },
    {
      heading: "Key files and entry points",
      hint: "The files that matter and the functions or exports callers reach for.",
    },
    {
      heading: "Responsibilities",
      hint: "What this module owns — and what it deliberately does not.",
    },
    {
      heading: "Dependencies",
      hint: "What this module relies on and what relies on it.",
    },
  ],
  feature: [
    {
      heading: "What it does",
      hint: "The user-facing or system-facing capability this feature provides.",
    },
    {
      heading: "How it works",
      hint: "The mechanism behind the capability at a useful level of detail.",
    },
    {
      heading: "Entry points",
      hint: "Where execution begins — commands, functions, or routes that invoke it.",
    },
    {
      heading: "Edge cases",
      hint: "The boundary conditions and unusual inputs it handles.",
    },
  ],
  reference: [
    {
      heading: "Summary",
      hint: "A one-paragraph description of what is being referenced.",
    },
    {
      heading: "Canonical location",
      hint: "Where the authoritative source lives — file path, URL, or symbol.",
    },
    {
      heading: "Usage notes",
      hint: "How to apply this reference correctly, including any caveats.",
    },
  ],
};

/**
 * Returns the section list for a given knowledge kind.
 */
export function getTemplateSections(kind: KnowledgeKind): TemplateSection[] {
  return KNOWLEDGE_TEMPLATES[kind];
}

/**
 * Renders a fillable markdown skeleton for a kind: each section becomes a
 * `## <heading>` followed by its hint as an HTML comment, so the guidance
 * does not count as real content and is trivially deletable.
 */
export function renderTemplate(kind: KnowledgeKind): string {
  return getTemplateSections(kind)
    .map((section) => `## ${section.heading}\n\n<!-- ${section.hint} -->\n`)
    .join("\n");
}

/**
 * Minimum real-content character count below which a body is considered
 * shallow by the knowledge-health validator.
 */
export const SHALLOW_BODY_MIN_CHARS = 120;

/**
 * Measures the length of real prose content in a body, defeating both
 * empty bodies and hollow all-headers templates.
 *
 * Drops the leading H1 title, all markdown headings, HTML comments (incl.
 * multi-line), blockquote markers, and leading list/ordered markers, then
 * collapses whitespace and returns the trimmed length.
 */
export function extractBodyContentLength(body: string): number {
  // Strip HTML comments first (may span multiple lines).
  const withoutComments = body.replace(/<!--[\s\S]*?-->/g, "");

  const content = withoutComments
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      // Drop the leading H1 title line and any markdown heading line.
      if (/^#{1,6}\s/.test(trimmed)) return false;
      return true;
    })
    .map((line) => {
      let cleaned = line;
      // Drop blockquote markers.
      cleaned = cleaned.replace(/^\s*>\s?/, "");
      // Strip leading markdown list/ordered markers.
      cleaned = cleaned.replace(/^\s*([-*+]|\d+[.)])\s+/, "");
      return cleaned;
    })
    .join(" ");

  // Collapse all remaining whitespace to single spaces, then trim.
  return content.replace(/\s+/g, " ").trim().length;
}

/**
 * True when a body has less real content than the shallow floor.
 */
export function isBodyShallow(body: string): boolean {
  return extractBodyContentLength(body) < SHALLOW_BODY_MIN_CHARS;
}
