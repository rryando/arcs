import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateDiagramFromTasks } from "../src/utils/diagram-generator.js";

const scriptPath = resolve(
  import.meta.dirname,
  "../opencode/arcs/skills/to-diagram/scripts/manage-diagram.mjs",
);
const skillPath = resolve(import.meta.dirname, "../opencode/arcs/skills/to-diagram/SKILL.md");

function run(command: string, filePath: string, ...args: string[]) {
  const result = spawnSync("node", [scriptPath, command, filePath, ...args], {
    encoding: "utf-8",
    cwd: import.meta.dirname,
  });
  return result;
}

const VALID_DIAGRAM = `%% plan: test-plan
%% status: T001=done, T002=inProgress, T003=backlog, T004=backlog, T005=blocked
%% ready: T003
%% blocked: T005
%% next-action: Start T003

%% node: T001
%% title: Design schema
%% status: done
%% skill: quick-dev
%% scope: db/
%% acceptance: Migration runs
%% verify: npm run migrate

%% node: T002
%% title: Build API
%% status: inProgress
%% skill: tdd
%% scope: src/api/
%% acceptance: CRUD works
%% verify: npm test

%% node: T003
%% title: Write tests
%% status: backlog
%% skill: tdd
%% scope: test/
%% acceptance: Tests pass
%% verify: npm test
%% blocked-by: T001

%% node: T004
%% title: Build UI
%% status: backlog
%% skill: code-agent
%% scope: src/ui/
%% acceptance: UI renders
%% verify: npm test
%% blocked-by: T002

%% node: T005
%% title: Deploy
%% status: blocked
%% skill: quick-dev
%% scope: infra/
%% acceptance: Deployed
%% verify: npm run deploy
%% blocked-by: T003, T004

flowchart TD
    classDef done fill:#22c55e,color:#fff
    classDef inProgress fill:#f59e0b,color:#fff
    classDef blocked fill:#ef4444,color:#fff
    classDef backlog fill:#94a3b8,color:#fff

    T001[Design schema]:::done --> T002[Build API]:::inProgress
    T001 --> T003[Write tests]:::backlog
    T002 --> T004[Build UI]:::backlog
    T003 --> T005[Deploy]:::blocked
    T004 --> T005
`;

let tempDir: string;
let diagramPath: string;

