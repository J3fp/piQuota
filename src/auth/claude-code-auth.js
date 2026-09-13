/**
 * Claude Code CLI credentials — the second Claude source.
 *
 * `pi-claude-code-provider` creates a Pi provider that drives the installed
 * `claude` executable. It deliberately stores nothing in Pi's auth store: the
 * subscription token lives in Claude Code's own file, which Claude Code owns and
 * refreshes itself.
 *
 * This module therefore has a stricter contract than `pi-auth.js`:
 *
 *   - the file is opened read-only and is never written, moved or truncated;
 *   - the refresh token is deliberately *not* carried into the credential, so no
 *     later code path can even attempt to rotate it behind Claude Code's back
 *     (Anthropic rotates refresh tokens, and a stolen rotation would sign the
 *     installed CLI out);
 *   - reading never throws: an absent or corrupt store degrades with a message
 *     that names the file it looked for.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, rmdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Windows-side profiles reachable from WSL, discovered without spawning cmd.exe. */
const WINDOWS_USERS_ROOT = "/mnt/c/Users";
const MAX_WINDOWS_PROFILES = 40;

const CREDENTIALS_NAME = ".credentials.json";
const PROFILE_NAME = ".claude.json";

export const DEFAULT_LABEL = "Claude (Pi)";
export const OAUTH_REFRESH_LOCK_NAME = ".oauth_refresh.lock";
export const DEFAULT_STALE_LOCK_MS = 120_000;

/**
 * @param {string} value
 * @returns {string | null}
 */
function text(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function epochMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) return parsed;
    const fromDate = Date.parse(value);
    if (!Number.isNaN(fromDate)) return fromDate;
  }
  return null;
}

/**
 * Non-reversible identity fingerprint. Never a token, never reversible.
 *
 * @param {string[]} parts
 * @returns {string}
 */
function fingerprint(parts) {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

/**
 * Config directory Claude Code itself would use.
 *
 * `CLAUDE_CONFIG_DIR` is Claude Code's own documented relocation variable, so a
 * user who moved the CLI's state must be followed rather than second-guessed.
 *
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [options]
 * @returns {string}
 */
export function resolveClaudeConfigDir(options = {}) {
  const env = options.env ?? process.env;
  return text(env.CLAUDE_CONFIG_DIR) ?? join(options.home ?? homedir(), ".claude");
}

/**
 * Every candidate credential path, in priority order, whether or not it exists.
 *
 * @param {{ env?: Record<string, string | undefined>, home?: string, platform?: string, usersRoot?: string }} [options]
 * @returns {string[]}
 */
export function claudeCodeCandidatePaths(options = {}) {
  const env = options.env ?? process.env;
  const explicit = text(env.PI_QUOTA_CLAUDE_CODE_CREDENTIALS);
  if (explicit) return [explicit];

  const candidates = [join(resolveClaudeConfigDir(options), CREDENTIALS_NAME)];
  // A relocated config directory is authoritative: do not also probe the default one.
  if (text(env.CLAUDE_CONFIG_DIR)) return candidates;

  candidates.push(...discoverWindowsClaudeCodePaths({ platform: options.platform, usersRoot: options.usersRoot }));
  return candidates;
}

/**
 * Windows-side Claude Code stores reachable from WSL.
 *
 * @param {{ platform?: string, usersRoot?: string }} [options]
 * @returns {string[]}
 */
export function discoverWindowsClaudeCodePaths(options = {}) {
  const platform = options.platform ?? process.platform;
  const usersRoot = options.usersRoot ?? WINDOWS_USERS_ROOT;
  if (platform === "win32") return [];
  if (!existsSync(usersRoot)) return [];

  /** @type {string[]} */
  const found = [];
  let entries = [];
  try {
    entries = readdirSync(usersRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  let scanned = 0;
  for (const entry of entries) {
    if (scanned >= MAX_WINDOWS_PROFILES) break;
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name === "Default" || name === "Default User" || name === "All Users" || name === "Public") continue;
    scanned += 1;
    const candidate = join(usersRoot, name, ".claude", CREDENTIALS_NAME);
    if (existsSync(candidate)) found.push(candidate);
  }
  return found;
}

/**
 * Candidate paths that actually exist, de-duplicated by real path.
 *
 * @param {{ env?: Record<string, string | undefined>, home?: string, platform?: string, usersRoot?: string }} [options]
 * @returns {string[]}
 */
export function resolveClaudeCodeCredentialPaths(options = {}) {
  const seen = new Set();
  const out = [];
  for (const path of claudeCodeCandidatePaths(options)) {
    if (!existsSync(path)) continue;
    let key = path;
    try {
      key = realpathSync(path);
    } catch {
      // Keep the unresolved path; existsSync already ran.
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

/**
 * Claude Code's own profile file, which carries the account e-mail and the
 * display name. It is a large file (project history lives in it), so only the
 * account fields are ever returned from it.
 *
 * @param {{ env?: Record<string, string | undefined>, home?: string, profilePath?: string }} [options]
 * @returns {string[]}
 */
export function claudeCodeProfilePaths(options = {}) {
  if (options.profilePath) return [options.profilePath];
  const first = join(resolveClaudeConfigDir(options), PROFILE_NAME);
  const fallback = join(options.home ?? homedir(), PROFILE_NAME);
  return fallback === first ? [first] : [first, fallback];
}

/**
 * @param {{ env?: Record<string, string | undefined>, home?: string, profilePath?: string }} [options]
 * @returns {{ email?: string, displayName?: string, organizationType?: string }}
 */
export function readClaudeCodeProfile(options = {}) {
  for (const path of claudeCodeProfilePaths(options)) {
    if (!existsSync(path)) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, { encoding: "utf-8", flag: "r" }));
    } catch {
      continue;
    }
    const account = parsed?.oauthAccount;
    if (!account || typeof account !== "object") continue;

    /** @type {{ email?: string, displayName?: string, organizationType?: string }} */
    const profile = {};
    const email = text(account.emailAddress);
    const displayName = text(account.displayName);
    const organizationType = text(account.organizationType);
    if (email) profile.email = email;
    if (displayName) profile.displayName = displayName;
    if (organizationType) profile.organizationType = organizationType;
    if (Object.keys(profile).length > 0) return profile;
  }
  return {};
}

/**
 * Read one Claude Code credential file. Never writes, never throws.
 *
 * @param {string} path
 * @returns {{ ok: true, oauth: Record<string, unknown> } | { ok: false, error: string }}
 */
export function readClaudeCodeCredentialFile(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, { encoding: "utf-8", flag: "r" }));
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error)?.code;
    if (code === "ENOENT") return { ok: false, error: missingMessage(path) };
    const message = /** @type {{ message?: string }} */ (error)?.message ?? String(error);
    return { ok: false, error: `cannot parse ${path}: ${message}` };
  }

  const oauth = parsed?.claudeAiOauth;
  if (!oauth || typeof oauth !== "object") {
    return { ok: false, error: `${path} has no claudeAiOauth block; run \`claude\` once to sign in` };
  }
  return { ok: true, oauth: /** @type {Record<string, unknown>} */ (oauth) };
}

