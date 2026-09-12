/**
 * OpenAI Codex quota from a Pi OAuth access token.
 *
 * Endpoint: GET https://chatgpt.com/backend-api/wham/usage
 * Required headers: Bearer token, `chatgpt-account-id` (taken from the JWT claim
 * `https://api.openai.com/auth.chatgpt_account_id`) and the Codex originator.
 *
 * Windows: `rate_limit.primary_window` (5h) and `rate_limit.secondary_window`
 * (weekly), each `{ used_percent, limit_window_seconds, reset_after_seconds, reset_at }`.
 *
 * No refresh is attempted: OpenAI rotates the refresh token, so refreshing here
 * would invalidate the copy Pi has stored.
 */

import { buildWindow, clampPercent, degradedResult, displayIdentity, finiteNumber, parseReset, parseResetSeconds, stringValue, windowFromSeconds } from "../model.js";
import { requestJson } from "../http.js";
import { extractChatGptAccountId } from "../auth/jwt.js";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/**
 * @param {Record<string, unknown>} window
 * @param {string} fallbackId
 * @param {number} now
 * @returns {import("../model.js").QuotaWindow | null}
 */
function windowFromRateLimit(window, fallbackId, now) {
  const used = clampPercent(window.used_percent ?? window.usedPercent);
  if (used === null) return null;

  const windowSeconds = finiteNumber(window.limit_window_seconds);
  const derived = windowFromSeconds(windowSeconds);
  const id = windowSeconds === null ? fallbackId : derived.id;
  const label = windowSeconds === null
    ? (fallbackId === "5h" ? "5h window" : "Weekly window")
    : derived.label;

  const explicitReset = parseReset(window.reset_at, now);
  const resets = explicitReset.resetsAt !== null
    ? explicitReset
    : parseResetSeconds(window.reset_after_seconds, now);

  return buildWindow({
    id,
    label,
    usedPercent: used,
    resetsAt: resets.resetsAt,
    windowSeconds,
    now,
  });
}

/**
 * @param {import("../auth/pi-auth.js").PiCredential} credential
 * @param {{ now?: number, fetchFn?: typeof fetch, timeoutMs?: number, expiresInMin?: number | null }} [options]
 * @returns {Promise<import("../model.js").QuotaResult>}
 */
export async function fetchQuota(credential, options = {}) {
  const now = options.now ?? Date.now();
  const accountId = credential.accountId ?? (credential.access ? extractChatGptAccountId(credential.access) : null);
  const base = {
    family: "codex",
    label: "Codex (Pi)",
    account: displayIdentity({ ...credential, accountId }),
    plan: credential.planType,
    source: credential.source,
    sourceKind: credential.sourceKind ?? "pi",
    expiresInMin: options.expiresInMin ?? null,
  };

  if (!credential.access) {
    return degradedResult({ ...base, error: "Pi store has no openai-codex access token; run /login openai-codex in Pi" });
  }

  /** @type {Record<string, string>} */
  const headers = {
    Authorization: `Bearer ${credential.access}`,
    accept: "application/json",
    originator: "codex_cli_rs",
  };
  if (accountId) headers["chatgpt-account-id"] = accountId;

  const response = await requestJson(USAGE_URL, { headers, fetchFn: options.fetchFn, timeoutMs: options.timeoutMs });
  if (!response.ok) {
    const error = response.authError
      ? "Codex token expired or rejected; use any Codex model in Pi to refresh it"
      : `Codex usage request failed: ${response.error}`;
    return degradedResult({ ...base, error });
  }

  const body = record(response.body) ?? {};
  const rateLimit = record(body.rate_limit) ?? {};
  const plan = stringValue(body.plan_type) ?? credential.planType ?? null;

  /** @type {import("../model.js").QuotaWindow[]} */
  const windows = [];
  const primary = record(rateLimit.primary_window);
  const secondary = record(rateLimit.secondary_window);
  if (primary) {
    const window = windowFromRateLimit(primary, "5h", now);
    if (window) windows.push(window);
  }
  if (secondary) {
    const window = windowFromRateLimit(secondary, "weekly", now);
    if (window) windows.push(window);
  }

  const credits = record(body.credits);
  if (credits && credits.has_credits === true && credits.unlimited !== true) {
    const balance = finiteNumber(credits.balance);
    if (balance !== null && balance > 0) {
      windows.push(
        buildWindow({
          id: "credits",
          label: "Credits",
          usedPercent: null,
          remainingPercent: null,
          note: `${balance} credits available`,
          now,
        }),
      );
    }
  }

  if (windows.length === 0) {
    return degradedResult({
      ...base,
      plan,
      error: "Codex usage response had no primary/secondary window (API shape may have changed)",
    });
  }

  return {
    ...base,
    plan,
    windows,
    error: null,
    ok: true,
    updatedAt: new Date(now).toISOString(),
  };
}
