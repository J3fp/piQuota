/**
 * Approval mirroring for Pi.
 *
 * gentle-pi emits `pi-permission-system:permission-request` on Pi's extension event
 * bus, and nothing listens to it: approvals reach Herdr's UI but never the phone.
 * moshi-hook's own generated Pi extension already knows how to build the envelope,
 * but never registers a handler that calls it, and Pi has no `PermissionRequest`
 * event of its own.
 *
 * The wire is tested against a real Unix socket, so a payload that only looks right
 * cannot pass.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const EXTENSION = fileURLToPath(new URL("../extensions/moshi-approvals.ts", import.meta.url));
const PERMISSION_EVENT = "pi-permission-system:permission-request";

/**
 * A throwaway moshi-hook socket that records whatever is written to it.
 *
 * @returns {Promise<{ path: string, received: Array<Record<string, any>>, close: () => Promise<void> }>}
 */
async function makeSocketServer() {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-approvals-"));
  const path = join(dir, "moshi-hook.sock");
  /** @type {Array<Record<string, any>>} */
  const received = [];

  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
    });
    socket.on("end", () => {
      for (const line of buffer.split("\n")) {
        if (line.trim() === "") continue;
        try {
          received.push(JSON.parse(line));
        } catch {
          received.push({ __unparsable: line });
        }
      }
    });
    socket.on("error", () => {});
  });

  await new Promise((resolve) => server.listen(path, resolve));
  return {
    path,
    received,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** A minimal Pi surface: only what this extension is allowed to use. */
function makeHarness() {
  const handlers = new Map();
  const listeners = new Map();
  const forbidden = [];

  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    events: {
      on: (channel, handler) => {
        listeners.set(channel, handler);
        return () => listeners.delete(channel);
      },
      emit: (channel, data) => listeners.get(channel)?.(data),
    },
    registerTool: () => forbidden.push("registerTool"),
    registerCommand: () => forbidden.push("registerCommand"),
    sendMessage: () => forbidden.push("sendMessage"),
    sendUserMessage: () => forbidden.push("sendUserMessage"),
    appendEntry: () => forbidden.push("appendEntry"),
  };

  const ctx = {
    hasUI: true,
    cwd: "/work/piQuota",
    model: { displayName: "GPT-5.5" },
    getContextUsage: () => ({ percent: 12 }),
    sessionManager: {
      getSessionId: () => "session-abc",
      getSessionFile: () => "/home/u/.pi/agent/sessions/session-abc.jsonl",
    },
  };

  return { pi, ctx, handlers, listeners, forbidden };
}

/**
 * Load the extension with a socket the test owns.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<{ pi: any, ctx: any, listeners: Map<string, Function>, forbidden: string[] }>}
 */
async function load(env) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const module = await import(EXTENSION);
  const harness = makeHarness();
  module.default(harness.pi);
  return { ...harness, restore: () => Object.assign(process.env, previous) };
}

test("the extension registers on Pi's own event bus, for the channel gentle-pi emits", async () => {
  const server = await makeSocketServer();
  const loaded = await load({ MOSHI_SOCKET_PATH: server.path });

  assert.equal(typeof loaded.pi.default === "undefined", true);
  assert.equal(loaded.listeners.has(PERMISSION_EVENT), true, "the emitted channel must be the one subscribed");
  assert.equal(loaded.forbidden.length, 0, "a mirroring extension must not touch context or commands");

  loaded.restore();
  await server.close();
});

test("a waiting approval is mirrored with the shape moshi-hook already parses", async () => {
  const server = await makeSocketServer();
  const loaded = await load({ MOSHI_SOCKET_PATH: server.path });

  await loaded.handlers.get("session_start")({}, loaded.ctx);
  await loaded.listeners.get(PERMISSION_EVENT)({
    requestId: "req-1",
    state: "waiting",
    source: "tool_call",
    message: "Gentle AI safety policy requires confirmation for this tool call.",
    toolName: "bash",
  });
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(server.received.length, 1);
  const envelope = server.received[0];
  assert.equal(envelope.type, "session.update");
  assert.equal(envelope.source, "pi");
  assert.equal(envelope.eventName, "PermissionRequest");
  assert.equal(envelope.category, "approval_required");
  assert.equal(envelope.phase, "waitingForApproval");
  assert.equal(envelope.actionId, "req-1");
  assert.equal(envelope.toolName, "bash");
  assert.equal(envelope.title, "Pi needs approval");
  assert.equal(envelope.subtitle, "Answer in terminal");
  assert.match(envelope.message, /requires confirmation/);

  // Session context comes from the events Pi did fire, so the card lands on the
  // right session instead of a nameless one.
  assert.equal(envelope.sessionId, "session-abc");
  assert.equal(envelope.cwd, "/work/piQuota");
  assert.equal(envelope.modelName, "GPT-5.5");
  assert.equal(envelope.transcriptPath, "/home/u/.pi/agent/sessions/session-abc.jsonl");
  assert.equal(envelope.contextRemaining, 88);
  assert.equal(typeof envelope.requestedAt, "string");

  loaded.restore();
  await server.close();
});

