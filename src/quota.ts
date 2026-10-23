// Live quota of each provider account, read once when a session picks where to start and shared by
// every Pi process on the machine (quota/<provider>.json), so many sessions starting together make
// one request per account. Never throws: a reading that fails or runs out of time is simply absent.
//
// The Anthropic and Codex readers are adapted from pi-multi-pass (extensions/multi-sub.ts, 1.12.0):
//
// MIT License
// Copyright (c) 2026 hjanuschka
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions: The above copyright notice and this
// permission notice shall be included in all copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type QuotaKind = "anthropic" | "codex" | "xai";

export interface QuotaWindow {
	label: string;
	/** 0..100 left in this window. */
	remainingPercent: number;
	/** When the window resets (epoch ms). */
	resetAtMs?: number;
	/** Lowercase model name this window applies to (such as "opus"); absent for account-wide windows. */
	scope?: string;
}

export interface QuotaReading {
	kind: QuotaKind;
	windows: QuotaWindow[];
	atMs: number;
}

export interface QuotaConfig {
	/** An account with less than this much left in a window is not usable for a new session. */
	minRemainingPercent: number;
	/** Total time a session start may spend waiting for readings. */
	timeoutMs: number;
	cacheSeconds: number;
	/** Providers with a reader, beyond the built-in names. */
	kinds: Map<string, QuotaKind>;
	/** Endpoint overrides, for tests and proxies. */
	baseUrls: Partial<Record<"anthropic" | "codex" | "xai" | "xaiManagement", string>>;
	/** Prepaid xAI credit that counts as "full", to express a dollar balance as a percentage. */
	xaiReferenceUsd: number;
}

export const DEFAULT_QUOTA: QuotaConfig = {
	minRemainingPercent: 5,
	timeoutMs: 3000,
	cacheSeconds: 60,
	kinds: new Map(),
	baseUrls: {},
	xaiReferenceUsd: 20,
};

const FAILURE_CACHE_MS = 15_000;
const LOCK_POLL_MS = 50;

export function kindOf(provider: string, config: QuotaConfig): QuotaKind | undefined {
	const named = config.kinds.get(provider);
	if (named) return named;
	if (/^anthropic(-\d+)?$/.test(provider)) return "anthropic";
	if (/^openai-codex(-\d+)?$/.test(provider)) return "codex";
	if (provider === "xai") return "xai";
	return undefined;
}

/** Room left for a model on this account: its tightest window, counting model-scoped windows only for that model. */
export function roomFor(reading: QuotaReading, model: string): number | undefined {
	const lower = model.toLowerCase();
	const applicable = reading.windows.filter((w) => !w.scope || lower.includes(w.scope));
	return applicable.length ? Math.min(...applicable.map((w) => w.remainingPercent)) : undefined;
}

/** When the window that is under `minPercent` for this model frees up, if known. */
export function exhaustedUntilMs(reading: QuotaReading, model: string, minPercent: number): number | undefined {
	const lower = model.toLowerCase();
	const low = reading.windows.filter((w) => (!w.scope || lower.includes(w.scope)) && w.remainingPercent < minPercent && w.resetAtMs);
	return low.length ? Math.max(...low.map((w) => w.resetAtMs!)) : undefined;
}

export function describe(reading: QuotaReading): string {
	return reading.windows.map((w) => `${w.label} ${Math.round(w.remainingPercent)}%`).join(", ");
}

// ---------------------------------------------------------------------------------------------
// Parsing (pure)

const record = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const clampPercent = (n: number) => Math.max(0, Math.min(100, n));
const isoMs = (value: unknown): number | undefined => {
	if (typeof value !== "string") return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : undefined;
};

