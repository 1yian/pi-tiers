# pi-tiers

Work tiers for [Pi](https://github.com/earendil-works/pi). Instead of picking a model, pick a class of work: `tier/default`, `tier/deep`, `tier/quick`, or `tier/auto`. Each tier is a [virtual model](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/virtual-models.md) that commits each session to one model from an ordered chain across your accounts:

- **One model per session; one flow for every tier.** On a first request a session commits to one model and account and keeps it. The chain is a preference order of models: the first entry with a usable account wins, and within it the least loaded account (quota use the provider reported, live Pi agents on that account, and recent token use, across every Pi process on the machine). A failed call is retried on that same model with exponential backoff (next bullet). Explicit credits, billing and subscription denials mark the account exhausted without requiring a second quota confirmation. Non-retryable provider failures continue the interrupted turn on the next allowed subscription, excluding accounts already tried. Unknown errors use the independent classifier's bounded recovery policy (see Failures). Repeated connection failures leave the service for the rest of the run. This holds for every tier, `compact` and `reviewer` included.
- **The classifier picks the provider.** After the tier is known, code builds the tier's candidate table (providers and accounts of its chain), drops accounts under `quota.minRemainingPercent`, cooling accounts and models, `PI_TIERS_AVOID` providers, and anything the active rule disallows, and asks the `auto` classifier (a second, separate call) to choose one row. Every usable provider of the tier's chain is a row, labelled `subscription` or `PAYG` (the providers in `payg`), and the classifier is told to prefer subscriptions. Each row shows chain position, quota left and time to reset per window, live agents, and recent tokens, and the call also sees the task text. Code validates the answer; on a timeout (`auto.providerTimeoutSeconds`, default 3), an error, an off-list answer, or no task text it uses the ranked pick below. With one candidate left there is no call. Every pick (table, answer, fallback or not, chosen) is logged as a `provider-pick` record in `log.jsonl`. The session still keeps its one model.
- **Retry with backoff is Pi's.** Known transient errors use Pi's retry budget. For unrecognized errors only, the classifier may request one immediate retry per account before failover. Pi retries a retryable failure (rate limit, overload, 5xx, dropped connection) on the same provider, model, and account, waiting `baseDelayMs` doubling per retry up to `maxAgentDelayMs`, for at most `maxRetries` retries; the settings are `retry.maxRetries`, `retry.baseDelayMs`, and `retry.maxAgentDelayMs` in Pi's `settings.json`. Pi's defaults (3 retries from 2s) wait 14s; for a 60 second budget set `"retry": {"enabled": true, "maxRetries": 5, "baseDelayMs": 2000, "maxAgentDelayMs": 30000}`, which waits 2s, 4s, 8s, 16s, 30s. Compaction summaries use the same settings.
- **A service that cannot be reached leaves the run.** A connection failure is a request that never got an HTTP response (`Connection error.`, a timeout, a reset, a DNS failure). The first one is retried on the same model by Pi, where the prompt cache is warm. When the same model fails that way twice in a row, pi-tiers takes its whole service out of the run (an account group such as `claude` is one service, so `anthropic-2` is not tried after `anthropic` could not connect; a provider outside any group is its own service). The retry after that goes to the first usable model of another service in the chain, ranked as usual (the classifier among the usable ones, code as the fallback), with a `tier: ... could not be reached` line in the session. The run stays there until the next user message; then every service is tried again and the session is back on the model it committed to, because a connection failure says nothing about the account. Pi's retry budget is shared by the whole run, so five retries cover three services at two attempts each; with Pi's default three retries only the first two services are tried. Requests outside the agent loop (compaction summaries, extension calls through the registry) skip a service the run could not reach too, but only after the agent loop has seen it fail: Pi does not report a failed direct request to extensions, so a summary request cannot move off a service on its own. When every service fails, the error is surfaced after Pi's retries as before.
- **Subscriptions before pay-per-token.** Providers named in `payg` rank last in the code pick (chosen only when no subscription is usable); the classifier sees them labelled PAYG and is told to prefer subscriptions.
- **Provider denials are authoritative.** Explicit usage denials mark the account even when live quota is unavailable or claims room. A later quota reading with room can clear a stale mark, but never clears the current operation's tried-account set. Ordinary rate limits and server failures on providers with a live reader still use confirmed quota before moving.
- **Live quota at session start.** When a session picks its account, pi-tiers reads each candidate account's real limits once (Anthropic `api/oauth/usage`, Codex `wham/usage`, xAI billing; see [Live quota](#live-quota)) and ranks accounts by the room left in their tightest window, with live agents as the tie-breaker. The default 5% floor is a preference: when no preferred subscription fits, a context-capable subscription with positive room below the floor is allowed. Zero room and cooldowns remain unavailable to recovery and direct requests. A reading that fails or runs out of time falls back to the header-based score.
- **A restart picks again.** A session this Pi process has not routed yet picks its account at its first request, even when its session file already holds a committed model (a resumed or restarted worker), so an account that ran out in the meantime is not reused.
- **Recovery is bounded.** Failed accounts are excluded until the next user request, with at most one classifier-requested retry per account and at most 32 continuations. Recovery never introduces a PAYG fallback, changes credentials, or makes payments. With no fitting subscription left, one final error ends the operation and original provider errors remain in `failures.jsonl`.
- **`PI_TIERS_AVOID`.** A comma-separated list of provider names exactly as pi-tiers prints them (for example `anthropic,anthropic-2`) is left out of every chain for that process, on a fresh start and on a resume; accounts are then chosen by live quota and load as usual. When nothing is left for the tier, the request fails with `pi-tiers: PI_TIERS_AVOID (...) leaves no provider for tier '<tier>'.`
- **Cooldowns are shared** by every Pi process on the machine. Direct calls and recovery exclude cooling accounts; initial ordinary-turn assignment retains the existing earliest-reset fallback when every account is cooling.
- **Background work.** A Pi started with `PI_TIERS_BACKGROUND=1` never uses the providers in `background.skip` (for example an account kept for you).
- **Spread.** With `"spread": true`, equally loaded accounts of a group are tried in an order rotated by the session id, so ties break differently per session.
- **`tier/auto`** classifies the first message of a session with a classifier model (for example TypeSafe's Jev) and stays on that tier for the session.
- **Sticky per session and tier.** The session keeps its model for that tier, including follow-ups, new messages, and direct requests such as compaction, keeping prompt caches warm. An oversized request moves to a fitting model or stops safely.
- **Rules** replace or filter chains by git remote or working directory, for example "work repos only use the work account".
- **Forced rules.** `PI_TIERS_RULE=<name>` applies that rule wherever Pi runs, for example a `vertex-pi` wrapper that keeps a session on one cloud. An unknown name fails closed.
- **Context-aware.** When a session picks its model, one whose context window cannot hold the conversation is skipped instead of forcing a compaction. The request is sized from the last real response's reported usage plus the messages after it, not from Pi's whole-session estimate, so an edited context cannot make a healthy account look too small.

## Install

```bash
pi install git:github.com/1yian/pi-tiers@v0.1.14
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
| `auto.tiers`, `auto.fallback`, `auto.minConfidence` | Tiers it may pick, the tier used when it is unsure or unavailable, and the confidence needed to use its pick (default 0.6). `auto.floor` (default: same as `minConfidence`) lets a pick between the two stand instead of the fallback. |
| `auto.providerTimeoutSeconds` | How long the classifier's provider pick may take before code picks (default 3). |
| `payg` | Pay-per-token providers (for example `baseten`), labelled PAYG for the classifier and ranked last by code. |
| `auto.sections`, `auto.maxChars` | Headings whose sections are classified instead of the whole message, and a length cap. A `#` heading runs to the next heading of its level; a plain label such as `Spec:` (also matched at the end of a line) runs to the next configured label or the end. |
| `rules[]` | `name`, `match.gitRemote` (regex) and/or `match.cwdPrefix`. `tiers` replaces chains in that context; `allowProviders` filters the other chains and blocks overrides to other providers. Set `PI_TIERS_RULE=<name>` to force a rule regardless of directory. |
| `override` | Regex for an explicit model line in the first message, e.g. `Model override: anthropic/claude-opus-5-5 max`. Group 1 is `provider/model`, group 2 the thinking level. |
| `warnProviders` | Providers flagged as last resorts in the status line. |
| `cooldowns` | Fallback durations in seconds when a response carries no reset header: `rateLimitSeconds` (600), `serverErrorSeconds` (30), `usageLimitSeconds` (3600), `authSeconds` (3600). Also used for explicit provider denials when a live quota reader exists. |
| `background` | For a Pi started with `PI_TIERS_BACKGROUND=1`: `skip` lists providers it never uses. |

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
4. Keep the committed model when it fits, otherwise select a context-capable candidate. Reserve 16,000 tokens for the response. Direct calls never select an undersized or cooling model; positive subscription room below the preference floor is the last subscription fallback.
5. Pi retries known transient failures. Explicit usage and other non-retryable provider errors exclude the failed account and continue on another allowed subscription. Unknown errors consult the classifier. Rules, overrides, avoided providers and context limits remain enforced.

## Failures

A failed run is appended to `~/.pi/agent/tiers/failures.jsonl` (one JSON object per line) and emitted as `pi-tiers:failure` on `pi.events`: `v`, `ts`, `session`, `pid`, `cwd`, `tier`, `provider`, `model`, `status` (HTTP status or null), `kind` (`usage-limit`, `rate-limit`, `auth`, `forbidden`, `server`, `transient`, `unknown`), `scope`, `message` (the provider's own error text), `retryAfter` (raw header), `resetAt` (earliest reset or Retry-After as ISO time, or null), `headers` (retry-after, reset, rate-limit, and utilization headers), and `recovery` (`none`, or `pool` when the interrupted turn continued after a provider failure). The same text appears as a transcript entry. Failures of direct requests (compaction summaries) are not reported to extensions by Pi.

Unknown errors ask the configured `auto.classifier` (normally Jev) to choose `failover`, `retry`, `cooldown`, or `auth-stop`. Error text is redacted and treated as untrusted data. The classifier must not be the failed provider. Its deadline is `auto.providerTimeoutSeconds`; absent, unavailable, timed-out or invalid answers default to failover. Verdicts are cached in-process for five minutes by provider, HTTP status and normalized error signature, capped at 128 entries. Retry is limited to once per account; cooldown duration comes from `cooldowns.serverErrorSeconds`, never a model-generated timestamp. Auth-stop preserves the error without another provider call.

**Pi 1.5.2 limitation:** direct requests, including actual conversation compaction, resolve to a physical model before generation and do not send failures back to this router. This change makes direct *selection* context-safe and handles a future direct `failed` callback, but cannot complete a failed compaction on another subscription in that same operation on unmodified Pi. See [the exact upstream integration and reproduction](docs/direct-failover.md). Do not treat a normal turn on `tier/compact` as proof of conversation-compaction recovery.

Every decision is appended to `~/.pi/agent/tiers/log.jsonl`, including a `retry-failure` record for each failed attempt Pi retries (`key`, `transient`, the consecutive connection failures in `streak`, `durationMs`, and the provider's error text), which the session transcript does not keep for a turn that recovered.

## Status line

pi-tiers sets the `pi-tiers` status, e.g. `auto → deep ↓2 → opus-5.5 xhigh · anthropic-2`, and emits `pi-tiers:route` on `pi.events` with the structured route (`selected`, `tier`, `auto`, `provider`, `model`, `thinking`, `position`, `warn`, `rule`) so custom footers can lay it out themselves. `↓N` appears when the first choice did not answer; `auto?` means the classifier was unsure.

## Commands

- `/tier [name]` switches the session to a tier.
- `/tiers` shows each chain with usable and skipped rungs, and active cooldowns.

## Tests

`npm run e2e` drives real `pi --mode json` processes against a scripted fake provider: healthy first choice, retries with doubling backoff on the same model, connection failures that move the run to the next service and back on the next message, failures that are surfaced without a switch, repicks on confirmed quota exhaustion (agent loop and compaction), banked resets, cross-process cooldowns and load, timeouts, background skips and waits, foreground waits, spread, all-cooling pools, auto picks and fallbacks, overrides, rules, context skipping, and live quota (more room wins, nearly-out accounts skipped, failed or hung fetches fall back, parallel starts fetch once and spread). It writes a report to `.e2e-<timestamp>/report.md`.

## License

MIT
