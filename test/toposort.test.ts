// ---------------------------------------------------------------------------
// Tests for toposort utility (Kahn's algorithm with cycle detection)
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { ToposortInput } from "../src/utils/toposort.js";
import { detectCycle, toposort } from "../src/utils/toposort.js";

describe("toposort", () => {
  it("returns empty array for empty input", () => {
    expect(toposort([])).toEqual([]);
  });

  it("returns single task id", () => {
    const tasks: ToposortInput[] = [{ id: "a" }];
    expect(toposort(tasks)).toEqual(["a"]);
  });

  it("returns tasks in dependency order", () => {
    const tasks: ToposortInput[] = [{ id: "b", dependsOn: ["a"] }, { id: "a" }];
    const result = toposort(tasks);
    expect(result.indexOf("a")).toBeLessThan(result.indexOf("b"));
  });

  it("handles chain dependencies a -> b -> c", () => {
    const tasks: ToposortInput[] = [
      { id: "c", dependsOn: ["b"] },
      { id: "b", dependsOn: ["a"] },
      { id: "a" },
    ];
    const result = toposort(tasks);
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("uses priority as tiebreaker for zero-in-degree nodes", () => {
    const tasks: ToposortInput[] = [
      { id: "low-task", priority: "low" },
      { id: "high-task", priority: "high" },
      { id: "medium-task", priority: "medium" },
    ];
    const result = toposort(tasks);
    expect(result).toEqual(["high-task", "medium-task", "low-task"]);
  });

  it("uses priority tiebreaker when multiple become available simultaneously", () => {
    // a -> b, a -> c; b and c are siblings, b is high, c is low
    const tasks: ToposortInput[] = [
      { id: "a" },
      { id: "c", dependsOn: ["a"], priority: "low" },
      { id: "b", dependsOn: ["a"], priority: "high" },
    ];
    const result = toposort(tasks);
    expect(result.indexOf("a")).toBeLessThan(result.indexOf("b"));
    expect(result.indexOf("b")).toBeLessThan(result.indexOf("c"));
  });

  it("throws on cycle", () => {
    const tasks: ToposortInput[] = [
      { id: "a", dependsOn: ["b"] },
      { id: "b", dependsOn: ["a"] },
    ];
    expect(() => toposort(tasks)).toThrow();
  });

  it("throws on self-cycle", () => {
    const tasks: ToposortInput[] = [{ id: "a", dependsOn: ["a"] }];
    expect(() => toposort(tasks)).toThrow();
  });

  it("handles diamond dependency pattern", () => {
    // a -> b, a -> c, b -> d, c -> d
    const tasks: ToposortInput[] = [
      { id: "d", dependsOn: ["b", "c"] },
      { id: "b", dependsOn: ["a"] },
      { id: "c", dependsOn: ["a"] },
      { id: "a" },
    ];
    const result = toposort(tasks);
    expect(result.indexOf("a")).toBeLessThan(result.indexOf("b"));
    expect(result.indexOf("a")).toBeLessThan(result.indexOf("c"));
    expect(result.indexOf("b")).toBeLessThan(result.indexOf("d"));
    expect(result.indexOf("c")).toBeLessThan(result.indexOf("d"));
  });

  it("tasks without dependsOn field work the same as empty dependsOn", () => {
    const tasks: ToposortInput[] = [{ id: "a", dependsOn: undefined }, { id: "b" }];
    expect(() => toposort(tasks)).not.toThrow();
    expect(toposort(tasks)).toHaveLength(2);
  });
});

describe("detectCycle", () => {
  it("returns null for acyclic graph", () => {
    const tasks: ToposortInput[] = [{ id: "a" }, { id: "b", dependsOn: ["a"] }];
    expect(detectCycle(tasks)).toBeNull();
  });

  it("returns cycle path for simple cycle", () => {
    const tasks: ToposortInput[] = [
      { id: "a", dependsOn: ["b"] },
      { id: "b", dependsOn: ["a"] },
    ];
    const cycle = detectCycle(tasks);
    expect(cycle).not.toBeNull();
    expect(cycle!.length).toBeGreaterThan(0);
    // The cycle path should contain both nodes
    expect(cycle).toContain("a");
    expect(cycle).toContain("b");
  });

  it("returns null for empty input", () => {
    expect(detectCycle([])).toBeNull();
  });

  it("returns null for single node without self-loop", () => {
    expect(detectCycle([{ id: "a" }])).toBeNull();
  });

  it("returns cycle path for self-loop", () => {
    const cycle = detectCycle([{ id: "a", dependsOn: ["a"] }]);
    expect(cycle).not.toBeNull();
    expect(cycle).toContain("a");
  });

  it("returns cycle path for 3-node cycle", () => {
    const tasks: ToposortInput[] = [
      { id: "a", dependsOn: ["c"] },
      { id: "b", dependsOn: ["a"] },
      { id: "c", dependsOn: ["b"] },
    ];
    const cycle = detectCycle(tasks);
    expect(cycle).not.toBeNull();
    expect(cycle!.length).toBeGreaterThanOrEqual(3);
  });
});