export function parseAnthropic(data: unknown): QuotaWindow[] {
	const raw = record(data);
	const windows: QuotaWindow[] = [];
	for (const [label, value] of [
		["5h", raw?.five_hour],
		["7d", raw?.seven_day],
	] as const) {
		const w = record(value);
		if (w && typeof w.utilization === "number") windows.push({ label, remainingPercent: clampPercent(100 - w.utilization), resetAtMs: isoMs(w.resets_at) });
	}
	// Model-scoped weekly limits (such as Opus) are separate from the flat fields above.
	for (const entry of Array.isArray(raw?.limits) ? raw.limits : []) {
		const limit = record(entry);
		if (limit?.kind !== "weekly_scoped" || typeof limit.percent !== "number") continue;
		const name = record(record(limit.scope)?.model)?.display_name;
		const scope = typeof name === "string" && name ? name.toLowerCase().replace(/^claude\s+/, "") : undefined;
		windows.push({ label: `7d ${scope ?? "scoped"}`, remainingPercent: clampPercent(100 - limit.percent), resetAtMs: isoMs(limit.resets_at), scope });
	}
	return windows;
}

export function parseCodex(data: unknown): QuotaWindow[] {
	const rate = record(record(data)?.rate_limit);
	const windows: QuotaWindow[] = [];
	for (const value of [rate?.primary_window, rate?.secondary_window]) {
		const w = record(value);
		if (!w) continue;
		const seconds = typeof w.limit_window_seconds === "number" ? w.limit_window_seconds : 0;
		const used = typeof w.used_percent === "number" ? w.used_percent : 0;
		const hours = seconds / 3600;
		const label = Math.abs(hours - 5) < 0.04 ? "5h" : Math.abs(hours - 168) < 0.04 ? "7d" : `${Math.round(hours)}h`;
		windows.push({ label, remainingPercent: clampPercent(100 - used), resetAtMs: typeof w.reset_at === "number" ? w.reset_at * 1000 : undefined });
	}
	return windows;
}

const cents = (value: unknown): number => {
	const n = Number(record(value)?.val ?? 0);
	return Number.isFinite(n) ? n : 0;
};

/** SuperGrok / X Premium subscription credits (the login Pi's xai provider holds). */
export function parseXaiCredits(data: unknown, referenceUsd: number): QuotaWindow[] {
	const config = record(record(data)?.config);
	if (!config) return [];
	const monthly = cents(config.monthlyLimit);
	const used = typeof config.creditUsagePercent === "number" ? config.creditUsagePercent : monthly > 0 ? (cents(config.used) / monthly) * 100 : undefined;
	if (used === undefined) return [];
	let remaining = clampPercent(100 - used);
	// Prepaid balance and a pay-as-you-go cap keep the account working after the subscription credits are gone.
	const prepaid = Math.abs(cents(config.prepaidBalance));
	if (prepaid > 0) remaining = Math.max(remaining, clampPercent((prepaid / 100 / referenceUsd) * 100));
	const cap = cents(config.onDemandCap);
	if (cap > 0) remaining = Math.max(remaining, clampPercent(((cap - cents(config.onDemandUsed)) / cap) * 100));
	const period = record(config.currentPeriod);
	return [{ label: "credits", remainingPercent: remaining, resetAtMs: isoMs(period?.end ?? config.billingPeriodEnd) }];
}

/** Prepaid API credit of the team, from the Management API (purchases are negative in `total`). */
export function parseXaiPrepaid(data: unknown, referenceUsd: number): QuotaWindow[] {
	const total = record(record(data)?.total);
	if (!total) return [];
	const balanceUsd = Math.max(0, -cents(total)) / 100;
	return [{ label: "prepaid", remainingPercent: clampPercent((balanceUsd / referenceUsd) * 100) }];
}

