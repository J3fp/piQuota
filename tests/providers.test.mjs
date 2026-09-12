/**
 * Provider tests. Every response is a fixture; no network call is made and no
 * real credential is used.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fetchQuota as fetchClaude } from "../src/providers/claude.js";
import { fetchQuota as fetchCodex } from "../src/providers/codex.js";
import { fetchQuota as fetchAntigravity } from "../src/providers/antigravity.js";
import { fetchQuota as fetchOpenCodeGo } from "../src/providers/opencode-go.js";
import { normalizeCredential } from "../src/auth/pi-auth.js";
import { redact } from "../src/http.js";
import {
  antigravityUsageBody,
  claudeUsageBody,
  codexUsageBody,
  jsonResponse,
  makeFakeJwt,
  routedFetch,
} from "./helpers.mjs";

const NOW = 1_800_000_000_000;

test("claude: reads five_hour and seven_day and formats the overage with its decimal scale", async () => {
  const { fetchFn, calls } = routedFetch([["api.anthropic.com", () => jsonResponse(claudeUsageBody())]]);
  const credential = normalizeCredential("anthropic", { type: "oauth", access: "sk-ant-oat01-FAKE" }, "/tmp/auth.json");
  assert.ok(credential);

  const result = await fetchClaude(credential, { now: NOW, fetchFn });
  assert.equal(result.ok, true);
  assert.equal(result.label, "Claude (Pi)");
  assert.deepEqual(result.windows.map((window) => window.id), ["5h", "weekly"]);
  assert.equal(result.windows[0].remainingPercent, 96);
  assert.match(result.windows[1].note ?? "", /29\.08 USD/);

  const headers = /** @type {Record<string, string>} */ (calls[0].init.headers);
  assert.equal(headers["anthropic-beta"], "oauth-2025-04-20");
  assert.equal(headers.Authorization, "Bearer sk-ant-oat01-FAKE");
});

test("claude: a 401 degrades with a re-login hint instead of throwing", async () => {
  const { fetchFn } = routedFetch([["api.anthropic.com", () => jsonResponse({}, { status: 401 })]]);
  const credential = normalizeCredential("anthropic", { type: "oauth", access: "sk-ant-oat01-FAKE" }, "/tmp/auth.json");
  assert.ok(credential);
  const result = await fetchClaude(credential, { now: NOW, fetchFn });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /use any Claude model in Pi/);
});

test("codex: maps primary/secondary windows by their real length and sends chatgpt-account-id", async () => {
  const access = makeFakeJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_fixture", chatgpt_plan_type: "plus" },
    exp: 1_900_000_000,
  });
  const { fetchFn, calls } = routedFetch([["chatgpt.com", () => jsonResponse(codexUsageBody())]]);
  const credential = normalizeCredential("openai-codex", { type: "oauth", access, refresh: "rt.1.fake" }, "/tmp/auth.json");
  assert.ok(credential);

  const result = await fetchCodex(credential, { now: NOW, fetchFn });
  assert.equal(result.ok, true);
  assert.equal(result.plan, "plus");
  assert.deepEqual(result.windows.map((window) => window.id), ["5h", "weekly"]);
  assert.deepEqual(result.windows.map((window) => window.windowSeconds), [18000, 604800]);

  const headers = /** @type {Record<string, string>} */ (calls[0].init.headers);
  assert.equal(headers["chatgpt-account-id"], "acct_fixture");
  assert.equal(headers.originator, "codex_cli_rs");
});

test("codex: an unrecognized body degrades rather than reporting empty windows", async () => {
  const { fetchFn } = routedFetch([["chatgpt.com", () => jsonResponse({ plan_type: "plus" })]]);
  const credential = normalizeCredential("openai-codex", { type: "oauth", access: "a.b.c", refresh: "rt.1.fake" }, "/tmp/auth.json");
  assert.ok(credential);
  const result = await fetchCodex(credential, { now: NOW, fetchFn });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /no primary\/secondary window/);
});

test("antigravity: labels multi-group buckets and always sends the CLI user agent", async () => {
  const { fetchFn, calls } = routedFetch([["cloudcode", () => jsonResponse(antigravityUsageBody())]]);
  const credential = normalizeCredential("antigravity", {
    type: "oauth",
    access: "ya29.FAKE",
    refresh: "1//FAKE",
    projectId: "fixture-project",
    email: "fixture@example.com",
  }, "/tmp/auth.json");
  assert.ok(credential);

  const result = await fetchAntigravity(credential, { now: NOW, fetchFn, refresh: false });
  assert.equal(result.ok, true);
  const labels = result.windows.map((window) => window.label);
  assert.equal(labels.some((label) => label.startsWith("Gemini · ")), true);
  assert.equal(labels.some((label) => label.startsWith("Claude/GPT · ")), true);
  assert.equal(new Set(result.windows.map((window) => window.id)).size, result.windows.length);

  const window = result.windows.find((entry) => entry.label === "Gemini · weekly");
  assert.ok(window);
  assert.ok(Math.abs((window.usedPercent ?? 0) - 1.77) < 0.001, `usedPercent was ${window.usedPercent}`);
  assert.equal(window.resetsAt, new Date("2030-01-08T08:06:47Z").toISOString());

  const headers = /** @type {Record<string, string>} */ (calls[0].init.headers);
  assert.match(headers["User-Agent"], /^antigravity\/cli\//);
  assert.equal(JSON.parse(/** @type {string} */ (calls[0].init.body)).project, "fixture-project");
});

test("antigravity: the license 403 becomes an actionable message", async () => {
  const { fetchFn } = routedFetch([
    ["cloudcode", () => jsonResponse({ error: { code: 403, message: "You do not have a valid license" } }, { status: 403 })],
  ]);
  const credential = normalizeCredential("antigravity", {
    type: "oauth",
    access: "ya29.FAKE",
    refresh: "1//FAKE",
    projectId: "fixture-project",
  }, "/tmp/auth.json");
  assert.ok(credential);
  const result = await fetchAntigravity(credential, { now: NOW, fetchFn, refresh: false });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Antigravity token rejected|quota request failed/);
});

