// Chain resolution and candidate selection. Pure apart from the lookups passed in.
import type { ChainEntry, Config, Rule, Thinking } from "./config.ts";

/** A concrete (account provider, model, thinking) to try, in preference order. */
export interface Candidate {
	provider: string;
	model: string;
	thinking: Thinking;
	/** 1-based position in the expanded chain. */
	position: number;
}

export const candidateKey = (c: { provider: string; model: string }) => `${c.provider}/${c.model}`;

/**
 * Candidates for a tier in this context: the rule's replacement chain when it has one, otherwise
 * the base chain filtered to the rule's allowed providers. Account groups expand in order.
 */
export function candidatesFor(config: Config, tier: string, rule: Rule | undefined): Candidate[] {
	const replacement = rule?.tiers.get(tier);
	const chain: ChainEntry[] = replacement ?? config.tiers.get(tier)?.chain ?? [];
	const allow = replacement ? undefined : rule?.allowProviders;
	const out: Candidate[] = [];
	for (const entry of chain) {
		for (const provider of config.accounts.get(entry.provider) ?? [entry.provider]) {
			if (allow && !allow.has(provider)) continue;
			out.push({ provider, model: entry.model, thinking: entry.thinking, position: out.length + 1 });
		}
	}
	return out;
}

export type SkipReason = "unknown-model" | "no-credentials" | "cooling" | "context-too-small";

export interface PickInput {
	candidates: Candidate[];
	/** Key of the candidate to keep when it is still usable (stickiness within a turn). */
	prefer?: string;
	check: (c: Candidate) => SkipReason | undefined;
	/** Context window of a candidate's model, used to pick the largest one when every usable rung is too small. */
	contextWindow?: (c: Candidate) => number;
}

export interface PickResult {
	chosen?: Candidate;
	skipped: Array<{ key: string; reason: SkipReason }>;
	/** Set when no rung fit the conversation and the largest usable one was chosen so Pi compacts first. */
	compacting?: boolean;
}

export function pick({ candidates, prefer, check, contextWindow }: PickInput): PickResult {
	const skipped: PickResult["skipped"] = [];
	if (prefer) {
		const sticky = candidates.find((c) => candidateKey(c) === prefer);
		if (sticky && !check(sticky)) return { chosen: sticky, skipped };
	}
	const tooSmall: Candidate[] = [];
	for (const c of candidates) {
		const reason = check(c);
		if (!reason) return { chosen: c, skipped };
		skipped.push({ key: candidateKey(c), reason });
		if (reason === "context-too-small") tooSmall.push(c);
	}
	// Every usable rung is only too small: take the largest window and let Pi compact before sending,
	// rather than failing a request that a compacted conversation could still serve.
	if (tooSmall.length && contextWindow) {
		const largest = tooSmall.reduce((best, c) => (contextWindow(c) > contextWindow(best) ? c : best));
		return { chosen: largest, skipped, compacting: true };
	}
	return { skipped };
}
