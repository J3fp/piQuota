/**
 * Read-only JWT payload decoding.
 *
 * Pi stores the OpenAI Codex access token as a signed JWT whose payload already
 * carries the account id, plan type and email. We decode the payload for
 * identification only; the signature is never verified and the token is never
 * rewritten.
 */

/**
 * @param {string} token
 * @returns {Record<string, unknown> | null}
 */
export function decodeJwtPayload(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const padded = parts[1] + "=".repeat((4 - (parts[1].length % 4)) % 4);
    const json = Buffer.from(padded, "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Read a nested field from the payload. Keys are passed as a list on purpose:
 * OAuth claim names contain dots (`https://api.openai.com/auth`), so splitting a
 * dotted path would break on the very keys we need.
 *
 * @param {Record<string, unknown> | null} source
 * @param {string[]} keys
 * @returns {unknown}
 */
function readPath(source, keys) {
  if (!source) return undefined;
  return keys.reduce((current, key) => {
    if (current && typeof current === "object") {
      return /** @type {Record<string, unknown>} */ (current)[key];
    }
    return undefined;
  }, /** @type {unknown} */ (source));
}

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const OPENAI_PROFILE_CLAIM = "https://api.openai.com/profile";

/**
 * @param {string} token
 * @returns {string | null}
 */
export function extractChatGptAccountId(token) {
  const value = readPath(decodeJwtPayload(token), [OPENAI_AUTH_CLAIM, "chatgpt_account_id"]);
  return typeof value === "string" && value ? value : null;
}

/**
 * @param {string} token
 * @returns {string | null}
 */
export function extractChatGptPlanType(token) {
  const value = readPath(decodeJwtPayload(token), [OPENAI_AUTH_CLAIM, "chatgpt_plan_type"]);
  return typeof value === "string" && value ? value : null;
}

/**
 * @param {string} token
 * @returns {string | null}
 */
export function extractEmail(token) {
  const value = readPath(decodeJwtPayload(token), [OPENAI_PROFILE_CLAIM, "email"]);
  return typeof value === "string" && value ? value : null;
}

/**
 * @param {string} token
 * @returns {number | null} Expiry as epoch milliseconds.
 */
export function extractExpiresAtMs(token) {
  const value = readPath(decodeJwtPayload(token), ["exp"]);
  return typeof value === "number" && Number.isFinite(value) ? value * 1000 : null;
}
