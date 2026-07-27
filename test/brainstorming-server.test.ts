import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptsDir = resolve(import.meta.dirname, "../opencode/arcs/skills/brainstorming/scripts");
const startScript = resolve(scriptsDir, "start-server.sh");
const stopScript = resolve(scriptsDir, "stop-server.sh");
const serverScript = resolve(scriptsDir, "server.js");
const cleanupPaths: string[] = [];

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("brainstorming server helper safety", () => {
  it("rejects outside-root and traversal cleanup targets without deleting them", () => {
    const outsideRoot = mkdtempSync(resolve(tmpdir(), "brainstorm-outside-test-"));
    const sentinel = resolve(outsideRoot, "sentinel.txt");
    writeFileSync(sentinel, "keep");
    cleanupPaths.push(outsideRoot);

    const outside = spawnSync("bash", [stopScript, outsideRoot], { encoding: "utf-8" });
    const traversal = spawnSync(
      "bash",
      [stopScript, `${outsideRoot}/../${outsideRoot.split("/").pop()}`],
      {
        encoding: "utf-8",
      },
    );

    expect(outside.status).not.toBe(0);
    expect(traversal.status).not.toBe(0);
    expect(existsSync(sentinel)).toBe(true);
  });

  it("cleans up a valid generated temporary session root", () => {
    const sessionRoot = resolve(tmpdir(), `brainstorm-${process.pid}-${Date.now()}`);
    mkdirSync(sessionRoot);
    writeFileSync(resolve(sessionRoot, ".server.pid"), "99999999\n");

    const result = spawnSync("bash", [stopScript, sessionRoot], { encoding: "utf-8" });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ status: "stopped" });
    expect(existsSync(sessionRoot)).toBe(false);
  });

  it("accepts a literal loopback bind host and preserves server info and stopped markers", async () => {
    const sessionRoot = resolve(tmpdir(), `brainstorm-${process.pid}-${Date.now()}`);
    mkdirSync(sessionRoot);
    cleanupPaths.push(sessionRoot);

    const child = spawn(process.execPath, [serverScript], {
      env: {
        ...process.env,
        BRAINSTORM_DIR: sessionRoot,
        BRAINSTORM_HOST: "127.0.0.1",
        BRAINSTORM_URL_HOST: "localhost",
        BRAINSTORM_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    await new Promise<void>((resolveReady, reject) => {
      const timeout = setTimeout(() => reject(new Error("server did not start")), 3000);
      child.stdout.on("data", (chunk) => {
        if (!chunk.toString().includes("server-started")) return;
        clearTimeout(timeout);
        resolveReady();
      });
    });

    const infoPath = resolve(sessionRoot, ".server-info");
    const info = JSON.parse(readFileSync(infoPath, "utf-8"));
    expect(info.host).toBe("127.0.0.1");
    expect(info.url_host).toBe("localhost");

    child.kill("SIGTERM");
    await new Promise<void>((resolveExit, reject) => {
      const started = Date.now();
      const interval = setInterval(() => {
        if (child.exitCode !== null) {
          clearInterval(interval);
          resolveExit();
        } else if (Date.now() - started > 3000) {
          clearInterval(interval);
          reject(new Error("server did not stop"));
        }
      }, 10);
    });
    expect(existsSync(infoPath)).toBe(false);
    expect(existsSync(resolve(sessionRoot, ".server-stopped"))).toBe(true);
  });

  it("rejects non-loopback host configuration", () => {
    const start = spawnSync("bash", [startScript, "--host", "0.0.0.0"], { encoding: "utf-8" });
    const direct = spawnSync(process.execPath, [serverScript], {
      encoding: "utf-8",
      env: { ...process.env, BRAINSTORM_HOST: "0.0.0.0" },
    });

    expect(start.status).not.toBe(0);
    expect(start.stdout).toMatch(/loopback/i);
    expect(direct.status).not.toBe(0);
    expect(direct.stderr).toMatch(/loopback/i);
  });

  it("rejects localhost as resolver-dependent bind configuration", () => {
    const start = spawnSync("bash", [startScript, "--host", "localhost"], {
      encoding: "utf-8",
    });
    if (start.status === 0) {
      const info = JSON.parse(start.stdout);
      spawnSync("bash", [stopScript, info.screen_dir], { encoding: "utf-8" });
    }
    const direct = spawnSync(process.execPath, [serverScript], {
      encoding: "utf-8",
      timeout: 1000,
      env: { ...process.env, BRAINSTORM_HOST: "localhost" },
    });

    expect(start.status).not.toBe(0);
    expect(start.stdout).toMatch(/literal loopback/i);
    expect(direct.status).not.toBe(0);
    expect(direct.stderr).toMatch(/literal loopback/i);
  });
});
