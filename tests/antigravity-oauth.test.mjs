/**
 * Antigravity refresh tests.
 *
 * The refresh is the only place this project performs a write-like action, so
 * the tests assert it (a) works, (b) stays in memory, and (c) never touches a
 * credential file.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { describeOAuthClient, ensureFreshAccessToken, extractClientFromPiAntigravity, refreshAccessToken, resolveOAuthClient } from "../src/providers/antigravity-oauth.js";
import { jsonResponse, routedFetch } from "./helpers.mjs";

/** Writes a file shaped like pi-antigravity's obfuscated literals. */
function fakePiAntigravity() {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-agy-"));
  const path = join(dir, "oauth.ts");
  const clientId = "1071006060591-fixture.apps.googleusercontent.com";
  const clientSecret = "fixture-client-secret-val";
  const split = (value) => {
    const encoded = Buffer.from(value, "utf-8").toString("base64");
    const half = Math.ceil(encoded.length / 2);
    return `atob("${encoded.slice(0, half)}" + "${encoded.slice(half)}")`;
  };
  writeFileSync(
    path,
    `export const CLIENT_ID = antigravityEnv("CLIENT_ID") ||\n  ${split(clientId)};\n` +
      `export const CLIENT_SECRET =\n  antigravityEnv("CLIENT_SECRET") || ${split(clientSecret)};\n`,
  );
  return { path, clientId, clientSecret };
}

test("the OAuth client is recovered from the installed pi-antigravity package", () => {
  const fixture = fakePiAntigravity();
  const extracted = extractClientFromPiAntigravity(fixture.path);
  assert.ok(extracted);
  assert.equal(extracted.clientId, fixture.clientId);
  assert.equal(extracted.clientSecret, fixture.clientSecret);
});

test("a missing or malformed package yields null instead of throwing", () => {
  assert.equal(extractClientFromPiAntigravity("/definitely/not/here.ts"), null);
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-agy-bad-"));
  const path = join(dir, "oauth.ts");
  writeFileSync(path, "export const CLIENT_ID = atob(\"@@@\");");
  assert.equal(extractClientFromPiAntigravity(path), null);
});

test("client resolution prefers the environment, then the package, then the builtin", () => {
  const fixture = fakePiAntigravity();
  const fromEnv = resolveOAuthClient({ env: { ANTIGRAVITY_CLIENT_ID: "id-env", ANTIGRAVITY_CLIENT_SECRET: "secret-env" }, sourcePath: fixture.path });
  assert.equal(fromEnv.source, "env");
  assert.equal(fromEnv.clientId, "id-env");

  const fromPackage = resolveOAuthClient({ env: {}, sourcePath: fixture.path });
  assert.equal(fromPackage.source, "pi-antigravity");

  const builtin = resolveOAuthClient({ env: {}, sourcePath: "/nope.ts" });
  assert.equal(builtin.source, "builtin");
  assert.match(builtin.clientId, /apps\.googleusercontent\.com$/);
});

test("describeOAuthClient explains where the client came from", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-agy-desc-"));
  const path = join(dir, "oauth.ts");
  writeFileSync(path, "export const x = 1;");
  assert.match(describeOAuthClient({ client: resolveOAuthClient({ env: {}, sourcePath: path }) }), /builtin public Google/);
});

test("a refresh returns rotated tokens without writing anything", async () => {
  let authHeader = null;
  const { fetchFn, calls } = routedFetch([
    [
      "oauth2.googleapis.com",
      (_url, init) => {
        authHeader = init.body;
        return jsonResponse({ access_token: "ya29.new", expires_in: 3600 });
      },
    ],
  ]);

  const result = await refreshAccessToken("1//refresh", {
    client: { clientId: "id", clientSecret: "secret" },
    fetchFn,
  });
  assert.equal("error" in result, false);
  assert.equal(/** @type {{ access: string }} */ (result).access, "ya29.new");
  assert.equal(/** @type {{ refresh: string }} */ (result).refresh, "1//refresh");
  assert.ok(authHeader.includes("grant_type=refresh_token"));
  assert.equal(calls.length, 1);
});

test("a failed refresh reports an error instead of throwing", async () => {
  const { fetchFn } = routedFetch([["oauth2.googleapis.com", () => jsonResponse({ error: "invalid_grant" }, { status: 400 })]]);
  const result = await refreshAccessToken("1//refresh", { client: { clientId: "id", clientSecret: "secret" }, fetchFn });
  assert.equal("error" in result, true);
  assert.match(/** @type {{ error: string }} */ (result).error, /token refresh failed/);

  assert.equal("error" in (await refreshAccessToken("", { fetchFn })), true);
});

test("ensureFreshAccessToken mutates the in-memory account only", async () => {
  const { fetchFn } = routedFetch([["oauth2.googleapis.com", () => jsonResponse({ access_token: "ya29.fresh", expires_in: 3600 })]]);
  const account = { access: "ya29.stale", refresh: "1//keep", expiresAtMs: 1 };

  const result = await ensureFreshAccessToken(account, { fetchFn, now: 1_800_000_000_000, client: { clientId: "id", clientSecret: "secret" } });
  assert.equal(result.ok, true);
  assert.equal(result.refreshed, true);
  assert.equal(account.access, "ya29.fresh");
  assert.equal(account.refresh, "1//keep");
  assert.ok(/** @type {number} */ (account.expiresAtMs) > 1_800_000_000_000);
});

test("a still-fresh token is left alone", async () => {
  const { fetchFn, calls } = routedFetch([]);
  const account = { access: "ya29.ok", refresh: "1//keep", expiresAtMs: 1_800_000_000_000 + 3_600_000 };
  const result = await ensureFreshAccessToken(account, { fetchFn, now: 1_800_000_000_000 });
  assert.equal(result.refreshed, false);
  assert.equal(calls.length, 0);
});

test("refresh can be disabled, and then degrades without calling out", async () => {
  const { fetchFn, calls } = routedFetch([]);
  const account = { access: "ya29.stale", refresh: "1//keep", expiresAtMs: 1 };
  const result = await ensureFreshAccessToken(account, { fetchFn, now: 1_800_000_000_000, enabled: false });
  assert.equal(result.refreshed, false);
  assert.equal(result.error, "refresh disabled");
  assert.equal(calls.length, 0);
});

test("a credential file placed next to the test is never the one we read or write", () => {
  // Guard rail: the module must not know about ~/.pi at all.
  const source = readFileSync(new URL("../src/providers/antigravity-oauth.js", import.meta.url), "utf-8");
  assert.equal(source.includes(".pi/agent/auth.json"), false);
  assert.equal(/writeFileSync|appendFileSync|renameSync|unlinkSync/.test(source), false);
});
