// ---------------------------------------------------------------------------
// Tests for the opencode -> session-store discovery bridge (pure units:
// env configuration parsing and event -> status mapping).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  readOpencodeConfig,
  startOpencodeDiscovery,
  statusForOpencodeEvent,
} from "../src/web-server/opencode-client.js";

describe("opencode bridge: configuration", () => {
  it("is disabled when no endpoint is configured", () => {
    expect(readOpencodeConfig({})).toBeNull();
    // Discovery must be a no-op so the web server never depends on opencode.
    expect(startOpencodeDiscovery(null)).toBe(false);
  });

  it("builds a base url from OPENCODE_PORT", () => {
    expect(readOpencodeConfig({ OPENCODE_PORT: "4096" })).toEqual({
      baseUrl: "http://127.0.0.1:4096",
    });
  });

  it("honours OPENCODE_HOSTNAME", () => {
    expect(readOpencodeConfig({ OPENCODE_PORT: "4096", OPENCODE_HOSTNAME: "localhost" })).toEqual({
      baseUrl: "http://localhost:4096",
    });
  });

  it("prefers an explicit url and strips trailing slashes", () => {
    expect(
      readOpencodeConfig({ ARCS_OPENCODE_URL: "http://127.0.0.1:9999/", OPENCODE_PORT: "4096" }),
    ).toEqual({ baseUrl: "http://127.0.0.1:9999" });
  });

  it("carries the server password through", () => {
    expect(
      readOpencodeConfig({ OPENCODE_PORT: "4096", OPENCODE_SERVER_PASSWORD: "hunter2" }),
    ).toEqual({ baseUrl: "http://127.0.0.1:4096", password: "hunter2" });
  });

  it("rejects a non-numeric or out-of-range port", () => {
    expect(readOpencodeConfig({ OPENCODE_PORT: "nope" })).toBeNull();
    expect(readOpencodeConfig({ OPENCODE_PORT: "0" })).toBeNull();
    expect(readOpencodeConfig({ OPENCODE_PORT: "99999" })).toBeNull();
  });
});

describe("opencode bridge: event to status mapping", () => {
  it("maps lifecycle events", () => {
    expect(statusForOpencodeEvent({ type: "session.created" })).toBe("active");
    expect(statusForOpencodeEvent({ type: "session.idle" })).toBe("idle");
    expect(statusForOpencodeEvent({ type: "session.error" })).toBe("failed");
    expect(statusForOpencodeEvent({ type: "session.deleted" })).toBe("disconnected");
  });

  it("maps session.status payloads", () => {
    expect(
      statusForOpencodeEvent({ type: "session.status", properties: { status: { type: "busy" } } }),
    ).toBe("active");
    expect(
      statusForOpencodeEvent({ type: "session.status", properties: { status: { type: "retry" } } }),
    ).toBe("active");
    expect(
      statusForOpencodeEvent({ type: "session.status", properties: { status: { type: "idle" } } }),
    ).toBe("idle");
    expect(statusForOpencodeEvent({ type: "session.status" })).toBeNull();
  });

  it("leaves the status alone for events that carry no transition", () => {
    expect(statusForOpencodeEvent({ type: "session.updated" })).toBeNull();
    expect(statusForOpencodeEvent({ type: "message.updated" })).toBeNull();
    expect(statusForOpencodeEvent({})).toBeNull();
  });
});
