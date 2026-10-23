// pi-tiers: work tiers as virtual models. Every tier commits a session to one model from an ordered chain.
// A failed call is retried on that model by Pi's own backoff (settings `retry`); only a failure whose live
// quota check confirms an exhausted account moves the session to another provider. `tier/auto` picks the tier with a classifier.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	estimateTokens as estimateMessageTokens,
	getAgentDir,
	type ModelRoute,
	type ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type AutoDecision, decideTier, lastUserText, messageText } from "./auto.ts";
import { assign, type Candidate, candidateKey, candidatesFor, type Expansion, type PickResult, pick, type SkipReason, subscriptionsFirst } from "./chain.ts";
import { type Config, ConfigError, defaultConfigPath, loadConfig, type Rule, THINKING_LEVELS, type Thinking } from "./config.ts";
import { accountKey, CooldownStore, modelKey } from "./cooldowns.ts";
import { classifyFailure, type Failure, isTransient, type ResponseInfo, resetFromHeaders } from "./failures.ts";
import { LoadStore, utilizationFromHeaders } from "./load.ts";
import { askProvider, tableRow } from "./provider-pick.ts";
import { describe as describeQuota, exhaustedUntilMs, exhaustedWindow, kindOf, type Outcome, type QuotaReading, QuotaStore, roomFor } from "./quota.ts";
import { formatStatus, type RouteStatus } from "./status.ts";

export const PROVIDER = "tier";
export const AUTO = "auto";
export const STATUS_KEY = "pi-tiers";
export const ROUTE_EVENT = "pi-tiers:route";
export const FAILURE_EVENT = "pi-tiers:failure";
const ENTRY = "pi-tiers";
/** Room left for the response when checking whether a conversation fits a model's context window. */
const CONTEXT_HEADROOM = 16_000;
/** Continuations the extension may request in one run after a request failed outright. */
const MAX_CONTINUES = 4;
/** Weights of a provider's load when choosing where a session starts. These are heuristics, not measurements:
 * quota already used (0..1) outweighs a whole agent, and 500K recent tokens count as one agent. */
const UTILIZATION_WEIGHT = 10;
const TOKENS_PER_AGENT = 500_000;

interface Override {
	provider: string;
	model: string;
	thinking: Thinking;
}

interface TierState {
	tier?: string;
	auto?: AutoDecision;
	/** null once the first message was checked and carried no override. */
	override?: Override | null;
	/** provider/model that answered last; the session keeps using it while it stays usable, for prompt-cache reuse. */
	key?: string;
}

interface EntryData {
	text: string;
}

