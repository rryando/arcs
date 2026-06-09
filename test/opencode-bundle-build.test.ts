import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const bundleRoot = resolve(root, "opencode/arcs");
const skillsRoot = resolve(bundleRoot, "skills");
const runtimeManifestPath = resolve(root, "opencode/arcs/bundle-runtime.json");

function expectRelativePathInBundle(relativePath: string, label: string) {
  const looksWindowsAbsolute = /^[A-Za-z]:[\\/]/.test(relativePath) || /^\\\\/.test(relativePath);

  expect(relativePath, `runtime path escapes bundle root: ${label}`).not.toBe("");
  expect(
    isAbsolute(relativePath) || looksWindowsAbsolute,
    `runtime path escapes bundle root: ${label}`,
  ).toBe(false);
  expect(
    relativePath.replace(/\\/g, "/"),
    `runtime path escapes bundle root: ${label}`,
  ).not.toMatch(/^\.\.(?:\/|$)/);
}

function expectBundledPath(targetPath: string, expectedRoot: string, label: string) {
  expectRelativePathInBundle(relative(expectedRoot, targetPath), label);
}

function writeRuntimeFile(rootPath: string, relativePath: string, content: string) {
  const outputPath = resolve(rootPath, relativePath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content);
}

function runBundleBuild(env: NodeJS.ProcessEnv) {
  return spawnSync("node", [resolve(root, "scripts/build-opencode-bundle.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      ...env,
    },
    encoding: "utf-8",
  });
}

