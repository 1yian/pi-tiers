// Parses tiers.json into typed config. This is the only place raw config is validated;
// everything downstream trusts these types.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_QUOTA, type QuotaConfig, type QuotaKind } from "./quota.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING_LEVELS)[number];

/** One rung of a chain: `provider/model:thinking`, where provider may name an account group. */
export interface ChainEntry {
	provider: string;
	model: string;
	thinking: Thinking;
}

export interface TierDef {
	name: string;
	description: string;
	chain: ChainEntry[];
}

export interface Rule {
	name: string;
	gitRemote?: RegExp;
	cwdPrefixes: string[];
	/** Full chain replacements for this context. */
	tiers: Map<string, ChainEntry[]>;
	/** When set, base chains of tiers without a replacement keep only these providers (after account expansion). */
	allowProviders?: Set<string>;
}

export interface AutoConfig {
	classifierProvider: string;
	classifierModel: string;
	tiers: string[];
	fallback: string;
	minConfidence: number;
	/** Markdown headings whose sections are sent instead of the whole message, when present. */
	sections: string[];
	maxChars: number;
	/** How long the provider pick may take before code picks instead. */
	providerTimeoutMs: number;
}

export interface Cooldowns {
	rateLimitSeconds: number;
	serverErrorSeconds: number;
	usageLimitSeconds: number;
	authSeconds: number;
}

/** Background work: every request from a process started with PI_TIERS_BACKGROUND=1. */
export interface Background {
	/** Providers background work never uses, such as an account kept for the user. */
	skip: Set<string>;
}

export interface Config {
	path: string;
	accounts: Map<string, string[]>;
	tiers: Map<string, TierDef>;
	auto?: AutoConfig;
	rules: Rule[];
	override?: RegExp;
	cooldowns: Cooldowns;
	background: Background;
	/** Start each session on a different member of an account group, chosen from its session id. */
	spread: boolean;
	/** Live quota used to choose where a session starts; undefined when `quota` is false. */
	quota?: QuotaConfig;
	warnProviders: Set<string>;
	/** Pay-per-token providers: offered only when no subscription candidate is left. */
	payg: Set<string>;
	stateDir: string;
}

export class ConfigError extends Error {}

const TIER_NAME = /^[a-z][a-z0-9-]*$/;

export function defaultConfigPath(agentDir: string): string {
	return process.env.PI_TIERS_CONFIG || join(agentDir, "tiers.json");
}

export function loadConfig(path: string, agentDir: string): Config | undefined {
	if (!existsSync(path)) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new ConfigError(`${path}: ${(error as Error).message}`);
	}
	return parseConfig(raw, path, agentDir);
}

