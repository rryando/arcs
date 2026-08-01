/**
 * Unit tests for the web client's pure shortcut-matching core and the
 * server's SSE change classifier.
 */

import { describe, expect, it } from "vitest";
import { classifyChange } from "../src/web-server/watcher.js";
import { formatFileRefs, parseFileRefs } from "../web/src/lib/file-refs.js";
import { extractHeadings } from "../web/src/lib/markdown-headings.js";
import { type Binding, eventToKey, matchBindings } from "../web/src/lib/shortcuts.js";

function keyEvent(
  key: string,
  mods: Partial<Record<"ctrl" | "alt" | "shift" | "meta", boolean>> = {},
) {
  return {
    key,
    ctrlKey: mods.ctrl ?? false,
    metaKey: mods.meta ?? false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
  };
}

function binding(keys: string): Binding {
  return { keys, description: keys, run: () => {} };
}

describe("eventToKey", () => {
  it("maps plain keys", () => {
    expect(eventToKey(keyEvent("g"))).toBe("g");
    expect(eventToKey(keyEvent("/"))).toBe("/");
    expect(eventToKey(keyEvent("?"))).toBe("?");
  });

  it("maps named keys", () => {
    expect(eventToKey(keyEvent("Enter"))).toBe("enter");
    expect(eventToKey(keyEvent("Escape"))).toBe("escape");
    expect(eventToKey(keyEvent("ArrowDown"))).toBe("down");
    expect(eventToKey(keyEvent(" "))).toBe("space");
    expect(eventToKey(keyEvent("Home"))).toBe("home");
    expect(eventToKey(keyEvent("End"))).toBe("end");
  });

  it("maps modifiers", () => {
    expect(eventToKey(keyEvent("s", { ctrl: true }))).toBe("ctrl+s");
    expect(eventToKey(keyEvent("k", { meta: true }))).toBe("ctrl+k");
    expect(eventToKey(keyEvent("G", { shift: true }))).toBe("shift+g");
  });

  it("returns null for pure modifier presses", () => {
    expect(eventToKey(keyEvent("Control", { ctrl: true }))).toBeNull();
    expect(eventToKey(keyEvent("Shift", { shift: true }))).toBeNull();
  });

  it("does not tag shift on single characters (shift+g is G)", () => {
    expect(eventToKey(keyEvent("G", { shift: true }))).toBe("shift+g");
    expect(eventToKey(keyEvent("g"))).toBe("g");
  });
});

describe("matchBindings", () => {
  const bindings = [
    binding("g k"),
    binding("g d"),
    binding("/"),
    binding("ctrl+s"),
    binding("escape"),
  ];

  it("matches a full sequence", () => {
    const result = matchBindings(bindings, ["g", "k"]);
    expect(result.kind).toBe("matched");
    expect(result.kind === "matched" && result.binding.keys).toBe("g k");
  });

  it("reports partial sequences", () => {
    expect(matchBindings(bindings, ["g"]).kind).toBe("partial");
  });

  it("matches single keys directly", () => {
    expect(matchBindings(bindings, ["/"]).kind).toBe("matched");
    expect(matchBindings(bindings, ["ctrl+s"]).kind).toBe("matched");
  });

  it("reports none for unknown keys", () => {
    expect(matchBindings(bindings, ["z"]).kind).toBe("none");
    expect(matchBindings(bindings, ["g", "z"]).kind).toBe("none");
  });

  it("prefers the highest-priority exact binding", () => {
    const low = { ...binding("/"), description: "global", priority: 0 };
    const high = { ...binding("/"), description: "local", priority: 20 };
    const result = matchBindings([low, high], ["/"]);
    expect(result.kind).toBe("matched");
    expect(result.kind === "matched" && result.binding.description).toBe("local");
  });
});

describe("classifyChange", () => {
  it("classifies collection areas", () => {
    expect(classifyChange("projects/arcs/knowledge/index.json")).toEqual({
      slug: "arcs",
      area: "knowledge",
    });
    expect(classifyChange("projects/arcs/tasks/index.json")).toEqual({
      slug: "arcs",
      area: "tasks",
    });
    expect(classifyChange("projects/arcs/plans/x.meta.json")).toEqual({
      slug: "arcs",
      area: "plans",
    });
    expect(classifyChange("projects/arcs/proposals/codegraph.json")).toEqual({
      slug: "arcs",
      area: "proposals",
    });
  });

  it("classifies docs and meta", () => {
    expect(classifyChange("projects/arcs/overview.md")).toEqual({ slug: "arcs", area: "docs" });
    expect(classifyChange("projects/arcs/tasks.md")).toEqual({ slug: "arcs", area: "tasks" });
    expect(classifyChange("projects/arcs/meta.json")).toEqual({ slug: "arcs", area: "meta" });
  });

  it("classifies root meta and ignores tokens", () => {
    expect(classifyChange("meta.json")).toEqual({ slug: null, area: "root" });
    expect(classifyChange("tokens/wp_abc.json")).toBeNull();
    expect(classifyChange("config.json")).toBeNull();
  });
});

describe("file reference editor format", () => {
  it("parses one path per line with optional #anchor", () => {
    expect(parseFileRefs("src/a.ts#handler\nsrc/b.ts\n")).toEqual([
      { path: "src/a.ts", anchor: "handler" },
      { path: "src/b.ts" },
    ]);
  });

  it("formats refs back into stable editable text", () => {
    expect(formatFileRefs([{ path: "src/a.ts", anchor: "handler" }, { path: "src/b.ts" }])).toBe(
      "src/a.ts#handler\nsrc/b.ts",
    );
  });

  it("ignores blank lines and trims values", () => {
    expect(parseFileRefs("  src/a.ts # handler  \n\n src/b.ts ")).toEqual([
      { path: "src/a.ts", anchor: "handler" },
      { path: "src/b.ts" },
    ]);
  });
});

describe("markdown heading anchors", () => {
  it("gives duplicate headings stable unique ids", () => {
    expect(extractHeadings("# Title\n\n## Repeat\n\n## Repeat\n\n### Repeat")).toEqual([
      { depth: 1, text: "Title", id: "title" },
      { depth: 2, text: "Repeat", id: "repeat" },
      { depth: 2, text: "Repeat", id: "repeat-2" },
      { depth: 3, text: "Repeat", id: "repeat-3" },
    ]);
  });

  it("ignores headings inside fenced code blocks", () => {
    expect(extractHeadings("## Visible\n```md\n## Hidden\n```\n## Visible")).toEqual([
      { depth: 2, text: "Visible", id: "visible" },
      { depth: 2, text: "Visible", id: "visible-2" },
    ]);
  });
});