function jwtClaim(token: string, claim: string, field: string): string | undefined {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
		const value = record(payload?.[claim])?.[field];
		return typeof value === "string" ? value : undefined;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------------------------
// Fetching

interface XaiManagement {
	key: string;
	teamId: string;
}

/** Management key for xAI API-key accounts: XAI_MANAGEMENT_API_KEY + XAI_TEAM_ID, or `{"key","teamId"}` in <agentDir>/xai-management.json. */
export function xaiManagement(agentDir: string): XaiManagement | undefined {
	const env = { key: process.env.XAI_MANAGEMENT_API_KEY?.trim(), teamId: process.env.XAI_TEAM_ID?.trim() };
	if (env.key && env.teamId) return { key: env.key, teamId: env.teamId };
	try {
		const file = JSON.parse(readFileSync(join(agentDir, "xai-management.json"), "utf8"));
		if (typeof file.key === "string" && typeof file.teamId === "string" && file.key && file.teamId) return { key: file.key, teamId: file.teamId };
	} catch {}
	return undefined;
}

async function getJson(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<unknown> {
	const response = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal });
	if (!response.ok)
		throw new Error(response.status === 401 || response.status === 403 ? `HTTP ${response.status} (credentials rejected)` : `HTTP ${response.status}`);
	return response.json();
}

export interface Fetcher {
	apiKey: (provider: string) => Promise<string | undefined>;
	agentDir: string;
}