export function parseConfig(raw: unknown, path: string, agentDir: string): Config {
	const fail = (where: string, what: string): never => {
		throw new ConfigError(`${path}: ${where}: ${what}`);
	};
	const obj = (value: unknown, where: string): Record<string, unknown> =>
		value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : fail(where, "expected an object");
	const str = (value: unknown, where: string): string => (typeof value === "string" && value ? value : fail(where, "expected a non-empty string"));
	const strArray = (value: unknown, where: string): string[] =>
		Array.isArray(value) ? value.map((v, i) => str(v, `${where}[${i}]`)) : fail(where, "expected an array of strings");
	const num = (value: unknown, where: string, fallback: number): number =>
		value === undefined ? fallback : typeof value === "number" && value >= 0 ? value : fail(where, "expected a non-negative number");

	const root = obj(raw, "root");

	const accounts = new Map<string, string[]>();
	for (const [group, list] of Object.entries(obj(root.accounts ?? {}, "accounts"))) {
		const members = strArray(list, `accounts.${group}`);
		if (members.length === 0) fail(`accounts.${group}`, "needs at least one provider");
		accounts.set(group, members);
	}

	const chain = (value: unknown, where: string): ChainEntry[] => {
		const entries = strArray(value, where).map((spec, i) => parseEntry(spec, `${where}[${i}]`, fail));
		if (entries.length === 0) fail(where, "needs at least one model");
		return entries;
	};

	const tiers = new Map<string, TierDef>();
	for (const [name, def] of Object.entries(obj(root.tiers, "tiers"))) {
		if (!TIER_NAME.test(name) || name === "auto") fail(`tiers.${name}`, "tier names are lowercase words and cannot be 'auto'");
		const d = obj(def, `tiers.${name}`);
		tiers.set(name, { name, description: typeof d.description === "string" ? d.description : "", chain: chain(d.chain, `tiers.${name}.chain`) });
	}
	if (tiers.size === 0) fail("tiers", "define at least one tier");

	let auto: AutoConfig | undefined;
	if (root.auto !== undefined) {
		const a = obj(root.auto, "auto");
		const [classifierProvider, ...rest] = str(a.classifier, "auto.classifier").split("/");
		if (!classifierProvider || rest.length === 0) fail("auto.classifier", "expected provider/model");
		const autoTiers = a.tiers === undefined ? [...tiers.keys()] : strArray(a.tiers, "auto.tiers");
		for (const t of autoTiers) {
			if (!tiers.has(t)) fail("auto.tiers", `unknown tier '${t}'`);
			if (!tiers.get(t)!.description) fail(`tiers.${t}.description`, "auto needs a description for every tier it can pick");
		}
		const fallback = str(a.fallback ?? autoTiers[0], "auto.fallback");
		if (!tiers.has(fallback)) fail("auto.fallback", `unknown tier '${fallback}'`);
		const minConfidence = num(a.minConfidence, "auto.minConfidence", 0.6);
		if (minConfidence > 1) fail("auto.minConfidence", "expected a value between 0 and 1");
		auto = {
			classifierProvider,
			classifierModel: rest.join("/"),
			tiers: autoTiers,
			fallback,
			minConfidence,
			sections: a.sections === undefined ? [] : strArray(a.sections, "auto.sections"),
			maxChars: num(a.maxChars, "auto.maxChars", 12000),
			providerTimeoutMs: num(a.providerTimeoutSeconds, "auto.providerTimeoutSeconds", 3) * 1000,
		};
	}

	const rules: Rule[] = [];
	const rawRules = root.rules === undefined ? [] : root.rules;
	if (!Array.isArray(rawRules)) fail("rules", "expected an array");
	(rawRules as unknown[]).forEach((value, i) => {
		const r = obj(value, `rules[${i}]`);
		const where = `rules[${i}]`;
		const m = obj(r.match, `${where}.match`);
		const gitRemote = m.gitRemote === undefined ? undefined : regex(str(m.gitRemote, `${where}.match.gitRemote`), `${where}.match.gitRemote`, fail);
		const cwdPrefixes =
			m.cwdPrefix === undefined ? [] : strArray(Array.isArray(m.cwdPrefix) ? m.cwdPrefix : [m.cwdPrefix], `${where}.match.cwdPrefix`).map(expandHome);
		if (!gitRemote && cwdPrefixes.length === 0) fail(`${where}.match`, "needs gitRemote or cwdPrefix");
		const ruleTiers = new Map<string, ChainEntry[]>();
		for (const [name, c] of Object.entries(obj(r.tiers ?? {}, `${where}.tiers`))) {
			if (!tiers.has(name)) fail(`${where}.tiers`, `unknown tier '${name}'`);
			ruleTiers.set(name, chain(c, `${where}.tiers.${name}`));
		}
		const allow = r.allowProviders === undefined ? undefined : new Set(strArray(r.allowProviders, `${where}.allowProviders`));
		rules.push({ name: typeof r.name === "string" ? r.name : `rule ${i + 1}`, gitRemote, cwdPrefixes, tiers: ruleTiers, allowProviders: allow });
	});

	const c = obj(root.cooldowns ?? {}, "cooldowns");
	const cooldowns: Cooldowns = {
		rateLimitSeconds: num(c.rateLimitSeconds, "cooldowns.rateLimitSeconds", 600),
		serverErrorSeconds: num(c.serverErrorSeconds, "cooldowns.serverErrorSeconds", 30),
		usageLimitSeconds: num(c.usageLimitSeconds, "cooldowns.usageLimitSeconds", 3600),
		authSeconds: num(c.authSeconds, "cooldowns.authSeconds", 3600),
	};

	const b = obj(root.background ?? {}, "background");
	const background: Background = {
		skip: new Set(b.skip === undefined ? [] : strArray(b.skip, "background.skip")),
	};
	if (root.spread !== undefined && typeof root.spread !== "boolean") fail("spread", "expected true or false");

	let quota: QuotaConfig | undefined = DEFAULT_QUOTA;
	if (root.quota === false) quota = undefined;
	else if (root.quota !== undefined) {
		const q = obj(root.quota, "quota");
		const percent = num(q.minRemainingPercent, "quota.minRemainingPercent", DEFAULT_QUOTA.minRemainingPercent);
		if (percent > 100) fail("quota.minRemainingPercent", "expected a value between 0 and 100");
		const kinds = new Map<string, QuotaKind>();
		for (const [provider, kind] of Object.entries(obj(q.providers ?? {}, "quota.providers"))) {
			if (kind !== "anthropic" && kind !== "codex" && kind !== "xai") fail(`quota.providers.${provider}`, "expected anthropic, codex, or xai");
			kinds.set(provider, kind as QuotaKind);
		}
		const urls = obj(q.baseUrls ?? {}, "quota.baseUrls");
		const baseUrls: QuotaConfig["baseUrls"] = {};
		for (const name of ["anthropic", "codex", "xai", "xaiManagement"] as const)
			if (urls[name] !== undefined) baseUrls[name] = str(urls[name], `quota.baseUrls.${name}`);
		const xai = obj(q.xai ?? {}, "quota.xai");
		quota = {
			minRemainingPercent: percent,
			timeoutMs: num(q.timeoutSeconds, "quota.timeoutSeconds", DEFAULT_QUOTA.timeoutMs / 1000) * 1000,
			cacheSeconds: num(q.cacheSeconds, "quota.cacheSeconds", DEFAULT_QUOTA.cacheSeconds),
			kinds,
			baseUrls,
			xaiReferenceUsd: num(xai.referenceUsd, "quota.xai.referenceUsd", DEFAULT_QUOTA.xaiReferenceUsd) || DEFAULT_QUOTA.xaiReferenceUsd,
		};
	}

	return {
		path,
		accounts,
		tiers,
		auto,
		rules,
		override: root.override === undefined ? undefined : regex(str(root.override, "override"), "override", fail),
		cooldowns,
		background,
		spread: root.spread === true,
		quota,
		warnProviders: new Set(root.warnProviders === undefined ? [] : strArray(root.warnProviders, "warnProviders")),
		payg: new Set(root.payg === undefined ? [] : strArray(root.payg, "payg")),
		stateDir: root.stateDir === undefined ? join(agentDir, "tiers") : expandHome(str(root.stateDir, "stateDir")),
	};
}

function parseEntry(spec: string, where: string, fail: (where: string, what: string) => never): ChainEntry {
	const slash = spec.indexOf("/");
	if (slash <= 0) fail(where, `'${spec}' is not provider/model[:thinking]`);
	const provider = spec.slice(0, slash);
	let model = spec.slice(slash + 1);
	let thinking: Thinking = "medium";
	const colon = model.lastIndexOf(":");
	if (colon > 0 && (THINKING_LEVELS as readonly string[]).includes(model.slice(colon + 1))) {
		thinking = model.slice(colon + 1) as Thinking;
		model = model.slice(0, colon);
	}
	if (!model) fail(where, `'${spec}' has no model id`);
	return { provider, model, thinking };
}

function regex(source: string, where: string, fail: (where: string, what: string) => never): RegExp {
	try {
		return new RegExp(source, "im");
	} catch (error) {
		return fail(where, (error as Error).message);
	}
}

function expandHome(path: string): string {
	return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}
