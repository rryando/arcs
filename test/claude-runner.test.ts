/**
 * Unit tests for the headless `claude -p` runner (src/web-server/claude-runner.ts).
 *
 * Pure module tests — a fake spawnImpl stands in for node child_process, so no
 * real child is ever spawned. The fake records exact argv/env/stdio, lets tests
 * drive stdout/stderr/exit, and records kill signals for the timeout path.
 */

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginRun,
  endRun,
  isRunLive,
  runClaudeJob,
  type SpawnImpl,
  STDERR_CAP,
  STDOUT_CAP,
} from "../src/web-server/claude-runner.js";

/** Minimal child that mirrors the ChildProcess surface the runner touches. */
class FakeChild extends EventEmitter {
  pid: number | undefined;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed: NodeJS.Signals[] = [];

  constructor(pid?: number | undefined) {
    super();
    this.pid = pid;
  }

  kill(signal: NodeJS.Signals): boolean {
    this.killed.push(signal);
    return true;
  }

  /** Emits data then exit/close, mirroring real stream-drain ordering. */
  finish(
    code: number | null,
    signal: NodeJS.Signals | null,
    output: { stdout?: string; stderr?: string } = {},
  ): void {
    if (output.stdout) this.stdout.emit("data", output.stdout);
    if (output.stderr) this.stderr.emit("data", output.stderr);
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

interface FakeSpawnResult {
  spawnCalls: Array<{ command: string; args: string[]; options: SpawnOptions }>;
  children: FakeChild[];
  spawnImpl: SpawnImpl;
}

/** Records spawn args and returns FakeChildren; optionally simulates ENOENT. */
function fakeSpawn(errorCode?: string): FakeSpawnResult {
  const spawnCalls: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  const children: FakeChild[] = [];
  const spawnImpl: SpawnImpl = (command, args, options) => {
    spawnCalls.push({ command, args, options });
    const child = errorCode ? new FakeChild() : new FakeChild(4242);
    children.push(child);
    if (errorCode) {
      const err = new Error(`spawn ${command} failed`) as NodeJS.ErrnoException;
      err.code = errorCode;
      // Real spawn surfaces ENOENT asynchronously — after listeners attach.
      queueMicrotask(() => {
        child.emit("error", err);
        child.emit("close", null, null);
      });
    }
    return child as unknown as ChildProcess;
  };
  return { spawnCalls, children, spawnImpl };
}

const JSON_REPLY = JSON.stringify({ result: "hello from claude" });

afterEach(() => {
  vi.unstubAllEnvs();
  // Free any keys still held by a test that left a run in flight.
  if (isRunLive("w")) endRun("w");
  if (isRunLive("w1")) endRun("w1");
  if (isRunLive("w2")) endRun("w2");
  if (isRunLive("same")) endRun("same");
  if (isRunLive("k1")) endRun("k1");
  if (isRunLive("k2")) endRun("k2");
});

describe("runClaudeJob — spawn surface", () => {
  it("spawns the configured binary with exact argv, cwd and stdio", async () => {
    const { spawnCalls, children, spawnImpl } = fakeSpawn();
    const run = runClaudeJob(
      { argv: ["-p", "hello", "--output-format", "json"], cwd: "/tmp/ws", writeTargetKey: "w" },
      { spawnImpl },
    );
    children[0].finish(0, null, { stdout: JSON_REPLY });
    const record = await run;

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe("claude");
    expect(spawnCalls[0].args).toEqual(["-p", "hello", "--output-format", "json"]);
    expect(spawnCalls[0].options.cwd).toBe("/tmp/ws");
    expect(spawnCalls[0].options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(record.pid).toBe(children[0].pid);
  });

  it("honors a binary override", async () => {
    const { spawnCalls, children, spawnImpl } = fakeSpawn();
    const run = runClaudeJob(
      { argv: ["-p", "x"], writeTargetKey: "w" },
      { spawnImpl, binary: "claude-next" },
    );
    children[0].finish(0, null, { stdout: JSON_REPLY });
    await run;
    expect(spawnCalls[0].command).toBe("claude-next");
  });
});

describe("runClaudeJob — output caps", () => {
  it("caps stdout at 1MB keeping the tail", async () => {
    const { children, spawnImpl } = fakeSpawn();
    const run = runClaudeJob({ argv: ["-p", "x"], writeTargetKey: "w" }, { spawnImpl });
    const payload = `${"o".repeat(STDOUT_CAP + 4096)}TAIL`;
    children[0].finish(0, null, { stdout: payload });
    const record = await run;

    expect(record.outcome).toBe("success");
    expect(record.replyText).toHaveLength(STDOUT_CAP);
    expect(record.replyText?.endsWith("TAIL")).toBe(true);
  });

  it("caps stderr at 4KB keeping the tail for non-zero exits", async () => {
    const { children, spawnImpl } = fakeSpawn();
    const run = runClaudeJob({ argv: ["-p", "x"], writeTargetKey: "w" }, { spawnImpl });
    children[0].finish(1, null, { stderr: `${"e".repeat(STDERR_CAP + 1000)}END` });
    const record = await run;

    expect(record.outcome).toBe("error");
    expect(record.error).toHaveLength(STDERR_CAP);
    expect(record.error?.endsWith("END")).toBe(true);
  });
});

describe("runClaudeJob — timeout escalation", () => {
  it("SIGTERM then SIGKILL on a short injected timeout", async () => {
    const { children, spawnImpl } = fakeSpawn();
    const run = runClaudeJob(
      { argv: ["-p", "x"], writeTargetKey: "w", timeoutMs: 20 },
      { spawnImpl, killGraceMs: 15 },
    );

    await vi.waitFor(() => expect(children[0].killed).toContain("SIGTERM"));
    await vi.waitFor(() => expect(children[0].killed).toContain("SIGKILL"));
    expect(children[0].killed).toEqual(["SIGTERM", "SIGKILL"]);

    children[0].finish(null, "SIGKILL");
    const record = await run;
    expect(record.outcome).toBe("timeout");
    expect(record.error).toMatch(/timed out after 20ms/);
  });

  it("reads the timeout from ARCS_CLAUDE_RUN_TIMEOUT_MS when timeoutMs is absent", async () => {
    const { children, spawnImpl } = fakeSpawn();
    vi.stubEnv("ARCS_CLAUDE_RUN_TIMEOUT_MS", "20");
    const run = runClaudeJob(
      { argv: ["-p", "x"], writeTargetKey: "w" },
      { spawnImpl, killGraceMs: 10 },
    );

    await vi.waitFor(() => expect(children[0].killed).toContain("SIGKILL"));
    children[0].finish(null, "SIGKILL");
    const record = await run;
    expect(record.outcome).toBe("timeout");
  });
});

describe("runClaudeJob — json parsing and exit mapping", () => {
  it("maps exit 0 + valid json + no is_error to success with the result", async () => {
    const { children, spawnImpl } = fakeSpawn();
    const run = runClaudeJob({ argv: ["-p", "x"], writeTargetKey: "w" }, { spawnImpl });
    children[0].finish(0, null, {
      stdout: JSON.stringify({ is_error: false, result: "ok reply" }),
    });
    const record = await run;

    expect(record.outcome).toBe("success");
    expect(record.replyText).toBe("ok reply");
    expect(record.replyChars).toBe(8);
    expect(record.error).toBeUndefined();
  });

  it("maps exit 0 + is_error to error with the result as the message", async () => {
    const { children, spawnImpl } = fakeSpawn();
    const run = runClaudeJob({ argv: ["-p", "x"], writeTargetKey: "w" }, { spawnImpl });
    children[0].finish(0, null, {
      stdout: JSON.stringify({ is_error: true, result: "model refused" }),
    });
    const record = await run;

    expect(record.outcome).toBe("error");
    expect(record.error).toBe("model refused");
    expect(record.replyText).toBeUndefined();
  });

  it("falls back to trimmed raw stdout when exit 0 output is not json", async () => {
    const { children, spawnImpl } = fakeSpawn();
    const run = runClaudeJob({ argv: ["-p", "x"], writeTargetKey: "w" }, { spawnImpl });
    children[0].finish(0, null, { stdout: "  plain text reply  " });
    const record = await run;

    expect(record.outcome).toBe("success");
    expect(record.replyText).toBe("plain text reply");
  });

  it("maps non-zero exit to error using the stderr tail", async () => {
    const { children, spawnImpl } = fakeSpawn();
    const run = runClaudeJob({ argv: ["-p", "x"], writeTargetKey: "w" }, { spawnImpl });
    children[0].finish(2, null, { stderr: "claude blew up\n" });
    const record = await run;

    expect(record.outcome).toBe("error");
    expect(record.error).toBe("claude blew up");
  });

  it("falls back to the exit status when a non-zero exit has no stderr", async () => {
    const { children, spawnImpl } = fakeSpawn();
    const run = runClaudeJob({ argv: ["-p", "x"], writeTargetKey: "w" }, { spawnImpl });
    children[0].finish(1, null, {});
    const record = await run;

    expect(record.outcome).toBe("error");
    expect(record.error).toBe("claude exited with status 1");
  });

  it("maps spawn ENOENT to 'claude not found on PATH'", async () => {
    const { spawnImpl } = fakeSpawn("ENOENT");
    const record = await runClaudeJob({ argv: ["-p", "x"], writeTargetKey: "w" }, { spawnImpl });

    expect(record.outcome).toBe("error");
    expect(record.error).toBe("claude not found on PATH");
    expect(record.pid).toBeNull();
  });

  it("never throws — a signal-terminated child maps to an error record", async () => {
    const { children, spawnImpl } = fakeSpawn();
    const run = runClaudeJob({ argv: ["-p", "x"], writeTargetKey: "w" }, { spawnImpl });
    children[0].finish(null, "SIGKILL");
    const record = await run;

    expect(record.outcome).toBe("error");
    expect(record.error).toMatch(/terminated by signal SIGKILL/);
  });
});

describe("runClaudeJob — env scrub", () => {
  it("deletes ARCS_HOOK_* from the child env and inherits the rest", async () => {
    vi.stubEnv("ARCS_HOOK_TOKEN", "secret-token");
    vi.stubEnv("ARCS_HOOK_SLUG", "acme");
    vi.stubEnv("ARCS_HOOK_URL", "http://127.0.0.1:4173/hooks/acme");
    vi.stubEnv("ARCS_UNRELATED", "keep-me");

    const { spawnCalls, children, spawnImpl } = fakeSpawn();
    const run = runClaudeJob({ argv: ["-p", "x"], writeTargetKey: "w" }, { spawnImpl });
    children[0].finish(0, null, { stdout: JSON_REPLY });
    await run;

    const childEnv = spawnCalls[0].options.env;
    expect(childEnv?.ARCS_HOOK_TOKEN).toBeUndefined();
    expect(childEnv?.ARCS_HOOK_SLUG).toBeUndefined();
    expect(childEnv?.ARCS_HOOK_URL).toBeUndefined();
    expect(childEnv?.ARCS_UNRELATED).toBe("keep-me");
    expect(childEnv?.PATH).toBe(process.env.PATH);
    expect(childEnv?.HOME).toBe(process.env.HOME);
  });

  it("scrubs a custom base env exactly (only ARCS_HOOK_* dropped)", async () => {
    const { spawnCalls, children, spawnImpl } = fakeSpawn();
    const run = runClaudeJob(
      {
        argv: ["-p", "x"],
        writeTargetKey: "w",
        env: {
          PATH: "/bin",
          HOME: "/home/t",
          ARCS_HOOK_TOKEN: "t",
          ARCS_HOOK_SLUG: "s",
          ARCS_HOOK_URL: "u",
        },
      },
      { spawnImpl },
    );
    children[0].finish(0, null, { stdout: JSON_REPLY });
    await run;

    expect(spawnCalls[0].options.env).toEqual({ PATH: "/bin", HOME: "/home/t" });
  });
});

describe("runClaudeJob — onSettled write-back seam", () => {
  it("invokes the injected write-back after close with the settled run record", async () => {
    const { children, spawnImpl } = fakeSpawn();
    const onSettled = vi.fn();
    const run = runClaudeJob({ argv: ["-p", "x"], writeTargetKey: "w", onSettled }, { spawnImpl });
    // Not before the child exits — the seam fires only once the run settles.
    expect(onSettled).not.toHaveBeenCalled();

    children[0].finish(0, null, { stdout: JSON.stringify({ result: "hi" }) });
    const record = await run;

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(record);
    expect(record.outcome).toBe("success");
    expect(record.replyChars).toBe(2);
    expect(record.endedAt).toBeTypeOf("number");
  });

  it("fires the write-back on an error exit too — partial runtime transcripts still mirror", async () => {
    const { children, spawnImpl } = fakeSpawn();
    const onSettled = vi.fn();
    const run = runClaudeJob({ argv: ["-p", "x"], writeTargetKey: "w", onSettled }, { spawnImpl });
    children[0].finish(1, null, { stderr: "boom" });
    const record = await run;

    expect(record.outcome).toBe("error");
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "error", error: "boom" }),
    );
  });

  it("fires the write-back on a timeout record", async () => {
    const { children, spawnImpl } = fakeSpawn();
    const onSettled = vi.fn();
    const run = runClaudeJob(
      { argv: ["-p", "x"], writeTargetKey: "w", timeoutMs: 20, onSettled },
      { spawnImpl, killGraceMs: 10 },
    );

    await vi.waitFor(() => expect(children[0].killed).toContain("SIGKILL"));
    children[0].finish(null, "SIGKILL");
    const record = await run;

    expect(record.outcome).toBe("timeout");
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ outcome: "timeout" }));
  });

  it("still notifies the write-back for a refused overlap run (uniform record contract)", async () => {
    const { children, spawnImpl } = fakeSpawn();
    const first = runClaudeJob({ argv: ["-p", "x"], writeTargetKey: "same" }, { spawnImpl });
    const onSettled = vi.fn();

    const refused = await runClaudeJob(
      { argv: ["-p", "y"], writeTargetKey: "same", onSettled },
      { spawnImpl },
    );
    expect(refused.outcome).toBe("error");
    expect(refused.pid).toBeNull();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(refused);

    children[0].finish(0, null, { stdout: JSON_REPLY });
    await first;
  });

  it("swallows write-back failures so the run record still resolves", async () => {
    const { children, spawnImpl } = fakeSpawn();
    const onSettled = vi.fn(async () => {
      throw new Error("store is down");
    });
    const run = runClaudeJob({ argv: ["-p", "x"], writeTargetKey: "w", onSettled }, { spawnImpl });
    children[0].finish(0, null, { stdout: JSON_REPLY });

    await expect(run).resolves.toMatchObject({
      outcome: "success",
      replyText: "hello from claude",
    });
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});

