// ---------------------------------------------------------------------------
// Tests for session-store — CRUD, upsert idempotency, filters, validation
// ---------------------------------------------------------------------------

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPlan } from "../src/utils/plan-store.js";
import {
  createSession,
  deleteSession,
  drainSessionMessageQueue,
  enqueueSessionMessage,
  getSession,
  listSessions,
  readSessionIndex,
  updateSession,
  upsertSession,
} from "../src/utils/session-store.js";
import { createTask } from "../src/utils/task-store.js";
import { classifyChange } from "../src/web-server/watcher.js";

const tempDirs: string[] = [];

function makeProjectDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "arcs-session-store-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("session-store: create", () => {
  it("creates an opencode session with defaults", async () => {
    const dir = makeProjectDir();
    const session = await createSession(dir, {
      runtimeType: "opencode",
      runtimeSessionId: "ses_044c13d2dffeggKIOZf9LscKxX",
    });

    expect(session.runtimeSessionId).toBe("ses_044c13d2dffeggKIOZf9LscKxX");
    expect(session.normalizedId).toBe("ses-044c13d2dffeggkiozf9lsckxx");
    expect(session.id).toBe(session.normalizedId);
    expect(session.status).toBe("active");
    expect(session.startedAt).toBe(session.updatedAt);
    expect(session.lastMessageAt).toBeUndefined();
  });

  it("writes a flat sessions/index.json", async () => {
    const dir = makeProjectDir();
    await createSession(dir, { runtimeType: "opencode", runtimeSessionId: "ses_one" });

    const raw = readFileSync(resolve(dir, "sessions", "index.json"), "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw).sessions).toHaveLength(1);
  });

  it("rejects a duplicate runtime session id", async () => {
    const dir = makeProjectDir();
    await createSession(dir, { runtimeType: "opencode", runtimeSessionId: "ses_one" });
    await expect(
      createSession(dir, { runtimeType: "opencode", runtimeSessionId: "ses_one" }),
    ).rejects.toThrow("already exists");
  });

  it("rejects an unknown runtime type", async () => {
    const dir = makeProjectDir();
    await expect(
      createSession(dir, {
        runtimeType: "cursor" as never,
        runtimeSessionId: "ses_one",
      }),
    ).rejects.toThrow("Invalid session runtime type");
  });

  it("rejects an unknown status", async () => {
    const dir = makeProjectDir();
    await expect(
      createSession(dir, {
        runtimeType: "opencode",
        runtimeSessionId: "ses_one",
        status: "zombie" as never,
      }),
    ).rejects.toThrow("Invalid session status");
  });

  it("rejects a runtime session id that normalizes to nothing", async () => {
    const dir = makeProjectDir();
    await expect(
      createSession(dir, { runtimeType: "opencode", runtimeSessionId: "___" }),
    ).rejects.toThrow("Invalid runtime session id");
  });
});

describe("session-store: read", () => {
  it("returns an empty index for a project with no sessions dir", async () => {
    const dir = makeProjectDir();
    expect(await readSessionIndex(dir)).toEqual({ sessions: [] });
    expect(await listSessions(dir)).toEqual([]);
  });

  it("gets a session by raw runtime id or normalized id", async () => {
    const dir = makeProjectDir();
    const created = await createSession(dir, {
      runtimeType: "opencode",
      runtimeSessionId: "ses_ABC",
    });

    expect((await getSession(dir, "ses_ABC")).id).toBe(created.id);
    expect((await getSession(dir, created.normalizedId)).id).toBe(created.id);
  });

  it("throws when the session is missing", async () => {
    const dir = makeProjectDir();
    await expect(getSession(dir, "ses_missing")).rejects.toThrow("Could not find session");
  });

  it("filters by status and runtime type", async () => {
    const dir = makeProjectDir();
    await createSession(dir, { runtimeType: "opencode", runtimeSessionId: "ses_a" });
    await createSession(dir, {
      runtimeType: "opencode",
      runtimeSessionId: "ses_b",
      status: "idle",
    });
    await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "cc_c",
      status: "idle",
    });

    expect(await listSessions(dir, { status: "idle" })).toHaveLength(2);
    expect(await listSessions(dir, { runtimeType: "opencode" })).toHaveLength(2);
    expect(await listSessions(dir, { status: "idle", runtimeType: "claude-code" })).toHaveLength(1);
  });
});

