import { afterEach, describe, expect, it } from "vitest";
import type { CLIResult } from "../src/cli/command-registry.js";
import { runCommand } from "./helpers/cli-runner.js";
import { withTempDataDir } from "./helpers/temp-data-dir.js";

function expectFailure(result: CLIResult): asserts result is Extract<CLIResult, { ok: false }> {
  if (result.ok) throw new Error("Expected a failure envelope");
}

const ORIGINAL = process.env.ARCS_GUARDED;

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.ARCS_GUARDED;
  } else {
    process.env.ARCS_GUARDED = ORIGINAL;
  }
});

describe("central write-gate enforcement via invokeCommand", () => {
  it("blocks a mutating command without --token when ARCS_GUARDED=1", async () => {
    process.env.ARCS_GUARDED = "1";
    await withTempDataDir(async () => {
      const result = await runCommand("worktree prune", ["some-project"]);
      expect(result).toMatchObject({ ok: false, code: "missing_token" });
    });
  });

  it("lets a mutating command past the gate with --token (fails later on its own merits)", async () => {
    process.env.ARCS_GUARDED = "1";
    await withTempDataDir(async () => {
      const result = await runCommand("worktree prune", ["some-project", "--token", "t-1"]);
      // Gate passed; the command now fails on repo/project grounds, not the gate.
      expectFailure(result);
      expect(result.code).not.toBe("missing_token");
    });
  });

  it("accepts --token=<value> form as well", async () => {
    process.env.ARCS_GUARDED = "1";
    await withTempDataDir(async () => {
      const result = await runCommand("remember", ["some-project", "insight text", "--token=t-2"]);
      expectFailure(result);
      expect(result.code).not.toBe("missing_token");
    });
  });

  it("proceeds unguarded without any token ceremony", async () => {
    delete process.env.ARCS_GUARDED;
    await withTempDataDir(async () => {
      const result = await runCommand("plan create", ["some-project"]);
      expectFailure(result);
      expect(result.code).not.toBe("missing_token");
    });
  });

  it("leaves read-only commands alone while guarded", async () => {
    process.env.ARCS_GUARDED = "1";
    await withTempDataDir(async () => {
      const result = await runCommand("plan list", ["some-project"]);
      // May fail on unknown project, but never on the write gate.
      expectFailure(result);
      expect(result.code).not.toBe("missing_token");
    });
  });

  it("gates remember — regression: it writes knowledge and must declare mutation", async () => {
    process.env.ARCS_GUARDED = "1";
    await withTempDataDir(async () => {
      const result = await runCommand("remember", ["some-project", "insight text"]);
      expect(result).toMatchObject({ ok: false, code: "missing_token" });
    });
  });

  it("still gates worktree prune through the central path", async () => {
    process.env.ARCS_GUARDED = "1";
    await withTempDataDir(async () => {
      const result = await runCommand("worktree prune", ["some-project"]);
      expect(result).toMatchObject({ ok: false, code: "missing_token" });
    });
  });
});
