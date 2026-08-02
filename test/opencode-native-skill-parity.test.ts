import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const runtimeManifestPath = resolve(root, "opencode/arcs/bundle-runtime.json");

type RuntimeManifest = {
  skills: Record<string, string[]>;
  preservedFiles: string[];
};

describe("ARCS-native skill inventory", () => {
  const runtimeManifest = JSON.parse(readFileSync(runtimeManifestPath, "utf-8")) as RuntimeManifest;
  const nativeSkillFiles = runtimeManifest.preservedFiles.filter((path) =>
    path.startsWith("skills/"),
  );
  const exactSkillInventory = [
    "brainstorming",
    "caveman-commit",
    "deep-pr-review",
    "enriching-codegraph-proposals",
    "executing-plans",
    "implementation",
    "init-project",
    "install-claude-code-hook",
    "systematic-debugging",
    "test-driven-development",
    "to-diagram",
    "writing-knowledge",
    "writing-plans",
  ];

  it("ships exactly the 13 active skills", () => {
    const managedSkills = Object.keys(runtimeManifest.skills);
    const nativeSkills = nativeSkillFiles.map((path) => path.split("/")[1]);

    expect([...managedSkills, ...nativeSkills].sort()).toEqual(exactSkillInventory);
  });

  it("keeps native skills outside the manifest-managed runtime skill inventory", () => {
    const manifestManagedFiles = new Set(
      Object.entries(runtimeManifest.skills).flatMap(([skillName, files]) =>
        files.map((file) => `skills/${skillName}/${file}`),
      ),
    );

    for (const skillFile of nativeSkillFiles) {
      expect(manifestManagedFiles.has(skillFile), `${skillFile} is managed twice`).toBe(false);
    }
  });

  it("has every preserved ARCS-native skill present on disk", () => {
    for (const skillFile of nativeSkillFiles) {
      const diskPath = resolve(root, "opencode/arcs", skillFile);
      expect(
        existsSync(diskPath),
        [`ARCS-native skill file missing on disk: ${skillFile}`, `Expected at: ${diskPath}`].join(
          "\n",
        ),
      ).toBe(true);
    }
  });
});
