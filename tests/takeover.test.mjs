/**
 * `piquota moshi takeover`: making piQuota the only publisher on the paired host.
 *
 * moshi-hook ships its own usage poller, which reads each agent's own credential
 * file. Installing Claude Code is enough to make that poller publish a second
 * Claude card. Takeover records the intent in piQuota's own state, flips
 * moshi-hook's setting through its own CLI, and stays reversible.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { clearTakeover, readTakeover, resolveTakeoverPath, setMoshiUsageCollection, writeTakeover } from "../src/moshi/takeover.js";
import { effectiveUsageCollection } from "../src/moshi/settings.js";

/**
 * @param {string} value
 * @returns {{ home: string, configPath: string }}
 */
function makeConfig(value) {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-takeover-"));
  const dir = join(home, ".config", "moshi");
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, "config.toml");
  writeFileSync(configPath, `[gateway]\nalways_on_discovery = true\nusage_collection = ${value}\n`);
  return { home, configPath };
}

test("takeover is inactive until it is explicitly recorded", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-takeover-"));
  const state = readTakeover({ home, env: {} });
  assert.equal(state.active, false);
  assert.equal(state.previous, null);
  assert.equal(state.path, resolveTakeoverPath({ home, env: {} }));
});

test("recording a takeover round-trips and keeps the previous setting for the release", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-takeover-"));
  const written = writeTakeover({ home, env: {}, previous: "true", takenAt: "2030-01-01T00:00:00.000Z" });
  assert.equal(written.ok, true);

  const state = readTakeover({ home, env: {} });
  assert.equal(state.active, true);
  assert.equal(state.previous, "true");
  assert.equal(state.takenAt, "2030-01-01T00:00:00.000Z");
  assert.equal(clearTakeover({ home, env: {} }).removed, true);
  assert.equal(readTakeover({ home, env: {} }).active, false);
});

test("the takeover marker is private and atomic", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-takeover-"));
  writeTakeover({ home, env: {}, previous: null });
  const path = resolveTakeoverPath({ home, env: {} });

  assert.equal(statSync(path).mode & 0o777, 0o600);
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  assert.equal(parsed.publisher, "pi-quota");
  assert.equal(parsed.previous, null);
});

test("a truncated marker is treated as inactive instead of crashing", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-takeover-"));
  writeTakeover({ home, env: {}, previous: "true" });
  writeFileSync(resolveTakeoverPath({ home, env: {} }), "{ truncated");

  const state = readTakeover({ home, env: {} });
  assert.equal(state.active, false);
  assert.match(state.error ?? "", /cannot parse/);
});

test("clearing a marker that was never written is a no-op", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-takeover-"));
  assert.equal(clearTakeover({ home, env: {} }).ok, true);
  assert.equal(clearTakeover({ home, env: {} }).removed, false);
});

test("the override keeps piQuota publishing while moshi-hook's own collection is off", () => {
  const { home, configPath } = makeConfig("off");
  writeTakeover({ home, env: {}, previous: "true" });

  const effective = effectiveUsageCollection({ home, env: {}, configPath });
  assert.equal(effective.enabled, true, "takeover means we publish even though moshi-hook stopped");
  assert.equal(effective.takeover, true);
  assert.equal(effective.moshiHookEnabled, false);
  assert.equal(effective.duplicateRisk, false);
});

test("without a takeover, moshi-hook's own switch still governs piQuota", () => {
  const { home, configPath } = makeConfig("off");
  const effective = effectiveUsageCollection({ home, env: {}, configPath });

  assert.equal(effective.enabled, false);
  assert.equal(effective.takeover, false);
  assert.equal(effective.moshiHookEnabled, false);
});

test("re-enabling moshi-hook's collection under a takeover is flagged as a duplicate risk", () => {
  const { home, configPath } = makeConfig("true");
  writeTakeover({ home, env: {}, previous: "off" });

  const effective = effectiveUsageCollection({ home, env: {}, configPath });
  assert.equal(effective.enabled, true);
  assert.equal(effective.takeover, true);
  assert.equal(effective.moshiHookEnabled, true);
  assert.equal(effective.duplicateRisk, true);
});

test("changing moshi-hook's setting goes through its own CLI, never through its config file", () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    return { status: 0, stdout: "", stderr: "" };
  };

  const result = setMoshiUsageCollection("off", { run });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [["moshi-hook", "set", "usage-collection", "off"]]);
});

test("a failing moshi-hook invocation reports the reason instead of throwing", () => {
  const run = () => {
    throw new Error("moshi-hook not found");
  };
  const result = setMoshiUsageCollection("off", { run });
  assert.equal(result.ok, false);
  assert.match(result.error, /moshi-hook not found/);
});

test("a failing invocation is reported without inventing an exit code", () => {
  const run = () => ({ status: 3, stdout: "", stderr: "unknown setting" });
  const result = setMoshiUsageCollection("off", { run });
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown setting/);
});

test("a malformed setting value is rejected before moshi-hook is ever called", () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    return { status: 0, stdout: "", stderr: "" };
  };
  const result = setMoshiUsageCollection("5m; rm -rf /", { run });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0, "an injected value must never reach the shell");
});

test("the takeover state never contains a host secret or a token", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-takeover-"));
  writeTakeover({ home, env: {}, previous: "true", takenAt: "2030-01-01T00:00:00.000Z" });
  const raw = readFileSync(resolveTakeoverPath({ home, env: {} }), "utf-8");
  assert.equal(/secret_|host_|sk-|ya29\./.test(raw), false);

  const { configPath } = makeConfig("off");
  writeTakeover({ home, env: {}, previous: "true" });
  assert.equal(JSON.stringify(effectiveUsageCollection({ home, env: {}, configPath })).includes("secret_"), false);
  assert.equal(existsSync(resolveTakeoverPath({ home, env: {} })), true);
});

test("a missing moshi-hook binary is a failure, never a silent success", () => {
  const run = () => ({ status: null, stdout: "", stderr: "", error: "spawn moshi-hook ENOENT" });
  const result = setMoshiUsageCollection("off", { run });
  assert.equal(result.ok, false);
  assert.match(result.error, /ENOENT/);

  const silent = setMoshiUsageCollection("off", { run: () => ({ status: null, stdout: "", stderr: "", error: null }) });
  assert.equal(silent.ok, false);
  assert.match(silent.error, /could not be executed/);
});

test("a documented interval value is passed through unchanged", () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    return { status: 0, stdout: "", stderr: "" };
  };
  assert.equal(setMoshiUsageCollection("5m", { run }).ok, true);
  assert.deepEqual(calls, [["moshi-hook", "set", "usage-collection", "5m"]]);
});

test("the real runner reports a missing binary without throwing", async () => {
  const { runCommand } = await import("../src/exec.js");
  const result = runCommand("piquota-definitely-not-a-real-binary", ["--version"]);
  assert.equal(result.status, null);
  assert.ok(result.error);
  assert.equal(typeof result.stdout, "string");
});