describe("opencode bundle builder", () => {
  it("validates declared runtime files in the output root and prunes undeclared content", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "opencode-bundle-build-"));
    const outputRoot = resolve(tempRoot, "output");
    const runtimeManifestPath = resolve(tempRoot, "bundle-runtime.json");

    try {
      const runtimeManifest = {
        skills: {
          planner: ["SKILL.md", "notes.md"],
        },
        agents: ["agents/helper.md"],
        plugin: [".opencode/plugins/runtime.js"],
      };

      writeFileSync(runtimeManifestPath, JSON.stringify(runtimeManifest, null, 2));
      // Output root IS the source of truth — declared files are authored here.
      writeRuntimeFile(outputRoot, "skills/planner/SKILL.md", "skill");
      writeRuntimeFile(outputRoot, "skills/planner/notes.md", "notes");
      writeRuntimeFile(outputRoot, "agents/helper.md", "agent");
      writeRuntimeFile(outputRoot, ".opencode/plugins/runtime.js", "plugin");

      // Manifest + bundle-runtime are preserved (preservedOutputFiles).
      writeRuntimeFile(outputRoot, "manifest.json", "keep manifest");
      writeRuntimeFile(outputRoot, "bundle-runtime.json", "keep runtime manifest");
      // Undeclared files that should be pruned by the build.
      writeRuntimeFile(outputRoot, "skills/planner/stale.md", "remove me");
      writeRuntimeFile(outputRoot, "skills/planner/ignored.md", "remove me too");
      writeRuntimeFile(outputRoot, "extra/nested.txt", "remove nested");

      const result = runBundleBuild({
        ARCS_BUNDLE_OUTPUT_ROOT: outputRoot,
        ARCS_BUNDLE_RUNTIME_MANIFEST: runtimeManifestPath,
      });

      expect(result.status).toBe(0);
      expect(readFileSync(resolve(outputRoot, "skills/planner/SKILL.md"), "utf-8")).toBe("skill");
      expect(readFileSync(resolve(outputRoot, "skills/planner/notes.md"), "utf-8")).toBe("notes");
      expect(readFileSync(resolve(outputRoot, "agents/helper.md"), "utf-8")).toBe("agent");
      expect(readFileSync(resolve(outputRoot, ".opencode/plugins/runtime.js"), "utf-8")).toBe(
        "plugin",
      );
      expect(existsSync(resolve(outputRoot, "skills/planner/ignored.md"))).toBe(false);
      expect(existsSync(resolve(outputRoot, "skills/planner/stale.md"))).toBe(false);
      expect(existsSync(resolve(outputRoot, "extra/nested.txt"))).toBe(false);
      expect(readFileSync(resolve(outputRoot, "manifest.json"), "utf-8")).toBe("keep manifest");
      expect(readFileSync(resolve(outputRoot, "bundle-runtime.json"), "utf-8")).toBe(
        "keep runtime manifest",
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails loudly when a declared runtime file is missing from the output root", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "opencode-bundle-build-missing-"));
    const outputRoot = resolve(tempRoot, "output");
    const runtimeManifestPath = resolve(tempRoot, "bundle-runtime.json");

    try {
      const runtimeManifest = {
        skills: {
          planner: ["SKILL.md", "missing.md"],
        },
        agents: [],
        plugin: [],
      };

      writeFileSync(runtimeManifestPath, JSON.stringify(runtimeManifest, null, 2));
      writeRuntimeFile(outputRoot, "skills/planner/SKILL.md", "skill");

      const result = runBundleBuild({
        ARCS_BUNDLE_OUTPUT_ROOT: outputRoot,
        ARCS_BUNDLE_RUNTIME_MANIFEST: runtimeManifestPath,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Missing declared bundle file");
      expect(result.stderr).toContain("skills/planner/missing.md");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects declared runtime paths that are absolute or escape the output root", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "opencode-bundle-build-invalid-path-"));
    const outputRoot = resolve(tempRoot, "output");
    const runtimeManifestPath = resolve(tempRoot, "bundle-runtime.json");
    const invalidPathCases = [
      {
        label: "posix escape",
        manifest: {
          skills: {
            planner: ["../escape.md"],
          },
          agents: [],
          plugin: [],
        },
        expectedPath: "skills/planner/../escape.md",
      },
      {
        label: "absolute agent path",
        manifest: {
          skills: {},
          agents: [resolve(tempRoot, "outside.md")],
          plugin: [],
        },
        expectedPath: resolve(tempRoot, "outside.md").replace(/\\/g, "/"),
      },
    ];

    try {
      for (const invalidPathCase of invalidPathCases) {
        writeFileSync(runtimeManifestPath, JSON.stringify(invalidPathCase.manifest, null, 2));

        const result = runBundleBuild({
          ARCS_BUNDLE_OUTPUT_ROOT: outputRoot,
          ARCS_BUNDLE_RUNTIME_MANIFEST: runtimeManifestPath,
        });

        expect(result.status, invalidPathCase.label).not.toBe(0);
        expect(result.stderr, invalidPathCase.label).toContain("Invalid declared runtime path");
        expect(result.stderr, invalidPathCase.label).toContain(invalidPathCase.expectedPath);
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects skill namespace traversal that can target preserved root files", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "opencode-bundle-build-invalid-skill-name-"));
    const outputRoot = resolve(tempRoot, "output");
    const runtimeManifestPath = resolve(tempRoot, "bundle-runtime.json");
    const invalidPathCases = [
      {
        manifest: {
          skills: {
            "../..": ["manifest.json"],
          },
          agents: [],
          plugin: [],
        },
        expectedPath: "skills/../../manifest.json",
      },
      {
        manifest: {
          skills: {
            planner: ["../manifest.json"],
          },
          agents: [],
          plugin: [],
        },
        expectedPath: "skills/planner/../manifest.json",
      },
    ];

    try {
      for (const invalidPathCase of invalidPathCases) {
        writeFileSync(runtimeManifestPath, JSON.stringify(invalidPathCase.manifest, null, 2));

        const result = runBundleBuild({
          ARCS_BUNDLE_OUTPUT_ROOT: outputRoot,
          ARCS_BUNDLE_RUNTIME_MANIFEST: runtimeManifestPath,
        });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Invalid declared runtime path");
        expect(result.stderr).toContain(invalidPathCase.expectedPath);
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects reserved path segments in agents and plugin entries", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "opencode-bundle-build-invalid-agent-plugin-"));
    const outputRoot = resolve(tempRoot, "output");
    const runtimeManifestPath = resolve(tempRoot, "bundle-runtime.json");
    const invalidPathCases = [
      {
        manifest: {
          skills: {},
          agents: ["agents/../manifest.json"],
          plugin: [],
        },
        expectedPath: "agents/../manifest.json",
      },
      {
        manifest: {
          skills: {},
          agents: [],
          plugin: [".opencode/plugins/../manifest.json"],
        },
        expectedPath: ".opencode/plugins/../manifest.json",
      },
    ];

    try {
      for (const invalidPathCase of invalidPathCases) {
        writeFileSync(runtimeManifestPath, JSON.stringify(invalidPathCase.manifest, null, 2));

        const result = runBundleBuild({
          ARCS_BUNDLE_OUTPUT_ROOT: outputRoot,
          ARCS_BUNDLE_RUNTIME_MANIFEST: runtimeManifestPath,
        });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Invalid declared runtime path");
        expect(result.stderr).toContain(invalidPathCase.expectedPath);
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects agent and plugin entries outside their category roots", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "opencode-bundle-build-invalid-category-root-"));
    const outputRoot = resolve(tempRoot, "output");
    const runtimeManifestPath = resolve(tempRoot, "bundle-runtime.json");
    const invalidPathCases = [
      {
        manifest: {
          skills: {},
          agents: ["manifest.json"],
          plugin: [],
        },
        expectedPath: "manifest.json",
      },
      {
        manifest: {
          skills: {},
          agents: ["skills/foo/SKILL.md"],
          plugin: [],
        },
        expectedPath: "skills/foo/SKILL.md",
      },
      {
        manifest: {
          skills: {},
          agents: [],
          plugin: ["manifest.json"],
        },
        expectedPath: "manifest.json",
      },
      {
        manifest: {
          skills: {},
          agents: [],
          plugin: ["skills/foo/SKILL.md"],
        },
        expectedPath: "skills/foo/SKILL.md",
      },
    ];

    try {
      for (const invalidPathCase of invalidPathCases) {
        writeFileSync(runtimeManifestPath, JSON.stringify(invalidPathCase.manifest, null, 2));

        const result = runBundleBuild({
          ARCS_BUNDLE_OUTPUT_ROOT: outputRoot,
          ARCS_BUNDLE_RUNTIME_MANIFEST: runtimeManifestPath,
        });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Invalid declared runtime path");
        expect(result.stderr).toContain(invalidPathCase.expectedPath);
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects nested agent entries outside the agents/*.md contract", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "opencode-bundle-build-nested-agent-"));
    const outputRoot = resolve(tempRoot, "output");
    const runtimeManifestPath = resolve(tempRoot, "bundle-runtime.json");

    try {
      const runtimeManifest = {
        skills: {},
        agents: ["agents/reviews/reviewer.md"],
        plugin: [],
      };

      writeFileSync(runtimeManifestPath, JSON.stringify(runtimeManifest, null, 2));
      writeRuntimeFile(outputRoot, "agents/reviews/reviewer.md", "reviewer");

      const result = runBundleBuild({
        ARCS_BUNDLE_OUTPUT_ROOT: outputRoot,
        ARCS_BUNDLE_RUNTIME_MANIFEST: runtimeManifestPath,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Invalid declared runtime path");
      expect(result.stderr).toContain("agents/reviews/reviewer.md");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("opencode bundle runtime manifest", () => {
  it("ships the curated manifest shape for runtime bundling", () => {
    const runtimeManifest = JSON.parse(readFileSync(runtimeManifestPath, "utf-8"));

    expect(runtimeManifest).toEqual({
      skills: {
        brainstorming: [
          "SKILL.md",
          "spec-document-reviewer-prompt.md",
          "visual-companion.md",
          "scripts/frame-template.html",
          "scripts/helper.js",
          "scripts/server.js",
          "scripts/start-server.sh",
          "scripts/stop-server.sh",
        ],
        "code-agent": ["SKILL.md"],
        "deep-pr-review": ["SKILL.md", "review-template.md", "graphify-diff.md"],
        "enriching-codegraph-proposals": ["SKILL.md"],
        "executing-plans": ["SKILL.md"],
        "quick-dev": ["SKILL.md"],
        "requesting-code-review": ["SKILL.md", "code-reviewer.md"],
        "subagent-driven-development": [
          "SKILL.md",
          "code-quality-reviewer-prompt.md",
          "implementer-prompt.md",
          "spec-reviewer-prompt.md",
        ],
        "systematic-debugging": [
          "SKILL.md",
          "condition-based-waiting.md",
          "condition-based-waiting-example.ts",
          "defense-in-depth.md",
          "find-polluter.sh",
          "phases-reference.md",
          "root-cause-tracing.md",
        ],
        "test-driven-development": [
          "SKILL.md",
          "tdd-rationalizations-and-examples.md",
          "testing-anti-patterns.md",
        ],
        "to-diagram": ["SKILL.md", "scripts/manage-diagram.mjs"],
        "writing-plans": ["SKILL.md", "plan-document-reviewer-prompt.md"],
      },
      agents: [],
      plugin: [],
      excludePatterns: [
        "**/references/**",
        "**/examples/**",
        "**/CREATION-LOG.md",
        "**/test-pressure-*.md",
      ],
    });
  });

  it("lists only bundled files that exist in the tree", () => {
    const runtimeManifest = JSON.parse(readFileSync(runtimeManifestPath, "utf-8"));

    for (const [skillName, skillFiles] of Object.entries<string[]>(runtimeManifest.skills)) {
      for (const skillFile of skillFiles) {
        const skillPath = resolve(skillsRoot, skillName, skillFile);

        expectBundledPath(skillPath, resolve(skillsRoot, skillName), `${skillName}/${skillFile}`);
        expect(existsSync(skillPath), `missing skill runtime file: ${skillName}/${skillFile}`).toBe(
          true,
        );
      }
    }

    for (const agentFile of runtimeManifest.agents) {
      const agentPath = resolve(bundleRoot, agentFile);

      expectBundledPath(agentPath, bundleRoot, agentFile);
      expect(existsSync(agentPath), `missing runtime agent file: ${agentFile}`).toBe(true);
    }

    for (const pluginFile of runtimeManifest.plugin) {
      const pluginPath = resolve(bundleRoot, pluginFile);

      expectBundledPath(pluginPath, bundleRoot, pluginFile);
      expect(existsSync(pluginPath), `missing runtime plugin file: ${pluginFile}`).toBe(true);
    }
  });

  it("rejects cross-platform path escapes before existence checks", () => {
    expect(() => expectRelativePathInBundle("../escape.txt", "posix escape")).toThrow();
    expect(() => expectRelativePathInBundle("..\\escape.txt", "windows escape")).toThrow();
    expect(() => expectRelativePathInBundle("C:\\escape.txt", "absolute windows path")).toThrow();
    expect(() => expectRelativePathInBundle("\\\\server\\share\\escape.txt", "unc path")).toThrow();
  });
});