export default function piTiers(pi: ExtensionAPI): void {
	const agentDir = getAgentDir();
	const path = defaultConfigPath(agentDir);
	let config: Config | undefined;
	let configError: string | undefined;
	try {
		config = loadConfig(path, agentDir);
	} catch (error) {
		configError = error instanceof ConfigError ? error.message : String(error);
	}

	pi.registerEntryRenderer<EntryData>(ENTRY, (entry, _options, theme) => new Text(theme.fg("dim", entry.data?.text ?? ""), 0, 0));

	if (!config) {
		const message = configError ?? `pi-tiers: no config at ${path}; see the README for the format.`;
		pi.registerCommand("tiers", { description: "Show pi-tiers status", handler: async (_args, ctx) => ctx.ui.notify(message, "warning") });
		if (configError) pi.on("session_start", async (_event, ctx) => ctx.ui.notify(configError!, "error"));
		return;
	}
	const cfg = config;
	const store = new CooldownStore(cfg.stateDir);
	const load = new LoadStore(cfg.stateDir);
	const quota = cfg.quota ? new QuotaStore(cfg.stateDir, cfg.quota, agentDir) : undefined;
	const remotes = new Map<string, string[]>();
	let lastRouteKey: string | undefined;
	// Last model chosen per session and tier. Direct requests (compaction, extension calls) carry no
	// router state, so this is what keeps them on the account that is already working.
	const served = new Map<string, string>();
	const routedSessions = new Set<string>();
	let lastResponse: (ResponseInfo & { key?: string; atMs: number }) | undefined;
	let lastTier: string | undefined;
	let lastAssistant: AssistantMessage | undefined;
	/** Set when the last failed turn's live quota check confirmed an exhausted account; keeps the provider's own error for the failure log.
	 * `next` is the model the turn continues on, absent when every provider is used up (the turn then ends with `line`). */
	let exhausted: { line: string; original: string; next?: string } | undefined;
	/** Sessions (and tiers) whose account just proved exhausted: their next request picks again instead of staying put. */
	const leaving = new Set<string>();
	// Size of the most recent request, for choosing a model to continue a failed run on.
	let lastTokens = 0;
	let continues = 0;
	const pending: string[] = [];

	const log = (record: Record<string, unknown>) => {
		try {
			mkdirSync(cfg.stateDir, { recursive: true });
			appendFileSync(join(cfg.stateDir, "log.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...record })}\n`);
		} catch {
			// Logging must never break a request.
		}
	};

	const gitRemotes = (cwd: string): string[] => {
		let list = remotes.get(cwd);
		if (!list) {
			try {
				list = execFileSync("git", ["-C", cwd, "remote", "-v"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 })
					.split("\n")
					.map((l) => l.split(/\s+/)[1])
					.filter(Boolean);
			} catch {
				list = [];
			}
			remotes.set(cwd, list);
		}
		return list;
	};

	// PI_TIERS_RULE=<name> forces one rule for this process and the Pi processes it starts.
	const forcedRule = process.env.PI_TIERS_RULE?.trim();
	const forced = forcedRule ? cfg.rules.find((r) => r.name === forcedRule) : undefined;
	if (forcedRule && !forced) {
		pi.on("session_start", async (_event, ctx) => ctx.ui.notify(`pi-tiers: PI_TIERS_RULE=${forcedRule} names no rule in ${cfg.path}`, "error"));
	}
	const ruleFor = (cwd: string): Rule | undefined => {
		if (forcedRule) {
			if (!forced) throw new Error(`pi-tiers: PI_TIERS_RULE=${forcedRule} names no rule in ${cfg.path}`);
			return forced;
		}
		return cfg.rules.find(
			(r) => r.cwdPrefixes.some((p) => cwd === p || cwd.startsWith(`${p}/`)) || (r.gitRemote && gitRemotes(cwd).some((u) => r.gitRemote!.test(u))),
		);
	};

	const checker =
		(ctx: ExtensionContext, tokens: number, nowMs: number, useQuota = false) =>
		(c: Candidate): SkipReason | undefined => {
			const model = ctx.modelRegistry.find(c.provider, c.model);
			if (!model) return "unknown-model";
			if (!ctx.modelRegistry.hasConfiguredAuth(model)) return "no-credentials";
			if (store.get(accountKey(c.provider), nowMs) || store.get(modelKey(c.provider, c.model), nowMs)) return "cooling";
			if (useQuota && quota && cfg.quota) {
				const reading = quota.latest.get(c.provider);
				const room = reading && roomFor(reading, c.model);
				if (room !== undefined && room < cfg.quota.minRemainingPercent) return "quota-low";
			}
			if (tokens && model.contextWindow && model.contextWindow < tokens + CONTEXT_HEADROOM) return "context-too-small";
			return undefined;
		};

	const quotaSummary = (outcomes: ReadonlyMap<string, Outcome>) =>
		Object.fromEntries(
			[...outcomes].map(([provider, o]) => [
				provider,
				"reading" in o
					? { source: o.source, windows: o.reading.windows.map((w) => ({ label: w.label, left: Math.round(w.remainingPercent), scope: w.scope })) }
					: { source: o.source, error: o.error },
			]),
		);
	const quotaLine = (outcomes: ReadonlyMap<string, Outcome>) =>
		[...outcomes].map(([provider, o]) => `${provider} ${"reading" in o ? `${describeQuota(o.reading)} (${o.source})` : `unavailable: ${o.error}`}`).join("; ");

	// A live reading is authoritative for providers that have a reader. When it shows room again, a usage-limit
	// mark on the account is stale (a banked reset restores quota before the mark's own reset time), so it is cleared.
	const clearStaleMarks = (outcomes: ReadonlyMap<string, Outcome>, nowMs: number) => {
		if (!cfg.quota) return;
		for (const [provider, o] of outcomes) {
			if (!("reading" in o)) continue;
			const mark = store.get(accountKey(provider), nowMs);
			if (mark?.reason !== "usage-limit" || (mark.atMs ?? 0) > o.reading.atMs) continue;
			const room = accountRoom(o.reading);
			if (room === undefined || room < cfg.quota.minRemainingPercent) continue;
			store.clear(accountKey(provider), o.reading.atMs);
			log({ event: "cooldown-cleared", key: accountKey(provider), reason: mark.reason, room: Math.round(room), source: o.source });
		}
	};
	const readQuota = async (providers: Iterable<string>, ctx: ExtensionContext, nowMs: number) => {
		if (!quota) return new Map<string, Outcome>();
		const outcomes = await quota.read(providers, (p) => ctx.modelRegistry.getApiKeyForProvider(p));
		clearStaleMarks(outcomes, nowMs);
		return outcomes;
	};

	/** Whether live quota covers this provider, so a text-classified cooldown is not needed for it. */
	const live = (provider: string): boolean => Boolean(cfg.quota && kindOf(provider, cfg.quota));

	const windowOf = (ctx: ExtensionContext) => (c: Candidate) => ctx.modelRegistry.find(c.provider, c.model)?.contextWindow ?? 0;

	const isBackground = () => process.env.PI_TIERS_BACKGROUND === "1";

	// Background work leaves out the providers kept for the user; with `spread`, each session starts on
	// its own member of every account group, so one account's limit moves only the sessions it served.
	// PI_TIERS_AVOID names providers (exactly as pi-tiers prints them) a restarted worker must not land on again.
	const avoided = (): Set<string> =>
		new Set(
			(process.env.PI_TIERS_AVOID ?? "")
				.split(",")
				.map((n) => n.trim())
				.filter(Boolean),
		);
	const expansion = (ctx: ExtensionContext): Expansion => {
		const skip = new Set([...(isBackground() ? cfg.background.skip : []), ...avoided()]);
		return { rotate: cfg.spread ? seedOf(ctx.sessionManager.getSessionId()) : 0, skip: skip.size ? skip : undefined };
	};

	const noteFailure = (
		provider: string,
		model: string,
		errorMessage: string,
		ctx: ExtensionContext,
		{ transientCools, notify = true }: { transientCools: boolean; notify?: boolean },
	): Failure | undefined => {
		// Providers with a live reader are marked only from a confirmed quota reading, never from error text.
		if (live(provider)) return undefined;
		const nowMs = Date.now();
		const key = `${provider}/${model}`;
		const response = lastResponse && lastResponse.key === key && nowMs - lastResponse.atMs < 120_000 ? lastResponse : undefined;
		if (!transientCools && isTransient(errorMessage, response)) {
			log({ event: "transient", key, error: errorMessage.slice(0, 300) });
			return undefined;
		}
		const failure = classifyFailure(errorMessage, response, cfg.cooldowns, nowMs);
		if (!failure) return undefined;
		const storeKey = failure.scope === "account" ? accountKey(provider) : modelKey(provider, model);
		store.set(storeKey, { untilMs: failure.untilMs, reason: failure.kind, atMs: nowMs });
		log({ event: "failure", key, kind: failure.kind, scope: failure.scope, until: new Date(failure.untilMs).toISOString(), error: errorMessage.slice(0, 300) });
		if (failure.kind === "auth" && notify)
			ctx.ui.notify(`pi-tiers: ${provider} rejected its credentials; skipping it until ${new Date(failure.untilMs).toLocaleTimeString()}`, "warning");
		return failure;
	};

	// A failure that ends a run is written where Fleet can read it, with the provider's own words and
	// reset time, whether or not this tier recovers by itself.
	const surfaceFailure = (failed: AssistantMessage, tier: string | undefined, recovery: "none" | "pool", ctx: ExtensionContext): void => {
		const nowMs = Date.now();
		const key = `${failed.provider}/${failed.model}`;
		const response = lastResponse && lastResponse.key === key && nowMs - lastResponse.atMs < 120_000 ? lastResponse : undefined;
		const message = exhausted?.original ?? failed.errorMessage ?? "";
		const classified = classifyFailure(message, response, cfg.cooldowns, nowMs);
		const resetMs = response ? resetFromHeaders(response.headers, nowMs) : undefined;
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(response?.headers ?? {}))
			if (/retry-after|reset|ratelimit|utilization/i.test(name)) headers[name.toLowerCase()] = value;
		const record = {
			v: 1,
			ts: new Date(nowMs).toISOString(),
			session: ctx.sessionManager.getSessionId(),
			pid: process.pid,
			cwd: ctx.cwd,
			tier: tier ?? null,
			provider: failed.provider,
			model: failed.model,
			status: response?.status ?? null,
			kind: classified?.kind ?? (isTransient(message, response) ? "transient" : "unknown"),
			scope: classified?.scope ?? null,
			message: message.slice(0, 4000),
			retryAfter: headers["retry-after"] ?? null,
			resetAt: resetMs ? new Date(resetMs).toISOString() : null,
			headers,
			recovery,
		};
		try {
			mkdirSync(cfg.stateDir, { recursive: true });
			appendFileSync(join(cfg.stateDir, "failures.jsonl"), `${JSON.stringify(record)}\n`);
		} catch {
			// The session entry below still carries it.
		}
		log({ event: "surfaced", key, kind: record.kind, status: record.status, recovery });
		pi.events.emit(FAILURE_EVENT, record);
		// A used-up quota is already the session's one visible line; nothing else is printed for it.
		if (recovery === "none" && !exhausted) {
			const when = record.resetAt ? `; resets ${record.resetAt}` : record.retryAfter ? `; retry-after ${record.retryAfter}s` : "";
			pi.appendEntry<EntryData>(ENTRY, {
				text: `pi-tiers: ${key} failed (${record.kind}${record.status ? ` ${record.status}` : ""}${when}): ${message.slice(0, 300)}. Not switching models; waiting for recovery.`,
			});
		}
	};

	// Reads the account's live quota and, when a window for this model is under the floor, marks the account (or the
	// model, for a model-scoped window) unavailable until the live reset time. A provider with no reader, or a
	// reading that fails, confirms nothing.
	const confirmExhausted = async (
		provider: string,
		model: string,
		ctx: ExtensionContext,
		fresh: boolean,
	): Promise<{ window: NonNullable<ReturnType<typeof exhaustedWindow>>; line: string } | undefined> => {
		if (!quota || !cfg.quota || !live(provider)) return undefined;
		const nowMs = Date.now();
		const outcome = (await quota.read([provider], (p) => ctx.modelRegistry.getApiKeyForProvider(p), nowMs, fresh)).get(provider);
		if (!outcome || !("reading" in outcome)) return undefined;
		clearStaleMarks(new Map([[provider, outcome]]), nowMs);
		const window = exhaustedWindow(outcome.reading, model, cfg.quota.minRemainingPercent);
		if (!window) return undefined;
		if (window.resetAtMs) {
			const key = window.scope ? modelKey(provider, model) : accountKey(provider);
			store.set(key, { untilMs: window.resetAtMs, reason: "usage-limit", atMs: Date.now() });
			log({ event: "failure", source: "live-quota", key, kind: "usage-limit", until: new Date(window.resetAtMs).toISOString() });
		}
		return { window, line: `${provider} ${window.label} quota has exhausted. Restart worker to launch on a new provider.` };
	};

	// The model a turn would continue on after its account ran out: the first usable candidate of the tier, by live quota.
	// The router makes the final choice (the classifier among the usable ones, code as the fallback).
	const alternative = async (ctx: ExtensionContext): Promise<string | undefined> => {
		if (!lastTier || continues >= MAX_CONTINUES) return undefined;
		const candidates = subscriptionsFirst(candidatesFor(cfg, lastTier, ruleFor(ctx.cwd), expansion(ctx)), cfg.payg);
		await readQuota(
			candidates.map((c) => c.provider),
			ctx,
			Date.now(),
		);
		const result = pick({ candidates, check: checker(ctx, lastTokens, Date.now(), true) });
		return result.chosen && !result.compacting ? candidateKey(result.chosen) : undefined;
	};

	const publish = (ctx: ExtensionContext, status: RouteStatus | undefined, text?: string) => {
		ctx.ui.setStatus(STATUS_KEY, text ?? (status ? formatStatus(status) : undefined));
		pi.events.emit(ROUTE_EVENT, status ?? null);
	};

	async function route(selected: string, req: ModelRouteRequest<TierState>, ctx: ExtensionContext): Promise<ModelRoute<TierState>> {
		const nowMs = Date.now();
		const previous = req.state ?? {};
		const state: TierState = { ...previous };

		// Pi retries a failed call on the same model with backoff; a provider without a live reader keeps a text-classified mark.
		if (req.reason === "retry" && req.failed)
			noteFailure(req.failed.model.provider, req.failed.model.id, req.failed.message.errorMessage ?? "", ctx, { transientCools: false });

		let tier = selected;
		if (selected === AUTO) {
			if (!state.tier && req.reason !== "direct") {
				const decision: AutoDecision = cfg.auto
					? await decideTier(cfg, cfg.auto, lastUserText(req.messages), ctx, req.signal)
					: { tier: [...cfg.tiers.keys()][0], fallback: "no-classifier", detail: "no auto section in config" };
				state.tier = decision.tier;
				state.auto = decision;
				const conf = decision.confidence === undefined ? "" : ` (${decision.confidence.toFixed(2)})`;
				pending.push(
					`tier: auto → ${decision.tier}${conf}${decision.fallback ? `, fallback: ${decision.fallback}${decision.detail ? `, ${decision.detail}` : ""}` : ""}`,
				);
				log({ event: "auto", ...decision });
			}
			tier = state.tier ?? cfg.auto?.fallback ?? [...cfg.tiers.keys()][0];
		}

		if (cfg.override && state.override === undefined && req.reason !== "direct") {
			state.override = parseOverride(cfg.override, messageText(req.messages.find((m: Message) => m.role === "user")));
			if (state.override) pending.push(`tier: model override ${state.override.provider}/${state.override.model} ${state.override.thinking}`);
		}

		const rule = ruleFor(ctx.cwd);
		const expand = expansion(ctx);
		let candidates = subscriptionsFirst(candidatesFor(cfg, tier, rule, expand), cfg.payg);
		if (!candidates.length && avoided().size && candidatesFor(cfg, tier, rule, { ...expand, skip: undefined }).length) {
			throw new Error(`pi-tiers: PI_TIERS_AVOID (${[...avoided()].join(",")}) leaves no provider for tier '${tier}'.`);
		}
		const override = state.override;
		if (override && !(rule?.allowProviders && !rule.allowProviders.has(override.provider)) && !expand.skip?.has(override.provider)) {
			candidates = [{ ...override, position: 0 }, ...candidates];
		}
		// Stay on the model that last served this session and tier. It is left only when live quota confirmed the
		// account exhausted (after a failed turn, or at a direct request's pick time); whatever else happens to it, the session keeps it.
		const sessionId = ctx.sessionManager.getSessionId();
		const servedKey = `${sessionId}\0${tier}`;
		// A session this process has not routed yet is starting here, even when its file already holds a committed
		// model (a resumed or restarted worker): it picks again, so an account that ran out meanwhile, or one on
		// PI_TIERS_AVOID, is not kept just because the old process used it.
		let sticky = routedSessions.has(sessionId)
			? (state.key ?? served.get(servedKey) ?? (req.previous ? `${req.previous.model.provider}/${req.previous.model.id}` : undefined))
			: undefined;
		// A failed turn confirmed this account exhausted. A direct request (compaction, an extension call) has no failed turn
		// to confirm anything, so its pick checks the live quota of the model it would stay on.
		let departed = leaving.delete(servedKey);
		if (!departed && sticky && req.reason === "direct") {
			const slash = sticky.indexOf("/");
			departed = Boolean(await confirmExhausted(sticky.slice(0, slash), sticky.slice(slash + 1), ctx, false));
		}
		if (departed) sticky = undefined;
		const tokens = requestTokens(req.messages);
		if (req.reason !== "direct") {
			lastTier = tier;
			lastTokens = tokens;
		}
		let quotaOutcomes: ReadonlyMap<string, Outcome> = new Map();
		const selectNew = async (): Promise<PickResult> => {
			// Live quota is read when a session picks its account; a failed or slow reading leaves the
			// header-based score in charge and never delays the start by more than quota.timeoutSeconds.
			quotaOutcomes = await readQuota(
				candidates.map((c) => c.provider),
				ctx,
				nowMs,
			);
			const roomOf = (c: Candidate) => {
				const reading = quota?.latest.get(c.provider);
				return reading && roomFor(reading, c.model);
			};
			const loadOf = (c: Candidate) => {
				const l = load.of(c.provider, nowMs, sessionId);
				return l.agents + l.tokens / TOKENS_PER_AGENT;
			};
			const scored = assign({
				candidates,
				payg: cfg.payg,
				check: checker(ctx, tokens, nowMs, true),
				score: (c) => {
					const l = load.of(c.provider, nowMs, sessionId);
					return l.utilization * UTILIZATION_WEIGHT + l.agents + l.tokens / TOKENS_PER_AGENT;
				},
				freeAt: (c) => {
					const reading = quota?.latest.get(c.provider);
					const quotaFree = (reading && cfg.quota && exhaustedUntilMs(reading, c.model, cfg.quota.minRemainingPercent)) || 0;
					return Math.max(store.freeAt([accountKey(c.provider), modelKey(c.provider, c.model)], nowMs), quotaFree);
				},
				contextWindow: windowOf(ctx),
				room: roomOf,
				load: loadOf,
				seed: seedOf(sessionId),
			});
			if (req.reason === "direct" || candidates[0]?.position === 0) return scored;
			// The tier is known; now the classifier chooses the provider from the tier's own usable candidates,
			// subscriptions first. Code validates the answer and falls back to the ranked pick above.
			const usable = candidates.filter((c) => !checker(ctx, tokens, nowMs, true)(c));
			// Every usable provider is offered, pay-per-token ones labelled as such; the classifier is told to prefer subscriptions.
			const offered = usable;
			if (!offered.length) return scored;
			const rows = offered.map((c) => tableRow(c, quota?.latest.get(c.provider), load.of(c.provider, nowMs, sessionId), nowMs, cfg.payg.has(c.provider)));
			const pick: { key?: string; fallback?: string; detail?: string } =
				offered.length > 1 && cfg.auto
					? await askProvider(cfg.auto, { name: tier, description: cfg.tiers.get(tier)?.description ?? "" }, lastUserText(req.messages), rows, ctx, req.signal)
					: { fallback: offered.length > 1 ? "no-classifier" : "single" };
			const chosen = pick.key ? offered.find((c) => candidateKey(c) === pick.key) : undefined;
			const record = {
				table: rows,
				answer: pick.key ?? null,
				source: chosen ? "jev" : "code",
				...(pick.fallback ? { fallback: pick.fallback } : {}),
				...(pick.detail ? { detail: pick.detail } : {}),
				chosen: candidateKey(chosen ?? scored.chosen ?? offered[0]),
			};
			log({ event: "provider-pick", session: sessionId, tier, ...record });
			return chosen ? { chosen, skipped: scored.skipped } : scored;
		};
		const known = sticky ? candidates.find((c) => candidateKey(c) === sticky) : undefined;
		const stuck = known && ctx.modelRegistry.find(known.provider, known.model);
		// Too small for the conversation is not a reason to leave: Pi compacts before sending.
		const tooSmall = Boolean(stuck?.contextWindow && stuck.contextWindow < tokens + CONTEXT_HEADROOM);
		const result: PickResult =
			known && stuck && ctx.modelRegistry.hasConfiguredAuth(stuck)
				? { chosen: known, skipped: [], ...(tooSmall ? { compacting: true } : {}) }
				: await selectNew();

		if (!result.chosen) {
			const why = result.skipped.map((s) => `${s.key}: ${s.reason}`).join(", ") || "empty chain";
			if (req.reason !== "direct") publish(ctx, undefined, `${selected === AUTO ? `auto → ${tier}` : tier} → no model available`);
			log({ event: "route", selected, tier, reason: req.reason, chosen: null, skipped: result.skipped });
			throw new Error(`pi-tiers: no usable model for tier '${tier}' (${why})`);
		}
		const chosen = result.chosen;
		const model = ctx.modelRegistry.find(chosen.provider, chosen.model)!;
		state.key = candidateKey(chosen);
		served.set(servedKey, state.key);
		routedSessions.add(sessionId);
		lastRouteKey = state.key;
		if (req.reason !== "direct") load.assign(sessionId, chosen.provider);
		if (quotaOutcomes.size && req.reason !== "direct") pending.push(`tier: quota ${quotaLine(quotaOutcomes)}; chose ${state.key}`);

		// The status line describes the conversation, so direct requests (compaction, extension calls
		// on other tiers) are logged but never published over the session's own route.
		if (req.reason !== "direct")
			publish(ctx, {
				selected,
				tier,
				auto: state.auto ? { confidence: state.auto.confidence, unsure: Boolean(state.auto.fallback) } : undefined,
				provider: chosen.provider,
				model: chosen.model,
				thinking: chosen.thinking,
				position: chosen.position,
				warn: cfg.warnProviders.has(chosen.provider),
				rule: rule?.name,
			});
		log({
			event: "route",
			session: ctx.sessionManager.getSessionId(),
			selected,
			tier,
			reason: req.reason,
			chosen: state.key,
			position: chosen.position,
			skipped: result.skipped,
			rule: rule?.name,
			tokens,
			...(quotaOutcomes.size ? { quota: quotaSummary(quotaOutcomes) } : {}),
			...(result.compacting ? { compacting: true } : {}),
			...(departed ? { departed: true } : {}),
		});

		const changed = JSON.stringify(state) !== JSON.stringify(previous);
		return { model, thinkingLevel: chosen.thinking as ModelRoute["thinkingLevel"], state: changed ? state : req.state };
	}

	for (const id of [...cfg.tiers.keys(), ...(cfg.auto ? [AUTO] : [])]) {
		pi.registerVirtualModel<TierState>({
			provider: PROVIDER,
			id,
			name: id === AUTO ? "Tier: auto" : `Tier: ${id}`,
			thinkingLevels: ["medium"],
			route: (req, ctx) => route(id, req, ctx),
		});
	}

	// Agent-loop requests report their HTTP status here before Pi decides whether to retry, so the
	// cooldown exists even when the retry budget runs out. Providers with a live quota reader get none: only a confirmed reading marks them. Direct requests (compaction summaries,
	// extension calls through the registry) do not emit this event; they are protected only by
	// cooldowns that agent-loop requests in this or another process already recorded.
	pi.on("after_provider_response", async (event) => {
		const nowMs = Date.now();
		lastResponse = { status: event.status, headers: event.headers, key: lastRouteKey, atMs: nowMs };
		const utilization = utilizationFromHeaders(event.headers);
		if (utilization !== undefined && lastRouteKey) load.setUtilization(lastRouteKey.slice(0, lastRouteKey.indexOf("/")), utilization, nowMs);
		const failing = event.status === 401 || event.status === 403 || event.status === 429 || event.status >= 500;
		if (!failing || !lastRouteKey) return;
		const slash = lastRouteKey.indexOf("/");
		const provider = lastRouteKey.slice(0, slash);
		const model = lastRouteKey.slice(slash + 1);
		if (live(provider)) return;
		const failure = classifyFailure("", { status: event.status, headers: event.headers }, cfg.cooldowns, nowMs);
		if (!failure) return;
		const storeKey = failure.scope === "account" ? accountKey(provider) : modelKey(provider, model);
		if ((store.get(storeKey, nowMs)?.untilMs ?? 0) >= failure.untilMs) return;
		store.set(storeKey, { untilMs: failure.untilMs, reason: failure.kind, atMs: nowMs });
		log({
			event: "failure",
			source: "response",
			key: lastRouteKey,
			kind: failure.kind,
			scope: failure.scope,
			until: new Date(failure.untilMs).toISOString(),
			status: event.status,
		});
	});

	pi.on("agent_start", async () => {
		lastAssistant = undefined;
		exhausted = undefined;
		continues = 0;
	});

	// A failed turn whose account has run out of quota: the run continues on another provider when one is usable, and ends
	// with exactly one line naming the provider and window when none is. Any other failure is Pi's to retry (settings `retry`)
	// on the same model, and when retries run out it is surfaced as it is: pi-tiers never switches provider for it.
	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		lastAssistant = event.message as AssistantMessage;
		const usage = lastAssistant.usage;
		if (lastAssistant.stopReason !== "error" && usage)
			load.addUsage(lastAssistant.provider, (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheWrite ?? 0), Date.now());
		while (pending.length) pi.appendEntry<EntryData>(ENTRY, { text: pending.shift()! });
		if (lastAssistant.stopReason !== "error" || ctx.model?.provider !== PROVIDER) return;
		const failed = lastAssistant;
		const found = await confirmExhausted(failed.provider, failed.model, ctx, true);
		if (!found) return;
		const next = await alternative(ctx);
		const key = `${failed.provider}/${failed.model}`;
		exhausted = { line: found.line, original: failed.errorMessage ?? "", next };
		log({ event: "quota-exhausted", key, line: found.line, next: next ?? null });
		// Either text is one Pi does not retry: the same account would only fail again.
		if (next) leaving.add(`${ctx.sessionManager.getSessionId()}\0${lastTier}`);
		lastAssistant = {
			...failed,
			errorMessage: next ? `pi-tiers: ${failed.provider} ${found.window.label} quota exhausted; continuing on another provider.` : found.line,
		};
		return { message: lastAssistant };
	});

	// A failure Pi no longer retries ends the run. When it was a confirmed quota exhaustion with another provider usable,
	// ask for one more request, which the router sends there. Otherwise the session keeps its model and the failure
	// is only recorded for Fleet, which decides whether to restart the worker.
	pi.on("agent_before_settle", async (event, ctx) => {
		const failed = lastAssistant;
		if (event.outcome !== "error" || failed?.stopReason !== "error" || ctx.model?.provider !== PROVIDER) return;
		// event.context.canContinue is false here because the run ends on the failed assistant message;
		// the custom message returned below is what makes the continuation valid.
		if (ctx.signal?.aborted) return;
		noteFailure(failed.provider, failed.model, exhausted?.original ?? failed.errorMessage ?? "", ctx, { transientCools: true, notify: false });
		const next = exhausted?.next;
		surfaceFailure(failed, lastTier, next ? "pool" : "none", ctx);
		if (!next) return;
		continues++;
		return {
			entries: [
				{
					type: "custom_message" as const,
					customType: ENTRY,
					content: `pi-tiers: ${failed.provider}/${failed.model} has no quota left; continuing the interrupted turn on another provider.`,
					display: true,
				},
			],
			continue: true,
		};
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		load.release(ctx.sessionManager.getSessionId());
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.model?.provider === PROVIDER) publish(ctx, undefined, `${ctx.model.id} → …`);
	});

	pi.on("model_select", async (event, ctx) => {
		if (event.model.provider !== PROVIDER) publish(ctx, undefined, undefined);
		else publish(ctx, undefined, `${event.model.id} → …`);
	});

	pi.registerCommand("tier", {
		description: "Switch to a tier: /tier <name> (or pick one)",
		getArgumentCompletions: (prefix) =>
			[...cfg.tiers.keys(), ...(cfg.auto ? [AUTO] : [])].filter((n) => n.startsWith(prefix)).map((n) => ({ value: n, label: n })),
		handler: async (args, ctx) => {
			const names = [...cfg.tiers.keys(), ...(cfg.auto ? [AUTO] : [])];
			const name = args.trim() || (ctx.hasUI ? await ctx.ui.select("Tier", names) : undefined);
			if (!name) return;
			const model = ctx.modelRegistry.find(PROVIDER, name);
			if (!model || !(await pi.setModel(model))) ctx.ui.notify(`pi-tiers: unknown tier '${name}'`, "error");
		},
	});

	pi.registerCommand("tiers", {
		description: "Show tier chains, usable models, and cooldowns",
		handler: async (_args, ctx) => {
			const nowMs = Date.now();
			const rule = ruleFor(ctx.cwd);
			const check = checker(ctx, 0, nowMs);
			const lines = [`pi-tiers (${cfg.path})${rule ? `, rule: ${rule.name}` : ""}`];
			for (const name of cfg.tiers.keys()) {
				const parts = candidatesFor(cfg, name, rule, expansion(ctx)).map((c) => {
					const reason = check(c);
					return `${candidateKey(c)}:${c.thinking}${reason ? ` [${reason}]` : ""}`;
				});
				lines.push(`${name}: ${parts.join(" → ")}`);
			}
			if (quota) {
				const providers = new Set([...cfg.tiers.keys()].flatMap((name) => candidatesFor(cfg, name, rule, expansion(ctx)).map((c) => c.provider)));
				const outcomes = await quota.read(providers, (p) => ctx.modelRegistry.getApiKeyForProvider(p));
				lines.push(outcomes.size ? `quota (usable above ${cfg.quota!.minRemainingPercent}% left): ${quotaLine(outcomes)}` : "quota: no readable accounts");
			}
			const active = store.active(nowMs);
			lines.push(active.length ? "cooldowns:" : "cooldowns: none");
			for (const [key, e] of active) lines.push(`  ${key} ${e.reason} until ${new Date(e.untilMs).toLocaleString()}`);
			pi.appendEntry<EntryData>(ENTRY, { text: lines.join("\n") });
			if (!ctx.hasUI) console.log(lines.join("\n"));
		},
	});
}

