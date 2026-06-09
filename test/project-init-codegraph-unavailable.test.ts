import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "./helpers/cli-runner.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

// Mock codegraph so the project-init handler sees the binary as UNAVAILABLE
// (the `!info.available` branch) without shelling out to a real binary.
vi.mock("../src/utils/codegraph.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/codegraph.js")>();
  return {
    ...actual,
    detectCodegraph: () => ({ available: false }),
  };
});

describe("project init — codegraph not_available signal", () => {
  const originalSkipCodegraph = process.env.ARCS_SKIP_CODEGRAPH;
  const originalSkipQuickScan = process.env.ARCS_SKIP_QUICK_SCAN;

  beforeEach(() => {
    process.env.ARCS_SKIP_QUICK_SCAN = "1";
  });

  afterEach(() => {
    if (originalSkipCodegraph === undefined) delete process.env.ARCS_SKIP_CODEGRAPH;
    else process.env.ARCS_SKIP_CODEGRAPH = originalSkipCodegraph;
    if (originalSkipQuickScan === undefined) delete process.env.ARCS_SKIP_QUICK_SCAN;
    else process.env.ARCS_SKIP_QUICK_SCAN = originalSkipQuickScan;
  });

  it("returns a structured not_available codegraph object instead of null", async () => {
    await withTempDataDir(async () => {
      // withTempDataDir sets ARCS_SKIP_CODEGRAPH=1 — override so the branch runs.
      process.env.ARCS_SKIP_CODEGRAPH = "0";

      const result = await runCommand("project init", [
        "demo-unavailable",
        "--description=Demo project",
        "--json",
      ]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const data = result.data as {
        codegraph: {
          proposed: number;
          available?: boolean;
          hint?: string;
        } | null;
      };

      expect(data.codegraph).not.toBeNull();
      expect(data.codegraph?.available).toBe(false);
      expect(data.codegraph?.proposed).toBe(0);
      expect(data.codegraph?.hint).toMatch(/codegraph binary not found/);
      expect(data.codegraph?.hint).toMatch(/npm i -g @colbymchenry\/codegraph/);
    });
  });

  it("respects ARCS_SKIP_CODEGRAPH=1 — leaves codegraph null, no nudge", async () => {
    await withTempDataDir(async () => {
      // withTempDataDir already sets ARCS_SKIP_CODEGRAPH=1; assert skip behavior.
      process.env.ARCS_SKIP_CODEGRAPH = "1";

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const result = await runCommand("project init", [
        "demo-skipped",
        "--description=Demo project",
      ]);

      logSpy.mockRestore();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const data = result.data as { codegraph: unknown };
      expect(data.codegraph).toBeNull();
    });
  });
});
