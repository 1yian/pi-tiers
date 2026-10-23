// Cooldowns shared by every Pi process on the machine. Each process writes only its own file
// (cooldowns/<pid>.json), so there is no shared write target; readers merge all files.
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const accountKey = (provider: string) => `account:${provider}`;
export const modelKey = (provider: string, model: string) => `model:${provider}/${model}`;

export interface CooldownEntry {
	untilMs: number;
	reason: string;
	/** When the mark was set; a live quota reading taken after this can clear it. Absent on marks from older versions. */
	atMs?: number;
}

const CLEAR = "clear:";
const CLEAR_TTL_MS = 8 * 24 * 3600_000;

const REFRESH_MS = 2000;

export class CooldownStore {
	private readonly dir: string;
	private readonly file: string;
	private readonly own = new Map<string, CooldownEntry>();
	private merged = new Map<string, CooldownEntry>();
	private readAtMs = 0;

	constructor(stateDir: string) {
		this.dir = join(stateDir, "cooldowns");
		this.file = join(this.dir, `${process.pid}.json`);
	}

	set(key: string, entry: CooldownEntry): void {
		this.own.set(key, entry);
		this.merged.set(key, entry);
		this.flush(Date.now());
	}

	/**
	 * Drops the marks on a key that were set before `nowMs`, for every process: a live reading showed the account has room
	 * again (a banked reset restores quota before the mark's own reset time). A mark set afterwards still holds.
	 */
	clear(key: string, nowMs: number): void {
		this.set(`${CLEAR}${key}`, { untilMs: nowMs + CLEAR_TTL_MS, reason: "cleared", atMs: nowMs });
		this.readAtMs = 0;
	}

	/** The active cooldown for a key across all processes, if any. */
	get(key: string, nowMs: number): CooldownEntry | undefined {
		this.refresh(nowMs);
		const entry = this.merged.get(key);
		return entry && entry.untilMs > nowMs ? entry : undefined;
	}

	/** When every one of these keys is free again, or nowMs when none is cooling. */
	freeAt(keys: readonly string[], nowMs: number): number {
		return Math.max(nowMs, ...keys.map((key) => this.get(key, nowMs)?.untilMs ?? nowMs));
	}

	active(nowMs: number): Array<[string, CooldownEntry]> {
		this.refresh(nowMs);
		return [...this.merged].filter(([key, e]) => !key.startsWith(CLEAR) && e.untilMs > nowMs).sort(([a], [b]) => a.localeCompare(b));
	}

	private refresh(nowMs: number): void {
		if (nowMs - this.readAtMs < REFRESH_MS) return;
		this.readAtMs = nowMs;
		const all: Array<[string, CooldownEntry]> = [...this.own];
		let names: string[] = [];
		try {
			names = readdirSync(this.dir).filter((n) => n.endsWith(".json"));
		} catch {
			// No directory yet: nothing has cooled down.
		}
		for (const name of names) {
			const path = join(this.dir, name);
			let entries: Record<string, CooldownEntry>;
			try {
				entries = JSON.parse(readFileSync(path, "utf8"));
			} catch {
				continue; // Partially written or removed between list and read.
			}
			let live = false;
			for (const [key, e] of Object.entries(entries)) {
				if (typeof e?.untilMs !== "number" || e.untilMs <= nowMs) continue;
				live = true;
				all.push([key, e]);
			}
			// A file whose entries all expired belongs to nobody useful; its owner rewrites it on the next set.
			if (!live && path !== this.file) {
				try {
					unlinkSync(path);
				} catch {}
			}
		}
		const clearedAt = new Map<string, number>();
		for (const [key, e] of all)
			if (key.startsWith(CLEAR)) clearedAt.set(key.slice(CLEAR.length), Math.max(clearedAt.get(key.slice(CLEAR.length)) ?? 0, e.atMs ?? 0));
		const merged = new Map<string, CooldownEntry>();
		for (const [key, e] of all) {
			if (key.startsWith(CLEAR) || (e.atMs ?? 0) <= (clearedAt.get(key) ?? -1)) {
				if (key.startsWith(CLEAR)) merged.set(key, e);
				continue;
			}
			const current = merged.get(key);
			if (!current || current.untilMs < e.untilMs) merged.set(key, e);
		}
		this.merged = merged;
	}

	private flush(nowMs: number): void {
		for (const [key, e] of this.own) if (e.untilMs <= nowMs) this.own.delete(key);
		mkdirSync(this.dir, { recursive: true });
		const tmp = `${this.file}.tmp`;
		writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.own)));
		renameSync(tmp, this.file);
	}
}