/** Room left in the account-wide windows, which model-scoped windows do not change. */
function accountRoom(reading: QuotaReading): number | undefined {
	const windows = reading.windows.filter((w) => !w.scope);
	return windows.length ? Math.min(...windows.map((w) => w.remainingPercent)) : undefined;
}

function parseOverride(pattern: RegExp, text: string): Override | null {
	const m = pattern.exec(text);
	if (!m?.[1]) return null;
	const spec = m[1].trim();
	const slash = spec.indexOf("/");
	if (slash <= 0) return null;
	const level = (m[2] ?? "").trim().toLowerCase();
	return {
		provider: spec.slice(0, slash),
		model: spec.slice(slash + 1),
		thinking: (THINKING_LEVELS as readonly string[]).includes(level) ? (level as Thinking) : "medium",
	};
}

/**
 * Size of what this request sends. Pi's own session figure is not used: after an edit to the
 * context it re-estimates the whole stored branch, which can be many times what the request carries.
 * Starts from the last real response's reported usage and adds the messages after it; without one,
 * estimates every message the way Pi does (images at a fixed size, signatures not counted).
 */
function requestTokens(messages: readonly Message[]): number {
	let start = 0;
	let tokens = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted" && m.usage?.totalTokens > 0) {
			tokens = m.usage.totalTokens;
			start = i + 1;
			break;
		}
	}
	for (const m of messages.slice(start)) tokens += estimateMessageTokens(m);
	return tokens;
}

/** A stable number per session, so a session keeps its starting account across processes and restarts. */
function seedOf(sessionId: string): number {
	let hash = 2166136261;
	for (let i = 0; i < sessionId.length; i++) hash = Math.imul(hash ^ sessionId.charCodeAt(i), 16777619);
	return hash >>> 0;
}