test("opencode-go: without dashboard credentials it degrades and explains the missing fields", async () => {
  const { fetchFn } = routedFetch([["opencode.ai/zen", () => jsonResponse({ object: "list", data: [{ id: "m1" }] })]]);
  const credential = normalizeCredential("opencode-go", { type: "api_key", key: "sk-FAKE-zen" }, "/tmp/auth.json");
  assert.ok(credential);

  const result = await fetchOpenCodeGo(credential, { now: NOW, fetchFn, env: {}, stores: [], allowBrowser: false });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Pi OpenCode key is valid \(1 Zen models visible\)/);
  assert.match(result.error ?? "", /no auth cookie/);
  assert.match(result.error ?? "", /piquota auth opencode/);
});

test("opencode-go: a rejected Zen key is reported as a credential problem", async () => {
  const { fetchFn } = routedFetch([["opencode.ai/zen", () => jsonResponse({}, { status: 401 })]]);
  const credential = normalizeCredential("opencode-go", { type: "api_key", key: "sk-FAKE-zen" }, "/tmp/auth.json");
  assert.ok(credential);
  const result = await fetchOpenCodeGo(credential, { now: NOW, fetchFn, env: {}, stores: [], allowBrowser: false });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /rejected by OpenCode Zen/);
});

test("redact removes credentials and e-mails from any leaked text", () => {
  const text = "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature for user@example.com key sk-ant-oat01-abcdef token ya29.abcdef";
  const cleaned = redact(text);
  assert.equal(cleaned.includes("user@example.com"), false);
  assert.equal(cleaned.includes("abcdef"), false);
  assert.equal(cleaned.includes("<email>"), true);
});

test("a throttled family is paused instead of hammered, and recovers", async () => {
  const { backoffState, clearBackoff, isThrottled, recordBackoff, retryAfterFromError, resolveBackoffPath } =
    await import("../src/providers/backoff.js");
  const { collectQuota } = await import("../src/engine.js");
  const { fileURLToPath } = await import("node:url");
  const FIXTURE = fileURLToPath(new URL("./fixtures/fake-auth.json", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-backoff-"));
  const NOW = 1_800_000_000_000;

  assert.equal(isThrottled("Claude usage request failed: rate limited (HTTP 429); retry in 12s"), true);
  assert.equal(isThrottled("Claude usage request failed: HTTP 500"), false);
  assert.equal(retryAfterFromError("rate limited (HTTP 429); retry in 212s"), 212);
  assert.equal(retryAfterFromError("no hint"), null);

  // A short retry-after is floored so we never retry immediately.
  const recorded = recordBackoff("claude", { retryAfterSec: 5, now: NOW, home: dir });
  assert.match(resolveBackoffPath({ home: dir }), /backoff\.json$/);
  assert.ok(recorded.seconds >= 300, `floor was not applied: ${recorded.seconds}`);
  assert.equal(backoffState("claude", { now: NOW, home: dir }).active, true);
  assert.equal(backoffState("claude", { now: NOW + 400_000, home: dir }).active, false);

  // While paused, the engine skips the network call entirely.
  const calls = [];
  const fetchFn = /** @type {typeof fetch} */ (async (url) => {
    calls.push(String(url));
    return jsonResponse({ five_hour: { utilization: 4 }, seven_day: { utilization: 11 } });
  });
  const paused = await collectQuota({
    paths: [FIXTURE], families: ["claude"], now: NOW, fetchFn, env: {}, stores: [], allowBrowser: false,
    home: dir,
  });
  assert.equal(paused.providers[0].ok, false);
  assert.match(paused.providers[0].error ?? "", /backing off/);
  assert.equal(calls.length, 0, "the throttled family must not be called");

  const after = await collectQuota({
    paths: [FIXTURE], families: ["claude"], now: NOW + 400_000, fetchFn, env: {}, stores: [], allowBrowser: false,
    home: dir,
  });
  assert.equal(after.providers[0].ok, true);
  assert.equal(calls.length, 1);
  // A successful fetch clears the backoff itself, so there is nothing left to clear.
  assert.equal(backoffState("claude", { now: NOW + 400_000, home: dir }).active, false);
  assert.equal(clearBackoff("claude", { home: dir }), false);
});
