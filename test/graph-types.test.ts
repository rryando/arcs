import { describe, expect, it } from "vitest";
import { EDGE_WEIGHTS } from "../src/retrieval/graph-types.js";

describe("graph-types", () => {
  it("EDGE_WEIGHTS has exactly 8 entries", () => {
    expect(Object.keys(EDGE_WEIGHTS)).toHaveLength(8);
  });

  it("all EDGE_WEIGHTS values are between 0 (exclusive) and 1 (inclusive)", () => {
    for (const [key, value] of Object.entries(EDGE_WEIGHTS)) {
      expect(value, `${key} should be > 0`).toBeGreaterThan(0);
      expect(value, `${key} should be <= 1`).toBeLessThanOrEqual(1);
    }
  });
});
