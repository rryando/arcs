import { describe, expect, it } from "vitest";
import {
  chooseCurrentFocus,
  deriveOperatingBrief,
  recommendSurface,
  type StructuredPlan,
  type StructuredTask,
} from "../src/utils/workflow-policy.js";

describe("workflow policy", () => {
  it("recommends queue for a small standalone action", () => {
    expect(
      recommendSurface({
        hasPlanSignals: false,
        hasDurableKnowledgeSignal: false,
        itemLabel: "Rename one function across two files",
      }),
    ).toEqual({
      surface: "queue",
      why: expect.stringMatching(/execution state|small standalone/i),
    });
  });

  it("recommends plan for multi-step coordinated work", () => {
    expect(
      recommendSurface({
        hasPlanSignals: true,
        hasDurableKnowledgeSignal: false,
        itemLabel: "Add operating brief across prompts and context resolution",
      }).surface,
    ).toBe("plan");
  });

  it("recommends memory for durable discoveries", () => {
    expect(
      recommendSurface({
        hasPlanSignals: false,
        hasDurableKnowledgeSignal: true,
        itemLabel: "Document focus-selection gotcha",
      }).surface,
    ).toBe("memory");
  });

  it("prefers memory when both plan and durable knowledge signals are present", () => {
    expect(
      recommendSurface({
        hasPlanSignals: true,
        hasDurableKnowledgeSignal: true,
        itemLabel: "Auth System",
      }).surface,
    ).toBe("memory");
  });

  it("prefers the most recently updated in-progress plan over tasks", () => {
    expect(
      chooseCurrentFocus({
        plans: [
          {
            title: "Older plan",
            status: "in_progress",
            updatedAt: "2026-03-17T00:00:00.000Z",
          },
          {
            title: "Newer plan",
            status: "in_progress",
            updatedAt: "2026-03-18T00:00:00.000Z",
          },
        ],
        inProgressTasks: ["- [/] Update docs"],
        backlogTasks: ["- [ ] First backlog item"],
      }),
    ).toEqual({
      kind: "plan",
      label: "Newer plan",
    });
  });

  it("preserves stable plan order when recency cannot be determined", () => {
    expect(
      chooseCurrentFocus({
        plans: [
          {
            title: "First plan",
            status: "in_progress",
            updatedAt: "not-a-date",
          },
          {
            title: "Second plan",
            status: "in_progress",
          },
        ],
        inProgressTasks: ["- [/] Update docs"],
        backlogTasks: ["- [ ] First backlog item"],
      }),
    ).toEqual({
      kind: "plan",
      label: "First plan",
    });
  });

  it("falls back to first in-progress task when no in-progress plan exists", () => {
    expect(
      chooseCurrentFocus({
        plans: [],
        inProgressTasks: ["- [/] First task", "- [/] Second task"],
        backlogTasks: ["- [ ] Backlog item"],
      }),
    ).toEqual({
      kind: "task",
      label: "First task",
    });
  });

  it("falls back to first backlog item when nothing is in progress", () => {
    expect(
      chooseCurrentFocus({
        plans: [],
        inProgressTasks: [],
        backlogTasks: ["- [ ] First backlog item", "- [ ] Second backlog item"],
      }),
    ).toEqual({
      kind: "task",
      label: "First backlog item",
    });
  });
});