describe("runClaudeJob — concurrency", () => {
  it("refuses an overlapping run on the same write-target key and kills the fresh child", async () => {
    const { children, spawnImpl } = fakeSpawn();
    const first = runClaudeJob({ argv: ["-p", "x"], writeTargetKey: "same" }, { spawnImpl });

    // The first run is live (map populated synchronously before its first await).
    expect(isRunLive("same")).toBe(true);

    const refused = await runClaudeJob(
      { argv: ["-p", "y"], writeTargetKey: "same" },
      { spawnImpl },
    );
    expect(refused.outcome).toBe("error");
    expect(refused.error).toMatch(/already in progress/);
    expect(refused.pid).toBeNull();
    expect(children[1].killed).toEqual(["SIGKILL"]);

    // Release the first run — the slot frees and the same key becomes available.
    children[0].finish(0, null, { stdout: JSON_REPLY });
    const firstRecord = await first;
    expect(firstRecord.outcome).toBe("success");
    expect(isRunLive("same")).toBe(false);

    const retry = runClaudeJob({ argv: ["-p", "z"], writeTargetKey: "same" }, { spawnImpl });
    children[2].finish(0, null, { stdout: JSON_REPLY });
    expect((await retry).outcome).toBe("success");
  });

  it("allows concurrent runs on different write-target keys", async () => {
    const { children, spawnImpl } = fakeSpawn();
    const a = runClaudeJob({ argv: ["-p", "a"], writeTargetKey: "k1" }, { spawnImpl });
    const b = runClaudeJob({ argv: ["-p", "b"], writeTargetKey: "k2" }, { spawnImpl });

    expect(isRunLive("k1")).toBe(true);
    expect(isRunLive("k2")).toBe(true);

    children[0].finish(0, null, { stdout: JSON.stringify({ result: "a" }) });
    children[1].finish(0, null, { stdout: JSON.stringify({ result: "b" }) });

    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.outcome).toBe("success");
    expect(ra.replyText).toBe("a");
    expect(rb.outcome).toBe("success");
    expect(rb.replyText).toBe("b");
  });
});

describe("beginRun / endRun contract", () => {
  it("returns a typed refusal and endRun clears the slot", () => {
    const child = new FakeChild();
    const first = beginRun("w", child as unknown as ChildProcess);
    expect(first.ok).toBe(true);

    const second = beginRun("w", new FakeChild() as unknown as ChildProcess);
    expect(second).toEqual({
      ok: false,
      reason: "ALREADY_RUNNING",
      message: `a claude run for "w" is already in progress`,
    });

    endRun("w");
    expect(isRunLive("w")).toBe(false);
    const third = beginRun("w", child as unknown as ChildProcess);
    expect(third.ok).toBe(true);
    endRun("w");
  });
});
