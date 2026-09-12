/**
 * Quota collection engine.
 *
 * Loads Pi credentials (read-only), asks each provider for its windows and
 * returns one normalized report. Providers never throw: a failure becomes a
 * degraded result with an actionable message.
 */

import { checkFreshness, LABEL_BY_FAMILY, loadPiCredentials, resolveAuthPaths } from "./auth/pi-auth.js";
import { degradedResult, displayIdentity, selectPrimaryWindow } from "./model.js";
import { backoffState, clearBackoff, isThrottled, recordBackoff, retryAfterFromError } from "./providers/backoff.js";
import { fetchQuota as fetchClaude } from "./providers/claude.js";
import { fetchQuota as fetchCodex } from "./providers/codex.js";
import { fetchQuota as fetchAntigravity } from "./providers/antigravity.js";
import { fetchQuota as fetchOpenCodeGo } from "./providers/opencode-go.js";

/** Canonical family order used by every surface. */
export const FAMILIES = ["claude", "codex", "antigravity", "opencode-go"];

/** @type {Record<string, (credential: any, options?: any) => Promise<import("./model.js").QuotaResult>>} */
const PROVIDERS = {
  claude: fetchClaude,
  codex: fetchCodex,
  antigravity: fetchAntigravity,
  "opencode-go": fetchOpenCodeGo,
};

/**
 * @typedef {Object} PiQuotaReport
 * @property {string} engine
 * @property {number} schemaVersion
 * @property {true} readOnly
 * @property {string} generatedAt
 * @property {string[]} sources               Pi auth stores that were read.
 * @property {string[]} warnings
 * @property {import("./model.js").QuotaResult[]} providers   Flattened, family-ordered.
 * @property {Record<string, import("./model.js").QuotaResult[]>} byFamily
 */

/**
 * @param {{
 *   families?: string[],
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   platform?: string,
 *   usersRoot?: string,
 *   paths?: string[],
 *   now?: number,
 *   fetchFn?: typeof fetch,
 *   timeoutMs?: number,
 *   refresh?: boolean,
 *   stores?: import("./browser/cookies.js").CookieStore[],
 *   allowBrowser?: boolean,
 * }} [options]
 * @returns {Promise<PiQuotaReport>}
 */
export async function collectQuota(options = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const families = options.families ?? FAMILIES;

  const loaded = loadPiCredentials({
    env,
    home: options.home,
    platform: options.platform,
    usersRoot: options.usersRoot,
    paths: options.paths,
  });

  /** @type {Record<string, import("./model.js").QuotaResult[]>} */
  const byFamily = {};
  /** @type {string[]} */
  const warnings = [...loaded.warnings];

  await Promise.all(
    families.map(async (family) => {
      const credentials = loaded.credentials.filter((credential) => credential.family === family);
      if (credentials.length === 0) {
        byFamily[family] = [
          degradedResult({
            family,
            label: LABEL_BY_FAMILY[family] ?? family,
            error: `no ${family} credential in the Pi store`,
            source: loaded.paths[0] ?? resolveAuthPaths({ env, home: options.home })[0] ?? "~/.pi/agent/auth.json",
            now,
          }),
        ];
        return;
      }

      // A family that is currently throttled is skipped entirely, so the
      // caller's sticky layer can republish the previous good snapshot instead
      // of adding more pressure to a rate-limited endpoint.
      const throttle = backoffState(family, { now, env, home: options.home });
      if (throttle.active) {
        byFamily[family] = [
          degradedResult({
            family,
            label: LABEL_BY_FAMILY[family] ?? family,
            // Keep the identity visible while paused: "unknown" on screen is
            // worse than a stale-but-labelled account.
            account: displayIdentity(credentials[0]),
            error: `backing off after a throttle: next attempt in ${throttle.secondsLeft}s`,
            source: credentials[0].source,
            now,
          }),
        ];
        return;
      }

      /** @type {import("./model.js").QuotaResult[]} */
      const results = [];
      for (const credential of credentials) {
        const freshness = checkFreshness(credential, now);
        if (!freshness.fresh) {
          warnings.push(
            `${family}: Pi token expired ${Math.abs(freshness.expiresInMin ?? 0)}m ago; use that provider in Pi to refresh it`,
          );
        }
        const fetchQuota = PROVIDERS[family];
        try {
          const result = await fetchQuota(credential, {
            now,
            fetchFn: options.fetchFn,
            timeoutMs: options.timeoutMs,
            expiresInMin: freshness.expiresInMin,
            env,
            home: options.home,
            refresh: options.refresh,
            stores: options.stores,
            allowBrowser: options.allowBrowser,
          });
          if (isThrottled(result.error)) {
            const seconds = recordBackoff(family, {
              retryAfterSec: retryAfterFromError(result.error),
              now,
              env,
              home: options.home,
            }).seconds;
            warnings.push(`${family}: throttled upstream; pausing that family for ${seconds}s`);
          } else if (result.ok) {
            clearBackoff(family, { env, home: options.home });
          }
          results.push(result);
        } catch (error) {
          // A provider must never take the whole report down.
          results.push(
            degradedResult({
              family,
              label: credential.label,
              account: credential.email ?? credential.accountId ?? "unknown",
              error: `provider crashed: ${/** @type {{ message?: string }} */ (error)?.message ?? String(error)}`,
              source: credential.source,
              now,
              expiresInMin: freshness.expiresInMin,
            }),
          );
        }
      }
      byFamily[family] = results;
    }),
  );

  const providers = families.flatMap((family) => byFamily[family] ?? []);

  // Stamp the primary window so the terminal, the Pi TUI and the Moshi adapter
  // all agree on which window represents a provider, with no duplicated rules.
  for (const provider of providers) {
    provider.primaryWindowId = selectPrimaryWindow(provider.windows ?? [])?.id ?? null;
  }

  return {
    engine: "pi-quota",
    schemaVersion: 1,
    readOnly: true,
    generatedAt: new Date(now).toISOString(),
    sources: loaded.paths,
    warnings,
    providers,
    byFamily,
  };
}

/**
 * Convenience accessor used by the renderers.
 *
 * @param {PiQuotaReport} report
 * @returns {import("./model.js").QuotaResult | null}
 */
export function firstForFamily(report, family) {
  return report.byFamily[family]?.[0] ?? null;
}
