# pi-quota

One source of truth for quota: **the credentials Pi already owns**.

`pi-quota` is a standalone project. It does not import, invoke or modify
shuvquota, and it never writes to a credential file.

| Surface | Command |
| --- | --- |
| Terminal | `piquota` · `piquota --json` · `piquota --status` |
| Pi TUI | `/quota` · `/usage` |
| Moshi Usages tab | `piquota moshi push` (or the `moshi watch` user service) |

## Hard guarantees

* `~/.pi/agent/auth.json` is opened with `flag: "r"`. Never written, synced or
  refreshed. Verified with a checksum before and after every run.
* No token, refresh token, API key, session cookie or `sessionKey` is printed,
  logged, cached, or sent anywhere. E-mail identities are redacted in every
  artifact.
* Antigravity's access token **may** be refreshed, but only in memory. Google
  does not rotate that refresh token, so Pi's stored copy stays valid. Claude and
  Codex are never refreshed, because they **do** rotate and persisting a rotated
  token would break Pi.
* Browser cookie databases are copied to a private temp dir and opened
  read-only. This is only used to fetch the opencode.ai session cookie that Pi
  does not store.
* `/quota` never injects quota into the LLM context: the extension only calls
  `ui.setStatus`, `ui.setWidget` and `ui.notify`.

## Status, verified against the live APIs

| Provider | Source | Endpoint | Result |
| --- | --- | --- | --- |
| Claude | `anthropic.access` | `GET api.anthropic.com/api/oauth/usage` | ✅ 5h + weekly |
| Codex | `openai-codex.access` + `accountId` | `GET chatgpt.com/backend-api/wham/usage` | ✅ 5h + weekly + plan |
| Antigravity | `antigravity.access` + `projectId` | `POST cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` | ✅ Gemini + Claude/GPT buckets, **with in-memory refresh** |
| OpenCode Go | opencode.ai session cookie | `GET opencode.ai/workspace/<id>/go` | ✅ weekly + monthly, verified live |

Three findings worth recording, each of which cost a wrong hypothesis:

1. **Antigravity needs the CLI `User-Agent`.** Without
   `User-Agent: antigravity/cli/...` the backend answers
   `403 You do not have a valid license of this product` for a healthy token.
2. **Pi's `opencode-go` entry is an OpenCode Zen API key, not a Go session.** It
   validates (`/zen/v1/models` → 200, 70 models) but exposes no usage, and every
   `/api/*` path on opencode.ai returns 404: the Go windows only exist in the
   authenticated SSR page.
3. **Moshi validates the `agent` field against a closed union of six values**
   (`claude-code`, `codex`, `opencode`, `kimi`, `grok`, `antigravity`). A custom
   `"pi"` agent is rejected with HTTP 422, so the Pi provenance is carried by
   `accountLabel` (`"Codex (Pi)"`) and the card keeps Moshi's own logo.

## Prerequisites & Installation

