# pi-tiers

Work tiers for [Pi](https://github.com/earendil-works/pi). Instead of picking a model, pick a class of work: `tier/default`, `tier/deep`, `tier/quick`, or `tier/auto`. Each tier is a [virtual model](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/virtual-models.md) that commits each session to one model from an ordered chain across your accounts:

- **One model per session, no recovery.** On a first request a session commits to one model and account and keeps it. The chain is a preference order of models: the first entry with a usable account wins, and within it the least loaded account (quota use the provider reported, live Pi agents on that account, and recent token use, across every Pi process on the machine). A failure of any kind (429, usage limit, auth, server error, unknown) does not switch models and sets nothing that switches one; it is surfaced instead (see Failures). Fleet, or you, decides whether to wait, retry, or reassign.
- **Live quota at session start.** When a session picks its account, pi-tiers reads each candidate account's real limits once (Anthropic `api/oauth/usage`, Codex `wham/usage`, xAI billing; see [Live quota](#live-quota)) and ranks accounts by the room left in their tightest window, with live agents as the tie-breaker. An account with under 5% left in any window is treated like a cooling one: the next usable account or chain entry wins. A reading that fails or runs out of time falls back to the header-based score. Nothing switches mid-session.
- **A restart picks again.** A session this Pi process has not routed yet picks its account at its first request, even when its session file already holds a committed model (a resumed or restarted worker), so an account that ran out in the meantime is not reused.
- **Used-up quota is one line.** When a turn on a tier fails and the failed account's live quota (read fresh) has a window under `quota.minRemainingPercent`, the turn's error text becomes exactly `<provider> <window> quota has exhausted. Restart worker to launch on a new provider.` and nothing else is printed; the provider's own error stays in `failures.jsonl` and drives cooldowns. Any other failure is unchanged. No retry and no switching.
- **`PI_TIERS_AVOID`.** A comma-separated list of provider names exactly as pi-tiers prints them (for example `anthropic,anthropic-2`) is left out of every chain for that process, on a fresh start and on a resume; accounts are then chosen by live quota and load as usual. When nothing is left for the tier, the request fails with `pi-tiers: PI_TIERS_AVOID (...) leaves no provider for tier '<tier>'.`
- **Resilient tiers keep failover.** Tiers listed in `resilient` (default: `compact` and `reviewer`, when defined) keep their own pool independent of the session's model, because compaction and validation must always run: a rate limit, usage limit, auth failure (401), refusal of one model (403), or server error cools that account (or that model on it) down and the request moves to the next usable rung. When every rung is cooling, the one that frees up first is tried anyway, since cooldowns are estimates.
- **Cooldowns are shared** by every Pi process on the machine. They rank accounts when a session picks its model (a cooling account is chosen last, never excluded) and drive the resilient tiers' failover.
- **Timeouts stay put.** A timeout or dropped connection says nothing about the account, so Pi's retries stay on the same model, where the prompt cache is.
- **Background work.** A Pi started with `PI_TIERS_BACKGROUND=1` never uses the providers in `background.skip` (for example an account kept for you), and on a resilient tier it waits for the first cooling rung to free up instead of failing.
- **Spread.** With `"spread": true`, equally loaded accounts of a group are tried in an order rotated by the session id, so ties break differently per session.
- **`tier/auto`** classifies the first message of a session with a classifier model (for example TypeSafe's Jev) and stays on that tier for the session.
- **Sticky per session and tier.** The session keeps its model for that tier, including follow-ups, new messages, and direct requests such as compaction, keeping prompt caches warm. A conversation too large for it is compacted, not moved.
- **Rules** replace or filter chains by git remote or working directory, for example "work repos only use the work account".
- **Forced rules.** `PI_TIERS_RULE=<name>` applies that rule wherever Pi runs, for example a `vertex-pi` wrapper that keeps a session on one cloud. An unknown name fails closed.
- **Context-aware.** When a session picks its model, one whose context window cannot hold the conversation is skipped instead of forcing a compaction. The request is sized from the last real response's reported usage plus the messages after it, not from Pi's whole-session estimate, so an edited context cannot make a healthy account look too small.

## Install

```bash
pi install git:github.com/1yian/pi-tiers@v0.1.8
```

Then write `~/.pi/agent/tiers.json` (or point `PI_TIERS_CONFIG` at a file) and select a tier with `/model`, `--model tier/default`, or `/tier`.

## Config

See [`examples/tiers.json`](examples/tiers.json).

| Key | Meaning |
|---|---|
| `accounts` | Named groups of Pi provider IDs. A chain entry whose provider is a group expands to each member in order. Accounts are ordinary Pi providers, e.g. extra logins registered by [pi-multi-pass](https://github.com/hjanuschka/pi-multi-pass). |
| `tiers.<name>.chain` | Ordered `provider/model:thinking` entries. Thinking defaults to `medium`. |
| `tiers.<name>.description` | What belongs in the tier. Required for tiers `auto` can pick; the classifier sees these descriptions. |
| `auto.classifier` | `provider/model` of a Pi classifier model. |
| `auto.tiers`, `auto.fallback`, `auto.minConfidence` | Tiers it may pick, the tier used when it is unsure or unavailable, and the confidence floor (default 0.6). |
| `auto.sections`, `auto.maxChars` | Markdown headings whose sections are classified instead of the whole message, and a length cap. |
| `rules[]` | `name`, `match.gitRemote` (regex) and/or `match.cwdPrefix`. `tiers` replaces chains in that context; `allowProviders` filters the other chains and blocks overrides to other providers. Set `PI_TIERS_RULE=<name>` to force a rule regardless of directory. |
| `override` | Regex for an explicit model line in the first message, e.g. `Model override: anthropic/claude-opus-5-5 max`. Group 1 is `provider/model`, group 2 the thinking level. |
| `warnProviders` | Providers flagged as last resorts in the status line. |
| `cooldowns` | Fallback durations in seconds when a response carries no reset header: `rateLimitSeconds` (600), `serverErrorSeconds` (30), `usageLimitSeconds` (3600), `authSeconds` (3600). `waitSeconds` (0) is how long a foreground request waits for a cooling rung that frees up soon, instead of failing. |
| `background` | For a Pi started with `PI_TIERS_BACKGROUND=1`: `skip` lists providers it never uses, and `maxWaitSeconds` (21600) is how long it waits for a cooling rung instead of failing. |
| `resilient` | Tiers that keep their own failover pool (see above). Default `["compact", "reviewer"]` for those that exist. Name every tier whose work must continue without outside help. |
| `spread` | `true` rotates account groups by a number from the session id, which breaks ties between equally loaded accounts differently per session. Default `false`: ties go to the first account in chain order. |
| `quota` | Live quota at session start (on by default; `false` turns it off): `minRemainingPercent` (5), `timeoutSeconds` (3, total for all accounts), `cacheSeconds` (60), `providers` (provider id to `anthropic`, `codex`, or `xai`, for accounts the built-in names `anthropic`, `anthropic-N`, `openai-codex`, `openai-codex-N`, and `xai` do not cover), `xai.referenceUsd` (20), and `baseUrls` (endpoint overrides). |
| `stateDir` | Where cooldowns and the decision log live (default `~/.pi/agent/tiers`). |

## Live quota

The readers are adapted from [pi-multi-pass](https://github.com/hjanuschka/pi-multi-pass) (MIT; see the notice in `src/quota.ts`); nothing is imported from it at run time. They use the credentials Pi already holds, through the model registry, so an expiring login is refreshed by Pi.

| Provider | Source | Windows |
|---|---|---|
| `anthropic`, `anthropic-N` | `GET api.anthropic.com/api/oauth/usage` | `5h`, `7d`, and model-scoped weekly limits (such as Opus), which count only for that model |
| `openai-codex` | `GET chatgpt.com/backend-api/wham/usage` | `5h`, `7d` |
| `xai`, signed in with SuperGrok or X Premium (Pi's default xAI login) | `GET cli-chat-proxy.grok.com/v1/billing?format=credits`, the endpoint Grok's own CLI uses | `credits` (weekly or monthly subscription credits; prepaid balance or a pay-as-you-go cap keeps the account usable once they are gone). Undocumented by xAI. |
| `xai` with an API key (`XAI_API_KEY`) | Management API `GET management-api.x.ai/v1/billing/teams/{team}/prepaid/balance` | `prepaid`, the dollar balance as a percentage of `quota.xai.referenceUsd` |

An xAI API key cannot read its own balance. Create a **management key** in the xAI Console (Settings, Management Keys) and give it to pi-tiers as `XAI_MANAGEMENT_API_KEY` plus your team id as `XAI_TEAM_ID`, or put `{"key": "...", "teamId": "..."}` in `~/.pi/agent/xai-management.json` (mode 600). Without them an API-key xAI account has no reading and keeps the header-based score.

Providers without a reader (Vertex, Baseten) keep the header-based score. Readings are cached per account for `cacheSeconds` in `<stateDir>/quota/`, shared by every Pi process on the machine, with one process fetching while the others wait for its result; a failure is cached for 15 seconds. Accounts whose readings are within 10 points of each other tie, and ties go to the account with the fewest live agents and recent tokens, then to a per-session pick so sessions starting together spread out.

Every start that read quota logs the readings and the choice: a `tier: quota ...; chose ...` entry in the session, a `quota` field on the `route` record in `log.jsonl`, and `/tiers` prints the current readings.

## How a request is routed

1. `auto` decides the tier on the first user message and stores it as session state.
2. A `Model override:` line, when configured and present, is tried first.
3. The chain for the tier comes from the first matching rule, otherwise the base config.
4. A resilient tier skips candidates that are unknown, have no credentials, are cooling down, or cannot fit the conversation (largest window plus a Pi compaction when none fits). Any other tier uses the session's committed model; on a session's first request it picks as described above, ranking a cooling or nearly out account last and never refusing.
5. A failure Pi does not retry ends the run. On a resilient tier the account is cooled down and the turn continues on the next usable model with a visible note. On any other tier nothing continues: the failure is recorded for Fleet.
6. When no resilient candidate is usable but one is only cooling down, a background request waits for it up to `background.maxWaitSeconds` in total, and a foreground request up to `cooldowns.waitSeconds` in total; after that the rung that frees first is tried anyway.

## Failures

A failed run is appended to `~/.pi/agent/tiers/failures.jsonl` (one JSON object per line) and emitted as `pi-tiers:failure` on `pi.events`: `v`, `ts`, `session`, `pid`, `cwd`, `tier`, `provider`, `model`, `status` (HTTP status or null), `kind` (`usage-limit`, `rate-limit`, `auth`, `forbidden`, `server`, `transient`, `unknown`), `scope`, `message` (the provider's own error text), `retryAfter` (raw header), `resetAt` (earliest reset or Retry-After as ISO time, or null), `headers` (retry-after, reset, rate-limit, and utilization headers), and `recovery` (`none`, or `pool` when a resilient tier continued the turn). The same text appears as a transcript entry. Failures of direct requests (compaction summaries) are not reported to extensions by Pi.

Direct requests (compaction summaries and extension calls through the model registry) are routed the same way, but Pi does not report their failures to extensions, so they see only cooldowns recorded by agent-loop requests, in this or any other Pi process.

Every decision is appended to `~/.pi/agent/tiers/log.jsonl`.

## Status line

pi-tiers sets the `pi-tiers` status, e.g. `auto → deep ↓2 → opus-5.5 xhigh · anthropic-2`, and emits `pi-tiers:route` on `pi.events` with the structured route (`selected`, `tier`, `auto`, `provider`, `model`, `thinking`, `position`, `warn`, `rule`) so custom footers can lay it out themselves. `↓N` appears when the first choice did not answer; `auto?` means the classifier was unsure.

## Commands

- `/tier [name]` switches the session to a tier.
- `/tiers` shows each chain with usable and skipped rungs, and active cooldowns.

## Tests

`npm run e2e` drives real `pi --mode json` processes against a scripted fake provider: healthy first choice, failures that stay on the assigned model and are surfaced, resilient-tier failover, cross-process cooldowns and load, timeouts, background skips and waits, foreground waits, spread, all-cooling pools, auto picks and fallbacks, overrides, rules, context skipping, and live quota (more room wins, nearly-out accounts skipped, failed or hung fetches fall back, parallel starts fetch once and spread). It writes a report to `.e2e-<timestamp>/report.md`.

## License

MIT