test("both decisions clear the card, and neither is reported as still waiting", async () => {
  for (const state of ["approved", "denied"]) {
    const server = await makeSocketServer();
    const loaded = await load({ MOSHI_SOCKET_PATH: server.path });
    await loaded.handlers.get("session_start")({}, loaded.ctx);

    await loaded.listeners.get(PERMISSION_EVENT)({ requestId: `req-${state}`, state: "waiting", toolName: "bash" });
    await loaded.listeners.get(PERMISSION_EVENT)({ requestId: `req-${state}`, state, toolName: "bash" });
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(server.received.length, 2, `state ${state}`);
    const [waiting, resolved] = server.received;
    assert.equal(waiting.phase, "waitingForApproval");
    assert.equal(resolved.eventName, "PermissionResolved");
    assert.equal(resolved.category, "session_started");
    assert.equal(resolved.title, "Pi resumed");
    assert.equal(resolved.message, `bash ${state}`, "the card says which way it went");
    assert.equal(resolved.actionId, `req-${state}`, "the same request id, so the daemon can match it");

    loaded.restore();
    await server.close();
  }
});

test("the terminal target travels with the envelope, so the daemon can address the pane", async () => {
  const server = await makeSocketServer();
  const loaded = await load({
    MOSHI_SOCKET_PATH: server.path,
    HERDR_ENV: "1",
    HERDR_PANE_ID: "w8:p1",
    HERDR_WORKSPACE_ID: "w8",
    HERDR_TAB_ID: "w8:t1",
    HERDR_SESSION: "herdr-1",
    TMUX: undefined,
    TMUX_PANE: undefined,
    ZELLIJ: undefined,
    ZELLIJ_SESSION_NAME: undefined,
    ZELLIJ_PANE_ID: undefined,
  });

  await loaded.handlers.get("session_start")({}, loaded.ctx);
  await loaded.listeners.get(PERMISSION_EVENT)({ requestId: "req-2", state: "waiting", toolName: "bash" });
  await new Promise((resolve) => setTimeout(resolve, 120));

  const envelope = server.received[0];
  assert.equal(envelope.terminalKind, "herdr");
  assert.equal(envelope.herdrPane, "w8:p1");
  assert.equal(envelope.herdrWorkspaceId, "w8");
  assert.equal(envelope.herdrTabId, "w8:t1");
  assert.equal(envelope.herdrSession, "herdr-1");

  loaded.restore();
  await server.close();
});

test("an approval before any session event still produces a usable envelope", async () => {
  const server = await makeSocketServer();
  const loaded = await load({ MOSHI_SOCKET_PATH: server.path });

  await loaded.listeners.get(PERMISSION_EVENT)({ requestId: "req-3", state: "waiting", toolName: "bash" });
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(server.received.length, 1);
  assert.equal(typeof server.received[0].sessionId, "string");
  assert.ok(server.received[0].sessionId.length > 0, "a session id is always present so the card is addressable");
  assert.equal(server.received[0].eventName, "PermissionRequest");

  loaded.restore();
  await server.close();
});

test("unknown or malformed payloads are ignored instead of crashing the turn", async () => {
  const server = await makeSocketServer();
  const loaded = await load({ MOSHI_SOCKET_PATH: server.path });
  const listener = loaded.listeners.get(PERMISSION_EVENT);

  assert.doesNotThrow(() => listener(undefined));
  assert.doesNotThrow(() => listener(null));
  assert.doesNotThrow(() => listener({}));
  assert.doesNotThrow(() => listener({ state: "something-else", toolName: "bash" }));
  assert.doesNotThrow(() => listener("not an object"));
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(server.received.length, 0, "nothing is invented for a payload we do not understand");

  loaded.restore();
  await server.close();
});

test("an absent daemon is silent: the hook never interrupts the user's turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-approvals-"));
  const loaded = await load({ MOSHI_SOCKET_PATH: join(dir, "nothing-here.sock") });

  assert.doesNotThrow(() =>
    loaded.listeners.get(PERMISSION_EVENT)({ requestId: "req-4", state: "waiting", toolName: "bash" }),
  );
  await new Promise((resolve) => setTimeout(resolve, 120));

  loaded.restore();
});

test("the envelope never carries credential material", async () => {
  const server = await makeSocketServer();
  const loaded = await load({ MOSHI_SOCKET_PATH: server.path });
  await loaded.handlers.get("session_start")({}, loaded.ctx);

  await loaded.listeners.get(PERMISSION_EVENT)({
    requestId: "req-5",
    state: "waiting",
    toolName: "bash",
    message: "confirm `rm -rf /tmp/x`",
  });
  await new Promise((resolve) => setTimeout(resolve, 120));

  const raw = JSON.stringify(server.received[0]);
  for (const secret of ["sk-ant-", "ya29.", "rt.1.", "Bearer ", "secret_", "host_"]) {
    assert.equal(raw.includes(secret), false, `the envelope leaked ${secret}`);
  }

  loaded.restore();
  await server.close();
});

test("session_shutdown drops the cached session so a later approval cannot reuse it", async () => {
  const server = await makeSocketServer();
  const loaded = await load({ MOSHI_SOCKET_PATH: server.path });

  await loaded.handlers.get("session_start")({}, loaded.ctx);
  await loaded.handlers.get("session_shutdown")({}, loaded.ctx);
  await loaded.listeners.get(PERMISSION_EVENT)({ requestId: "req-6", state: "waiting", toolName: "bash" });
  await new Promise((resolve) => setTimeout(resolve, 120));

  const envelope = server.received[0];
  assert.notEqual(envelope.sessionId, "session-abc", "a closed session must not be reused");
  assert.notEqual(envelope.cwd, "/work/piQuota");

  loaded.restore();
  await server.close();
});
