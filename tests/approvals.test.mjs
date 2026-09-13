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

test("the extension registers on Pi's own event bus, for the channel gentle-pi emits", async (t) => {
  const server = await makeSocketServer();
  t.after(() => server.close());
  const loaded = await load({ MOSHI_SOCKET_PATH: server.path });
  t.after(() => loaded.restore());

  assert.equal(typeof loaded.pi.default === "undefined", true);
  assert.equal(loaded.listeners.has(PERMISSION_EVENT), true, "the emitted channel must be the one subscribed");
  assert.equal(loaded.forbidden.length, 0, "a mirroring extension must not touch context or commands");

});

test("a waiting approval is mirrored with the shape moshi-hook already parses", async (t) => {
  const server = await makeSocketServer();
  t.after(() => server.close());
  const loaded = await load({ MOSHI_SOCKET_PATH: server.path });
  t.after(() => loaded.restore());

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

});

test("both decisions clear the card, and neither is reported as still waiting", async (t) => {
  for (const state of ["approved", "denied"]) {
    const server = await makeSocketServer();
  t.after(() => server.close());
    const loaded = await load({ MOSHI_SOCKET_PATH: server.path });
  t.after(() => loaded.restore());
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

test("the terminal target travels with the envelope, so the daemon can address the pane", async (t) => {
  const server = await makeSocketServer();
  t.after(() => server.close());
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

});

test("an approval before any session event still produces a usable envelope", async (t) => {
  const server = await makeSocketServer();
  t.after(() => server.close());
  const loaded = await load({ MOSHI_SOCKET_PATH: server.path });
  t.after(() => loaded.restore());

  await loaded.listeners.get(PERMISSION_EVENT)({ requestId: "req-3", state: "waiting", toolName: "bash" });
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(server.received.length, 1);
  assert.equal(typeof server.received[0].sessionId, "string");
  assert.ok(server.received[0].sessionId.length > 0, "a session id is always present so the card is addressable");
  assert.equal(server.received[0].eventName, "PermissionRequest");

});

test("unknown or malformed payloads are ignored instead of crashing the turn", async (t) => {
  const server = await makeSocketServer();
  t.after(() => server.close());
  const loaded = await load({ MOSHI_SOCKET_PATH: server.path });
  t.after(() => loaded.restore());
  const listener = loaded.listeners.get(PERMISSION_EVENT);

  assert.doesNotThrow(() => listener(undefined));
  assert.doesNotThrow(() => listener(null));
  assert.doesNotThrow(() => listener({}));
  assert.doesNotThrow(() => listener({ state: "something-else", toolName: "bash" }));
  assert.doesNotThrow(() => listener("not an object"));
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(server.received.length, 0, "nothing is invented for a payload we do not understand");

});

test("an absent daemon is silent: the hook never interrupts the user's turn", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-approvals-"));
  const loaded = await load({ MOSHI_SOCKET_PATH: join(dir, "nothing-here.sock") });
  t.after(() => loaded.restore());

  assert.doesNotThrow(() =>
    loaded.listeners.get(PERMISSION_EVENT)({ requestId: "req-4", state: "waiting", toolName: "bash" }),
  );
  await new Promise((resolve) => setTimeout(resolve, 120));

  loaded.restore();
});

test("the envelope never carries credential material", async (t) => {
  const server = await makeSocketServer();
  t.after(() => server.close());
  const loaded = await load({ MOSHI_SOCKET_PATH: server.path });
  t.after(() => loaded.restore());
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

});

test("session_shutdown drops the cached session so a later approval cannot reuse it", async (t) => {
  const server = await makeSocketServer();
  t.after(() => server.close());
  const loaded = await load({ MOSHI_SOCKET_PATH: server.path });
  t.after(() => loaded.restore());

  await loaded.handlers.get("session_start")({}, loaded.ctx);
  await loaded.handlers.get("session_shutdown")({}, loaded.ctx);
  await loaded.listeners.get(PERMISSION_EVENT)({ requestId: "req-6", state: "waiting", toolName: "bash" });
  await new Promise((resolve) => setTimeout(resolve, 120));

  const envelope = server.received[0];
  assert.notEqual(envelope.sessionId, "session-abc", "a closed session must not be reused");
  assert.notEqual(envelope.cwd, "/work/piQuota");

});

/**
 * The freeze/thaw pair that keeps the pane static while a mirrored prompt waits:
 * without it the animated working indicator invalidates the daemon's screen
 * fingerprint and remote approval fails verification.
 *
 * @returns {{ ui: Record<string, unknown>, calls: Array<Record<string, any> | undefined> }}
 */
function makeUi() {
  /** @type {Array<Record<string, any> | undefined>} */
  const calls = [];
  return {
    ui: { setWorkingIndicator: (options) => calls.push(options) },
    calls,
  };
}

test("a waiting prompt freezes the working indicator and a resolution restores it", async (t) => {
  const server = await makeSocketServer();
  t.after(() => server.close());
  const loaded = await load({ MOSHI_SOCKET_PATH: server.path });
  t.after(() => loaded.restore());
  const { ui, calls } = makeUi();
  await loaded.handlers.get("session_start")({}, { ...loaded.ctx, ui });
  const listener = loaded.listeners.get(PERMISSION_EVENT);

  await listener({ requestId: "req-f1", state: "waiting", toolName: "bash" });
  await listener({ requestId: "req-f1", state: "approved", toolName: "bash" });
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(calls.length, 2, "exactly one freeze and one restore");
  assert.deepEqual(calls[0], { frames: ["·"] }, "the indicator must stop animating while the prompt waits");
  assert.equal(calls[1], undefined, "the restore must go back to the default indicator");

});

test("overlapping waiting prompts freeze once, and only one restore is issued", async (t) => {
  const server = await makeSocketServer();
  t.after(() => server.close());
  const loaded = await load({ MOSHI_SOCKET_PATH: server.path });
  t.after(() => loaded.restore());
  const { ui, calls } = makeUi();
  await loaded.handlers.get("session_start")({}, { ...loaded.ctx, ui });
  const listener = loaded.listeners.get(PERMISSION_EVENT);

  await listener({ requestId: "req-f2", state: "waiting", toolName: "bash" });
  await listener({ requestId: "req-f3", state: "waiting", toolName: "bash" });
  await listener({ requestId: "req-f2", state: "denied", toolName: "bash" });
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(calls.length, 2, "a second freeze must not stack on the first");

});

test("session_shutdown thaws a pane a resolution never reached", async (t) => {
  const server = await makeSocketServer();
  t.after(() => server.close());
  const loaded = await load({ MOSHI_SOCKET_PATH: server.path });
  t.after(() => loaded.restore());
  const { ui, calls } = makeUi();
  await loaded.handlers.get("session_start")({}, { ...loaded.ctx, ui });
  const listener = loaded.listeners.get(PERMISSION_EVENT);

  await listener({ requestId: "req-f4", state: "waiting", toolName: "bash" });
  await loaded.handlers.get("session_shutdown")({}, loaded.ctx);
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(calls.length, 2);
  assert.equal(calls[1], undefined, "the shutdown must restore the default indicator");

});

test("a missing or throwing ui surface never interrupts the approval mirror", async (t) => {
  const server = await makeSocketServer();
  t.after(() => server.close());
  const loaded = await load({ MOSHI_SOCKET_PATH: server.path });
  t.after(() => loaded.restore());
  const { calls } = makeUi();
  await loaded.handlers.get("session_start")({}, { ...loaded.ctx, ui: { setWorkingIndicator: () => { throw new Error("no ui"); } } });
  const listener = loaded.listeners.get(PERMISSION_EVENT);

  assert.doesNotThrow(() => listener({ requestId: "req-f5", state: "waiting", toolName: "bash" }));
  assert.doesNotThrow(() => listener({ requestId: "req-f5", state: "approved", toolName: "bash" }));
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(server.received.length, 2, "the envelopes still go out");
  assert.equal(calls.length, 0);

});


