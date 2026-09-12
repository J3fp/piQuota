/**
 * Moshi settings that this project must respect.
 *
 * moshi-hook owns `~/.config/moshi/config.toml`; we only read it, so a user who
 * turned usage collection off never gets pushed data from here either.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { readTakeover } from "./takeover.js";

/**
 * @param {string} value
 * @returns {number | null}
 */
export function parseDurationSeconds(value) {
  const match = String(value).match(/^(\d+)\s*(ms|s|m|h)?$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  if (unit === "ms") return Math.round(amount / 1000);
  if (unit === "s") return amount;
  if (unit === "m") return amount * 60;
  return amount * 3600;
}

/**
 * @param {{ configPath?: string, home?: string }} [options]
 * @returns {{ enabled: boolean, raw: string | null, intervalSec: number | null, path: string }}
 */
export function readUsageCollection(options = {}) {
  const path = options.configPath ?? join(options.home ?? homedir(), ".config", "moshi", "config.toml");
  if (!existsSync(path)) return { enabled: true, raw: null, intervalSec: null, path };

  let text;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return { enabled: true, raw: null, intervalSec: null, path };
  }

  let value = null;
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*usage_collection\s*=\s*(.+?)\s*(?:#.*)?$/);
    if (match) value = match[1].trim().replace(/^["']|["']$/g, "");
  }
  if (value === null) return { enabled: true, raw: null, intervalSec: null, path };
  if (value === "false" || value === "off") return { enabled: false, raw: value, intervalSec: null, path };
  if (value === "true" || value === "on") return { enabled: true, raw: value, intervalSec: null, path };
  return { enabled: true, raw: value, intervalSec: parseDurationSeconds(value), path };
}

/**
 * Whether *this* publisher may push right now.
 *
 * `usage_collection` belongs to moshi-hook's own poller. After an explicit
 * `piquota moshi takeover` the setting is off precisely so that piQuota is the
 * only publisher left, and reading it as "stop publishing" would silence the
 * very thing the user asked for. The takeover is recorded explicitly, so this is
 * never inferred from the setting alone.
 *
 * @param {{ configPath?: string, home?: string, env?: Record<string, string | undefined>, stateDir?: string }} [options]
 * @returns {{
 *   enabled: boolean,
 *   takeover: boolean,
 *   moshiHookEnabled: boolean,
 *   duplicateRisk: boolean,
 *   raw: string | null,
 *   intervalSec: number | null,
 *   path: string,
 * }}
 */
export function effectiveUsageCollection(options = {}) {
  const setting = readUsageCollection(options);
  const takeover = readTakeover(options);
  const moshiHookEnabled = setting.enabled;
  return {
    enabled: takeover.active || moshiHookEnabled,
    takeover: takeover.active,
    moshiHookEnabled,
    // moshi-hook collecting again while a takeover is recorded means two
    // publishers for the same account, which is what the takeover removed.
    duplicateRisk: takeover.active && moshiHookEnabled,
    raw: setting.raw,
    intervalSec: setting.intervalSec,
    path: setting.path,
  };
}
