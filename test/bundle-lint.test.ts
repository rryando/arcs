import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const linterScript = resolve(root, "scripts/lint-bundle.mjs");

type LintIssue = {
  severity: "error" | "warning";
  kind: string;
  message: string;
  file?: string;
  repair?: string;
};

type LintResult = {
  issues: LintIssue[];
  summary: { errors: number; warnings: number };
};

function writeFile(rootPath: string, relativePath: string, content: string) {
  const outputPath = resolve(rootPath, relativePath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content);
}

function registryAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "software-engineer",
    status: "active",
    kind: "subagent",
    tier: "heavy",
    modes: ["opencode", "claudecode"],
    source: "prompts/software-engineer.txt",
    destination: "prompts/software-engineer.txt",
    description: "Implementation specialist",
    permissions: {
      edit: "allow",
      bash: "allow",
      webfetch: "allow",
      mcp: "allow",
      task: "deny",
    },
    ...overrides,
  };
}

function runLint(bundleRoot: string) {
  return spawnSync("node", [linterScript], {
    cwd: root,
    env: { ...process.env, BUNDLE_LINT_BUNDLE_ROOT: bundleRoot },
    encoding: "utf-8",
  });
}

describe("bundle linter", () => {
  it("reports missing manifest-declared files", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "bundle-lint-missing-"));
    const bundleRoot = resolve(tempRoot, "bundle");

    try {
      const manifest = {
        sourceRoot: "~/.config/opencode/skills/arcs",
        skills: { planner: ["SKILL.md", "notes.md"] },
        agents: [],
        plugin: [],
      };
      writeFile(bundleRoot, "bundle-runtime.json", JSON.stringify(manifest, null, 2));
      writeFile(bundleRoot, "manifest.json", JSON.stringify({ bundleId: "test", agents: [] }));
      // Only write SKILL.md, not notes.md
      writeFile(bundleRoot, "skills/planner/SKILL.md", "skill");

      const proc = spawnSync("node", [linterScript], {
        cwd: root,
        env: {
          ...process.env,
          BUNDLE_LINT_BUNDLE_ROOT: bundleRoot,
          BUNDLE_LINT_CONFIG_ROOT: resolve(tempRoot, "no-config"),
        },
        encoding: "utf-8",
      });

      const result = JSON.parse(proc.stdout) as LintResult;
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          severity: "error",
          kind: "missing-declared-file",
          file: "skills/planner/notes.md",
        }),
      );
      expect(result.summary.errors).toBeGreaterThan(0);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails for unexpected undeclared shipped files", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "bundle-lint-extra-"));
    const bundleRoot = resolve(tempRoot, "bundle");

    try {
      const manifest = {
        sourceRoot: "~/.config/opencode/skills/arcs",
        skills: { planner: ["SKILL.md"] },
        agents: [],
        plugin: [],
        preservedFiles: ["manifest.json", "bundle-runtime.json", ".opencode/plugins/arcs.js"],
      };
      writeFile(bundleRoot, "bundle-runtime.json", JSON.stringify(manifest, null, 2));
      writeFile(bundleRoot, "manifest.json", JSON.stringify({ bundleId: "test", agents: [] }));
      writeFile(bundleRoot, "skills/planner/SKILL.md", "skill");
      writeFile(bundleRoot, "skills/planner/stale.md", "stale");

      const proc = spawnSync("node", [linterScript], {
        cwd: root,
        env: {
          ...process.env,
          BUNDLE_LINT_BUNDLE_ROOT: bundleRoot,
          BUNDLE_LINT_CONFIG_ROOT: resolve(tempRoot, "no-config"),
        },
        encoding: "utf-8",
      });

      const result = JSON.parse(proc.stdout) as LintResult;
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          severity: "error",
          kind: "undeclared-file",
          file: "skills/planner/stale.md",
        }),
      );
      expect(proc.status).toBe(1);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("reports skills missing SKILL.md in their file list", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "bundle-lint-noskill-"));
    const bundleRoot = resolve(tempRoot, "bundle");

    try {
      const manifest = {
        sourceRoot: "~/.config/opencode/skills/arcs",
        skills: { planner: ["notes.md"] },
        agents: [],
        plugin: [],
      };
      writeFile(bundleRoot, "bundle-runtime.json", JSON.stringify(manifest, null, 2));
      writeFile(bundleRoot, "manifest.json", JSON.stringify({ bundleId: "test", agents: [] }));
      writeFile(bundleRoot, "skills/planner/notes.md", "notes");

      const proc = spawnSync("node", [linterScript], {
        cwd: root,
        env: {
          ...process.env,
          BUNDLE_LINT_BUNDLE_ROOT: bundleRoot,
          BUNDLE_LINT_CONFIG_ROOT: resolve(tempRoot, "no-config"),
        },
        encoding: "utf-8",
      });

      const result = JSON.parse(proc.stdout) as LintResult;
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          severity: "error",
          kind: "skill-missing-entry",
          message: expect.stringContaining("SKILL.md"),
        }),
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("reports missing .mjs bundled scripts", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "bundle-lint-mjs-"));
    const bundleRoot = resolve(tempRoot, "bundle");

    try {
      const manifest = {
        sourceRoot: "~/.config/opencode/skills/arcs",
        skills: { "to-diagram": ["SKILL.md", "scripts/manage-diagram.mjs"] },
        agents: [],
        plugin: [],
      };
      writeFile(bundleRoot, "bundle-runtime.json", JSON.stringify(manifest, null, 2));
      writeFile(bundleRoot, "manifest.json", JSON.stringify({ bundleId: "test", agents: [] }));
      writeFile(bundleRoot, "skills/to-diagram/SKILL.md", "skill");
      // Don't write the .mjs file — should be caught as missing-declared-file

      const proc = spawnSync("node", [linterScript], {
        cwd: root,
        env: {
          ...process.env,
          BUNDLE_LINT_BUNDLE_ROOT: bundleRoot,
          BUNDLE_LINT_CONFIG_ROOT: resolve(tempRoot, "no-config"),
        },
        encoding: "utf-8",
      });

      const result = JSON.parse(proc.stdout) as LintResult;
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          severity: "error",
          kind: "missing-declared-file",
          file: "skills/to-diagram/scripts/manage-diagram.mjs",
        }),
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("reports arcs-dashboard missing package.json type field", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "bundle-lint-pkg-"));
    const bundleRoot = resolve(tempRoot, "bundle");

    try {
      const manifest = {
        sourceRoot: "~/.config/opencode/skills/arcs",
        skills: { "arcs-dashboard": ["SKILL.md", "package.json"] },
        agents: [],
        plugin: [],
      };
      writeFile(bundleRoot, "bundle-runtime.json", JSON.stringify(manifest, null, 2));
      writeFile(bundleRoot, "manifest.json", JSON.stringify({ bundleId: "test", agents: [] }));
      writeFile(bundleRoot, "skills/arcs-dashboard/SKILL.md", "skill");
      // package.json without type field
      writeFile(bundleRoot, "skills/arcs-dashboard/package.json", JSON.stringify({}));

      const proc = spawnSync("node", [linterScript], {
        cwd: root,
        env: {
          ...process.env,
          BUNDLE_LINT_BUNDLE_ROOT: bundleRoot,
          BUNDLE_LINT_CONFIG_ROOT: resolve(tempRoot, "no-config"),
        },
        encoding: "utf-8",
      });

      const result = JSON.parse(proc.stdout) as LintResult;
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          severity: "error",
          kind: "package-json-invalid",
          message: expect.stringContaining("type"),
        }),
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  // config-drift detection removed: the repo bundle is the source of truth,
  // and there is no "config root" mirror to compare against. Use
  // `arcs deploy-superpowers --dry-run` to preview deployment-target diffs.

  it("exits 0 with no issues on clean bundle", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "bundle-lint-clean-"));
    const bundleRoot = resolve(tempRoot, "bundle");

    try {
      const manifest = {
        sourceRoot: "~/.config/opencode/skills/arcs",
        skills: { planner: ["SKILL.md"] },
        agents: [],
        plugin: [],
        preservedFiles: ["manifest.json", "bundle-runtime.json", ".opencode/plugins/arcs.js"],
      };
      writeFile(bundleRoot, "bundle-runtime.json", JSON.stringify(manifest, null, 2));
      writeFile(bundleRoot, "manifest.json", JSON.stringify({ bundleId: "test", agents: [] }));
      writeFile(bundleRoot, ".opencode/plugins/arcs.js", "plugin");
      writeFile(bundleRoot, "skills/planner/SKILL.md", "skill");

      const proc = spawnSync("node", [linterScript], {
        cwd: root,
        env: {
          ...process.env,
          BUNDLE_LINT_BUNDLE_ROOT: bundleRoot,
          BUNDLE_LINT_CONFIG_ROOT: resolve(tempRoot, "no-config"),
        },
        encoding: "utf-8",
      });

      const result = JSON.parse(proc.stdout) as LintResult;
      expect(result.issues).toEqual([]);
      expect(result.summary.errors).toBe(0);
      expect(proc.status).toBe(0);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("runs against the real repo bundle without errors", () => {
    const proc = spawnSync("node", [linterScript], {
      cwd: root,
      env: { ...process.env },
      encoding: "utf-8",
    });

    const result = JSON.parse(proc.stdout) as LintResult;
    expect(result.summary.errors).toBe(0);
    expect(proc.status).toBe(0);
  });

  it("reports malformed agent registry records", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "bundle-lint-registry-"));
    const bundleRoot = resolve(tempRoot, "bundle");

    try {
      writeFile(
        bundleRoot,
        "bundle-runtime.json",
        JSON.stringify({
          agents: [],
          skills: {},
          plugin: [],
          preservedFiles: ["manifest.json", "bundle-runtime.json"],
        }),
      );
      writeFile(
        bundleRoot,
        "manifest.json",
        JSON.stringify({ agents: [{ id: "software-engineer", status: "active" }] }),
      );

      const proc = spawnSync("node", [linterScript], {
        cwd: root,
        env: { ...process.env, BUNDLE_LINT_BUNDLE_ROOT: bundleRoot },
        encoding: "utf-8",
      });
      const result = JSON.parse(proc.stdout) as LintResult;
      expect(result.issues).toContainEqual(
        expect.objectContaining({ severity: "error", kind: "invalid-agent-registry" }),
      );
      expect(proc.status).toBe(1);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("requires active prompt sources but permits retired records to reference deleted prompts", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "bundle-lint-agent-status-"));
    const bundleRoot = resolve(tempRoot, "bundle");

    try {
      const activeAgent = registryAgent({ kind: "primary" });
      const retiredAgent = registryAgent({
        id: "oncall-ops",
        status: "retired",
        replacementId: "software-engineer",
        kind: "primary",
        source: "prompts/oncall-ops.txt",
        destination: "prompts/oncall-ops.txt",
      });
      writeFile(
        bundleRoot,
        "bundle-runtime.json",
        JSON.stringify({
          agents: [],
          skills: {},
          plugin: [],
          preservedFiles: ["manifest.json", "bundle-runtime.json"],
        }),
      );
      writeFile(
        bundleRoot,
        "manifest.json",
        JSON.stringify({ agents: [activeAgent, retiredAgent], config: { requiredMerges: [] } }),
      );

      const missingActive = runLint(bundleRoot);
      const missingActiveResult = JSON.parse(missingActive.stdout) as LintResult;
      expect(missingActiveResult.issues).toContainEqual(
        expect.objectContaining({
          severity: "error",
          kind: "missing-declared-file",
          file: "prompts/software-engineer.txt",
        }),
      );
      expect(missingActiveResult.issues).not.toContainEqual(
        expect.objectContaining({ file: "prompts/oncall-ops.txt" }),
      );

      writeFile(bundleRoot, "prompts/software-engineer.txt", "active prompt");
      const activePresent = runLint(bundleRoot);
      const activePresentResult = JSON.parse(activePresent.stdout) as LintResult;
      expect(activePresentResult.issues).toEqual([]);
      expect(activePresent.status).toBe(0);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("validates retired registry records even though their prompt sources may be absent", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "bundle-lint-retired-registry-"));
    const bundleRoot = resolve(tempRoot, "bundle");

    try {
      writeFile(
        bundleRoot,
        "bundle-runtime.json",
        JSON.stringify({ agents: [], skills: {}, plugin: [], preservedFiles: [] }),
      );
      writeFile(
        bundleRoot,
        "manifest.json",
        JSON.stringify({
          agents: [registryAgent({ status: "retired", source: "prompts/../deleted.txt" })],
        }),
      );

      const proc = runLint(bundleRoot);
      const result = JSON.parse(proc.stdout) as LintResult;
      expect(result.issues).toContainEqual(
        expect.objectContaining({ severity: "error", kind: "invalid-agent-registry" }),
      );
      expect(proc.status).toBe(1);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ["traversal source", { source: "prompts/../outside.txt" }],
    ["malformed destination", { destination: "prompts//software-engineer.txt" }],
    ["malformed id", { id: "../software-engineer" }],
    ["non-txt destination", { destination: "prompts/software-engineer.md" }],
  ])("rejects agent registry records with %s", (_label, overrides) => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "bundle-lint-invalid-registry-"));
    const bundleRoot = resolve(tempRoot, "bundle");

    try {
      writeFile(
        bundleRoot,
        "bundle-runtime.json",
        JSON.stringify({ agents: [], skills: {}, plugin: [], preservedFiles: [] }),
      );
      writeFile(
        bundleRoot,
        "manifest.json",
        JSON.stringify({ agents: [registryAgent(overrides)], config: { requiredMerges: [] } }),
      );

      const proc = runLint(bundleRoot);
      const result = JSON.parse(proc.stdout) as LintResult;
      expect(result.issues).toContainEqual(
        expect.objectContaining({ severity: "error", kind: "invalid-agent-registry" }),
      );
      expect(proc.status).toBe(1);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects duplicate agent prompt destinations", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "bundle-lint-duplicate-destination-"));
    const bundleRoot = resolve(tempRoot, "bundle");

    try {
      writeFile(
        bundleRoot,
        "bundle-runtime.json",
        JSON.stringify({ agents: [], skills: {}, plugin: [], preservedFiles: [] }),
      );
      writeFile(
        bundleRoot,
        "manifest.json",
        JSON.stringify({
          agents: [registryAgent(), registryAgent({ id: "devil-advocate" })],
          config: { requiredMerges: [] },
        }),
      );

      const proc = runLint(bundleRoot);
      const result = JSON.parse(proc.stdout) as LintResult;
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          severity: "error",
          kind: "invalid-agent-registry",
          message: expect.stringContaining("duplicate agent destination"),
        }),
      );
      expect(proc.status).toBe(1);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
