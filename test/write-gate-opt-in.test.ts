import { afterEach, describe, expect, it } from "vitest";
import { requireWriteGate } from "../src/cli/write-gate.js";

const ORIGINAL = process.env.ARCS_GUARDED;

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.ARCS_GUARDED;
  } else {
    process.env.ARCS_GUARDED = ORIGINAL;
  }
});

describe("requireWriteGate (write-gate opt-in)", () => {
  it("proceeds without a token when ARCS_GUARDED is unset", () => {
    delete process.env.ARCS_GUARDED;
    expect(requireWriteGate(undefined)).toBeNull();
  });

  it("treats values other than '1' as unguarded", () => {
    process.env.ARCS_GUARDED = "true";
    expect(requireWriteGate(undefined)).toBeNull();
  });

  it("demands --token when ARCS_GUARDED=1", () => {
    process.env.ARCS_GUARDED = "1";
    expect(requireWriteGate(undefined)).toMatchObject({
      ok: false,
      code: "missing_token",
    });
  });

  it("rejects blank and whitespace-only tokens while guarded", () => {
    process.env.ARCS_GUARDED = "1";
    expect(requireWriteGate("")).toMatchObject({ ok: false, code: "missing_token" });
    expect(requireWriteGate("   ")).toMatchObject({ ok: false, code: "missing_token" });
  });

  it("accepts a non-empty token while guarded", () => {
    process.env.ARCS_GUARDED = "1";
    expect(requireWriteGate("orchestrator-token")).toBeNull();
  });
});
