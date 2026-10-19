# pi-tiers

Work tiers for [Pi](https://github.com/earendil-works/pi). Instead of picking a model, pick a class of work: `tier/default`, `tier/deep`, `tier/quick`, or `tier/auto`. Each tier is a [virtual model](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/virtual-models.md) that walks an ordered chain of models across your accounts:

- **Failover across accounts and models.** A rate limit, usage limit, auth failure (401), refusal of one model (403), or server error in a conversation turn cools that account (or that model on it) down, and the request moves to the next usable rung.
- **Cooldowns are shared** by every Pi process on the machine, so one crewmate hitting a limit spares the others the wasted request.
- **`tier/auto`** classifies the first message of a session with a classifier model (for example TypeSafe's Jev) and stays on that tier for the session.
- **Sticky within a turn, fail back between turns.** Tool follow-ups stay on the model that answered, keeping prompt caches warm; the next user message returns to the most preferred usable model.
- **Rules** replace or filter chains by git remote or working directory, for example "work repos only use the work account".
- **Forced rules.** `PI_TIERS_RULE=<name>` applies that rule wherever Pi runs, for example a `vertex-pi` wrapper that keeps a session on one cloud. An unknown name fails closed.
- **Context-aware.** A model whose context window cannot hold the conversation is skipped instead of forcing a compaction.

## Install

```bash
pi install git:github.com/1yian/pi-tiers@v0.1.3
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
| `cooldowns` | Fallback durations in seconds when a response carries no reset header: `rateLimitSeconds` (600), `serverErrorSeconds` (30), `usageLimitSeconds` (3600), `authSeconds` (3600). |
| `stateDir` | Where cooldowns and the decision log live (default `~/.pi/agent/tiers`). |

## How a request is routed

1. `auto` decides the tier on the first user message and stores it as session state.
2. A `Model override:` line, when configured and present, is tried first.
3. The chain for the tier comes from the first matching rule, otherwise the base config.
4. Candidates are skipped when the model is unknown, has no credentials, is cooling down, or cannot fit the conversation.
5. Retries after a failure first record the cooldown. Failures Pi does not retry (usage limits, exhausted retries) are cooled down too, and the turn continues on the next usable model with a visible note.

Direct requests (compaction summaries and extension calls through the model registry) are routed the same way, but Pi does not report their failures to extensions, so they benefit only from cooldowns recorded by agent-loop requests, in this or any other Pi process.

Every decision is appended to `~/.pi/agent/tiers/log.jsonl`.

## Status line

pi-tiers sets the `pi-tiers` status, e.g. `auto → deep ↓2 → opus-5.5 xhigh · anthropic-2`, and emits `pi-tiers:route` on `pi.events` with the structured route (`selected`, `tier`, `auto`, `provider`, `model`, `thinking`, `position`, `warn`, `rule`) so custom footers can lay it out themselves. `↓N` appears when the first choice did not answer; `auto?` means the classifier was unsure.

## Commands

- `/tier [name]` switches the session to a tier.
- `/tiers` shows each chain with usable and skipped rungs, and active cooldowns.

## Tests

`npm run e2e` drives real `pi --mode json` processes against a scripted fake provider: healthy first choice, retryable 429, cross-process cooldowns, non-retryable usage limits, exhausted chains, auto picks and fallbacks, overrides, rules, and context skipping. It writes a report to `.e2e-<timestamp>/report.md`.

## License

MIT