describe("session-store: upsert", () => {
  it("creates on first sight and updates in place afterwards", async () => {
    const dir = makeProjectDir();
    const first = await upsertSession(dir, {
      runtimeType: "opencode",
      runtimeSessionId: "ses_one",
      startedAt: "2026-01-01T00:00:00.000Z",
      metadata: { title: "first" },
    });
    const second = await upsertSession(dir, {
      runtimeType: "opencode",
      runtimeSessionId: "ses_one",
      status: "idle",
      metadata: { directory: "/repo" },
    });

    expect(second.normalizedId).toBe(first.normalizedId);
    expect(second.status).toBe("idle");
    expect(second.startedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(second.metadata).toEqual({ title: "first", directory: "/repo" });
    expect((await readSessionIndex(dir)).sessions).toHaveLength(1);
  });

  it("keeps the existing status when the upsert omits one", async () => {
    const dir = makeProjectDir();
    await upsertSession(dir, {
      runtimeType: "opencode",
      runtimeSessionId: "ses_one",
      status: "failed",
    });
    const updated = await upsertSession(dir, {
      runtimeType: "opencode",
      runtimeSessionId: "ses_one",
      lastMessageAt: "2026-01-02T00:00:00.000Z",
    });

    expect(updated.status).toBe("failed");
    expect(updated.lastMessageAt).toBe("2026-01-02T00:00:00.000Z");
  });
});

describe("session-store: update and delete", () => {
  it("updates status and merges metadata", async () => {
    const dir = makeProjectDir();
    const created = await createSession(dir, {
      runtimeType: "opencode",
      runtimeSessionId: "ses_one",
      metadata: { title: "probe" },
    });

    const updated = await updateSession(dir, {
      id: created.normalizedId,
      status: "disconnected",
      metadata: { directory: "/repo" },
      now: "2026-02-01T00:00:00.000Z",
    });

    expect(updated.status).toBe("disconnected");
    expect(updated.metadata).toEqual({ title: "probe", directory: "/repo" });
    expect(updated.updatedAt).toBe("2026-02-01T00:00:00.000Z");
  });

  it("clears nullable fields", async () => {
    const dir = makeProjectDir();
    const created = await createSession(dir, {
      runtimeType: "opencode",
      runtimeSessionId: "ses_one",
      lastMessageAt: "2026-01-01T00:00:00.000Z",
      userEmail: "dev@example.com",
      metadata: { title: "probe" },
    });

    const updated = await updateSession(dir, {
      id: created.normalizedId,
      lastMessageAt: null,
      userEmail: null,
      metadata: null,
    });

    expect(updated.lastMessageAt).toBeUndefined();
    expect(updated.userEmail).toBeUndefined();
    expect(updated.metadata).toBeUndefined();
  });

  it("rejects an unknown status on update", async () => {
    const dir = makeProjectDir();
    const created = await createSession(dir, {
      runtimeType: "opencode",
      runtimeSessionId: "ses_one",
    });
    await expect(
      updateSession(dir, { id: created.normalizedId, status: "zombie" as never }),
    ).rejects.toThrow("Invalid session status");
  });

  it("throws when updating a missing session", async () => {
    const dir = makeProjectDir();
    await expect(updateSession(dir, { id: "ses_missing", status: "idle" })).rejects.toThrow(
      "Could not find session",
    );
  });

  it("deletes a session and leaves the rest intact", async () => {
    const dir = makeProjectDir();
    await createSession(dir, { runtimeType: "opencode", runtimeSessionId: "ses_a" });
    const b = await createSession(dir, { runtimeType: "opencode", runtimeSessionId: "ses_b" });

    await deleteSession(dir, b.normalizedId);

    const remaining = await listSessions(dir);
    expect(remaining.map((s) => s.runtimeSessionId)).toEqual(["ses_a"]);
    await expect(deleteSession(dir, b.normalizedId)).rejects.toThrow("Could not find session");
  });
});

describe("session-store: dag linkage", () => {
  it("links a session to an existing task and stores the normalized id", async () => {
    const dir = makeProjectDir();
    const task = await createTask(dir, { title: "Wire the bridge" });
    const created = await createSession(dir, {
      runtimeType: "opencode",
      runtimeSessionId: "ses_one",
    });

    const linked = await updateSession(dir, {
      id: created.normalizedId,
      linkedNodeType: "task",
      linkedNodeId: task.normalizedId,
    });

    expect(linked.linkedNodeType).toBe("task");
    expect(linked.linkedNodeId).toBe(task.normalizedId);
  });

  it("links a session to an existing plan", async () => {
    const dir = makeProjectDir();
    const plan = await createPlan(dir, {
      id: "session-bridge",
      title: "Session Bridge",
      status: "planned",
      keywords: ["sessions"],
    });
    const created = await createSession(dir, {
      runtimeType: "opencode",
      runtimeSessionId: "ses_one",
    });

    const linked = await updateSession(dir, {
      id: created.normalizedId,
      linkedNodeType: "plan",
      linkedNodeId: plan.normalizedId,
    });

    expect(linked.linkedNodeType).toBe("plan");
    expect(linked.linkedNodeId).toBe(plan.normalizedId);
  });

  it("rejects linking to a task id that does not exist", async () => {
    const dir = makeProjectDir();
    const created = await createSession(dir, {
      runtimeType: "opencode",
      runtimeSessionId: "ses_one",
    });

    await expect(
      updateSession(dir, {
        id: created.normalizedId,
        linkedNodeType: "task",
        linkedNodeId: "no-such-task",
      }),
    ).rejects.toThrow('Could not find task "no-such-task"');
    expect((await getSession(dir, created.normalizedId)).linkedNodeId).toBeUndefined();
  });

  it("rejects linking to a plan id that does not exist", async () => {
    const dir = makeProjectDir();
    const created = await createSession(dir, {
      runtimeType: "opencode",
      runtimeSessionId: "ses_one",
    });

    await expect(
      updateSession(dir, {
        id: created.normalizedId,
        linkedNodeType: "plan",
        linkedNodeId: "no-such-plan",
      }),
    ).rejects.toThrow('Could not find plan "no-such-plan"');
  });

  it("rejects an unknown linked node type", async () => {
    const dir = makeProjectDir();
    const created = await createSession(dir, {
      runtimeType: "opencode",
      runtimeSessionId: "ses_one",
    });

    await expect(
      updateSession(dir, {
        id: created.normalizedId,
        linkedNodeType: "knowledge" as never,
        linkedNodeId: "whatever",
      }),
    ).rejects.toThrow("Invalid session link");
  });

  it("rejects a half link when nothing is linked yet", async () => {
    const dir = makeProjectDir();
    const created = await createSession(dir, {
      runtimeType: "opencode",
      runtimeSessionId: "ses_one",
    });

    await expect(
      updateSession(dir, { id: created.normalizedId, linkedNodeType: "task" }),
    ).rejects.toThrow("must be set together");
    await expect(
      updateSession(dir, { id: created.normalizedId, linkedNodeId: "some-task" }),
    ).rejects.toThrow("must be set together");
  });

  it("retargets an existing link when only the id changes", async () => {
    const dir = makeProjectDir();
    const first = await createTask(dir, { title: "First" });
    const second = await createTask(dir, { title: "Second" });
    const created = await createSession(dir, {
      runtimeType: "opencode",
      runtimeSessionId: "ses_one",
    });

    await updateSession(dir, {
      id: created.normalizedId,
      linkedNodeType: "task",
      linkedNodeId: first.normalizedId,
    });
    const retargeted = await updateSession(dir, {
      id: created.normalizedId,
      linkedNodeId: second.normalizedId,
    });

    expect(retargeted.linkedNodeType).toBe("task");
    expect(retargeted.linkedNodeId).toBe(second.normalizedId);
  });

  it("clears both linkage fields together when either is nulled", async () => {
    const dir = makeProjectDir();
    const task = await createTask(dir, { title: "Wire the bridge" });
    const created = await createSession(dir, {
      runtimeType: "opencode",
      runtimeSessionId: "ses_one",
    });
    await updateSession(dir, {
      id: created.normalizedId,
      linkedNodeType: "task",
      linkedNodeId: task.normalizedId,
    });

    const unlinked = await updateSession(dir, { id: created.normalizedId, linkedNodeId: null });
    expect(unlinked.linkedNodeType).toBeUndefined();
    expect(unlinked.linkedNodeId).toBeUndefined();

    await updateSession(dir, {
      id: created.normalizedId,
      linkedNodeType: "task",
      linkedNodeId: task.normalizedId,
    });
    const unlinkedByType = await updateSession(dir, {
      id: created.normalizedId,
      linkedNodeType: null,
    });
    expect(unlinkedByType.linkedNodeType).toBeUndefined();
    expect(unlinkedByType.linkedNodeId).toBeUndefined();
  });

  it("never lets a discovery upsert clobber a human-made link", async () => {
    const dir = makeProjectDir();
    const task = await createTask(dir, { title: "Wire the bridge" });
    const created = await upsertSession(dir, {
      runtimeType: "opencode",
      runtimeSessionId: "ses_one",
    });
    await updateSession(dir, {
      id: created.normalizedId,
      linkedNodeType: "task",
      linkedNodeId: task.normalizedId,
    });

    const refreshed = await upsertSession(dir, {
      runtimeType: "opencode",
      runtimeSessionId: "ses_one",
      status: "idle",
      metadata: { directory: "/repo" },
    });

    expect(refreshed.linkedNodeType).toBe("task");
    expect(refreshed.linkedNodeId).toBe(task.normalizedId);
    expect(refreshed.status).toBe("idle");
  });
});

describe("session-store: message queue", () => {
  it("appends messages in order and starts from no queue at all", async () => {
    const dir = makeProjectDir();
    const created = await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "cc_one",
    });
    expect(created.messageQueue).toBeUndefined();

    await enqueueSessionMessage(dir, created.normalizedId, "first");
    const queued = await enqueueSessionMessage(dir, created.normalizedId, "second");

    expect(queued.messageQueue).toEqual(["first", "second"]);
    expect((await getSession(dir, created.normalizedId)).messageQueue).toEqual(["first", "second"]);
  });

  it("keeps every message when senders enqueue concurrently", async () => {
    const dir = makeProjectDir();
    const created = await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "cc_race",
    });

    const messages = ["a", "b", "c", "d", "e"];
    await Promise.all(messages.map((m) => enqueueSessionMessage(dir, created.normalizedId, m)));

    const stored = await getSession(dir, created.normalizedId);
    expect(stored.messageQueue?.slice().sort()).toEqual(messages);
  });

  it("drains the queue and clears it in one shot", async () => {
    const dir = makeProjectDir();
    const created = await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "cc_drain",
    });
    await enqueueSessionMessage(dir, created.normalizedId, "one");
    await enqueueSessionMessage(dir, created.normalizedId, "two");

    expect(await drainSessionMessageQueue(dir, created.normalizedId)).toEqual(["one", "two"]);

    const drained = await getSession(dir, created.normalizedId);
    expect(drained.messageQueue).toBeUndefined();
    expect(drained.lastMessageAt).toBeTruthy();
    // At-most-once: a second checkpoint must not replay the same batch.
    expect(await drainSessionMessageQueue(dir, created.normalizedId)).toEqual([]);
  });

  it("delivers each message to exactly one of two concurrent drains", async () => {
    const dir = makeProjectDir();
    const created = await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "cc_double_drain",
    });
    await enqueueSessionMessage(dir, created.normalizedId, "only-once");

    const [first, second] = await Promise.all([
      drainSessionMessageQueue(dir, created.normalizedId),
      drainSessionMessageQueue(dir, created.normalizedId),
    ]);

    expect([...first, ...second]).toEqual(["only-once"]);
  });

  it("leaves an idle session untouched when there is nothing queued", async () => {
    const dir = makeProjectDir();
    const created = await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "cc_idle",
    });

    expect(await drainSessionMessageQueue(dir, created.normalizedId)).toEqual([]);

    const stored = await getSession(dir, created.normalizedId);
    expect(stored.updatedAt).toBe(created.updatedAt);
    expect(stored.lastMessageAt).toBeUndefined();
  });

  it("replaces or clears the whole queue through updateSession", async () => {
    const dir = makeProjectDir();
    const created = await createSession(dir, {
      runtimeType: "claude-code",
      runtimeSessionId: "cc_replace",
    });
    await enqueueSessionMessage(dir, created.normalizedId, "stale");

    const replaced = await updateSession(dir, {
      id: created.normalizedId,
      messageQueue: ["fresh"],
    });
    expect(replaced.messageQueue).toEqual(["fresh"]);

    const cleared = await updateSession(dir, { id: created.normalizedId, messageQueue: null });
    expect(cleared.messageQueue).toBeUndefined();
  });

  it("rejects queue operations on a session that does not exist", async () => {
    const dir = makeProjectDir();
    await expect(enqueueSessionMessage(dir, "cc_missing", "hi")).rejects.toThrow("Could not find");
    await expect(drainSessionMessageQueue(dir, "cc_missing")).rejects.toThrow("Could not find");
  });
});

describe("session-store: watcher integration", () => {
  it("classifies session index writes as the sessions area", () => {
    expect(classifyChange("projects/demo/sessions/index.json")).toEqual({
      slug: "demo",
      area: "sessions",
    });
    expect(classifyChange("projects/demo/sessions")).toEqual({ slug: "demo", area: "sessions" });
  });
});
