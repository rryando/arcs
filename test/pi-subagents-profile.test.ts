import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Guards the hardened host profile in `.pi/subagents.json`.
//
// WHY: this file is a checked-in mirror of a live Pi preference file, and
// nothing in the repo reads it yet, so a drift between repo and host silently
// weakens the defaults that ARCS depends on. In particular a weak/absent
// `maxSubagentDepth` allows nested delegation, which contradicts the
// "no nested delegation" invariant every ARCS prompt relies on. Pin the
// invariants here so any accidental regression fails fast in CI.
const profilePath = resolve(import.meta.dirname, "..", ".pi", "subagents.json");

function readProfile(): Record<string, unknown> {
  return JSON.parse(readFileSync(profilePath, "utf-8")) as Record<string, unknown>;
}

describe("pi subagents profile", () => {
  it("pins the hardened invariants that ARCS prompts depend on", () => {
    const profile = readProfile();

    expect(profile.maxSubagentDepth).toBe(1);
    expect(profile.strictAgentFiles).toBe(true);
    expect(profile.scopeModels).toBe(true);
    expect(profile.fallbackSubagent).toBe("none");
    expect(profile.worktreeIsolation).toBe(true);

    expect(Number.isInteger(profile.defaultMaxTurns)).toBe(true);
    expect(profile.defaultMaxTurns as number).toBeGreaterThan(0);
    expect(profile.defaultMaxTurns as number).toBeLessThanOrEqual(200);

    expect(profile.maxConcurrent as number).toBeGreaterThan(0);
    expect(profile.maxConcurrentForeground as number).toBeGreaterThan(0);
  });
});