async function fetchWindows(provider: string, kind: QuotaKind, cfg: QuotaConfig, { apiKey, agentDir }: Fetcher, signal: AbortSignal): Promise<QuotaWindow[]> {
	const token = await apiKey(provider);
	if (kind === "xai" && token?.startsWith("xai-")) {
		// An xAI API key has no usage endpoint of its own; the team's prepaid balance needs a management key.
		const mgmt = xaiManagement(agentDir);
		if (!mgmt) throw new Error("API-key account: set XAI_MANAGEMENT_API_KEY and XAI_TEAM_ID to read its balance");
		const base = cfg.baseUrls.xaiManagement ?? "https://management-api.x.ai";
		const data = await getJson(`${base}/v1/billing/teams/${encodeURIComponent(mgmt.teamId)}/prepaid/balance`, { Authorization: `Bearer ${mgmt.key}` }, signal);
		return parseXaiPrepaid(data, cfg.xaiReferenceUsd);
	}
	if (!token) throw new Error("no credentials");
	switch (kind) {
		case "anthropic": {
			const base = cfg.baseUrls.anthropic ?? "https://api.anthropic.com";
			return parseAnthropic(await getJson(`${base}/api/oauth/usage`, { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" }, signal));
		}
		case "codex": {
			const base = (cfg.baseUrls.codex ?? process.env.CHATGPT_BASE_URL ?? "https://chatgpt.com/backend-api").replace(/\/+$/, "");
			const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "User-Agent": "pi-tiers" };
			const accountId = jwtClaim(token, "https://api.openai.com/auth", "chatgpt_account_id");
			if (accountId) headers["chatgpt-account-id"] = accountId;
			return parseCodex(await getJson(`${base}/wham/usage`, headers, signal));
		}
		case "xai": {
			const base = cfg.baseUrls.xai ?? "https://cli-chat-proxy.grok.com";
			return parseXaiCredits(
				await getJson(`${base}/v1/billing?format=credits`, { Authorization: `Bearer ${token}`, "X-XAI-Token-Auth": "xai-grok-cli" }, signal),
				cfg.xaiReferenceUsd,
			);
		}
	}
}

// ---------------------------------------------------------------------------------------------
// Shared cache

interface CacheFile {
	atMs: number;
	reading?: QuotaReading;
	error?: string;
}

export type Outcome = { source: "cache" | "live"; reading: QuotaReading } | { source: "failed" | "timeout" | "waited"; error: string };

export class QuotaStore {
	private readonly dir: string;
	private readonly inflight = new Map<string, Promise<Outcome>>();
	/** Latest reading per provider seen by this process, used by synchronous checks. */
	readonly latest = new Map<string, QuotaReading>();

	constructor(
		stateDir: string,
		private readonly cfg: QuotaConfig,
		private readonly agentDir: string,
	) {
		this.dir = join(stateDir, "quota");
	}

	/** Readings for every provider that has a reader, within the total time budget. Never throws. */
	async read(providers: Iterable<string>, apiKey: Fetcher["apiKey"], nowMs: number = Date.now()): Promise<Map<string, Outcome>> {
		const out = new Map<string, Outcome>();
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
		try {
			const unique = [...new Set(providers)];
			const outcomes = await Promise.all(unique.map((provider) => this.one(provider, controller.signal, nowMs, apiKey)));
			// Results keep the order the providers were asked in, whichever finished first.
			unique.forEach((provider, i) => {
				const outcome = outcomes[i];
				if (outcome) out.set(provider, outcome);
				// A failed read must not leave an older reading in force.
				if (outcome && "reading" in outcome) this.latest.set(provider, outcome.reading);
				else this.latest.delete(provider);
			});
		} finally {
			clearTimeout(timer);
		}
		return out;
	}

	private one(provider: string, signal: AbortSignal, nowMs: number, apiKey: Fetcher["apiKey"]): Promise<Outcome | undefined> | undefined {
		const kind = kindOf(provider, this.cfg);
		if (!kind) return undefined;
		let pending = this.inflight.get(provider);
		if (!pending) {
			pending = this.resolve(provider, kind, signal, nowMs, apiKey).finally(() => this.inflight.delete(provider));
			this.inflight.set(provider, pending);
		}
		return pending;
	}

	private cached(provider: string, nowMs: number): Outcome | undefined {
		try {
			const file = JSON.parse(readFileSync(join(this.dir, `${provider}.json`), "utf8")) as CacheFile;
			if (file.reading && nowMs - file.atMs < this.cfg.cacheSeconds * 1000) return { source: "cache", reading: file.reading };
			if (file.error && nowMs - file.atMs < FAILURE_CACHE_MS) return { source: "failed", error: file.error };
		} catch {}
		return undefined;
	}

	private async resolve(provider: string, kind: QuotaKind, signal: AbortSignal, nowMs: number, apiKey: Fetcher["apiKey"]): Promise<Outcome> {
		const hit = this.cached(provider, nowMs);
		if (hit) return hit;
		mkdirSync(this.dir, { recursive: true });
		const lock = join(this.dir, `${provider}.lock`);
		while (!signal.aborted) {
			if (tryLock(lock, this.cfg.timeoutMs + 2000)) {
				try {
					const again = this.cached(provider, Date.now());
					if (again) return again;
					return await this.fetchAndStore(provider, kind, signal, apiKey);
				} finally {
					try {
						unlinkSync(lock);
					} catch {}
				}
			}
			// Another process is fetching this account: wait for its result instead of asking again.
			await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
			const result = this.cached(provider, Date.now());
			if (result) return result;
		}
		return { source: "timeout", error: `no reading within ${this.cfg.timeoutMs}ms` };
	}

	private async fetchAndStore(provider: string, kind: QuotaKind, signal: AbortSignal, apiKey: Fetcher["apiKey"]): Promise<Outcome> {
		let entry: CacheFile;
		try {
			const windows = await fetchWindows(provider, kind, this.cfg, { apiKey, agentDir: this.agentDir }, signal);
			if (windows.length === 0) throw new Error("response had no quota windows");
			entry = { atMs: Date.now(), reading: { kind, windows, atMs: Date.now() } };
		} catch (error) {
			if (signal.aborted) return { source: "timeout", error: `no reading within ${this.cfg.timeoutMs}ms` };
			entry = { atMs: Date.now(), error: (error as Error).message };
		}
		try {
			const tmp = join(this.dir, `${provider}.json.${process.pid}.tmp`);
			writeFileSync(tmp, JSON.stringify(entry));
			renameSync(tmp, join(this.dir, `${provider}.json`));
		} catch {}
		return entry.reading ? { source: "live", reading: entry.reading } : { source: "failed", error: entry.error ?? "unknown" };
	}
}

/** Takes an exclusive lock file; a lock older than `staleMs` belongs to a dead or hung process and is taken over. */
function tryLock(path: string, staleMs: number): boolean {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			closeSync(openSync(path, "wx"));
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
			try {
				if (Date.now() - statSync(path).mtimeMs <= staleMs) return false;
				unlinkSync(path);
			} catch {
				return false;
			}
		}
	}
	return false;
}
