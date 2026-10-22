// Turns a failed request into a cooldown decision. Pure: no I/O.
import type { Cooldowns } from "./config.ts";

export type FailureKind = "usage-limit" | "rate-limit" | "auth" | "forbidden" | "server";

export interface Failure {
	kind: FailureKind;
	/** `account` cools every model on the provider; `model` cools one model on it. */
	scope: "account" | "model";
	untilMs: number;
}

export interface ResponseInfo {
	status: number;
	headers: Record<string, string>;
}

const USAGE =
	/usage.?limit|quota|insufficient_quota|billing|out of budget|available balance|GoUsageLimitError|FreeUsageLimitError|subscription_sharing_usage_limit|weekly limit|(?:5|five)[- ]hour|exceed(?:ed)? your (?:account'?s )?(?:rate|usage) limit/i;
const AUTH = /\b401\b|unauthori[sz]ed|invalid.?(?:api.?)?key|authentication|not logged in|token (?:has )?expired/i;
/** 403 without an auth reason: this model is off limits for the account (disabled, free tier refused, region). */
const FORBIDDEN = /\b403\b|forbidden|access is disabled|not allowed|FreeTierError|permission/i;
const RATE = /\b429\b|rate.?limit|too many requests|resource.?exhausted/i;
const SERVER =
	/overloaded|\b5\d\d\b|server.?error|internal.?error|unavailable|at capacity|timed? ?out|timeout|ECONNRESET|ECONNREFUSED|fetch failed|socket hang up|network/i;

const NETWORK = /timed? ?out|timeout|ECONNRESET|ECONNREFUSED|fetch failed|socket hang up|connection error|network/i;

/**
 * A request that never got an HTTP error back: a timeout or a dropped connection. It says nothing about
 * the account, so a retry stays on the same model, where its prompt cache is warm.
 */
export function isTransient(errorMessage: string, response: ResponseInfo | undefined): boolean {
	const status = response?.status ?? 0;
	return (status === 0 || status < 400) && NETWORK.test(errorMessage) && !USAGE.test(errorMessage) && !RATE.test(errorMessage);
}

const MIN_MS = 10_000;
const MAX_MS = 8 * 24 * 3600_000;

export function classifyFailure(errorMessage: string, response: ResponseInfo | undefined, cooldowns: Cooldowns, nowMs: number): Failure | undefined {
	const status = response?.status ?? 0;
	const reset = response ? resetFromHeaders(response.headers, nowMs) : undefined;
	const until = (fallbackSeconds: number) => clamp(reset ?? nowMs + fallbackSeconds * 1000, nowMs);
	if (USAGE.test(errorMessage)) return { kind: "usage-limit", scope: "account", untilMs: until(cooldowns.usageLimitSeconds) };
	if (status === 401 || AUTH.test(errorMessage)) return { kind: "auth", scope: "account", untilMs: until(cooldowns.authSeconds) };
	if (status === 403 || FORBIDDEN.test(errorMessage)) return { kind: "forbidden", scope: "model", untilMs: until(cooldowns.authSeconds) };
	if (status === 429 || RATE.test(errorMessage)) return { kind: "rate-limit", scope: "model", untilMs: until(cooldowns.rateLimitSeconds) };
	if (status >= 500 || SERVER.test(errorMessage)) return { kind: "server", scope: "model", untilMs: clamp(nowMs + cooldowns.serverErrorSeconds * 1000, nowMs) };
	return undefined;
}

/** Earliest future reset time named by `retry-after` or any `*reset*` header, if any. */
export function resetFromHeaders(headers: Record<string, string>, nowMs: number): number | undefined {
	const times: number[] = [];
	for (const [name, value] of Object.entries(headers)) {
		const key = name.toLowerCase();
		if (key === "retry-after") {
			const seconds = Number(value);
			if (Number.isFinite(seconds)) times.push(nowMs + seconds * 1000);
			else if (!Number.isNaN(Date.parse(value))) times.push(Date.parse(value));
		} else if (key.includes("reset")) {
			const t = parseTime(value, nowMs);
			if (t !== undefined) times.push(t);
		}
	}
	const future = times.filter((t) => t > nowMs);
	return future.length ? Math.min(...future) : undefined;
}

function parseTime(value: string, nowMs: number): number | undefined {
	const n = Number(value);
	if (Number.isFinite(n)) {
		if (n > 1e12) return n; // epoch ms
		if (n > 1e9) return n * 1000; // epoch seconds
		return nowMs + n * 1000; // relative seconds
	}
	const relative = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value.trim());
	if (relative) return nowMs + Number(relative[1]) * { ms: 1, s: 1000, m: 60_000, h: 3600_000 }[relative[2] as "ms" | "s" | "m" | "h"];
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function clamp(untilMs: number, nowMs: number): number {
	return Math.min(Math.max(untilMs, nowMs + MIN_MS), nowMs + MAX_MS);
}
