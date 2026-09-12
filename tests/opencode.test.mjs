/**
 * OpenCode tests: dashboard parsing and session/cookie resolution.
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findWorkspaceIds, htmlToText, parseGoDashboard, parsePercent, parseResetSeconds } from "../src/opencode/dashboard.js";
import { readFirefoxCookies } from "../src/browser/cookies.js";
import { configPaths, resolveCookie, writeSecretFile } from "../src/opencode/session.js";

const NOW = 1_800_000_000_000;

test("dashboard: renders data-slot usage items into canonical windows", () => {
  const html = `
    <div data-slot="usage-item">
      <span data-slot="usage-label">Rolling usage</span>
      <span data-slot="usage-value">42.5%</span>
      <span data-slot="reset-time">Resets in 2 hours 30 minutes</span>
    </div>
    <div data-slot="usage-item">
      <span data-slot="usage-label">Weekly usage</span>
      <span data-slot="usage-value">71%</span>
      <span data-slot="reset-time">Resets in 3 days</span>
    </div>
    <div data-slot="usage-item">
      <span data-slot="usage-label">Monthly usage</span>
      <span data-slot="usage-value">88%</span>
      <span data-slot="reset-time">Resets in 12 days</span>
    </div>`;
  const parsed = parseGoDashboard(html, { now: NOW });

  assert.deepEqual(parsed.windows.map((window) => window.id), ["5h", "weekly", "monthly"]);
  assert.equal(parsed.windows[0].usedPercent, 42.5);
  assert.equal(parsed.windows[0].remainingPercent, 57.5);
  assert.equal(parsed.windows[0].resetsInSec, 9000);
  assert.equal(parsed.windows[1].resetsInSec, 259200);
  assert.deepEqual(parsed.strategies, ["usage-item"]);
});

test("dashboard: falls back to hydration state when markup changes", () => {
  const html = `<script>const s={"rollingUsage":{"usagePercent":12,"resetInSec":600},
    "weeklyUsage":{"usagePercent":33,"resetInSec":86000},
    "monthlyUsage":{"usagePercent":44,"resetInSec":900000}};</script>`;
  const parsed = parseGoDashboard(html, { now: NOW });

  assert.deepEqual(parsed.windows.map((window) => window.id), ["5h", "weekly", "monthly"]);
  assert.equal(parsed.windows[0].usedPercent, 12);
  assert.equal(parsed.windows[2].usedPercent, 44);
  assert.deepEqual(parsed.strategies, ["hydration"]);
});

test("dashboard: a page with no recognizable windows returns nothing instead of throwing", () => {
  const parsed = parseGoDashboard("<html><body>Sign in</body></html>", { now: NOW });
  assert.deepEqual(parsed.windows, []);
  assert.deepEqual(parsed.strategies, []);
  assert.deepEqual(parseGoDashboard("", { now: NOW }).windows, []);
  assert.deepEqual(parseGoDashboard(null, { now: NOW }).windows, []);
});

test("dashboard: percentages and reset phrases are parsed defensively", () => {
  assert.equal(parsePercent("42.5%"), 42.5);
  assert.equal(parsePercent(7), 7);
  assert.equal(parsePercent("n/a"), null);
  assert.equal(parsePercent("190%"), 100);

  assert.equal(parseResetSeconds("Resets in 5 hours 10 minutes"), 18600);
  assert.equal(parseResetSeconds("resets in 3 days"), 259200);
  assert.equal(parseResetSeconds("Resets now"), 0);
  assert.equal(parseResetSeconds(""), null);
  assert.equal(parseResetSeconds(1200), 1200);

  assert.equal(htmlToText("<span>42% &amp; more</span>"), "42% & more");
});

test("workspace ids are discovered without picking up route segments", () => {
  const html = `<a href="/workspace/ws_abc12345/go">Go</a><a href="/workspace/settings">s</a>
    <script>{"workspaceId":"ws_zzz99999"}</script>`;
  const ids = findWorkspaceIds(html);
  assert.equal(ids.includes("ws_abc12345"), true);
  assert.equal(ids.includes("ws_zzz99999"), true);
  assert.equal(ids.includes("settings"), false);
});

test("cookie resolution prefers the environment, then the config file, and never a browser scan there", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-oc-"));
  const paths = configPaths({ home, env: {} });

  const empty = resolveCookie({ home, env: {}, stores: [], allowBrowser: false });
  assert.equal(empty.found, false);
  assert.equal(empty.origin, null);

  const written = writeSecretFile(paths.path, "cookie-from-config");
  assert.equal(written.ok, true);
  const fromConfig = resolveCookie({ home, env: {}, stores: [], allowBrowser: false });
  assert.equal(fromConfig.found, true);
  assert.equal(fromConfig.origin, "config");
  assert.equal(fromConfig.value, "cookie-from-config");

  const fromEnv = resolveCookie({ home, env: { OPENCODE_GO_AUTH_COOKIE: "cookie-from-env" } });
  assert.equal(fromEnv.origin, "env");
  assert.equal(fromEnv.value, "cookie-from-env");
});

test("cookie resolution explains why nothing was found", () => {
  const stores = [
    { browser: "chromium", path: "/nope", profile: "windows:Chrome/Default", readability: "encrypted" },
  ];
  const result = resolveCookie({ env: {}, home: "/nonexistent", stores });
  assert.equal(result.found, false);
  assert.equal(result.encryptedOnly, true);
  assert.match(result.detail, /DPAPI/);
});

test("the Firefox reader works on a copied database and is read-only", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-ff-"));
  const db = join(dir, "cookies.sqlite");
  const writer = new DatabaseSync(db);
  writer.exec("create table moz_cookies (host text, name text, value text, path text)");
  writer.prepare("insert into moz_cookies values (?, ?, ?, ?)").run(".opencode.ai", "auth", "session-abc", "/");
  writer.prepare("insert into moz_cookies values (?, ?, ?, ?)").run("example.com", "other", "nope", "/");
  writer.close();

  const rows = readFirefoxCookies(db, { hostLike: "%opencode.ai%", name: "auth" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, "session-abc");
  assert.equal(rows[0].host, ".opencode.ai");

  // A missing database is a clean empty result, never a throw.
  assert.deepEqual(readFirefoxCookies(join(dir, "missing.sqlite"), { hostLike: "%" }), []);
});

test("a malformed browser database does not break the lookup", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-bad-"));
  mkdirSync(dir, { recursive: true });
  const db = join(dir, "cookies.sqlite");
  writeFileSync(db, "not a sqlite database");
  assert.deepEqual(readFirefoxCookies(db, { hostLike: "%" }), []);
});

test("workspace ids are recovered from browser history, newest first", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { extractWorkspaceIds, findRecentWorkspaceIds, pathOnly, readVisitedUrls } = await import("../src/browser/history.js");
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-places-"));
  const db = join(dir, "places.sqlite");
  const writer = new DatabaseSync(db);
  writer.exec("create table moz_places (url text, title text, last_visit_date integer)");
  const insert = writer.prepare("insert into moz_places values (?, ?, ?)");
  insert.run("https://opencode.ai/workspace/wrk_NEWER/go", "go", 2000);
  insert.run("https://opencode.ai/workspace/wrk_OLDER/usage", "usage", 1000);
  insert.run("https://opencode.ai/workspace/settings", "s", 3000);
  insert.run("https://example.com/workspace/wrk_NOTOURS", "x", 4000);
  writer.close();

  const urls = readVisitedUrls(db, { urlLike: "%opencode.ai/workspace/%" });
  assert.deepEqual(extractWorkspaceIds(urls), ["wrk_NEWER", "wrk_OLDER"]);

  const found = findRecentWorkspaceIds({ stores: [{ profile: "test", path: db }] });
  assert.equal(found.ids[0], "wrk_NEWER");
  assert.equal(found.profile, "test");

  // Query strings never survive, so no token can leak through a URL.
  assert.equal(pathOnly("https://opencode.ai/auth/callback?code=secret&state=x"), "/auth/callback");
});

test("a missing history database yields no ids instead of throwing", async () => {
  const { findRecentWorkspaceIds } = await import("../src/browser/history.js");
  const found = findRecentWorkspaceIds({ stores: [{ profile: "test", path: "/definitely/not/here.sqlite" }] });
  assert.deepEqual(found.ids, []);
  assert.equal(found.profile, null);
});

test("the live page labels are matched, including the hyphenated 5-hour window", () => {
  // Verbatim labels from the real dashboard capture.
  const html = `
    <div data-slot="usage-item"><span data-slot="usage-label">5-hour Usage</span>
      <span data-slot="usage-value">1.9%</span>
      <span data-slot="reset-time">Resets in 4 hours 33 minutes</span></div>
    <div data-slot="usage-item"><span data-slot="usage-label">Weekly Usage</span>
      <span data-slot="usage-value">69%</span>
      <span data-slot="reset-time">Resets in 1 day 6 hours</span></div>
    <div data-slot="usage-item"><span data-slot="usage-label">Monthly Usage</span>
      <span data-slot="usage-value">34.5%</span>
      <span data-slot="reset-time">Resets in 10 days 1 hour</span></div>`;

  const parsed = parseGoDashboard(html, { now: NOW });
  assert.deepEqual(parsed.windows.map((window) => window.id), ["5h", "weekly", "monthly"]);
  assert.equal(parsed.windows[0].usedPercent, 1.9);
  assert.equal(parsed.windows[0].remainingPercent, 98.1);
  assert.equal(parsed.windows[0].resetsInSec, 16380);
  assert.equal(parsed.windows[2].usedPercent, 34.5);
});

test("a partial render is completed from the hydration state instead of hiding a window", () => {
  // Only two items are rendered; the 5h window exists only in the serialized state.
  const html = `
    <div data-slot="usage-item"><span data-slot="usage-label">Weekly Usage</span>
      <span data-slot="usage-value">69%</span><span data-slot="reset-time">Resets in 1 day</span></div>
    <div data-slot="usage-item"><span data-slot="usage-label">Monthly Usage</span>
      <span data-slot="usage-value">34.5%</span><span data-slot="reset-time">Resets in 10 days</span></div>
    <script>const s = {"rollingUsage":{"usagePercent":1.9,"resetInSec":16380}};</script>`;

  const parsed = parseGoDashboard(html, { now: NOW });
  assert.deepEqual(parsed.windows.map((window) => window.id), ["5h", "weekly", "monthly"]);
  assert.equal(parsed.windows[0].usedPercent, 1.9);
  assert.deepEqual(parsed.strategies.sort(), ["hydration", "usage-item"]);
});

test("label aliases accept the spellings the plan uses", () => {
  const cases = [
    ["5-hour Usage", "5h"],
    ["5h Usage", "5h"],
    ["5 hr limit", "5h"],
    ["Rolling usage", "5h"],
    ["Five Hour Limit Remaining", "5h"],
    ["Weekly Usage", "weekly"],
    ["7-day limit", "weekly"],
    ["Monthly Usage", "monthly"],
    ["30 day limit", "monthly"],
  ];
  for (const [label, expected] of cases) {
    const html = `<div data-slot="usage-item"><span data-slot="usage-label">${label}</span>
      <span data-slot="usage-value">10%</span><span data-slot="reset-time">Resets in 1 hour</span></div>`;
    const parsed = parseGoDashboard(html, { now: NOW });
    assert.equal(parsed.windows.length, 1, `label ${label}`);
    assert.equal(parsed.windows[0].id, expected, `label ${label}`);
  }
});
