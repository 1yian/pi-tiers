// pi-tiers: work tiers as virtual models. Each tier walks an ordered model chain across
// accounts, cools down accounts that fail, and `tier/auto` picks the tier with a classifier.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, type ModelRoute, type ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type AutoDecision, decideTier, lastUserText, messageText } from "./auto.ts";
import { type Candidate, candidateKey, candidatesFor, pick, type SkipReason } from "./chain.ts";
import { type Config, ConfigError, defaultConfigPath, loadConfig, type Rule, THINKING_LEVELS, type Thinking } from "./config.ts";
import { accountKey, CooldownStore, modelKey } from "./cooldowns.ts";
import { classifyFailure, type Failure, type ResponseInfo } from "./failures.ts";
import { formatStatus, type RouteStatus } from "./status.ts";

export const PROVIDER = "tier";
export const AUTO = "auto";
export const STATUS_KEY = "pi-tiers";
export const ROUTE_EVENT = "pi-tiers:route";
const ENTRY = "pi-tiers";
/** Room left for the response when checking whether a conversation fits a model's context window. */
const CONTEXT_HEADROOM = 16_000;
/** Continuations the extension may request in one run after a request failed outright. */
const MAX_CONTINUES = 4;

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
	/** provider/model that answered last, kept within a turn for prompt-cache reuse. */
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
	const remotes = new Map<string, string[]>();
	let lastRouteKey: string | undefined;
	let lastResponse: (ResponseInfo & { key?: string; atMs: number }) | undefined;
	let lastTier: string | undefined;
	let lastAssistant: AssistantMessage | undefined;
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
		(ctx: ExtensionContext, tokens: number, nowMs: number) =>
		(c: Candidate): SkipReason | undefined => {
			const model = ctx.modelRegistry.find(c.provider, c.model);
			if (!model) return "unknown-model";
			if (!ctx.modelRegistry.hasConfiguredAuth(model)) return "no-credentials";
			if (store.get(accountKey(c.provider), nowMs) || store.get(modelKey(c.provider, c.model), nowMs)) return "cooling";
			if (tokens && model.contextWindow && model.contextWindow < tokens + CONTEXT_HEADROOM) return "context-too-small";
			return undefined;
		};

	const noteFailure = (provider: string, model: string, errorMessage: string, ctx: ExtensionContext): Failure | undefined => {
		const nowMs = Date.now();
		const key = `${provider}/${model}`;
		const response = lastResponse && lastResponse.key === key && nowMs - lastResponse.atMs < 120_000 ? lastResponse : undefined;
		const failure = classifyFailure(errorMessage, response, cfg.cooldowns, nowMs);
		if (!failure) return undefined;
		const storeKey = failure.scope === "account" ? accountKey(provider) : modelKey(provider, model);
		store.set(storeKey, { untilMs: failure.untilMs, reason: failure.kind });
		log({ event: "failure", key, kind: failure.kind, scope: failure.scope, until: new Date(failure.untilMs).toISOString(), error: errorMessage.slice(0, 300) });
		if (failure.kind === "auth")
			ctx.ui.notify(`pi-tiers: ${provider} rejected its credentials; skipping it until ${new Date(failure.untilMs).toLocaleTimeString()}`, "warning");
		return failure;
	};

	const publish = (ctx: ExtensionContext, status: RouteStatus | undefined, text?: string) => {
		ctx.ui.setStatus(STATUS_KEY, text ?? (status ? formatStatus(status) : undefined));
		pi.events.emit(ROUTE_EVENT, status ?? null);
	};

	async function route(selected: string, req: ModelRouteRequest<TierState>, ctx: ExtensionContext): Promise<ModelRoute<TierState>> {
		const nowMs = Date.now();
		const previous = req.state ?? {};
		const state: TierState = { ...previous };

		if (req.reason === "retry" && req.failed) noteFailure(req.failed.model.provider, req.failed.model.id, req.failed.message.errorMessage ?? "", ctx);

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
		lastTier = tier;

		if (cfg.override && state.override === undefined && req.reason !== "direct") {
			state.override = parseOverride(cfg.override, messageText(req.messages.find((m: Message) => m.role === "user")));
			if (state.override) pending.push(`tier: model override ${state.override.provider}/${state.override.model} ${state.override.thinking}`);
		}

		const rule = ruleFor(ctx.cwd);
		let candidates = candidatesFor(cfg, tier, rule);
		const override = state.override;
		if (override && !(rule?.allowProviders && !rule.allowProviders.has(override.provider))) {
			candidates = [{ ...override, position: 0 }, ...candidates];
		}
		const sticky = req.reason === "user" ? undefined : (state.key ?? (req.previous ? `${req.previous.model.provider}/${req.previous.model.id}` : undefined));
		const tokens = ctx.getContextUsage()?.tokens ?? estimateTokens(req.messages);
		const result = pick({ candidates, prefer: sticky, check: checker(ctx, tokens, nowMs) });

		if (!result.chosen) {
			const why = result.skipped.map((s) => `${s.key}: ${s.reason}`).join(", ") || "empty chain";
			publish(ctx, undefined, `${selected === AUTO ? `auto → ${tier}` : tier} → no model available`);
			log({ event: "route", selected, tier, reason: req.reason, chosen: null, skipped: result.skipped });
			throw new Error(`pi-tiers: no usable model for tier '${tier}' (${why})`);
		}
		const chosen = result.chosen;
		const model = ctx.modelRegistry.find(chosen.provider, chosen.model)!;
		state.key = candidateKey(chosen);
		lastRouteKey = state.key;

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
	// cooldown exists even when the retry budget runs out. Direct requests (compaction summaries,
	// extension calls through the registry) do not emit this event; they are protected only by
	// cooldowns that agent-loop requests in this or another process already recorded.
	pi.on("after_provider_response", async (event) => {
		const nowMs = Date.now();
		lastResponse = { status: event.status, headers: event.headers, key: lastRouteKey, atMs: nowMs };
		const failing = event.status === 401 || event.status === 403 || event.status === 429 || event.status >= 500;
		if (!failing || !lastRouteKey) return;
		const slash = lastRouteKey.indexOf("/");
		const provider = lastRouteKey.slice(0, slash);
		const model = lastRouteKey.slice(slash + 1);
		const failure = classifyFailure("", { status: event.status, headers: event.headers }, cfg.cooldowns, nowMs);
		if (!failure) return;
		const storeKey = failure.scope === "account" ? accountKey(provider) : modelKey(provider, model);
		if ((store.get(storeKey, nowMs)?.untilMs ?? 0) >= failure.untilMs) return;
		store.set(storeKey, { untilMs: failure.untilMs, reason: failure.kind });
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
		continues = 0;
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		lastAssistant = event.message as AssistantMessage;
		while (pending.length) pi.appendEntry<EntryData>(ENTRY, { text: pending.shift()! });
	});

	// A failure Pi does not retry (usage limits, exhausted retries) ends the run. Cool the account
	// down and ask for one more request, which the router sends to the next usable model.
	pi.on("agent_before_settle", async (event, ctx) => {
		const failed = lastAssistant;
		if (event.outcome !== "error" || failed?.stopReason !== "error" || ctx.model?.provider !== PROVIDER) return;
		// event.context.canContinue is false here because the run ends on the failed assistant message;
		// the custom message returned below is what makes the continuation valid.
		if (ctx.signal?.aborted || continues >= MAX_CONTINUES) return;
		const failure = noteFailure(failed.provider, failed.model, failed.errorMessage ?? "", ctx);
		if (!failure || !lastTier) return;
		const nowMs = Date.now();
		const rule = ruleFor(ctx.cwd);
		const next = pick({ candidates: candidatesFor(cfg, lastTier, rule), check: checker(ctx, ctx.getContextUsage()?.tokens ?? 0, nowMs) }).chosen;
		if (!next) return;
		continues++;
		return {
			entries: [
				{
					type: "custom_message" as const,
					customType: ENTRY,
					content: `pi-tiers: ${failed.provider}/${failed.model} failed (${failure.kind}); continuing the interrupted turn on ${candidateKey(next)}.`,
					display: true,
				},
			],
			continue: true,
		};
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
				const parts = candidatesFor(cfg, name, rule).map((c) => {
					const reason = check(c);
					return `${candidateKey(c)}:${c.thinking}${reason ? ` [${reason}]` : ""}`;
				});
				lines.push(`${name}: ${parts.join(" → ")}`);
			}
			const active = store.active(nowMs);
			lines.push(active.length ? "cooldowns:" : "cooldowns: none");
			for (const [key, e] of active) lines.push(`  ${key} ${e.reason} until ${new Date(e.untilMs).toLocaleString()}`);
			pi.appendEntry<EntryData>(ENTRY, { text: lines.join("\n") });
			if (!ctx.hasUI) console.log(lines.join("\n"));
		},
	});
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

function estimateTokens(messages: readonly Message[]): number {
	let chars = 0;
	for (const m of messages) chars += JSON.stringify((m as { content?: unknown }).content ?? "").length;
	return Math.ceil(chars / 4);
}
