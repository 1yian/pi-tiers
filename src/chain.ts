// Chain resolution and candidate selection. Pure apart from the lookups passed in.
import type { ChainEntry, Config, Rule, Thinking } from "./config.ts";

/** A concrete (account provider, model, thinking) to try, in preference order. */
export interface Candidate {
	provider: string;
	model: string;
	thinking: Thinking;
	/** 1-based position in the expanded chain. */
	position: number;
	/** Index of the chain entry this came from; members of one account group share it. -1 for an override. */
	group?: number;
}

export const candidateKey = (c: { provider: string; model: string }) => `${c.provider}/${c.model}`;

export interface Expansion {
	/** Rotates every account group by this many members, so sessions start on different accounts. */
	rotate?: number;
	/** Providers left out entirely, such as an account kept away from background work. */
	skip?: ReadonlySet<string>;
}

/**
 * Candidates for a tier in this context: the rule's replacement chain when it has one, otherwise
 * the base chain filtered to the rule's allowed providers. Account groups expand in order, rotated
 * by `rotate`.
 */
export function candidatesFor(config: Config, tier: string, rule: Rule | undefined, { rotate = 0, skip }: Expansion = {}): Candidate[] {
	const replacement = rule?.tiers.get(tier);
	const chain: ChainEntry[] = replacement ?? config.tiers.get(tier)?.chain ?? [];
	const allow = replacement ? undefined : rule?.allowProviders;
	const out: Candidate[] = [];
	for (const [index, entry] of chain.entries()) {
		const group = config.accounts.get(entry.provider);
		const members = group ? rotated(group, rotate) : [entry.provider];
		for (const provider of members) {
			if (allow && !allow.has(provider)) continue;
			if (skip?.has(provider)) continue;
			out.push({ provider, model: entry.model, thinking: entry.thinking, position: out.length + 1, group: index });
		}
	}
	return out;
}

function rotated<T>(list: readonly T[], by: number): T[] {
	const start = ((by % list.length) + list.length) % list.length;
	return [...list.slice(start), ...list.slice(0, start)];
}

export type SkipReason = "unknown-model" | "no-credentials" | "cooling" | "quota-low" | "context-too-small";

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

export interface AssignInput {
	candidates: Candidate[];
	check: (c: Candidate) => SkipReason | undefined;
	/** Current load on the candidate's account; lower is better. */
	score: (c: Candidate) => number;
	/** When the candidate's known cooldown ends (ms); only used when every usable candidate is cooling. */
	freeAt: (c: Candidate) => number;
	contextWindow: (c: Candidate) => number;
	/** Live room left (0..100) in the candidate's tightest window, when known. */
	room?: (c: Candidate) => number | undefined;
	/** Live load without the header-based quota guess (agents and recent tokens), used with `room`. */
	load?: (c: Candidate) => number;
	/** Breaks exact ties differently per session, so sessions starting together spread out. */
	seed?: number;
}

/** Rooms within this many points of each other count as equal, so load decides between near-equal accounts. */
export const ROOM_BAND = 10;

/**
 * Chooses the one candidate a session commits to. The chain is a preference order of models: the
 * first chain entry with a usable account wins, and within it the least loaded account. A cooldown
 * is evidence the account is exhausted, so it ranks a candidate last but never removes it, because
 * a stale or wrong cooldown must not leave the session without a model.
 */
export function assign({ candidates, check, score, freeAt, contextWindow, room, load, seed }: AssignInput): PickResult {
	const skipped: PickResult["skipped"] = [];
	const ready: Candidate[] = [];
	const cooling: Candidate[] = [];
	const tooSmall: Candidate[] = [];
	for (const c of candidates) {
		const reason = check(c);
		if (!reason) ready.push(c);
		else if (reason === "cooling" || reason === "quota-low") cooling.push(c);
		else {
			skipped.push({ key: candidateKey(c), reason });
			if (reason === "context-too-small") tooSmall.push(c);
		}
	}
	const byOrder = (a: Candidate, b: Candidate) => (a.group ?? 0) - (b.group ?? 0) || a.position - b.position;
	if (ready.length) {
		const first = Math.min(...ready.map((c) => c.group ?? 0));
		const group = ready.filter((c) => (c.group ?? 0) === first);
		// With a live reading for every account of the group, the most room left wins, then the least load;
		// otherwise the header-based score decides as before.
		const rooms = room && load ? group.map((c) => room(c)) : [];
		if (room && load && rooms.length && rooms.every((r) => r !== undefined)) {
			const key = (c: Candidate) => [-Math.floor(room(c)! / ROOM_BAND), load(c)] as const;
			const ranked = [...group].sort((a, b) => key(a)[0] - key(b)[0] || key(a)[1] - key(b)[1] || a.position - b.position);
			const tied = ranked.filter((c) => key(c)[0] === key(ranked[0])[0] && key(c)[1] === key(ranked[0])[1]);
			return { chosen: tied[(seed ?? 0) % tied.length], skipped };
		}
		return { chosen: group.sort((a, b) => score(a) - score(b) || a.position - b.position)[0], skipped };
	}
	if (cooling.length) {
		const best = [...cooling].sort((a, b) => freeAt(a) - freeAt(b) || byOrder(a, b))[0];
		return { chosen: best, skipped };
	}
	if (tooSmall.length) {
		const largest = tooSmall.reduce((best, c) => (contextWindow(c) > contextWindow(best) ? c : best));
		return { chosen: largest, skipped, compacting: true };
	}
	return { skipped };
}