* **Node.js >= 20.0.0** (native `node:sqlite` and global `fetch` support; zero npm dependencies).
* **[Pi Coding Agent](https://github.com/earendil-works/pi)** (`pi`).
* **[Gentle AI](https://github.com/Gentleman-Programming/gentle-pi)** (`gentle-pi`).
* **[Moshi](https://getmoshi.app)** (`moshi-hook`) *(optional — only needed if syncing to the Moshi mobile app)*:
  - Install daemon & CLI: `curl -fsSL https://getmoshi.app/install | bash`
  - Pair your host: `moshi-hook pair`
  - Run daemon: `moshi-hook service install` or `moshi-hook serve`
  - *(Without Moshi, `piquota` in terminal and the Pi TUI extension work 100% locally)*.
* Platform support: Linux, WSL2, macOS. See [docs/OS-COMPATIBILITY.md](docs/OS-COMPATIBILITY.md) for OS-specific details.

### 1-Line Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/J3fp/piQuota/main/install.sh | bash
```

### Manual Install / Development

```bash
git clone https://github.com/J3fp/piQuota.git
cd piQuota
./install.sh              # --link for development, --uninstall to remove
```

No sudo. Copies the project to `~/.local/share/pi-quota`, symlinks
`~/.local/bin/piquota`, installs the Pi extension, and removes the previous
generation's `shuvquota` shim so upstream `/usr/bin/shuvquota` is reachable again.

## Commands

```bash
piquota                 # boxed panel: ring, bar, % left, "reset in 3h 12m"
piquota --json          # normalized report
piquota --compact       # one line per provider
piquota --status        # single line with rings, for status bars
piquota --explain       # which stores and fields are read (names only)

piquota auth status             # every credential source, including opencode.ai
piquota auth opencode           # open the login in Firefox and capture the session
piquota auth opencode --paste   # read the cookie from stdin instead
piquota auth opencode --no-browser
piquota auth opencode --wait 300

piquota moshi status            # pairing + usage-collection state
piquota moshi push              # publish once to the paired host, then exit
piquota moshi watch             # publish every 60s
piquota moshi artifact          # write the local JSON artifact
piquota moshi service install|uninstall|status
```

Colours: green above 50% remaining, yellow 20–50%, red below 20%.

**Which window the ring shows:** always the **shortest** one (5h/session first,
then daily, weekly, monthly), because that is the limit you hit first. A weekly
window at 31% left is more consumed, but a 5h window at 97% is what answers "can
I keep working right now". Ties inside the same rank go to the tightest window,
so Antigravity's two 5h groups resolve to whichever is more consumed. The rule
lives in `selectPrimaryWindow()` (`src/model.js`), the CLI stamps
`primaryWindowId` into the report, and the Pi extension reads that field, so the
terminal and the TUI cannot disagree. The full panel still lists every window,
so nothing is hidden.

Inside Pi:

| Command | Effect |
| --- | --- |
| `/quota` | refresh, reveal the panel, notify a one-line summary |
| `/quota line` | pin the compact line above the editor, in its own row |
| `/quota panel` | full boxed panel above the editor |
| `/quota hide` | hide the panel/line |
| `/quota status` / `nostatus` | enable/disable the footer status |
| `/quota refresh` | refresh only |
| `/quota json` | where the cached report lives |
| `/usage` | alias of `/quota` |

### The Pi line

By default the extension pins **one row above the editor**:

```
Claude:○ 0%  Codex:○ 8%  Agy:○ 4%  OP-Go:○ 4%
```

* each name is painted with its **own brand colour** — Claude `#D97757`, Codex
  `#10A37F`, Antigravity `#4285F4`, OpenCode `#007AFF`;
* the numbers are **used**, not remaining, and the semaphore is both colour and
  shape (`○` plenty left → `◔` → `◕` → `●` nearly spent), so it still reads on a
  colourblind or mono terminal;
* **only active providers are shown:** if you only have Claude and Codex configured
  in Pi, only Claude and Codex appear in the line and on Moshi (no empty warning
  icons for providers you don't use);
* `NO_COLOR` / `TERM=dumb` drops the colours and keeps the glyphs;
* the window shown is the **shortest** one (5h first), and `/quota` expands every
  window with a used-fraction bar and the reset countdown.

Pi's theme only exposes a fixed palette, so brand colours are emitted as
truecolor ANSI. Widget string arrays are wrapped in `Text` components by Pi,
which are ANSI-aware, so the codes are measured correctly and `theme.fg()` keeps
working in the same strings.

### Why the footer is off by default

gentle-pi replaces the footer with its own shell bar (`setFooter`) and that bar
drops segments **from the end** when the line overflows:

```js
while (segments.length > 1 && visibleWidth(left) > width) segments.pop();
```

Extension statuses render last, so a footer status is the first thing discarded —
which is why a long status line appears and then vanishes once the bar fills with
cost, branch and usage data. The quota line therefore lives in its own row, where
nothing competes for it. `/quota status` still enables the footer variant for
anyone who wants it.

## Moshi: real cards in the Usages tab

`piquota moshi push` posts to **your own paired host channel**:

```
POST {base}/hosts/{hostId}/usage
Authorization: Bearer secret_<host-secret>
{"snapshots":[{accountId,accountLabel,agent,hostName,capturedAt,
               windows:[{label,usedPercentage,resetsAt}]}]}
```

`accountLabel` is `"Claude (Pi)"`, `"Codex (Pi)"`, `"Antigravity (Pi)"`,
`"OpenCode Go (Pi)"`. Only percentages, window labels, reset timestamps and plan
names are sent — never a credential or an e-mail address.

The publisher respects moshi-hook's own `usage_collection` setting: if you turn
collection off, `moshi watch` pauses instead of pushing behind your back.

`piquota moshi watch` decouples the two cadences: it **pushes every 60s** but only
**refetches every 300s** (`--fetch-ttl`), so the provider APIs are not polled once
per push. That matters in practice: Anthropic's usage endpoint starts answering
`429` if it is polled every minute, and a card would drop off the screen because
of a transient error. On top of that, a transient failure keeps the previous
snapshot instead of degrading (`src/moshi/sticky.js`); a *permanent* one (expired
sign-in, missing credential) is never masked.

`piquota moshi service install` runs `moshi watch` as a systemd **user** service
(`pi-quota-moshi.service`). Full protocol notes, including how the endpoint and
schema were recovered: [docs/MOSHI.md](docs/MOSHI.md).

## Layout

```
src/auth/pi-auth.js            read-only auth.json reader, WSL + Linux, deduplicated
src/auth/jwt.js                Codex JWT payload reader (claim keys contain dots)
src/browser/cookies.js         read-only Firefox/Chromium cookie access via a temp copy
src/opencode/session.js        cookie + workspace resolution, dashboard fetch
src/opencode/dashboard.js      three-strategy parser for the Go plan page
src/providers/*.js             one file per provider; each degrades instead of throwing
src/providers/antigravity-oauth.js  in-memory refresh with Google's public client
src/moshi/client.js            paired-host publisher
src/moshi/artifact.js          local Moshi-shaped artifact, identities redacted
src/moshi/settings.js          reads moshi-hook's usage_collection setting
src/engine.js                  collectQuota() -> one normalized report
src/model.js                   window normalization, percent and reset parsing
src/render/{theme,panel}.js    colors, thresholds, rings, bars, boxed panel
src/cache.js                   60s TTL cache at ~/.cache/pi-quota/usage.json
bin/piquota.js                 the only CLI
extensions/quota-panel.ts      Pi TUI extension
```

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `no <family> credential in the Pi store` | Not logged in to Pi for that provider. `/login <provider>` in Pi. |
| `rate limited (HTTP 429); retry in Ns` | The vendor throttled the usage endpoint. Wait, or raise `--ttl`. |
| `Antigravity token rejected` | Refresh failed; `/login antigravity` in Pi. `--no-refresh` disables the attempt. |
| `no "auth" cookie for opencode.ai in N readable store(s)` | Run `piquota auth opencode`, or paste the cookie. |
| `only encrypted Chromium stores found` | Log in with Firefox; Chrome on Windows uses DPAPI. |
| `moshi push failed: ... rejected the host secret` | `moshi-hook pair` again. |
| `moshi-hook is not paired` | Only `moshi artifact` works until you pair. |
| `unknown argument` | `piquota --help` lists every flag. |

## Tests

```bash
node --test tests/*.test.mjs     # 97 tests, fake tokens only, no network
```

Modules covered: `auth.json` parsing and de-duplication, the four providers
(including the two Antigravity failures and the OpenCode degradation), the
dashboard parser's three strategies, the Firefox cookie reader against a
synthetic SQLite database, the Antigravity refresh (in-memory only), the Moshi
payload/redaction/transport, the renderers, and the Pi extension contract.

## Acknowledgments & Prior Art

* **[shuvquota](https://github.com/shuv1337/shuvquota)** by [@shuv1337](https://github.com/shuv1337):
  Huge credit to `shuvquota` for pioneering multi-provider terminal quota monitoring across AI services. Its approach to rate-limit endpoints, dashboard parsing patterns for OpenCode Go, and terminal quota concepts served as inspiration for this project.

  `piQuota` was built as a standalone, strictly read-only implementation designed specifically around [Pi Coding Agent](https://github.com/earendil-works/pi) credentials (`~/.pi/agent/auth.json`), Gentle AI orchestration, and direct Moshi mobile synchronization.
