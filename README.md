# pi-tiers

Work tiers for [Pi](https://github.com/earendil-works/pi). Instead of picking a model, pick a class of work: `tier/default`, `tier/deep`, `tier/quick`, or `tier/auto`. Each tier is a [virtual model](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/virtual-models.md) that walks an ordered chain of models across your accounts:

- **Failover across accounts and models.** A rate limit, usage limit, auth failure (401), refusal of one model (403), or server error in a conversation turn cools that account (or that model on it) down, and the request moves to the next usable rung.
- **Cooldowns are shared** by every Pi process on the machine, so one crewmate hitting a limit spares the others the wasted request.
- **Timeouts stay put.** A timeout or dropped connection says nothing about the account, so Pi's retries stay on the same model, where the prompt cache is. Only when Pi's retries run out does the turn move on.
- **Background work.** A Pi started with `PI_TIERS_BACKGROUND=1` never uses the providers in `background.skip` (for example an account kept for you), and when every rung it may use is cooling down it waits for the first one to free up instead of failing.
- **Spread.** With `"spread": true`, each session starts on its own member of every account group, chosen from its session id, so one account's limit moves only the sessions it was serving.
- **`tier/auto`** classifies the first message of a session with a classifier model (for example TypeSafe's Jev) and stays on that tier for the session.
- **Sticky per session and tier.** Once a model answers, the session keeps using it for that tier, including follow-ups, new messages, and direct requests such as compaction, keeping prompt caches warm. It leaves only when that model fails, cools down, or cannot fit the conversation, and then takes the next usable rung in chain order. A higher-priority rung whose cooldown ended does not pull the session back. Direct requests report no failures, so a failing sticky model for them clears only when an agent-loop request cools it.
- **Rules** replace or filter chains by git remote or working directory, for example "work repos only use the work account".
- **Forced rules.** `PI_TIERS_RULE=<name>` applies that rule wherever Pi runs, for example a `vertex-pi` wrapper that keeps a session on one cloud. An unknown name fails closed.
- **Context-aware.** A model whose context window cannot hold the conversation is skipped instead of forcing a compaction. The request is sized from the last real response's reported usage plus the messages after it, not from Pi's whole-session estimate, so an edited context cannot make a healthy account look too small.

## Install

```bash
pi install git:github.com/1yian/pi-tiers@v0.1.7
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
| `spread` | `true` starts each session on its own member of every account group, chosen from its session id. Default `false`: groups expand in order. |
| `stateDir` | Where cooldowns and the decision log live (default `~/.pi/agent/tiers`). |

## How a request is routed

1. `auto` decides the tier on the first user message and stores it as session state.
2. A `Model override:` line, when configured and present, is tried first.
3. The chain for the tier comes from the first matching rule, otherwise the base config.
4. Candidates are skipped when the model is unknown, has no credentials, is cooling down, or cannot fit the conversation. If every usable candidate is only too small, the one with the largest context window is used and Pi compacts the conversation before sending, instead of the request failing.
5. Retries after a failure first record the cooldown. A timeout or dropped connection records none, so the retry stays on the same model. Failures Pi does not retry (usage limits, exhausted retries, including timeouts) are cooled down too, and the turn continues on the next usable model with a visible note.
6. When no candidate is usable but one is only cooling down, a background request waits for it up to `background.maxWaitSeconds` in total, and a foreground request up to `cooldowns.waitSeconds` in total. The status line shows what it waits for. Otherwise the request fails with the reasons.

Direct requests (compaction summaries and extension calls through the model registry) are routed the same way, but Pi does not report their failures to extensions, so they benefit only from cooldowns recorded by agent-loop requests, in this or any other Pi process.

Every decision is appended to `~/.pi/agent/tiers/log.jsonl`.

## Status line

pi-tiers sets the `pi-tiers` status, e.g. `auto → deep ↓2 → opus-5.5 xhigh · anthropic-2`, and emits `pi-tiers:route` on `pi.events` with the structured route (`selected`, `tier`, `auto`, `provider`, `model`, `thinking`, `position`, `warn`, `rule`) so custom footers can lay it out themselves. `↓N` appears when the first choice did not answer; `auto?` means the classifier was unsure.

## Commands

- `/tier [name]` switches the session to a tier.
- `/tiers` shows each chain with usable and skipped rungs, and active cooldowns.

## Tests

`npm run e2e` drives real `pi --mode json` processes against a scripted fake provider: healthy first choice, retryable 429, cross-process cooldowns, non-retryable usage limits, timeouts, background skips and waits, foreground waits, spread, exhausted chains, auto picks and fallbacks, overrides, rules, and context skipping. It writes a report to `.e2e-<timestamp>/report.md`.

## License

MIT
