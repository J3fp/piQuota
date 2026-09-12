/**
 * Restarting moshi-hook's daemon, and proving the new setting took effect.
 *
 * moshi-hook reads `usage_collection` once at startup and says so: "restart the
 * daemon to apply". It has no `service restart` subcommand — asking for one prints
 * help and exits 0, which would read as success — so the restart goes through the
 * platform's service manager, and the outcome is verified instead of assumed.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { confirmDaemonUsageCollection, restartMoshiDaemon } from "../src/moshi/daemon.js";

/**
 * @param {Record<string, { status?: number | null, stdout?: string, stderr?: string, error?: string | null }>} answers
 */
function fakeRun(answers) {
  const calls = [];
  const run = (command, args) => {
    const key = [command, ...args].join(" ");
    calls.push(key);
    const answer = answers[key];
    if (!answer) return { status: 1, stdout: "", stderr: `unexpected: ${key}`, error: null };
    return { status: answer.status ?? 0, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "", error: answer.error ?? null };
  };
  return { run, calls };
}

test("an active user service is restarted and re-checked", () => {
  const { run, calls } = fakeRun({
    "systemctl --user is-active moshi-hook.service": { stdout: "active\n" },
    "systemctl --user restart moshi-hook.service": {},
  });
  const result = restartMoshiDaemon({ platform: "linux", run });

  assert.equal(result.ok, true);
  assert.equal(typeof result.restartedAtMs, "number");
  assert.equal(result.mechanism, "systemd-user");
  assert.deepEqual(calls, [
    "systemctl --user is-active moshi-hook.service",
    "systemctl --user restart moshi-hook.service",
    "systemctl --user is-active moshi-hook.service",
  ]);
});

test("a foreground daemon is never silently restarted", () => {
  const { run, calls } = fakeRun({
    "systemctl --user is-active moshi-hook.service": { status: 3, stdout: "inactive\n" },
  });
  const result = restartMoshiDaemon({ platform: "linux", run });

  assert.equal(result.ok, false);
  assert.match(result.detail, /not active/);
  assert.equal(calls.includes("systemctl --user restart moshi-hook.service"), false, "never restart something that is not ours to restart");
});

test("a failed restart reports the service manager's own reason", () => {
  const { run } = fakeRun({
    "systemctl --user is-active moshi-hook.service": { stdout: "active\n" },
    "systemctl --user restart moshi-hook.service": { status: 1, stderr: "Failed to restart moshi-hook.service: Unit not found." },
  });
  const result = restartMoshiDaemon({ platform: "linux", run });

  assert.equal(result.ok, false);
  assert.match(result.detail, /Unit not found/);
});

test("a service that dies on restart is not reported as a success", () => {
  let active = "active\n";
  const run = (command, args) => {
    const key = [command, ...args].join(" ");
    if (key.includes("is-active")) return { status: 0, stdout: active, stderr: "", error: null };
    active = "failed\n";
    return { status: 0, stdout: "", stderr: "", error: null };
  };
  const result = restartMoshiDaemon({ platform: "linux", run });
  assert.equal(result.ok, false);
  assert.match(result.detail, /not active afterwards/);
});

test("a non-Linux platform is told what to do instead of being guessed at", () => {
  const { run, calls } = fakeRun({});
  const result = restartMoshiDaemon({ platform: "darwin", run });

  assert.equal(result.ok, false);
  assert.equal(result.mechanism, "manual");
  assert.match(result.detail, /restart moshi-hook yourself/);
  assert.deepEqual(calls, [], "no command is invented for a platform we cannot identify");
});

test("the daemon banner confirms which value it actually loaded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-hook-log-"));
  const logPath = join(dir, "hook.log");
  writeFileSync(
    logPath,
    [
      'time=2026-09-12T15:00:00.000-05:00 level=INFO msg="starting moshi-hook daemon" usageCollection=true',
      'time=2026-09-12T15:00:01.000-05:00 level=INFO msg="usage poller: synced" count=1',
      'time=2026-09-12T15:52:26.092-05:00 level=INFO msg="starting moshi-hook daemon" usageCollection=false',
      'time=2026-09-12T15:52:26.138-05:00 level=INFO msg="usage collection disabled; background fetch and upload skipped"',
    ].join("\n"),
  );

  const confirmed = await confirmDaemonUsageCollection({ logPath });
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.applied, false, "the newest banner wins");
  assert.match(confirmed.detail, /usageCollection=false/);
});

test("a log with no daemon start yet is unconfirmed, not a failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-hook-log-"));
  const logPath = join(dir, "hook.log");
  writeFileSync(logPath, 'time=2026-09-12T15:00:00.000-05:00 level=INFO msg="usage poller: synced" count=1\n');

  const confirmed = await confirmDaemonUsageCollection({ logPath });
  assert.equal(confirmed.confirmed, false);
  assert.equal(confirmed.applied, null);
  assert.match(confirmed.detail, /no daemon start/);
});

test("a missing log is reported without throwing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-hook-log-"));
  const confirmed = await confirmDaemonUsageCollection({ logPath: join(dir, "nope.log") });
  assert.equal(confirmed.confirmed, false);
  assert.match(confirmed.detail, /no daemon log/);
});

test("a banner older than the restart is never reported as the current value", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-hook-log-"));
  const logPath = join(dir, "hook.log");
  const banner = (stamp, value) => `time=${stamp} level=INFO msg="starting moshi-hook daemon" usageCollection=${value}`;
  writeFileSync(logPath, [banner("2026-09-12T15:00:00.000-05:00", "true")].join("\n"));

  // The restart happened after that banner, so it proves nothing about it.
  const stale = await confirmDaemonUsageCollection({ logPath, notBeforeMs: Date.parse("2026-09-12T16:00:00.000-05:00"), waitMs: 0 });
  assert.equal(stale.confirmed, false);
  assert.match(stale.detail, /has not logged a start since the restart/);

  // Once a fresh banner lands, the very next read confirms it.
  writeFileSync(logPath, [banner("2026-09-12T15:00:00.000-05:00", "true"), banner("2026-09-12T16:00:05.000-05:00", "false")].join("\n"));
  const fresh = await confirmDaemonUsageCollection({ logPath, notBeforeMs: Date.parse("2026-09-12T16:00:00.000-05:00"), waitMs: 0 });
  assert.equal(fresh.confirmed, true);
  assert.equal(fresh.applied, false);
});

test("confirmation waits for the daemon to finish starting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-hook-log-"));
  const logPath = join(dir, "hook.log");
  writeFileSync(logPath, "");

  setTimeout(() => {
    writeFileSync(logPath, 'time=2026-09-12T16:00:05.000-05:00 level=INFO msg="starting moshi-hook daemon" usageCollection=false\n');
  }, 120);

  const confirmed = await confirmDaemonUsageCollection({ logPath, notBeforeMs: Date.parse("2026-09-12T16:00:00.000-05:00"), waitMs: 2_000, pollMs: 40 });
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.applied, false);
});