/**
 * @param {string | undefined} path
 * @returns {string}
 */
function missingMessage(path) {
  return `Claude Code CLI has no readable credentials; looked for ${path ?? "~/.claude/.credentials.json"}`;
}

/**
 * Detect and recover from an abandoned Claude Code OAuth refresh lock.
 *
 * Claude Code creates `.oauth_refresh.lock` only for the few seconds it takes to
 * rotate its tokens with Anthropic. If the CLI is interrupted or killed mid-refresh,
 * that directory remains and causes all future refreshes to fail with:
 * "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh."
 *
 * Any lock older than `staleMs` (default 2 minutes) is safely treated as abandoned,
 * as Claude Code's own internal lock expiration threshold is 60 seconds.
 *
 * @param {string} configDir
 * @param {{ now?: number, staleMs?: number }} [options]
 * @returns {{ recovered: boolean, lockPath: string, ageMs?: number, error?: string }}
 */
export function recoverStaleClaudeLock(configDir, options = {}) {
  const lockPath = join(configDir, OAUTH_REFRESH_LOCK_NAME);
  if (!existsSync(lockPath)) return { recovered: false, lockPath };

  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;

  try {
    const stat = statSync(lockPath);
    const ageMs = Math.max(0, now - stat.mtimeMs);
    if (ageMs < staleMs) {
      return { recovered: false, lockPath, ageMs };
    }
    try {
      rmdirSync(lockPath);
    } catch {
      rmSync(lockPath, { recursive: true, force: true });
    }
    return { recovered: true, lockPath, ageMs };
  } catch (error) {
    return {
      recovered: false,
      lockPath,
      error: /** @type {{ message?: string }} */ (error)?.message ?? String(error),
    };
  }
}

/**
 * Normalize the Claude Code store into the same credential shape `pi-auth.js`
 * produces, so every downstream surface treats both Claude sources identically.
 *
 * @param {{ env?: Record<string, string | undefined>, home?: string, platform?: string, usersRoot?: string, paths?: string[] | null }} [options]
 * @returns {{ ok: true, credential: import("./pi-auth.js").PiCredential & { sourceKind: string, rateLimitTier: string | null }, paths: string[] }
 *   | { ok: false, credential: null, error: string, paths: string[] }}
 */
