import { describe, expect, it } from "vitest";
import {
  extractBodyContentLength,
  getTemplateSections,
  isBodyShallow,
  KNOWLEDGE_TEMPLATES,
  renderTemplate,
  SHALLOW_BODY_MIN_CHARS,
} from "../src/utils/knowledge-templates.js";
import { KNOWLEDGE_KINDS, type KnowledgeKind } from "../src/utils/storage-utils.js";

describe("KNOWLEDGE_TEMPLATES", () => {
  it("covers exactly the 8 canonical kinds", () => {
    expect(Object.keys(KNOWLEDGE_TEMPLATES).sort()).toEqual([...KNOWLEDGE_KINDS].sort());
  });

  it("gives every kind a non-empty section list", () => {
    for (const kind of KNOWLEDGE_KINDS) {
      const sections = KNOWLEDGE_TEMPLATES[kind];
      expect(sections.length).toBeGreaterThan(0);
      for (const section of sections) {
        expect(section.heading.trim().length).toBeGreaterThan(0);
        expect(section.hint.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("uses the exact required headings per kind", () => {
    const expected: Record<KnowledgeKind, string[]> = {
      gotcha: ["Symptom", "Root cause", "Fix or workaround", "Trigger"],
      lesson: ["Expectation", "What happened", "Why", "Next time"],
      pattern: ["When to use", "Shape", "Example", "When not to use"],
      architecture: ["Structure", "Invariant or constraint", "Failure mode"],
      decision: ["Decision", "Rationale and forces", "Alternatives rejected", "Consequences"],
      module: ["Purpose", "Key files and entry points", "Responsibilities", "Dependencies"],
      feature: ["What it does", "How it works", "Entry points", "Edge cases"],
      reference: ["Summary", "Canonical location", "Usage notes"],
    };
    for (const kind of KNOWLEDGE_KINDS) {
      expect(KNOWLEDGE_TEMPLATES[kind].map((s) => s.heading)).toEqual(expected[kind]);
    }
  });
});

describe("getTemplateSections", () => {
  it("returns the same array as the template map for each kind", () => {
    for (const kind of KNOWLEDGE_KINDS) {
      expect(getTemplateSections(kind)).toBe(KNOWLEDGE_TEMPLATES[kind]);
    }
  });
});

describe("renderTemplate", () => {
  it("includes every section heading for a kind", () => {
    for (const kind of KNOWLEDGE_KINDS) {
      const rendered = renderTemplate(kind);
      for (const section of getTemplateSections(kind)) {
        expect(rendered).toContain(`## ${section.heading}`);
        // Hint is rendered as a deletable HTML comment.
        expect(rendered).toContain(`<!-- ${section.hint} -->`);
      }
    }
  });

  it("produces a markdown skeleton whose content is shallow (only headers + hints)", () => {
    for (const kind of KNOWLEDGE_KINDS) {
      const body = `# Some Title\n\n${renderTemplate(kind)}`;
      expect(extractBodyContentLength(body)).toBe(0);
      expect(isBodyShallow(body)).toBe(true);
    }
  });
});

describe("extractBodyContentLength", () => {
  it("returns ~0 for an H1 + headers + HTML-comment hints only", () => {
    const body = [
      "# My Knowledge Entry",
      "",
      "## Symptom",
      "",
      "<!-- What you observed. -->",
      "",
      "## Root cause",
      "",
      "<!-- The underlying reason. -->",
      "",
    ].join("\n");
    expect(extractBodyContentLength(body)).toBe(0);
  });

  it("excludes multi-line HTML comments from the count", () => {
    const body = [
      "# Title",
      "",
      "<!--",
      "this guidance spans",
      "several lines",
      "-->",
      "",
    ].join("\n");
    expect(extractBodyContentLength(body)).toBe(0);
  });

  it("excludes list markers and blockquote markers from the count", () => {
    const withMarkers = "- alpha\n* beta\n1. gamma\n2) delta\n> quoted";
    const withoutMarkers = "alpha beta gamma delta quoted";
    expect(extractBodyContentLength(withMarkers)).toBe(withoutMarkers.length);
  });

  it("collapses whitespace before measuring", () => {
    expect(extractBodyContentLength("foo   bar\n\n\nbaz")).toBe("foo bar baz".length);
  });

  it("counts real prose content", () => {
    expect(extractBodyContentLength("This is real content.")).toBe("This is real content.".length);
  });
});

describe("isBodyShallow", () => {
  it("is true for an empty body", () => {
    expect(isBodyShallow("")).toBe(true);
  });

  it("is true for a one-sentence body below the floor", () => {
    const body = "# Title\n\nA short note about a thing.";
    expect(extractBodyContentLength(body)).toBeLessThan(SHALLOW_BODY_MIN_CHARS);
    expect(isBodyShallow(body)).toBe(true);
  });

  it("is true for a freshly rendered template", () => {
    expect(isBodyShallow(renderTemplate("gotcha"))).toBe(true);
  });

  it("is false for a richly-filled multi-section body over the floor", () => {
    const body = [
      "# Race condition in plan-store writes",
      "",
      "## Symptom",
      "",
      "Concurrent writes to the same plan file occasionally lost updates,",
      "producing a plan whose task list silently dropped recently-added nodes.",
      "",
      "## Root cause",
      "",
      "Two writers read the file, mutated their in-memory copy, and wrote back",
      "without holding the file lock, so the last writer clobbered the first.",
      "",
      "## Fix or workaround",
      "",
      "Acquire the file lock around the read-modify-write cycle so the second",
      "writer observes the first writer's committed changes before mutating.",
    ].join("\n");
    expect(extractBodyContentLength(body)).toBeGreaterThan(SHALLOW_BODY_MIN_CHARS);
    expect(isBodyShallow(body)).toBe(false);
  });
});