describe("manage-diagram.mjs", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(resolve(tmpdir(), "manage-diagram-test-"));
    diagramPath = resolve(tempDir, "test.diagram.mmd");
    writeFileSync(diagramPath, VALID_DIAGRAM);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("inspect", () => {
    it("parses nodes, edges, and metadata", () => {
      const result = run("inspect", diagramPath);
      expect(result.status).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.planId).toBe("test-plan");
      expect(output.nodes).toHaveLength(5);
      expect(output.nodes[0]).toEqual({ id: "T001", label: "Design schema", status: "done" });
      expect(output.edges).toHaveLength(5);
      expect(output.edges[0]).toEqual({ from: "T001", to: "T002" });
      expect(output.metadataBlocks.T001.title).toBe("Design schema");
      expect(output.statusComment).toContain("T001=done");
      expect(output.readyComment).toContain("T003");
    });
  });

  describe("ready", () => {
    it("computes ready nodes from topology", () => {
      const result = run("ready", diagramPath);
      expect(result.status).toBe(0);

      const output = JSON.parse(result.stdout);
      // T003 has only T001 as dep and T001 is done → ready
      // T004 has T002 as dep and T002 is inProgress → not ready
      expect(output).toEqual(["T003"]);
    });
  });

  describe("validate", () => {
    it("validates a generated cancelled task without making it ready", () => {
      const generated = generateDiagramFromTasks("cancelled-plan", [
        {
          id: "cancelled-task",
          normalizedId: "cancelled-task",
          title: "Cancelled task",
          status: "cancelled",
          priority: "medium",
          scope: "src/",
          acceptance: "Remains cancelled",
          createdAt: "2026-08-12T00:00:00.000Z",
          updatedAt: "2026-08-12T00:00:00.000Z",
        },
      ]);
      writeFileSync(diagramPath, generated.mmd);

      const validation = run("validate", diagramPath);
      expect(validation.status).toBe(0);
      expect(JSON.parse(validation.stdout)).toEqual({ ok: true, errors: [] });

      const readiness = run("ready", diagramPath);
      expect(readiness.status).toBe(0);
      expect(JSON.parse(readiness.stdout)).toEqual([]);
    });

    it("keeps helper-managed skill guidance on the supported flowchart dialect", () => {
      const guidance = readFileSync(skillPath, "utf-8");

      expect(guidance).toContain("flowchart TD");
      expect(guidance).not.toContain("stateDiagram-v2");
    });

    it("passes a valid diagram", () => {
      const result = run("validate", diagramPath);
      expect(result.status).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.ok).toBe(true);
      expect(output.errors).toEqual([]);
    });

    it("fails on missing metadata field", () => {
      const broken = VALID_DIAGRAM.replace("%% acceptance: Migration runs\n", "");
      writeFileSync(diagramPath, broken);

      const result = run("validate", diagramPath);
      expect(result.status).not.toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.ok).toBe(false);
      expect(
        output.errors.some((e: string) => e.includes("acceptance") && e.includes("T001")),
      ).toBe(true);
    });

    it("fails on missing required field in a non-last metadata block", () => {
      // Remove acceptance from T003 (middle block)
      const broken = VALID_DIAGRAM.replace(
        "%% acceptance: Tests pass\n%% verify: npm test\n%% blocked-by: T001",
        "%% verify: npm test\n%% blocked-by: T001",
      );
      writeFileSync(diagramPath, broken);

      const result = run("validate", diagramPath);
      expect(result.status).not.toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.ok).toBe(false);
      expect(
        output.errors.some((e: string) => e.includes("acceptance") && e.includes("T003")),
      ).toBe(true);
    });

    it("fails on stale status comment", () => {
      const broken = VALID_DIAGRAM.replace("T001=done", "T001=backlog");
      writeFileSync(diagramPath, broken);

      const result = run("validate", diagramPath);
      expect(result.status).not.toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.ok).toBe(false);
      expect(output.errors.some((e: string) => e.includes("Status comment mismatch"))).toBe(true);
    });

    it("fails on metadata order mismatch", () => {
      // Swap T001 and T002 metadata blocks
      // Simpler approach: just reorder
      const reordered = VALID_DIAGRAM.replace(
        `%% node: T001
%% title: Design schema
%% status: done
%% skill: quick-dev
%% scope: db/
%% acceptance: Migration runs
%% verify: npm run migrate

%% node: T002
%% title: Build API
%% status: inProgress
%% skill: tdd
%% scope: src/api/
%% acceptance: CRUD works
%% verify: npm test`,
        `%% node: T002
%% title: Build API
%% status: inProgress
%% skill: tdd
%% scope: src/api/
%% acceptance: CRUD works
%% verify: npm test

%% node: T001
%% title: Design schema
%% status: done
%% skill: quick-dev
%% scope: db/
%% acceptance: Migration runs
%% verify: npm run migrate`,
      );
      writeFileSync(diagramPath, reordered);

      const result = run("validate", diagramPath);
      expect(result.status).not.toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.ok).toBe(false);
      expect(output.errors.some((e: string) => e.includes("not ordered"))).toBe(true);
    });

    it("fails when ready comment lists nonexistent node ID", () => {
      const broken = VALID_DIAGRAM.replace("%% ready: T003", "%% ready: T999");
      writeFileSync(diagramPath, broken);

      const result = run("validate", diagramPath);
      expect(result.status).not.toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.ok).toBe(false);
      expect(output.errors.some((e: string) => e.includes("T999") && e.includes("not found"))).toBe(
        true,
      );
    });

    it("fails on stateDiagram-v2", () => {
      writeFileSync(diagramPath, `%% plan: test\nstateDiagram-v2\n  [*] --> Draft\n`);

      const result = run("validate", diagramPath);
      expect(result.status).not.toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.ok).toBe(false);
      expect(output.errors[0]).toContain("stateDiagram-v2");
    });
  });

  describe("status", () => {
    it("errors when target node has no :::class suffix in graph", () => {
      // Remove :::backlog from T003 declaration
      const broken = VALID_DIAGRAM.replace("T003[Write tests]:::backlog", "T003[Write tests]");
      writeFileSync(diagramPath, broken);

      const result = run("status", diagramPath, "T003", "done");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("T003");
    });

    it("updates plan-level status comment after node status change", () => {
      const result = run("status", diagramPath, "T002", "done");
      expect(result.status).toBe(0);

      const updated = readFileSync(diagramPath, "utf-8");
      expect(updated).toContain("T002=done");
      expect(updated).not.toContain("T002=inProgress");
    });

    it("updates one node without changing topology and recomputes ready", () => {
      // Mark T002 as done — T004 should become ready
      const result = run("status", diagramPath, "T002", "done");
      expect(result.status).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.updated).toBe(true);
      expect(output.nodeId).toBe("T002");
      expect(output.status).toBe("done");
      expect(output.ready).toContain("T003");
      expect(output.ready).toContain("T004");

      // Verify file was updated
      const updated = readFileSync(diagramPath, "utf-8");
      expect(updated).toContain("T002[Build API]:::done");
      expect(updated).not.toContain("T002[Build API]:::inProgress");
    });
  });

  describe("file error handling", () => {
    it("emits clean error on missing file for inspect", () => {
      const result = run("inspect", "/nonexistent/path.mmd");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Error: File not found: /nonexistent/path.mmd");
    });

    it("emits clean error on missing file for ready", () => {
      const result = run("ready", "/nonexistent/path.mmd");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Error: File not found: /nonexistent/path.mmd");
    });

    it("emits clean error on missing file for validate", () => {
      const result = run("validate", "/nonexistent/path.mmd");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Error: File not found: /nonexistent/path.mmd");
    });

    it("emits clean error on missing metadata file for regenerate", () => {
      const result = run("regenerate", diagramPath, "--metadata", "/nonexistent/meta.json");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Error: File not found: /nonexistent/meta.json");
    });
  });

  describe("plan header validation", () => {
    it("inspect rejects diagram with missing plan header", () => {
      const noPlan = VALID_DIAGRAM.replace("%% plan: test-plan\n", "");
      writeFileSync(diagramPath, noPlan);
      const result = run("inspect", diagramPath);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Error: Diagram must have a non-empty plan header.");
    });

    it("ready rejects diagram with empty plan header", () => {
      const emptyPlan = VALID_DIAGRAM.replace("%% plan: test-plan", "%% plan:");
      writeFileSync(diagramPath, emptyPlan);
      const result = run("ready", diagramPath);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Error: Diagram must have a non-empty plan header.");
    });
  });

  describe("regenerate", () => {
    const VALID_METADATA = {
      planId: "regen-test",
      tasks: [
        {
          id: "T001",
          title: "First task",
          status: "done",
          skill: "quick-dev",
          scope: "src/",
          acceptance: "Works",
          verify: "npm test",
        },
        {
          id: "T002",
          title: "Second task",
          status: "backlog",
          skill: "code-agent",
          scope: "lib/",
          acceptance: "Builds",
          verify: "npm run build",
          dependencies: ["T001"],
        },
      ],
    };

    function writeMetadata(meta: unknown) {
      const metaPath = resolve(tempDir, "metadata.json");
      writeFileSync(metaPath, JSON.stringify(meta));
      return metaPath;
    }

    it("writes valid diagram from metadata", () => {
      const metaPath = writeMetadata(VALID_METADATA);
      const outPath = resolve(tempDir, "output.diagram.mmd");
      const result = run("regenerate", outPath, "--metadata", metaPath);
      expect(result.status).toBe(0);

      const content = readFileSync(outPath, "utf-8");
      expect(content).toContain("%% plan: regen-test");
      expect(content).toContain("flowchart TD");
      expect(content).toContain("T001[First task]:::done");
      expect(content).toContain("T002[Second task]:::backlog");
      expect(content).toContain("T001 --> T002");
      expect(content).toContain("classDef done");
      expect(content).toContain("%% node: T001");
      expect(content).toContain("%% node: T002");
    });

    it("preserves stable IDs across task reorder", () => {
      const metaPath = writeMetadata(VALID_METADATA);
      const outPath = resolve(tempDir, "output.diagram.mmd");
      run("regenerate", outPath, "--metadata", metaPath);
      const first = readFileSync(outPath, "utf-8");

      // Reorder tasks in metadata
      const reordered = { ...VALID_METADATA, tasks: [...VALID_METADATA.tasks].reverse() };
      const metaPath2 = writeMetadata(reordered);
      run("regenerate", outPath, "--metadata", metaPath2);
      const second = readFileSync(outPath, "utf-8");

      expect(first).toBe(second);
    });

    it("assigns next T### for task without ID", () => {
      const meta = {
        planId: "assign-test",
        tasks: [
          {
            id: "T001",
            title: "Existing",
            status: "done",
            skill: "quick-dev",
            scope: "src/",
            acceptance: "Done",
            verify: "true",
          },
          {
            title: "New task no ID",
            status: "backlog",
            skill: "code-agent",
            scope: "lib/",
            acceptance: "Works",
            verify: "true",
          },
        ],
      };
      const metaPath = writeMetadata(meta);
      const outPath = resolve(tempDir, "output.diagram.mmd");
      const result = run("regenerate", outPath, "--metadata", metaPath);
      expect(result.status).toBe(0);

      const content = readFileSync(outPath, "utf-8");
      expect(content).toContain("T002[New task no ID]:::backlog");
    });

    it("retired task ID not reused", () => {
      // First generate with T001, T002
      const metaPath = writeMetadata(VALID_METADATA);
      const outPath = resolve(tempDir, "output.diagram.mmd");
      run("regenerate", outPath, "--metadata", metaPath);

      // Remove T001, add new task
      const meta2 = {
        planId: "regen-test",
        tasks: [
          {
            id: "T002",
            title: "Second task",
            status: "backlog",
            skill: "code-agent",
            scope: "lib/",
            acceptance: "Builds",
            verify: "npm run build",
          },
          {
            title: "Brand new",
            status: "backlog",
            skill: "quick-dev",
            scope: "new/",
            acceptance: "New",
            verify: "true",
          },
        ],
      };
      const metaPath2 = writeMetadata(meta2);
      run("regenerate", outPath, "--metadata", metaPath2);
      const content = readFileSync(outPath, "utf-8");

      // New task should get T003 not T001
      expect(content).toContain("T003[Brand new]");
      expect(content).not.toContain("T001[");
    });

    it("dependency edge changes reflected in graph", () => {
      const meta = {
        planId: "dep-test",
        tasks: [
          {
            id: "T001",
            title: "A",
            status: "done",
            skill: "quick-dev",
            scope: "a/",
            acceptance: "A",
            verify: "true",
          },
          {
            id: "T002",
            title: "B",
            status: "backlog",
            skill: "quick-dev",
            scope: "b/",
            acceptance: "B",
            verify: "true",
            dependencies: ["T001"],
          },
          {
            id: "T003",
            title: "C",
            status: "backlog",
            skill: "quick-dev",
            scope: "c/",
            acceptance: "C",
            verify: "true",
            dependencies: ["T002"],
          },
        ],
      };
      const metaPath = writeMetadata(meta);
      const outPath = resolve(tempDir, "output.diagram.mmd");
      run("regenerate", outPath, "--metadata", metaPath);
      const content = readFileSync(outPath, "utf-8");
      expect(content).toContain("T001 --> T002");
      expect(content).toContain("T002 --> T003");
      expect(content).not.toContain("T001 --> T003");
    });

    it("deterministic output across repeated runs", () => {
      const metaPath = writeMetadata(VALID_METADATA);
      const outPath = resolve(tempDir, "output.diagram.mmd");
      run("regenerate", outPath, "--metadata", metaPath);
      const first = readFileSync(outPath, "utf-8");
      run("regenerate", outPath, "--metadata", metaPath);
      const second = readFileSync(outPath, "utf-8");
      expect(first).toBe(second);
    });

    it("deterministic output regardless of dependency array order", () => {
      const meta1 = {
        planId: "det-test",
        tasks: [
          {
            id: "T001",
            title: "A",
            status: "done",
            skill: "s",
            scope: "a/",
            acceptance: "A",
            verify: "t",
          },
          {
            id: "T002",
            title: "B",
            status: "done",
            skill: "s",
            scope: "b/",
            acceptance: "B",
            verify: "t",
          },
          {
            id: "T003",
            title: "C",
            status: "backlog",
            skill: "s",
            scope: "c/",
            acceptance: "C",
            verify: "t",
            dependencies: ["T002", "T001"],
          },
        ],
      };
      const meta2 = {
        ...meta1,
        tasks: [
          meta1.tasks[0],
          meta1.tasks[1],
          { ...meta1.tasks[2], dependencies: ["T001", "T002"] },
        ],
      };
      const mp1 = writeMetadata(meta1);
      const mp2 = writeMetadata(meta2);
      const outPath = resolve(tempDir, "output.diagram.mmd");
      run("regenerate", outPath, "--metadata", mp1);
      const first = readFileSync(outPath, "utf-8");
      run("regenerate", outPath, "--metadata", mp2);
      const second = readFileSync(outPath, "utf-8");
      expect(first).toBe(second);
    });

    it("rejects missing dependency with clean error", () => {
      const meta = {
        planId: "bad-dep",
        tasks: [
          {
            id: "T001",
            title: "A",
            status: "done",
            skill: "s",
            scope: "a/",
            acceptance: "A",
            verify: "t",
            dependencies: ["T999"],
          },
        ],
      };
      const metaPath = writeMetadata(meta);
      const outPath = resolve(tempDir, "output.diagram.mmd");
      const result = run("regenerate", outPath, "--metadata", metaPath);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Error: Task dependency references missing task: T999");
    });

    it("rejects malformed JSON", () => {
      const metaPath = resolve(tempDir, "bad.json");
      writeFileSync(metaPath, "{ not valid json");
      const outPath = resolve(tempDir, "output.diagram.mmd");
      const result = run("regenerate", outPath, "--metadata", metaPath);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Error: Failed to parse metadata JSON:");
    });

    it("rejects missing planId", () => {
      const meta = {
        tasks: [
          {
            id: "T001",
            title: "A",
            status: "done",
            skill: "s",
            scope: "a/",
            acceptance: "A",
            verify: "t",
          },
        ],
      };
      const metaPath = writeMetadata(meta);
      const outPath = resolve(tempDir, "output.diagram.mmd");
      const result = run("regenerate", outPath, "--metadata", metaPath);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("planId");
    });

    it("rejects empty planId", () => {
      const meta = {
        planId: "",
        tasks: [
          {
            id: "T001",
            title: "A",
            status: "done",
            skill: "s",
            scope: "a/",
            acceptance: "A",
            verify: "t",
          },
        ],
      };
      const metaPath = writeMetadata(meta);
      const outPath = resolve(tempDir, "output.diagram.mmd");
      const result = run("regenerate", outPath, "--metadata", metaPath);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("planId");
    });

    it("accepts task without optional verify field", () => {
      const meta = {
        planId: "test",
        tasks: [
          { id: "T001", title: "A", status: "done", skill: "s", scope: "a/", acceptance: "A" },
        ],
      }; // verify is optional
      const metaPath = writeMetadata(meta);
      const outPath = resolve(tempDir, "output.diagram.mmd");
      const result = run("regenerate", outPath, "--metadata", metaPath);
      expect(result.status).toBe(0);
    });

    it("rejects missing required task field", () => {
      const meta = {
        planId: "test",
        tasks: [{ id: "T001", title: "A", status: "done", skill: "s", scope: "a/" }],
      }; // missing acceptance (required)
      const metaPath = writeMetadata(meta);
      const outPath = resolve(tempDir, "output.diagram.mmd");
      const result = run("regenerate", outPath, "--metadata", metaPath);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("acceptance");
    });

    it("rejects invalid status", () => {
      const meta = {
        planId: "test",
        tasks: [
          {
            id: "T001",
            title: "A",
            status: "invalid",
            skill: "s",
            scope: "a/",
            acceptance: "A",
            verify: "t",
          },
        ],
      };
      const metaPath = writeMetadata(meta);
      const outPath = resolve(tempDir, "output.diagram.mmd");
      const result = run("regenerate", outPath, "--metadata", metaPath);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("status");
    });
  });

  describe("validate --metadata", () => {
    function writeMetadata(meta: unknown) {
      const metaPath = resolve(tempDir, "metadata.json");
      writeFileSync(metaPath, JSON.stringify(meta));
      return metaPath;
    }

    it("detects class status mismatch", () => {
      // Diagram says T001 is done, metadata says backlog
      const meta = {
        planId: "test-plan",
        tasks: [
          {
            id: "T001",
            title: "Design schema",
            status: "backlog",
            skill: "quick-dev",
            scope: "db/",
            acceptance: "Migration runs",
            verify: "npm run migrate",
          },
          {
            id: "T002",
            title: "Build API",
            status: "inProgress",
            skill: "tdd",
            scope: "src/api/",
            acceptance: "CRUD works",
            verify: "npm test",
            dependencies: ["T001"],
          },
          {
            id: "T003",
            title: "Write tests",
            status: "backlog",
            skill: "tdd",
            scope: "test/",
            acceptance: "Tests pass",
            verify: "npm test",
            dependencies: ["T001"],
          },
          {
            id: "T004",
            title: "Build UI",
            status: "backlog",
            skill: "code-agent",
            scope: "src/ui/",
            acceptance: "UI renders",
            verify: "npm test",
            dependencies: ["T002"],
          },
          {
            id: "T005",
            title: "Deploy",
            status: "blocked",
            skill: "quick-dev",
            scope: "infra/",
            acceptance: "Deployed",
            verify: "npm run deploy",
            dependencies: ["T003", "T004"],
          },
        ],
      };
      const metaPath = writeMetadata(meta);
      const result = run("validate", diagramPath, "--metadata", metaPath);
      expect(result.status).not.toBe(0);
      const output = JSON.parse(result.stdout);
      expect(
        output.errors.some((e: string) => e.includes("status mismatch") && e.includes("T001")),
      ).toBe(true);
    });

    it("detects phantom node in diagram", () => {
      // Metadata missing T005
      const meta = {
        planId: "test-plan",
        tasks: [
          {
            id: "T001",
            title: "Design schema",
            status: "done",
            skill: "quick-dev",
            scope: "db/",
            acceptance: "Migration runs",
            verify: "npm run migrate",
          },
          {
            id: "T002",
            title: "Build API",
            status: "inProgress",
            skill: "tdd",
            scope: "src/api/",
            acceptance: "CRUD works",
            verify: "npm test",
            dependencies: ["T001"],
          },
          {
            id: "T003",
            title: "Write tests",
            status: "backlog",
            skill: "tdd",
            scope: "test/",
            acceptance: "Tests pass",
            verify: "npm test",
            dependencies: ["T001"],
          },
          {
            id: "T004",
            title: "Build UI",
            status: "backlog",
            skill: "code-agent",
            scope: "src/ui/",
            acceptance: "UI renders",
            verify: "npm test",
            dependencies: ["T002"],
          },
        ],
      };
      const metaPath = writeMetadata(meta);
      const result = run("validate", diagramPath, "--metadata", metaPath);
      expect(result.status).not.toBe(0);
      const output = JSON.parse(result.stdout);
      expect(
        output.errors.some((e: string) => e.includes("Phantom node") && e.includes("T005")),
      ).toBe(true);
    });

    it("detects missing node from diagram", () => {
      // Metadata has T006 not in diagram
      const meta = {
        planId: "test-plan",
        tasks: [
          {
            id: "T001",
            title: "Design schema",
            status: "done",
            skill: "quick-dev",
            scope: "db/",
            acceptance: "Migration runs",
            verify: "npm run migrate",
          },
          {
            id: "T002",
            title: "Build API",
            status: "inProgress",
            skill: "tdd",
            scope: "src/api/",
            acceptance: "CRUD works",
            verify: "npm test",
            dependencies: ["T001"],
          },
          {
            id: "T003",
            title: "Write tests",
            status: "backlog",
            skill: "tdd",
            scope: "test/",
            acceptance: "Tests pass",
            verify: "npm test",
            dependencies: ["T001"],
          },
          {
            id: "T004",
            title: "Build UI",
            status: "backlog",
            skill: "code-agent",
            scope: "src/ui/",
            acceptance: "UI renders",
            verify: "npm test",
            dependencies: ["T002"],
          },
          {
            id: "T005",
            title: "Deploy",
            status: "blocked",
            skill: "quick-dev",
            scope: "infra/",
            acceptance: "Deployed",
            verify: "npm run deploy",
            dependencies: ["T003", "T004"],
          },
          {
            id: "T006",
            title: "New task",
            status: "backlog",
            skill: "quick-dev",
            scope: "new/",
            acceptance: "New",
            verify: "true",
          },
        ],
      };
      const metaPath = writeMetadata(meta);
      const result = run("validate", diagramPath, "--metadata", metaPath);
      expect(result.status).not.toBe(0);
      const output = JSON.parse(result.stdout);
      expect(
        output.errors.some((e: string) => e.includes("Missing node") && e.includes("T006")),
      ).toBe(true);
    });

    it("detects topology mismatch", () => {
      // Metadata has different deps than diagram
      const meta = {
        planId: "test-plan",
        tasks: [
          {
            id: "T001",
            title: "Design schema",
            status: "done",
            skill: "quick-dev",
            scope: "db/",
            acceptance: "Migration runs",
            verify: "npm run migrate",
          },
          {
            id: "T002",
            title: "Build API",
            status: "inProgress",
            skill: "tdd",
            scope: "src/api/",
            acceptance: "CRUD works",
            verify: "npm test",
            dependencies: ["T001"],
          },
          {
            id: "T003",
            title: "Write tests",
            status: "backlog",
            skill: "tdd",
            scope: "test/",
            acceptance: "Tests pass",
            verify: "npm test",
            dependencies: ["T002"],
          }, // changed from T001
          {
            id: "T004",
            title: "Build UI",
            status: "backlog",
            skill: "code-agent",
            scope: "src/ui/",
            acceptance: "UI renders",
            verify: "npm test",
            dependencies: ["T002"],
          },
          {
            id: "T005",
            title: "Deploy",
            status: "blocked",
            skill: "quick-dev",
            scope: "infra/",
            acceptance: "Deployed",
            verify: "npm run deploy",
            dependencies: ["T003", "T004"],
          },
        ],
      };
      const metaPath = writeMetadata(meta);
      const result = run("validate", diagramPath, "--metadata", metaPath);
      expect(result.status).not.toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.errors.some((e: string) => e.includes("Topology mismatch"))).toBe(true);
    });

    it("detects stale plan-level comments", () => {
      // Modify diagram to have wrong status comment but correct graph
      const stale = VALID_DIAGRAM.replace(
        "%% status: T001=done, T002=inProgress, T003=backlog, T004=backlog, T005=blocked",
        "%% status: T001=backlog, T002=inProgress, T003=backlog, T004=backlog, T005=blocked",
      );
      writeFileSync(diagramPath, stale);

      const meta = {
        planId: "test-plan",
        tasks: [
          {
            id: "T001",
            title: "Design schema",
            status: "done",
            skill: "quick-dev",
            scope: "db/",
            acceptance: "Migration runs",
            verify: "npm run migrate",
          },
          {
            id: "T002",
            title: "Build API",
            status: "inProgress",
            skill: "tdd",
            scope: "src/api/",
            acceptance: "CRUD works",
            verify: "npm test",
            dependencies: ["T001"],
          },
          {
            id: "T003",
            title: "Write tests",
            status: "backlog",
            skill: "tdd",
            scope: "test/",
            acceptance: "Tests pass",
            verify: "npm test",
            dependencies: ["T001"],
          },
          {
            id: "T004",
            title: "Build UI",
            status: "backlog",
            skill: "code-agent",
            scope: "src/ui/",
            acceptance: "UI renders",
            verify: "npm test",
            dependencies: ["T002"],
          },
          {
            id: "T005",
            title: "Deploy",
            status: "blocked",
            skill: "quick-dev",
            scope: "infra/",
            acceptance: "Deployed",
            verify: "npm run deploy",
            dependencies: ["T003", "T004"],
          },
        ],
      };
      const metaPath = writeMetadata(meta);
      const result = run("validate", diagramPath, "--metadata", metaPath);
      expect(result.status).not.toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.errors.some((e: string) => e.includes("Stale plan-level comments"))).toBe(true);
    });

    it("detects incomplete metadata in node blocks", () => {
      // Remove acceptance from T001 metadata block in the diagram (acceptance is required)
      const incomplete = VALID_DIAGRAM.replace("%% acceptance: Migration runs\n", "");
      writeFileSync(diagramPath, incomplete);

      const meta = {
        planId: "test-plan",
        tasks: [
          {
            id: "T001",
            title: "Design schema",
            status: "done",
            skill: "quick-dev",
            scope: "db/",
            acceptance: "Migration runs",
            verify: "npm run migrate",
          },
          {
            id: "T002",
            title: "Build API",
            status: "inProgress",
            skill: "tdd",
            scope: "src/api/",
            acceptance: "CRUD works",
            verify: "npm test",
            dependencies: ["T001"],
          },
          {
            id: "T003",
            title: "Write tests",
            status: "backlog",
            skill: "tdd",
            scope: "test/",
            acceptance: "Tests pass",
            verify: "npm test",
            dependencies: ["T001"],
          },
          {
            id: "T004",
            title: "Build UI",
            status: "backlog",
            skill: "code-agent",
            scope: "src/ui/",
            acceptance: "UI renders",
            verify: "npm test",
            dependencies: ["T002"],
          },
          {
            id: "T005",
            title: "Deploy",
            status: "blocked",
            skill: "quick-dev",
            scope: "infra/",
            acceptance: "Deployed",
            verify: "npm run deploy",
            dependencies: ["T003", "T004"],
          },
        ],
      };
      const metaPath = writeMetadata(meta);
      const result = run("validate", diagramPath, "--metadata", metaPath);
      expect(result.status).not.toBe(0);
      const output = JSON.parse(result.stdout);
      expect(
        output.errors.some((e: string) => e.includes("Incomplete metadata") && e.includes("T001")),
      ).toBe(true);
    });
  });

  describe("sort-metadata", () => {
    it("orders metadata blocks deterministically by node ID", () => {
      // Write with T003 before T002
      const disordered = VALID_DIAGRAM.replace(
        `%% node: T002
%% title: Build API
%% status: inProgress
%% skill: tdd
%% scope: src/api/
%% acceptance: CRUD works
%% verify: npm test

%% node: T003
%% title: Write tests
%% status: backlog
%% skill: tdd
%% scope: test/
%% acceptance: Tests pass
%% verify: npm test
%% blocked-by: T001`,
        `%% node: T003
%% title: Write tests
%% status: backlog
%% skill: tdd
%% scope: test/
%% acceptance: Tests pass
%% verify: npm test
%% blocked-by: T001

%% node: T002
%% title: Build API
%% status: inProgress
%% skill: tdd
%% scope: src/api/
%% acceptance: CRUD works
%% verify: npm test`,
      );
      writeFileSync(diagramPath, disordered);

      const result = run("sort-metadata", diagramPath);
      expect(result.status).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.sorted).toBe(true);
      expect(output.order).toEqual(["T001", "T002", "T003", "T004", "T005"]);

      // Verify the file now has T002 before T003
      const content = readFileSync(diagramPath, "utf-8");
      const t002Idx = content.indexOf("%% node: T002");
      const t003Idx = content.indexOf("%% node: T003");
      expect(t002Idx).toBeLessThan(t003Idx);
    });
  });

  // Regression coverage for a real defect: a node whose title contains ']'
  // (e.g. "workspacePaths[0]") is emitted as a QUOTED label,
  //   T002["...workspacePaths[0]"]:::backlog,
  // and the old `[^\]]+` label group truncated at the first ']'. That broke
  // `status` ("no :::class suffix") and desynced labels of later nodes.
  describe("quoted labels with embedded metacharacters", () => {
    const BRACKETED_DIAGRAM = `%% plan: bracket-plan
%% status: T001=done, T002=backlog, T003=backlog
%% ready: T002, T003
%% next-action: Start T002

%% node: T001
%% title: First
%% status: done
%% skill: s
%% scope: a/
%% acceptance: A
%% verify: t

%% node: T002
%% title: Resolve code capture relative to the working tree, not workspacePaths[0]
%% status: backlog
%% skill: s
%% scope: b/
%% acceptance: B
%% verify: t

%% node: T003
%% title: Declared after the bracketed label
%% status: backlog
%% skill: s
%% scope: c/
%% acceptance: C
%% verify: t

flowchart TD
    classDef done fill:#22c55e,color:#fff
    classDef inProgress fill:#f59e0b,color:#fff
    classDef blocked fill:#ef4444,color:#fff
    classDef backlog fill:#94a3b8,color:#fff

    T001["First"]:::done
    T002["Resolve code capture relative to the working tree, not workspacePaths[0]"]:::backlog
    T003["Declared after the bracketed label"]:::backlog
    T001 --> T002
`;

    it("parses the full bracketed label and the correct status", () => {
      writeFileSync(diagramPath, BRACKETED_DIAGRAM);

      const result = run("inspect", diagramPath);
      expect(result.status).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.nodes).toEqual([
        { id: "T001", label: '"First"', status: "done" },
        {
          id: "T002",
          label: '"Resolve code capture relative to the working tree, not workspacePaths[0]"',
          status: "backlog",
        },
        { id: "T003", label: '"Declared after the bracketed label"', status: "backlog" },
      ]);

      // Real edges still parse; the '[' inside T002's label creates none.
      expect(output.edges).toEqual([{ from: "T001", to: "T002" }]);
    });

    it("updates a bracketed-label node without touching other nodes", () => {
      writeFileSync(diagramPath, BRACKETED_DIAGRAM);

      const result = run("status", diagramPath, "T002", "done");
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).updated).toBe(true);

      const updated = readFileSync(diagramPath, "utf-8");
      expect(updated).toContain(
        'T002["Resolve code capture relative to the working tree, not workspacePaths[0]"]:::done',
      );
      expect(updated).not.toContain('workspacePaths[0]"]:::backlog');
      // Nodes before and after are untouched.
      expect(updated).toContain('T001["First"]:::done');
      expect(updated).toContain('T003["Declared after the bracketed label"]:::backlog');
    });

    it("validates a diagram with a bracketed label", () => {
      writeFileSync(diagramPath, BRACKETED_DIAGRAM);

      const result = run("validate", diagramPath);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ ok: true, errors: [] });
    });

    const TRICKY_DIAGRAM = `%% plan: tricky-plan
%% status: T001=backlog, T002=backlog, T003=backlog, T004=backlog
%% ready: T001, T002, T003, T004
%% next-action: Start T001

%% node: T001
%% title: has [a] bracket
%% status: backlog
%% skill: s
%% scope: a/
%% acceptance: A
%% verify: t

%% node: T002
%% title: has "quoted" word
%% status: backlog
%% skill: s
%% scope: b/
%% acceptance: B
%% verify: t

%% node: T003
%% title: has :::done inside
%% status: backlog
%% skill: s
%% scope: c/
%% acceptance: C
%% verify: t

%% node: T004
%% title: has --> arrow
%% status: backlog
%% skill: s
%% scope: d/
%% acceptance: D
%% verify: t

flowchart TD
    classDef backlog fill:#94a3b8,color:#fff

    T001["has [a] bracket"]:::backlog
    T002["has \\"quoted\\" word"]:::backlog
    T003["has :::done inside"]:::backlog
    T004["has --> arrow"]:::backlog
`;

    it("round-trips labels with brackets, quotes, :::text, and arrows", () => {
      writeFileSync(diagramPath, TRICKY_DIAGRAM);

      const inspected = JSON.parse(run("inspect", diagramPath).stdout);
      expect(inspected.nodes).toEqual([
        { id: "T001", label: '"has [a] bracket"', status: "backlog" },
        { id: "T002", label: '"has \\"quoted\\" word"', status: "backlog" },
        { id: "T003", label: '"has :::done inside"', status: "backlog" },
        { id: "T004", label: '"has --> arrow"', status: "backlog" },
      ]);
      // A '-->' inside a label must never be parsed as an edge.
      expect(inspected.edges).toEqual([]);

      for (const id of ["T001", "T002", "T003", "T004"]) {
        const result = run("status", diagramPath, id, "done");
        expect(result.status).toBe(0);
      }

      const updated = readFileSync(diagramPath, "utf-8");
      expect(updated).toContain('T001["has [a] bracket"]:::done');
      expect(updated).toContain('T002["has \\"quoted\\" word"]:::done');
      expect(updated).toContain('T003["has :::done inside"]:::done');
      expect(updated).toContain('T004["has --> arrow"]:::done');
      // Still no spurious edges after the updates.
      expect(JSON.parse(run("inspect", diagramPath).stdout).edges).toEqual([]);
    });

    it("regression: status update on a generated label containing [0] (real repro)", () => {
      const generated = generateDiagramFromTasks("repro-plan", [
        {
          id: "a-task",
          normalizedId: "a-task",
          title: "First task",
          status: "done",
          priority: "medium",
          scope: "src/",
          acceptance: "A",
          createdAt: "2026-08-12T00:00:00.000Z",
          updatedAt: "2026-08-12T00:00:00.000Z",
        },
        {
          id: "b-capture",
          normalizedId: "b-capture",
          title: "Resolve --code capture relative to the working tree, not workspacePaths[0]",
          status: "backlog",
          priority: "medium",
          scope: "src/",
          acceptance: "B",
          createdAt: "2026-08-12T00:00:00.000Z",
          updatedAt: "2026-08-12T00:00:00.000Z",
        },
        {
          id: "c-after",
          normalizedId: "c-after",
          title: "A task declared after the bracketed label",
          status: "backlog",
          priority: "medium",
          scope: "src/",
          acceptance: "C",
          createdAt: "2026-08-12T00:00:00.000Z",
          updatedAt: "2026-08-12T00:00:00.000Z",
        },
      ]);
      writeFileSync(diagramPath, generated.mmd);

      expect(generated.mmd).toContain(
        'T002["Resolve --code capture relative to the working tree, not workspacePaths[0]"]:::backlog',
      );

      const result = run("status", diagramPath, "T002", "done");
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        updated: true,
        nodeId: "T002",
        status: "done",
        ready: ["T003"],
      });

      const updated = readFileSync(diagramPath, "utf-8");
      expect(updated).toContain(
        'T002["Resolve --code capture relative to the working tree, not workspacePaths[0]"]:::done',
      );
      // The node declared after the bracketed label is not desynced.
      expect(updated).toContain('T003["A task declared after the bracketed label"]:::backlog');
    });

    it("bare (legacy) labels still parse and update", () => {
      writeFileSync(diagramPath, VALID_DIAGRAM);

      const inspected = JSON.parse(run("inspect", diagramPath).stdout);
      expect(inspected.nodes[0]).toEqual({ id: "T001", label: "Design schema", status: "done" });

      const result = run("status", diagramPath, "T003", "done");
      expect(result.status).toBe(0);
      const updated = readFileSync(diagramPath, "utf-8");
      expect(updated).toContain("T003[Write tests]:::done");
    });
  });
});
