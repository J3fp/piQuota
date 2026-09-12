# Moshi integration

How Pi quota reaches the Moshi **Usages** tab, and why it takes this shape.

Everything below was recovered from the installed `moshi-hook 0.3.21` by
observation, because the application is closed source (the Go symbols reference
`github.com/rjyo/moshi/app-hook/...`, which is not public — `404`).

## The contract

moshi-hook uploads rate-limit snapshots to its own API with the **host secret**
from its own pairing store:

```
POST {base}/hosts/{hostId}/usage
Authorization: Bearer secret_<host-secret>
Content-Type: application/json

{
  "snapshots": [
    {
      "accountId":   "pi:codex",
      "accountLabel": "Codex (Pi)",
      "agent":       "codex",
      "hostName":    "your-host",
      "capturedAt":  "2026-09-12T16:50:46Z",
      "windows": [
        { "label": "5h window",     "usedPercentage": 19.46, "resetsAt": "2026-09-12T13:10:17Z" },
        { "label": "Weekly window", "usedPercentage": 3 }
      ]
    }
  ]
}
```

Observed details that matter:

* `base` defaults to `https://api.getmoshi.app/api/v1`
  (`MOSHI_API_BASE` overrides it).
* `hostId` and `hostSecret` live in `~/.local/state/moshi/secrets.json` under
  `host-id` and `host-secret`.
* `usedPercentage` is the percentage **used**, not remaining.
* Timestamps use **second precision** (`2026-09-18T09:59:59Z`), so millis are
  stripped.
* `resetsAt` is optional; omit it when the provider does not report one.
* There is no read-back endpoint: `GET /hosts/<id>/usage` answers `404`. A `200`
  on the POST is the only confirmation available.

## `agent` is a closed union

The server validates `agent` and rejects anything else:

```
HTTP 422 {"property":"/snapshots/0/agent","message":"Expected union value",
          "summary":"Property 'snapshots.0.agent' should be one of: 'string' x6"}
```

Probing each candidate (with a deliberately invalid window, so nothing was ever
accepted) yields the exact six members:

| Accepted | Rejected |
| --- | --- |
| `claude-code`, `codex`, `opencode`, `kimi`, `grok`, `antigravity` | `pi`, `claude_code`, `gemini`, `cursor`, `qwen`, `omp`, `hermes`, `kimi-code`, `opencode-go` |

So a Pi-specific agent card cannot be registered from the client. The mapping
used here keeps Moshi's own logo and puts the provenance in the label, which is
the field designed for it:

| Pi family | `agent` | `accountLabel` |
| --- | --- | --- |
| claude | `claude-code` | `Claude (Pi)` |
| codex | `codex` | `Codex (Pi)` |
| antigravity | `antigravity` | `Antigravity (Pi)` |
| opencode-go | `opencode` | `OpenCode Go (Pi)` |

`accountId` is `pi:<family>` (and `pi:<family>:2`, `:3` for extra accounts), so a
card is stable across runs and never derived from a secret.

## Which paths are *not* used, and why

| Path | Why not |
| --- | --- |
| `POST /hosts/<id>/events` | Agent-event transport. Verified to carry `contextRemaining` but **no rate limits**: six candidate field names (`rateLimits`, `rateLimitsByLimitId`, `rateLimit`, `limits`, `windows`, `usage`) were sent through the socket and none reached the event body. It is a notification channel. |
| WebSocket `GET /hosts/<id>/connect` | Only carries `{"type":"hello"}` and `activity` presence (`agent_state_update`). |
| moshi-hook's usage fetchers | A closed set (claude/codex/kimi/grok/antigravity) reading each CLI's own credential file — `usage fetcher: provider credentials not configured agent=<x>`. There is no `pi` fetcher and no plugin API: every `plugin` string in the binary refers to hook **installation** targets. |
| Writing `~/.codex/auth.json` or `~/.claude/.credentials.json` | Would make moshi-hook's own fetchers work, but it means writing credential files. Excluded by the project's rules. |
| `moshi-*-rl.json` cache files | Undocumented shape, and only read by moshi-hook for its own fetchers. |

## Respecting the user's settings

`moshi-hook set usage-collection off` must also silence this publisher, so
`piquota moshi watch` reads `~/.config/moshi/config.toml` before every cycle and
pauses when collection is off (`on`/`off`/`true`/`false`/duration are all
understood). `--force` overrides it for a single artifact write.

## Cadence and transient failures

Two mechanisms keep the cards from flickering:

* **Decoupled cadence.** `moshi watch --interval 60 --fetch-ttl 300` pushes every
  minute but only refetches every five. Polling Anthropic's usage endpoint once a
  minute makes it answer `429`, which is how a card disappears for a reason that
  has nothing to do with the provider being exhausted.
* **Sticky snapshots.** When a fresh fetch fails *transiently* (`429`, `5xx`,
  timeout, network), the previous good snapshot is republished and the report
  carries a `reused the previous snapshot for: <family>` warning. A permanent
  failure (expired sign-in, missing credential, rejected session) is passed
  through unchanged, because hiding it would be misleading.

Verified: a run right after a throttled Claude poll logs
`published 4 provider(s) (cached)`.

## The local artifact

`piquota moshi artifact` writes `~/.local/state/pi-quota/moshi-usage.json`
(mode `0600`) with the same snapshots plus a `windows[].kind` alias. It is a
diagnostic and a no-push fallback; the paired POST is the real delivery path.
Identities are redacted to `jo***@example.com` in the artifact, because it is a
file that can be copied around, unlike the push which goes to the user's own
device.

## Operating it

```bash
piquota moshi status            # pairing, base url, usage-collection, artifact
piquota moshi push              # one-shot
piquota moshi watch --interval 60
piquota moshi service install   # systemd --user, Restart=always
piquota moshi service uninstall
```

Verified live: `piquota moshi push` → `published 3 snapshot(s)`, and the service
(`pi-quota-moshi.service`) logs one publish per interval.

## Upstream suggestion

The one change that would remove the cookie requirement and the agent mapping
entirely is a first-class `pi` fetcher in moshi-hook reading
`~/.pi/agent/auth.json`:

* Codex: `access` (account id in the `https://api.openai.com/auth` claim) →
  `GET chatgpt.com/backend-api/wham/usage`, headers `chatgpt-account-id`,
  `originator: codex_cli_rs`; windows are `rate_limit.primary_window` /
  `secondary_window`.
* Claude: `access` → `GET api.anthropic.com/api/oauth/usage`, headers
  `anthropic-version: 2023-06-01`, `anthropic-beta: oauth-2025-04-20`; windows are
  `five_hour` / `seven_day`.
* Antigravity: `access` + `projectId` →
  `POST cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`, body
  `{"project": projectId}`. **The `User-Agent: antigravity/cli/...` header is
  mandatory** or the backend answers 403.

Read-only, no refresh (Claude and OpenAI rotate their refresh tokens and
persisting one would break Pi).