describe("deriveOperatingBrief (structured)", () => {
  it("returns QUEUE when a task is in_progress", () => {
    const tasks: StructuredTask[] = [
      { id: "T001", title: "Fix the bug", status: "in_progress", priority: "high" },
      { id: "T002", title: "Write docs", status: "backlog", priority: "low" },
    ];
    const plans: StructuredPlan[] = [];
    const brief = deriveOperatingBrief({ tasks, plans });
    expect(brief).toEqual({
      currentFocus: "Fix the bug",
      recommendedSurface: "QUEUE",
      why: "Task in progress: Fix the bug",
      nextAction: "Continue task T001",
    });
  });

  it("returns QUEUE when plan is in_progress with backlog task", () => {
    const tasks: StructuredTask[] = [
      { id: "T010", title: "Implement API", status: "backlog", planId: "P001", priority: "medium" },
    ];
    const plans: StructuredPlan[] = [{ id: "P001", title: "API Redesign", status: "in_progress" }];
    const brief = deriveOperatingBrief({ tasks, plans });
    expect(brief).toEqual({
      currentFocus: "API Redesign",
      recommendedSurface: "QUEUE",
      why: "Plan API Redesign has ready tasks",
      nextAction: "Start task T010",
    });
  });

  it("returns PLAN when a plan is proposed or planned", () => {
    const tasks: StructuredTask[] = [];
    const plans: StructuredPlan[] = [{ id: "P002", title: "New Feature", status: "proposed" }];
    const brief = deriveOperatingBrief({ tasks, plans });
    expect(brief).toEqual({
      currentFocus: "New Feature",
      recommendedSurface: "PLAN",
      why: expect.stringContaining("New Feature"),
      nextAction: "Advance plan P002",
    });
  });

  it("returns QUEUE for backlog tasks when no in-progress plan exists", () => {
    const tasks: StructuredTask[] = [
      { id: "T020", title: "Low pri", status: "backlog", priority: "low" },
      { id: "T021", title: "High pri", status: "backlog", priority: "high" },
    ];
    const plans: StructuredPlan[] = [{ id: "P003", title: "Done Plan", status: "done" }];
    const brief = deriveOperatingBrief({ tasks, plans });
    expect(brief).toEqual({
      currentFocus: "High pri",
      recommendedSurface: "QUEUE",
      why: "Backlog task ready: High pri",
      nextAction: "Start task T021",
    });
  });

  it("returns MEMORY when all work is complete", () => {
    const tasks: StructuredTask[] = [{ id: "T030", title: "Done task", status: "done" }];
    const plans: StructuredPlan[] = [{ id: "P004", title: "Archived Plan", status: "archived" }];
    const brief = deriveOperatingBrief({ tasks, plans });
    expect(brief).toEqual({
      currentFocus: "No active work",
      recommendedSurface: "MEMORY",
      why: "All plans/tasks complete",
      nextAction: "Review knowledge or start a new plan",
    });
  });

  it("returns MEMORY when tasks and plans are empty", () => {
    const brief = deriveOperatingBrief({ tasks: [], plans: [] });
    expect(brief).toEqual({
      currentFocus: "No active work",
      recommendedSurface: "MEMORY",
      why: "All plans/tasks complete",
      nextAction: "Review knowledge or start a new plan",
    });
  });

  it("in_progress task takes priority over in_progress plan with backlog task", () => {
    const tasks: StructuredTask[] = [
      { id: "T040", title: "Active task", status: "in_progress" },
      { id: "T041", title: "Ready task", status: "backlog", planId: "P005" },
    ];
    const plans: StructuredPlan[] = [{ id: "P005", title: "Active Plan", status: "in_progress" }];
    const brief = deriveOperatingBrief({ tasks, plans });
    expect(brief.recommendedSurface).toBe("QUEUE");
    expect(brief.nextAction).toBe("Continue task T040");
  });

  it("skips blocked task in in_progress plan — only picks ready task", () => {
    const tasks: StructuredTask[] = [
      { id: "T050", title: "Blocked task", status: "backlog", planId: "P006", dependsOn: ["T051"] },
      { id: "T051", title: "Prereq task", status: "backlog", planId: "P006" },
    ];
    const plans: StructuredPlan[] = [{ id: "P006", title: "Blocked Plan", status: "in_progress" }];
    const brief = deriveOperatingBrief({ tasks, plans });
    // T050 is blocked; T051 has no deps so it's ready
    expect(brief.recommendedSurface).toBe("QUEUE");
    expect(brief.nextAction).toBe("Start task T051");
  });

  it("reports all-blocked state when every backlog task has unmet deps", () => {
    const tasks: StructuredTask[] = [
      { id: "T060", title: "Blocked A", status: "backlog", dependsOn: ["T061"] },
      { id: "T061", title: "Blocked B", status: "backlog", dependsOn: ["T060"] },
    ];
    const plans: StructuredPlan[] = [];
    const brief = deriveOperatingBrief({ tasks, plans });
    expect(brief.recommendedSurface).toBe("PLAN");
    expect(brief.why).toMatch(/blocked by incomplete dependencies/i);
  });

  it("treats tasks without dependsOn as always ready (backward compat)", () => {
    const tasks: StructuredTask[] = [
      { id: "T070", title: "No deps task", status: "backlog", priority: "high" },
    ];
    const plans: StructuredPlan[] = [];
    const brief = deriveOperatingBrief({ tasks, plans });
    expect(brief.recommendedSurface).toBe("QUEUE");
    expect(brief.nextAction).toBe("Start task T070");
  });

  it("skips blocked backlog task and selects the ready one", () => {
    const tasks: StructuredTask[] = [
      {
        id: "T080",
        title: "Blocked high pri",
        status: "backlog",
        priority: "high",
        dependsOn: ["T082"],
      },
      { id: "T081", title: "Ready low pri", status: "backlog", priority: "low" },
    ];
    const plans: StructuredPlan[] = [];
    const brief = deriveOperatingBrief({ tasks, plans });
    expect(brief.recommendedSurface).toBe("QUEUE");
    expect(brief.nextAction).toBe("Start task T081");
  });
});
