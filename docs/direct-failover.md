# Direct-compaction integration still required in Pi

## What this branch changes

Normal agent turns recover from explicit credits/subscription denials without trusting a second billing request. Other non-retryable provider errors exclude the failed account and use another allowed subscription. Unknown errors consult the independent configured classifier, with a cached enum verdict and deterministic failover when it is unavailable.

Direct selection excludes undersized models and cooling accounts, and permits positive subscription room below the preference floor when no preferred subscription fits. No failed account or explicit override can re-enter the current operation. Recovery does not add PAYG, payments or credential changes.

The router also accepts `ModelRouteRequest.failed` with `reason: "direct"`, using the same deterministic rules and unknown-error classifier. It tracks failed accounts and single-account retries per operation signal. Callers without signals are sequential only. This callback handling is preparatory: unmodified Pi 1.5.2 never supplies it for a failed direct call, and the real compaction acceptance is therefore still unmet.

## Verified runtime boundary

Inspected Pi 1.5.2, without changing installed files:

- `packages/coding-agent/src/core/agent-session.ts`: `_getSummarizationRequestAuth` resolves the selected virtual model once, before `_runDefaultCompaction` calls `compact` with the physical model.
- `packages/coding-agent/src/core/compaction/compaction.ts`: `completeSummarization` retries the same physical model through `retryAssistantCall`. `getSummarizationFailure` then converts a provider refusal into a thrown summarization error.
- `packages/coding-agent/src/core/model-runtime.ts`: the virtual branch of `streamSimple` resolves once and recursively streams that physical model. It has no failed-direct rerouting loop.
- `packages/coding-agent/src/core/virtual-models.ts`: `ModelRouteRequest.failed` already represents the failed physical model, thinking level and assistant message, but is documented and populated only for agent retries.

An extension's `message_end`, `after_provider_response` and `agent_before_settle` do not receive the failed direct compaction request. Changing a regex, quota cache or tier configuration cannot reconnect that missing callback.

## Exact upstream change

1. Preserve the originating virtual model and operation signal through `_runDefaultCompaction`. On a physical provider error, retain its structured `AssistantMessage`, physical model and thinking level, rather than throwing away the attempt data in a string-only error.
2. Resolve that same virtual model again with `reason: "direct"`, the failed attempt in `failed`, the same signal and the original conversation sizing input. Each independent operation needs a distinct signal; every attempt of one operation must keep it. Extend the existing `failed` documentation to cover direct attempts.
3. Re-run the same buffered compaction preparation with the newly routed physical model. Resolve its credentials independently and recompute context/output budgets and thinking level. Never forward the first account's API key, headers or environment to a different provider. Never persist a partial or length-stopped summary. Abort and local validation errors must not start provider failover.
4. Bound the physical attempts independently in Pi as well. Stop when routing reports no eligible subscription or when the operation budget ends. Do not retry a credits 403 against the same physical account. Existing transient retries may still run within their bounded budget.
5. Apply the same failed-attempt feedback to `ModelRuntime.streamSimple` for virtual direct calls. Do not combine partial output from different attempts; buffer a request that must be recovered atomically, or refuse recovery once externally visible output has been emitted.
6. Keep the conversation's selected tier and persisted virtual routing state unchanged by direct work. After one successful compaction, write exactly one normal checkpoint through the existing session path.

This is an upstream integration change, not permission to patch an installed package or replace Pi's compaction in a live home.

## Reproduction and acceptance

The repository's real `pi --mode json` harness loads the actual router and scripted physical providers. No router is mocked and no paid provider requests are made.

```sh
npm ci
npm run typecheck
npm run lint
E2E_ONLY='billing failover' npm run e2e
E2E_ONLY='actual manual compaction' npm run e2e
```

The healthy manual-compaction scenario invokes `ctx.compact`, waits for its completion callback and reads the persisted session checkpoint. This proves it exercises the actual compactor, not a normal assistant turn on a compact tier.

The same scenario can inject the exact incident's xAI credits/subscription 403 at the physical summarization call:

```sh
E2E_COMPACTION_BILLING=1 E2E_ONLY='actual manual compaction' npm run e2e -- --keep
```

On unmodified Pi 1.5.2 this intentionally fails: two healthy conversation turns are followed by one failed physical summary, no alternate subscription is attempted, and no checkpoint is persisted. The error is recorded by the compaction completion callback. That failure is evidence of the upstream gap, not a passing recovery check. After upstream integration, this invocation must succeed through another subscription and assert that alternate provider in the checkpoint.

For a like-for-like main-versus-head comparison, `E2E_ROUTER_PATH=/absolute/path/to/main/src/index.ts` loads the main router while retaining this branch's physical fixtures and acceptance scenarios. The normal billing and unknown-error scenarios improve on this branch. The injected compaction failure remains on both sides until the Pi integration lands.

## Applied principles

- Fix Root Causes: repair account failure recognition and bounded routing, and identify the missing direct callback instead of changing a model pin or installed package.
- Model the Domain: encode recovery as an enum and operation-scoped tried/retried account sets, separate from shared cooldowns and quota preferences.
- Prove It Works: preserve real-process provider calls, classifier requests and persisted checkpoints; explicitly distinguish successful healthy compaction from still-failing injected compaction.
- Test Behavior Not Implementation: end-to-end assertions observe answering subscriptions, original provider errors and session checkpoints, not copies of the router's conditionals.