export function loadClaudeCodeCredential(options = {}) {
  const paths = options.paths ?? resolveClaudeCodeCredentialPaths(options);
  if (paths.length === 0) {
    return { ok: false, credential: null, error: missingMessage(claudeCodeCandidatePaths(options)[0]), paths: [] };
  }

  let lastError = null;
  let recoveredLock = null;
  for (const path of paths) {
    if (options.recoverStaleLock !== false) {
      const recovery = recoverStaleClaudeLock(dirname(path), { now: options.now, staleMs: options.staleMs });
      if (recovery.recovered) recoveredLock = recovery;
    }
    const read = readClaudeCodeCredentialFile(path);
    if (!read.ok) {
      lastError = read.error;
      continue;
    }

    const access = text(read.oauth.accessToken);
    if (!access) {
      return { ok: false, credential: null, error: `no Claude Code access token in ${path}; run \`claude\` once to sign in`, paths, recoveredLock };
    }

    const profile = readClaudeCodeProfile(options);
    const email = profile.email ?? null;

    return {
      ok: true,
      paths,
      recoveredLock,
      credential: {
        provider: "claude-code",
        family: "claude",
        label: DEFAULT_LABEL,
        sourceKind: "claude-code",
        source: path,
        identity: email ?? fingerprint(["claude-code", access]),
        access,
        // Only the access token's own expiry is exposed. The refresh token and its
        // expiry are never read or carried, because nothing here may act on them.
        expiresAtMs: epochMs(read.oauth.expiresAt),
        accountId: null,
        projectId: null,
        email,
        planType: text(read.oauth.subscriptionType),
        rateLimitTier: text(read.oauth.rateLimitTier),
        kind: "oauth",
      },
    };
  }

  return { ok: false, credential: null, error: lastError ?? missingMessage(claudeCodeCandidatePaths(options)[0]), paths, recoveredLock };
}

/**
 * Diagnostics for `piquota --explain`: names only, never token material.
 *
 * @param {{ env?: Record<string, string | undefined>, home?: string, platform?: string, usersRoot?: string, paths?: string[] | null }} [options]
 * @returns {{ ok: boolean, paths: string[], path: string | null, hasAccessToken: boolean, hasRefreshToken: boolean, expiresInMin: number | null, plan: string | null, error: string | null }}
 */
export function describeClaudeCodeSource(options = {}) {
  const paths = options.paths ?? resolveClaudeCodeCredentialPaths(options);
  const path = paths[0] ?? null;
  const configDir = path ? dirname(path) : resolveClaudeConfigDir(options);
  const lockPath = join(configDir, OAUTH_REFRESH_LOCK_NAME);
  let hasStaleLock = false;
  let lockAgeSec = null;
  if (existsSync(lockPath)) {
    try {
      const stat = statSync(lockPath);
      const ageMs = (options.now ?? Date.now()) - stat.mtimeMs;
      lockAgeSec = Math.max(0, Math.round(ageMs / 1000));
      hasStaleLock = ageMs >= (options.staleMs ?? DEFAULT_STALE_LOCK_MS);
    } catch {
      // Degrade gracefully if stat fails
    }
  }

  /** @type {{ ok: boolean, paths: string[], path: string | null, hasAccessToken: boolean, hasRefreshToken: boolean, hasStaleLock: boolean, lockAgeSec: number | null, expiresInMin: number | null, plan: string | null, error: string | null }} */
  const described = {
    ok: path !== null,
    paths,
    path,
    hasAccessToken: false,
    hasRefreshToken: false,
    hasStaleLock,
    lockAgeSec,
    expiresInMin: null,
    plan: null,
    error: path === null ? missingMessage(claudeCodeCandidatePaths(options)[0]) : null,
  };
  if (path === null) return described;

  const read = readClaudeCodeCredentialFile(path);
  if (!read.ok) {
    described.ok = false;
    described.error = read.error;
    return described;
  }

  const hasAccessToken = text(read.oauth.accessToken) !== null;
  described.hasAccessToken = hasAccessToken;
  // A boolean only: whether Claude Code holds a refresh token is useful to know,
  // its value never leaves the file.
  described.hasRefreshToken = text(read.oauth.refreshToken) !== null;
  described.plan = text(read.oauth.subscriptionType);
  const expiresAtMs = epochMs(read.oauth.expiresAt);
  described.expiresInMin = expiresAtMs === null ? null : Math.round((expiresAtMs - Date.now()) / 60000);
  if (!hasAccessToken) {
    described.ok = false;
    described.error = `no Claude Code access token in ${path}; run \`claude\` once to sign in`;
  }
  return described;
}
