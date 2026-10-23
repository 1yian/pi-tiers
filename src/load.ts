// Load on each provider account, shared by every Pi process on the machine, used to choose where a
// new session starts. Each process writes only its own file (load/<pid>.json); readers merge them.
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WINDOW_MS = 15 * 60_000;
const UTILIZATION_MAX_AGE_MS = 10 * 60_000;
const STALE_MS = 6 * 3600_000;
const REFRESH_MS = 2000;

interface Usage {
	atMs: number;
	provider: string;
	tokens: number;
}

interface LoadFile {
	pid: number;
	updatedMs: number;
	/** session id -> provider the session is committed to. */
	sessions: Record<string, string>;
	usage: Usage[];
	/** provider -> latest quota utilization (0..1) its responses reported. */
	utilization: Record<string, { value: number; atMs: number }>;
}

export interface ProviderLoad {
	agents: number;
	tokens: number;
	utilization: number;
}

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

export class LoadStore {
	private readonly dir: string;
	private readonly file: string;
	private readonly own: LoadFile = { pid: process.pid, updatedMs: 0, sessions: {}, usage: [], utilization: {} };
	private merged: LoadFile[] = [];
	private readAtMs = 0;

	constructor(stateDir: string) {
		this.dir = join(stateDir, "load");
		this.file = join(this.dir, `${process.pid}.json`);
		process.on("exit", () => this.remove());
	}

	assign(sessionId: string, provider: string): void {
		this.own.sessions[sessionId] = provider;
		this.flush();
	}

	release(sessionId: string): void {
		delete this.own.sessions[sessionId];
		this.flush();
	}

	addUsage(provider: string, tokens: number, nowMs: number): void {
		this.own.usage = [...this.own.usage.filter((u) => nowMs - u.atMs < WINDOW_MS), { atMs: nowMs, provider, tokens }];
		this.flush();
	}

	setUtilization(provider: string, value: number, nowMs: number): void {
		this.own.utilization[provider] = { value, atMs: nowMs };
		this.flush();
	}

	/** Load on a provider across live processes. `sessionId` is excluded so a session never counts against itself. */
	of(provider: string, nowMs: number, sessionId?: string): ProviderLoad {
		this.refresh(nowMs);
		const out: ProviderLoad = { agents: 0, tokens: 0, utilization: 0 };
		for (const f of this.merged) {
			for (const [id, p] of Object.entries(f.sessions)) if (p === provider && id !== sessionId) out.agents++;
			for (const u of f.usage) if (u.provider === provider && nowMs - u.atMs < WINDOW_MS) out.tokens += u.tokens;
			const util = f.utilization[provider];
			if (util && nowMs - util.atMs < UTILIZATION_MAX_AGE_MS) out.utilization = Math.max(out.utilization, util.value);
		}
		return out;
	}

	private refresh(nowMs: number): void {
		if (nowMs - this.readAtMs < REFRESH_MS) return;
		this.readAtMs = nowMs;
		const files: LoadFile[] = [this.own];
		let names: string[] = [];
		try {
			names = readdirSync(this.dir).filter((n) => n.endsWith(".json"));
		} catch {
			// No directory yet: nothing else is running.
		}
		for (const name of names) {
			const path = join(this.dir, name);
			if (path === this.file) continue;
			try {
				const f = JSON.parse(readFileSync(path, "utf8")) as LoadFile;
				if (!alive(f.pid) || nowMs - f.updatedMs > STALE_MS) {
					unlinkSync(path);
					continue;
				}
				files.push(f);
			} catch {
				// Partially written or removed between list and read.
			}
		}
		this.merged = files;
	}

	private flush(): void {
		this.own.updatedMs = Date.now();
		this.readAtMs = 0;
		try {
			mkdirSync(this.dir, { recursive: true });
			const tmp = `${this.file}.tmp`;
			writeFileSync(tmp, JSON.stringify(this.own));
			renameSync(tmp, this.file);
		} catch {
			// Load is advisory; never break a request over it.
		}
	}

	private remove(): void {
		try {
			unlinkSync(this.file);
		} catch {}
	}
}

/** Quota utilization (0..1) named by response headers, if any: `*utilization*` or a `*remaining*`/`*limit*` pair. */
export function utilizationFromHeaders(headers: Record<string, string>): number | undefined {
	const values: number[] = [];
	const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
	for (const [name, raw] of Object.entries(lower)) {
		const n = Number(raw);
		if (!Number.isFinite(n)) continue;
		if (name.includes("utilization")) values.push(n > 1 ? n / 100 : n);
		else if (name.includes("remaining")) {
			const limit = Number(lower[name.replace("remaining", "limit")]);
			if (Number.isFinite(limit) && limit > 0) values.push(1 - n / limit);
		}
	}
	return values.length ? Math.min(1, Math.max(0, ...values)) : undefined;
}
