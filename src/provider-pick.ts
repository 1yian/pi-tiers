// Asks the auto classifier which provider should serve a session, once the tier is known. Code builds and
// validates the candidate table; the classifier only chooses a row. Never throws: any failure is a fallback.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractSections } from "./auto.ts";
import type { Candidate } from "./chain.ts";
import { candidateKey } from "./chain.ts";
import type { AutoConfig } from "./config.ts";
import type { QuotaReading } from "./quota.ts";

export interface TableRow {
	key: string;
	position: number;
	/** Billed per token rather than covered by a subscription. */
	payg: boolean;
	/** Per window: label, percent left, minutes until it resets (when known). */
	windows: Array<{ label: string; left: number; resetInMin?: number }>;
	agents: number;
	recentTokens: number;
}

export interface ProviderPick {
	key?: string;
	/** Why code picks instead, when the classifier did not give a usable answer. */
	fallback?: "timeout" | "error" | "off-list" | "no-task" | "no-classifier";
	detail?: string;
}

export function tableRow(c: Candidate, reading: QuotaReading | undefined, load: { agents: number; tokens: number }, nowMs: number, payg: boolean): TableRow {
	return {
		key: candidateKey(c),
		position: c.position,
		payg,
		windows: (reading?.windows ?? []).map((w) => ({
			label: w.label,
			left: Math.round(w.remainingPercent),
			...(w.resetAtMs ? { resetInMin: Math.max(0, Math.round((w.resetAtMs - nowMs) / 60_000)) } : {}),
		})),
		agents: load.agents,
		recentTokens: Math.round(load.tokens),
	};
}

/** One compact line per candidate, as the classifier reads it. */
export function formatRow(r: TableRow): string {
	const quota = r.windows.length
		? r.windows.map((w) => `${w.label} ${w.left}% left${w.resetInMin === undefined ? "" : `, resets in ${w.resetInMin}m`}`).join("; ")
		: "quota unknown";
	return `${r.payg ? "PAYG" : "subscription"}; chain position ${r.position}; ${quota}; ${r.agents} live agents; ${Math.round(r.recentTokens / 1000)}k recent tokens`;
}

export async function askProvider(
	auto: AutoConfig,
	tier: { name: string; description: string },
	text: string,
	rows: readonly TableRow[],
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<ProviderPick> {
	const body = extractSections(text, auto.sections, auto.maxChars).trim();
	if (!body) return { fallback: "no-task" };
	const classifier = ctx.modelRegistry.findOfType("classifier", auto.classifierProvider, auto.classifierModel);
	if (!classifier) return { fallback: "no-classifier", detail: `${auto.classifierProvider}/${auto.classifierModel} not found` };
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), auto.providerTimeoutMs);
	const aborted = new Promise<"timeout">((resolve) => timeout.signal.addEventListener("abort", () => resolve("timeout"), { once: true }));
	try {
		const asked = ctx.modelRegistry
			.classify(
				classifier,
				{
					state: { task: body, tier: tier.name, tierDescription: tier.description },
					questions: {
						provider: {
							type: "choice",
							instructions:
								"Which ONE candidate should run this session? Prefer subscriptions over PAYG (pay per token) unless no subscription fits. Lower chain position is the preferred model. Prefer more quota left in the tightest window, fewer live agents and recent tokens, and a window that resets soon over one that is nearly spent. The session keeps this provider for its whole life.",
							criteria: Object.fromEntries(rows.map((r) => [r.key, formatRow(r)])),
						},
					},
				},
				{ signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal },
			)
			.catch((error: unknown) => ({ error: String(error) }));
		const result = await Promise.race([asked, aborted]);
		if (result === "timeout") return { fallback: "timeout" };
		if ("error" in result) return { fallback: "error", detail: result.error };
		const answer = result.answers?.provider;
		if (result.stopReason !== "stop" || answer?.type !== "choice") {
			return { fallback: timeout.signal.aborted ? "timeout" : "error", detail: result.errorMessage ?? "unexpected classifier answer" };
		}
		if (!rows.some((r) => r.key === answer.choice)) return { fallback: "off-list", detail: String(answer.choice).slice(0, 200) };
		return { key: answer.choice };
	} finally {
		clearTimeout(timer);
	}
}
