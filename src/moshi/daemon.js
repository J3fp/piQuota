/**
 * Restarting moshi-hook's daemon, and proving that it took effect.
 *
 * moshi-hook reads `usage_collection` once at startup and says so itself: "restart
 * the daemon to apply". It has no `service restart` subcommand — asking for one
 * prints help and exits 0, which would look like success — so the restart goes
 * through the platform's own service manager, and the result is verified rather
 * than assumed.
 *
 * The verification is evidence, not a gate: if moshi-hook changes its log wording
 * the takeover still happened, and the caller is told that confirmation was not
 * possible instead of being told a lie.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { runCommand } from "../exec.js";

export const SERVICE_NAME = "moshi-hook.service";

/**
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [options]
 * @returns {string}
 */
export function resolveHookLogPath(options = {}) {
  const env = options.env ?? process.env;
  const stateDir = join(env.XDG_STATE_HOME || join(options.home ?? homedir(), ".local", "state"), "moshi");
  return join(stateDir, "hook.log");
}

/**
 * @param {{ platform?: string, run?: typeof runCommand, service?: string }} [options]
 * @returns {{ ok: boolean, mechanism: "systemd-user" | "manual", detail: string }}
 */
export function restartMoshiDaemon(options = {}) {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runCommand;
  const service = options.service ?? SERVICE_NAME;

  if (platform !== "linux") {
    // launchd labels are not discoverable without guessing, and guessing an
    // identifier is worse than telling the user what to do.
    return {
      ok: false,
      mechanism: "manual",
      restartedAtMs: null,
      detail: "restart moshi-hook yourself (macOS has no systemd user service); the setting applies at its next start",
    };
  }

  const before = run("systemctl", ["--user", "is-active", service]);
  if (String(before?.stdout ?? "").trim() !== "active") {
    return {
      ok: false,
      mechanism: "systemd-user",
      restartedAtMs: null,
      detail: `the ${service} user service is not active; stop and restart moshi-hook yourself (for example: Ctrl-C, then \`moshi-hook serve\`)`,
    };
  }

  const restarted = run("systemctl", ["--user", "restart", service]);
  if (restarted?.status !== 0) {
    const detail =
      String(restarted?.stderr ?? "").trim() ||
      String(restarted?.stdout ?? "").trim() ||
      String(restarted?.error ?? "").trim() ||
      `systemctl --user restart ${service} failed`;
    return { ok: false, mechanism: "systemd-user", restartedAtMs: null, detail };
  }

  const after = run("systemctl", ["--user", "is-active", service]);
  const active = String(after?.stdout ?? "").trim() === "active";
  return {
    ok: active,
    mechanism: "systemd-user",
    restartedAtMs: Date.now(),
    detail: active ? `restarted ${service}` : `restarted ${service} but it is not active afterwards`,
  };
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read the newest startup banner, if there is one.
 *
 * @param {string} logPath
 * @returns {{ confirmed: boolean, applied: boolean | null, startedAtMs: number | null, detail: string }}
 */
function readNewestBanner(logPath) {
  if (!existsSync(logPath)) {
    return { confirmed: false, applied: null, startedAtMs: null, detail: `no daemon log at ${logPath}` };
  }

  let text;
  try {
    text = readFileSync(logPath, { encoding: "utf-8", flag: "r" });
  } catch (error) {
    return {
      confirmed: false,
      applied: null,
      startedAtMs: null,
      detail: `cannot read ${logPath}: ${/** @type {{ message?: string }} */ (error)?.message ?? String(error)}`,
    };
  }

  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].includes("starting moshi-hook daemon")) continue;
    const match = lines[index].match(/usageCollection=(true|false)/);
    if (!match) {
      return { confirmed: false, applied: null, startedAtMs: null, detail: "the daemon banner does not report usageCollection" };
    }
    const stamp = lines[index].match(/time=(\S+)/);
    const startedAtMs = stamp ? Date.parse(stamp[1]) : null;
    return {
      confirmed: true,
      applied: match[1] === "true",
      startedAtMs: Number.isNaN(/** @type {number} */ (startedAtMs)) ? null : startedAtMs,
      detail: `the running daemon reports usageCollection=${match[1]}`,
    };
  }
  return { confirmed: false, applied: null, startedAtMs: null, detail: "no daemon start has been logged yet" };
}

/**
 * Look for the daemon's own startup banner and read back the setting it loaded.
 *
 * The banner is the only place moshi-hook states what it actually applied, so it
 * is the closest thing to proof that a restart picked the new value up. A restart
 * returns before the daemon has written that line, so the caller passes when the
 * restart happened and this waits for a banner at least that new.
 *
 * @param {{ logPath?: string, env?: Record<string, string | undefined>, home?: string, notBeforeMs?: number | null, waitMs?: number, pollMs?: number }} [options]
 * @returns {Promise<{ confirmed: boolean, applied: boolean | null, detail: string }>}
 */
export async function confirmDaemonUsageCollection(options = {}) {
  const logPath = options.logPath ?? resolveHookLogPath(options);
  const notBeforeMs = options.notBeforeMs ?? null;
  const waitMs = options.waitMs ?? (notBeforeMs === null ? 0 : 5_000);
  const pollMs = options.pollMs ?? 250;
  const deadline = Date.now() + waitMs;

  let banner = readNewestBanner(logPath);
  // An older banner is not evidence about this restart, so keep waiting for a new
  // one rather than reporting the previous value as if it were the current one.
  while (
    notBeforeMs !== null &&
    (!banner.confirmed || banner.startedAtMs === null || banner.startedAtMs < notBeforeMs) &&
    Date.now() < deadline
  ) {
    await delay(pollMs);
    banner = readNewestBanner(logPath);
  }

  if (banner.confirmed && notBeforeMs !== null && banner.startedAtMs !== null && banner.startedAtMs < notBeforeMs) {
    return { confirmed: false, applied: null, detail: "the daemon has not logged a start since the restart" };
  }
  return { confirmed: banner.confirmed, applied: banner.applied, detail: banner.detail };
}
