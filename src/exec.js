/**
 * The one place that spawns a foreign binary.
 *
 * piQuota is a read-only observer, and the only external command it ever runs is
 * moshi-hook's own CLI, to change moshi-hook's own setting the supported way
 * instead of editing its config file. Everything else is HTTP and file reads.
 *
 * A missing binary must degrade, not throw: `spawnSync` reports ENOENT through
 * `error` with a null status, and callers here treat both as failure.
 */

import { spawnSync } from "node:child_process";

export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * @param {string} command
 * @param {string[]} [args]
 * @param {{ timeoutMs?: number, env?: Record<string, string | undefined> }} [options]
 * @returns {{ status: number | null, stdout: string, stderr: string, error: string | null }}
 */
export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env: options.env ?? process.env,
  });
  return {
    status: typeof result.status === "number" ? result.status : null,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    error: result.error ? result.error.message : null,
  };
}
