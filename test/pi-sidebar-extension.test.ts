import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import createArcsSidebar from "../web/extensions/arcs-sidebar.js";

type Handler = (event: any, ctx: any) => unknown;

function makePi() {
  const onHandlers = new Map<string, Handler[]>();
  const busHandlers = new Map<string, Array<(data: unknown) => void>>();
  const emitted: Array<{ channel: string; payload: any }> = [];
  const commands = new Map<string, { description: string; handler: Handler }>();
  const ui = {
    setStatus: vi.fn(),
    notify: vi.fn(),
    select: vi.fn(),
  };
  const pi = {
    on: vi.fn((event: string, handler: Handler) => {
      const list = onHandlers.get(event) ?? [];
      list.push(handler);
      onHandlers.set(event, list);
    }),
    events: {
      on: vi.fn((channel: string, handler: (data: unknown) => void) => {
        const list = busHandlers.get(channel) ?? [];
        list.push(handler);
        busHandlers.set(channel, list);
        return () => undefined;
      }),
      emit: vi.fn((channel: string, payload: unknown) => {
        emitted.push({ channel, payload: payload as any });
      }),
    },
    registerCommand: vi.fn((name: string, options: { description: string; handler: Handler }) => {
      commands.set(name, options);
    }),
  };
  return { pi, onHandlers, busHandlers, emitted, commands, ui };
}

function makeCtx(ui: unknown, cwd: string) {
  return { hasUI: false, mode: "print", cwd, ui };
}

describe("arcs-sidebar pi extension", () => {
  it("registers the reader, web, and refresh commands", () => {
    const { pi, commands } = makePi();
    createArcsSidebar(pi as any);
    expect([...commands.keys()].sort()).toEqual(["arcs-open", "arcs-refresh", "arcs-web"]);
    expect(commands.get("arcs-open")?.description).toMatch(/modal/i);
    expect(commands.get("arcs-open")?.description).toMatch(/proposal/i);
  });

  it("publishes the Atelier panel on session start and answers discovery", async () => {
    const { pi, onHandlers, busHandlers, emitted, ui } = makePi();
    createArcsSidebar(pi as any);

    const cwd = mkdtempSync(resolve(tmpdir(), "arcs-sidebar-"));
    const start = onHandlers.get("session_start")?.[0];
    expect(start).toBeDefined();
    await start!({ type: "session_start", reason: "startup" }, makeCtx(ui, cwd));

    const registers = emitted.filter(
      (e) => e.channel === "pi-atelier:sidebar-panels" && e.payload?.type === "register",
    );
    expect(registers.length).toBeGreaterThanOrEqual(1);
    expect(registers[0].payload.panel.id).toBe("arcs:overview");
    expect(registers[0].payload.source).toBe("arcs");

    // Discovery replays the panel with the requestId attached.
    const discover = busHandlers.get("pi-atelier:sidebar-panels")?.[0];
    expect(discover).toBeDefined();
    discover!({ type: "discover", requestId: "req-1" });
    let replay: { channel: string; payload: any } | undefined;
    for (let i = 0; i < 100 && !replay; i++) {
      await new Promise((r) => setTimeout(r, 50));
      replay = emitted.find((e) => e.payload?.requestId === "req-1");
    }
    expect(replay?.payload?.type).toBe("register");
  });

  it("unregisters the panel on shutdown", async () => {
    const { pi, onHandlers, emitted, ui } = makePi();
    createArcsSidebar(pi as any);

    const cwd = mkdtempSync(resolve(tmpdir(), "arcs-sidebar-"));
    await onHandlers.get("session_start")?.[0]?.(
      { type: "session_start", reason: "startup" },
      makeCtx(ui, cwd),
    );
    await onHandlers.get("session_shutdown")?.[0]?.(
      { type: "session_shutdown", reason: "quit" },
      makeCtx(ui, cwd),
    );

    const last = [...emitted].reverse().find((e) => e.channel === "pi-atelier:sidebar-panels");
    expect(last?.payload?.type).toBe("unregister");
    expect(last?.payload?.id).toBe("arcs:overview");
  });

  it("/arcs-open with bad usage notifies instead of throwing", async () => {
    const { pi, commands, ui } = makePi();
    createArcsSidebar(pi as any);

    const cwd = mkdtempSync(resolve(tmpdir(), "arcs-sidebar-"));
    const ctx = { ...makeCtx(ui, cwd), hasUI: true, mode: "tui" };
    await commands.get("arcs-open")?.handler("bogus-target extra", ctx);
    expect(ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Usage/), "warning");
    const usage = (ui.notify as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(usage).toMatch(/proposal/);
  });
});
