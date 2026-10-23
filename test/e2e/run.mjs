#!/usr/bin/env node
// End-to-end suite: drives real `pi --mode json` processes with pi-tiers and a scripted fake
// provider, then checks which model answered, which calls were made, and what was cooled down.
// Usage: node test/e2e/run.mjs [--keep]   (writes a markdown report to .e2e-<timestamp>/report.md)
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EXT = join(ROOT, "src/index.ts");
const FAKE = join(ROOT, "test/e2e/fake-provider.ts");
const DIRECT = join(ROOT, "test/e2e/direct-probe.ts");
const OUT = join(ROOT, `.e2e-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(OUT, { recursive: true });

const TIERS = {
	accounts: { fake: ["fake-a", "fake-b"] },
	tiers: {
		default: { description: "Build or fix from a known plan.", chain: ["fake/m1:high", "fake-c/m2:low"] },
		deep: { description: "Research and investigation.", chain: ["fake-c/m2:xhigh"] },
		big: { description: "Context test.", chain: ["fake-small/tiny:low", "fake-c/m2:low"] },
		small: { description: "Only a small window.", chain: ["fake-small/tiny:low"] },
		compact: { description: "Compactor pool.", chain: ["fake/m1:low", "fake-c/m2:low"] },
		pool: { description: "Waits.", chain: ["fake-c/m1:low", "fake-small/tiny:low"] },
	},
	auto: { classifier: "fake-cls/jev", tiers: ["default", "deep"], fallback: "default", minConfidence: 0.6, sections: ["## Captain's intent"] },
	rules: [{ name: "acme", match: { gitRemote: "github\\.com[:/]acme-corp/" }, tiers: { default: ["fake-c/m2:max"] } }],
	override: "^Model override:\\s*(\\S+)(?:\\s+(\\S+))?",
	warnProviders: ["fake-c"],
	cooldowns: { rateLimitSeconds: 600, serverErrorSeconds: 30, usageLimitSeconds: 3600, authSeconds: 3600 },
};

function makeHome(name, retry = { baseDelayMs: 10, maxAgentDelayMs: 50 }) {
	const dir = join(OUT, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ quietStartup: true, retry: { enabled: true, maxRetries: 3, ...retry } }));
	writeFileSync(join(dir, "tiers.json"), JSON.stringify(TIERS, null, 1));
	return dir;
}

function piCommand(home, { model, prompt, plan = {}, classify, cwd = home, env = {}, extra = [] }) {
	const calls = join(home, "calls.tsv");
	const args = [
		"--mode",
		"json",
		"--offline",
		"--no-skills",
		"--no-context-files",
		"--model",
		model,
		"-e",
		EXT,
		"-e",
		FAKE,
		...extra,
		...(Array.isArray(prompt) ? prompt : [prompt]),
	];
	const options = {
		cwd,
		encoding: "utf8",
		timeout: 60_000,
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: home,
			FAKE_CALLS: calls,
			FAKE_PLAN: JSON.stringify(plan),
			FAKE_CLASSIFY: JSON.stringify(classify ?? {}),
			...env,
		},
	};
	return { args, options, calls };
}

function runPi(home, opts) {
	const { args, options, calls } = piCommand(home, opts);
	const before = existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).length : 0;
	return summarize(home, spawnSync("pi", args, options), calls, before);
}

/** Starts a Pi without waiting, for scenarios that need several sessions starting together. */
function runPiAsync(home, opts) {
	const { args, options, calls } = piCommand(home, opts);
	return new Promise((resolveRun) => {
		const child = spawn("pi", args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], timeout: options.timeout });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => {
			stdout += d;
		});
		child.stderr.on("data", (d) => {
			stderr += d;
		});
		child.on("close", (status) => resolveRun(summarize(home, { status, stdout, stderr }, calls, 0)));
	});
}

function summarize(home, res, calls, before) {
	const events = res.stdout
		.split("\n")
		.filter(Boolean)
		.flatMap((l) => {
			try {
				return [JSON.parse(l)];
			} catch {
				return [];
			}
		});
	const ends = events.filter((e) => e.type === "message_end").map((e) => e.message);
	const assistants = ends.filter((m) => m.role === "assistant");
	const final = assistants.at(-1);
	const custom = sessionEntries(home)
		.filter((e) => (e.type === "custom_message" || e.type === "custom") && e.customType === "pi-tiers")
		.map((e) => e.content ?? e.data?.text);
	const allCalls = existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : [];
	const log = existsSync(join(home, "tiers/log.jsonl"))
		? readFileSync(join(home, "tiers/log.jsonl"), "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];
	const cooldowns = {};
	const cdDir = join(home, "tiers/cooldowns");
	if (existsSync(cdDir))
		for (const f of readdirSync(cdDir).filter((n) => n.endsWith(".json"))) Object.assign(cooldowns, JSON.parse(readFileSync(join(cdDir, f), "utf8")));
	return {
		status: res.status,
		stderr: res.stderr.trim().slice(-600),
		final: final && {
			provider: final.provider,
			model: final.model,
			stopReason: final.stopReason,
			thinking: final.thinkingLevel,
			text: final.content?.map((c) => c.text ?? "").join(""),
			error: final.errorMessage,
		},
		calls: allCalls.slice(before).map((l) => l.split("\t").join(":")),
		callTimes: existsSync(`${calls}.ts`) ? readFileSync(`${calls}.ts`, "utf8").split("\n").filter(Boolean).map(Number) : [],
		custom,
		routes: log.filter((r) => r.event === "route").slice(-3),
		autos: log.filter((r) => r.event === "auto"),
		picks: log.filter((r) => r.event === "provider-pick"),
		jevAsked: existsSync(`${calls}.jev`)
			? readFileSync(`${calls}.jev`, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((l) => JSON.parse(l))
			: [],
		cleared: log.filter((r) => r.event === "cooldown-cleared"),
		cooldowns: Object.keys(cooldowns).sort(),
		failures: existsSync(join(home, "tiers/failures.jsonl"))
			? readFileSync(join(home, "tiers/failures.jsonl"), "utf8")
					.split("\n")
					.filter(Boolean)
					.map((l) => JSON.parse(l))
			: [],
	};
}

/** Entries of the newest session file under the agent dir (the run that just finished). */
function sessionEntries(home) {
	const files = [];
	const walk = (dir) => {
		if (!existsSync(dir)) return;
		for (const name of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, name.name);
			if (name.isDirectory()) walk(path);
			else if (name.name.endsWith(".jsonl")) files.push(path);
		}
	};
	walk(join(home, "sessions"));
	const newest = files.sort().at(-1);
	return newest
		? readFileSync(newest, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];
}

const results = [];
const only = process.env.E2E_ONLY;
function scenario(name, fn) {
	if (only && !name.includes(only)) return;
	let outcome;
	try {
		outcome = fn();
	} catch (error) {
		outcome = { ok: false, detail: String(error?.stack ?? error) };
	}
	results.push({ name, ...outcome });
	console.log(`${outcome.ok ? "PASS" : "FAIL"}  ${name}`);
	if (!outcome.ok) console.log(`      ${JSON.stringify(outcome.evidence ?? outcome.detail).slice(0, 1500)}`);
}
const answered = (r) => r.final && r.final.stopReason === "stop" && `${r.final.provider}/${r.final.model}`;
const check = (ok, evidence) => ({ ok: Boolean(ok), evidence });

scenario("first choice answers when healthy", () => {
	const r = runPi(makeHome("healthy"), { model: "tier/default", prompt: "hello" });
	return check(answered(r) === "fake-a/m1" && r.calls.join() === "fake-a/m1:ok", r);
});

let sharedHome;
scenario("a retryable 429 stays on the assigned account and surfaces the provider error with its Retry-After", () => {
	sharedHome = makeHome("ratelimit");
	const r = runPi(sharedHome, { model: "tier/default", prompt: "hello", plan: { "fake-a/m1": ["429", "429", "429", "429"] } });
	const f = r.failures[0];
	const ok =
		r.final?.stopReason === "error" &&
		r.calls.every((c) => c === "fake-a/m1:429") &&
		f?.status === 429 &&
		f.kind === "rate-limit" &&
		f.retryAfter === "120" &&
		f.resetAt &&
		f.message.includes("rate_limit_error") &&
		f.recovery === "none" &&
		r.custom.some((c) => c.includes("Not switching models"));
	return check(ok, r);
});

scenario("a new session avoids an account another process recorded as cooling", () => {
	const r = runPi(sharedHome, { model: "tier/default", prompt: "hello again" });
	return check(answered(r) === "fake-b/m1" && r.calls.join() === "fake-b/m1:ok", r);
});

scenario("a non-retryable usage limit ends the run on the assigned account and is surfaced, with no continuation", () => {
	const r = runPi(makeHome("usage"), { model: "tier/default", prompt: "hello", plan: { "fake-a/m1": ["usage"] } });
	const ok =
		r.final?.stopReason === "error" && r.calls.join() === "fake-a/m1:usage" && r.failures[0]?.kind === "usage-limit" && r.failures[0].recovery === "none";
	return check(ok, r);
});

scenario("the compact tier follows the same flow as every tier: an error that is not a confirmed quota exhaustion is surfaced, with no switch", () => {
	const r = runPi(makeHome("pool-usage"), { model: "tier/compact", prompt: "hello", plan: { "fake-a/m1": ["usage"] } });
	const ok = r.final?.stopReason === "error" && r.calls.join() === "fake-a/m1:usage" && r.failures[0]?.recovery === "none";
	return check(ok, r);
});

scenario("a session start skips a model cooled by a 403 and takes the next chain entry", () => {
	const home = makeHome("forbidden");
	const tiers = JSON.parse(readFileSync(join(home, "tiers.json"), "utf8"));
	tiers.tiers.default.chain = ["fake-c/m1:low", "fake-c/m2:low"];
	writeFileSync(join(home, "tiers.json"), JSON.stringify(tiers));
	const first = runPi(home, { model: "tier/default", prompt: "hello", plan: { "fake-c/m1": ["403"] } });
	const r = runPi(home, { model: "tier/default", prompt: "hello" });
	const ok =
		first.final?.stopReason === "error" && first.failures[0]?.kind === "forbidden" && answered(r) === "fake-c/m2" && !r.cooldowns.includes("account:fake-c");
	return check(ok, { first, r });
});

scenario("whole account group cooling at session start moves to the next chain entry", () => {
	const home = makeHome("groupdown");
	coolFromOtherProcess(home, "account:fake-a", 60_000);
	coolFromOtherProcess(home, "account:fake-b", 60_000, "999998");
	const r = runPi(home, { model: "tier/default", prompt: "hello" });
	return check(answered(r) === "fake-c/m2" && r.routes.at(-1)?.position === 3, r);
});

scenario("every candidate cooling still assigns the one that frees first, instead of refusing", () => {
	const home = makeHome("alldown");
	coolFromOtherProcess(home, "account:fake-a", 120_000);
	coolFromOtherProcess(home, "account:fake-b", 30_000, "999998");
	coolFromOtherProcess(home, "account:fake-c", 60_000, "999997");
	const r = runPi(home, { model: "tier/default", prompt: "hello" });
	return check(answered(r) === "fake-b/m1" && r.calls.length === 1, r);
});

scenario("a session starts on the least loaded account: live agents and reported quota use count", () => {
	const home = makeHome("load");
	mkdirSync(join(home, "tiers/load"), { recursive: true });
	const other = (sessions, utilization = {}) => ({ pid: process.pid, updatedMs: Date.now(), sessions, usage: [], utilization });
	writeFileSync(join(home, "tiers/load/other.json"), JSON.stringify(other({ s1: "fake-a", s2: "fake-a" })));
	const crowded = runPi(home, { model: "tier/default", prompt: "hello" });
	writeFileSync(join(home, "tiers/load/other.json"), JSON.stringify(other({ s1: "fake-a" }, { "fake-b": { value: 0.95, atMs: Date.now() } })));
	const quota = runPi(home, { model: "tier/default", prompt: "hello" });
	return check(answered(crowded) === "fake-b/m1" && answered(quota) === "fake-a/m1", { crowded, quota });
});

scenario("auto picks the classifier's tier", () => {
	const r = runPi(makeHome("auto"), {
		model: "tier/auto",
		prompt: "## Captain's intent\nInvestigate why calls drop.",
		classify: { choice: "deep", confidence: 0.92 },
	});
	const line = r.custom.some((c) => c === "tier: auto → deep (0.92)");
	return check(answered(r) === "fake-c/m2" && r.autos[0]?.tier === "deep" && r.calls.includes("classifier:deep") && line, r);
});

scenario("auto falls back to the default tier when the classifier is unsure", () => {
	const r = runPi(makeHome("auto-low"), { model: "tier/auto", prompt: "do the thing", classify: { choice: "deep", confidence: 0.3 } });
	return check(answered(r) === "fake-a/m1" && r.autos[0]?.fallback === "low-confidence", r);
});

scenario("auto falls back to the default tier when the classifier errors", () => {
	const r = runPi(makeHome("auto-err"), { model: "tier/auto", prompt: "do the thing", classify: { error: "upstream 503" } });
	return check(answered(r) === "fake-a/m1" && r.autos[0]?.fallback === "error", r);
});

scenario("a Model override line wins over the tier chain", () => {
	const r = runPi(makeHome("override"), { model: "tier/default", prompt: "Model override: fake-c/m2 max\nPlease do X." });
	return check(answered(r) === "fake-c/m2" && r.routes.at(-1)?.position === 0, r);
});

scenario("a rule matched by git remote replaces the chain", () => {
	const home = makeHome("rule");
	const repo = join(home, "repo");
	mkdirSync(repo);
	execFileSync("git", ["init", "-q", repo]);
	execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:acme-corp/service.git"]);
	const r = runPi(home, { model: "tier/default", prompt: "hello", cwd: repo });
	return check(answered(r) === "fake-c/m2" && r.routes.at(-1)?.rule === "acme", r);
});

scenario("PI_TIERS_RULE forces a rule outside its matching repos", () => {
	const r = runPi(makeHome("forced-rule"), { model: "tier/default", prompt: "hello", env: { PI_TIERS_RULE: "acme" } });
	return check(answered(r) === "fake-c/m2" && r.routes.at(-1)?.rule === "acme", r);
});

scenario("PI_TIERS_RULE naming an unknown rule fails closed instead of using the base chain", () => {
	const r = runPi(makeHome("forced-unknown"), { model: "tier/default", prompt: "hello", env: { PI_TIERS_RULE: "nope" } });
	return check(r.final?.stopReason === "error" && r.calls.length === 0, r);
});

scenario("direct requests (compaction, extension calls) skip models cooled by an earlier agent-loop failure and leave the status line alone", () => {
	const home = makeHome("direct");
	runPi(home, { model: "tier/default", prompt: "hello", plan: { "fake-a/m1": ["429", "429", "429", "429"] } });
	const out = join(home, "direct.json");
	const r = runPi(home, { model: "tier/default", prompt: "/direct-probe default", env: { DIRECT_OUT: out }, extra: ["-e", DIRECT] });
	const { results = [], published = ["missing"] } = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
	r.direct = { results, published };
	// Direct requests must not overwrite the session's status line route.
	return check(results.length === 2 && results.every((x) => x === "fake-b/m1:stop") && r.routes.at(-1)?.reason === "direct" && published.length === 0, r);
});

scenario("a model whose context window is too small is skipped", () => {
	const r = runPi(makeHome("context"), { model: "tier/big", prompt: `Summarize: ${"lorem ipsum dolor sit amet ".repeat(9000)}` });
	const skipped = r.routes.at(-1)?.skipped?.some((s) => s.key === "fake-small/tiny" && s.reason === "context-too-small");
	return check(answered(r) === "fake-c/m2" && skipped, r);
});

scenario("when every usable rung is too small, the largest one is used and Pi compacts instead of the request failing", () => {
	// Two ~37K-token turns outgrow the only model's 64K window on the second turn.
	const home = makeHome("compact-fallback");
	const prompts = [`Remember: ${"lorem ipsum dolor sit amet ".repeat(5500)}`, `Summarize: ${"consectetur adipiscing elit ".repeat(5500)}`];
	const r = runPi(home, { model: "tier/small", prompt: prompts });
	const compaction = sessionEntries(home).find((e) => e.type === "compaction");
	r.compaction = compaction && { tokensBefore: compaction.tokensBefore };
	const routed = r.routes.some((x) => x.chosen === "fake-small/tiny" && x.compacting && x.reason === "user");
	return check(routed && compaction && r.final?.stopReason === "stop", r);
});

scenario("the same small-window model is used when the conversation fits", () => {
	const r = runPi(makeHome("context-fits"), { model: "tier/big", prompt: "short" });
	return check(answered(r) === "fake-small/tiny", r);
});

async function scenarioAsync(name, fn) {
	if (only && !name.includes(only)) return;
	let outcome;
	try {
		outcome = await fn();
	} catch (error) {
		outcome = { ok: false, detail: String(error?.stack ?? error) };
	}
	results.push({ name, ...outcome });
	console.log(`${outcome.ok ? "PASS" : "FAIL"}  ${name}`);
	if (!outcome.ok) console.log(`      ${JSON.stringify(outcome.evidence ?? outcome.detail).slice(0, 1500)}`);
}

function withTiers(home, change) {
	const tiers = JSON.parse(readFileSync(join(home, "tiers.json"), "utf8"));
	change(tiers);
	writeFileSync(join(home, "tiers.json"), JSON.stringify(tiers));
	return home;
}

/** Cools a key as another Pi process would, for the given number of milliseconds from now. */
function coolFromOtherProcess(home, key, ms, file = "999999") {
	mkdirSync(join(home, "tiers/cooldowns"), { recursive: true });
	writeFileSync(join(home, `tiers/cooldowns/${file}.json`), JSON.stringify({ [key]: { untilMs: Date.now() + ms, reason: "usage-limit" } }));
}

scenario("a timeout is retried on the same account, where the prompt cache is, instead of moving to the next one", () => {
	const r = runPi(makeHome("timeout"), { model: "tier/default", prompt: "hello", plan: { "fake-a/m1": ["timeout"] } });
	return check(answered(r) === "fake-a/m1" && r.calls.join() === "fake-a/m1:timeout,fake-a/m1:ok" && r.cooldowns.length === 0, r);
});

scenario("a dropped connection stays on the assigned account once Pi's retries run out, and is surfaced", () => {
	const r = runPi(makeHome("connection"), {
		model: "tier/default",
		prompt: "hello",
		plan: { "fake-a/m1": ["connection", "connection", "connection", "connection"] },
	});
	const ok = r.final?.stopReason === "error" && r.calls.length === 4 && r.calls.every((c) => c === "fake-a/m1:connection") && r.failures.length === 1;
	return check(ok, r);
});

scenario("background work never uses an account kept for the user", () => {
	const home = withTiers(makeHome("background-skip"), (t) => {
		t.background = { skip: ["fake-a"] };
	});
	const background = runPi(home, { model: "tier/default", prompt: "hello", env: { PI_TIERS_BACKGROUND: "1" } });
	const overridden = runPi(home, { model: "tier/default", prompt: "Model override: fake-a/m1\nhello", env: { PI_TIERS_BACKGROUND: "1" } });
	const foreground = runPi(home, { model: "tier/default", prompt: "hello" });
	const ok =
		answered(background) === "fake-b/m1" &&
		background.calls.join() === "fake-b/m1:ok" &&
		answered(overridden) === "fake-b/m1" &&
		overridden.calls.join() === "fake-b/m1:ok" &&
		answered(foreground) === "fake-a/m1";
	return check(ok, { background, overridden, foreground });
});

scenario("a tier whose only rung is cooling still uses it rather than failing to start", () => {
	const home = withTiers(makeHome("only-cooling"), (t) => {
		t.tiers.compact.chain = ["fake-c/m1:low"];
	});
	coolFromOtherProcess(home, "account:fake-c", 60_000);
	const r = runPi(home, { model: "tier/compact", prompt: "hello" });
	return check(answered(r) === "fake-c/m1" && r.calls.join() === "fake-c/m1:ok", r);
});

scenario("compaction-style direct requests on the compact tier keep working when every rung is cooling", () => {
	const home = makeHome("compact-cooling");
	coolFromOtherProcess(home, "account:fake-a", 120_000);
	coolFromOtherProcess(home, "account:fake-b", 30_000, "999998");
	coolFromOtherProcess(home, "account:fake-c", 60_000, "999997");
	const out = join(home, "direct.json");
	const r = runPi(home, { model: "tier/default", prompt: "/direct-probe compact", env: { DIRECT_OUT: out }, extra: ["-e", DIRECT] });
	const { results = [] } = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
	r.direct = results;
	return check(results.length === 2 && results.every((x) => x === "fake-b/m1:stop"), r);
});

scenario("with spread on, sessions start on different accounts of a group", () => {
	const home = withTiers(makeHome("spread"), (t) => {
		t.spread = true;
	});
	const expected = {
		"00000000-0000-4000-8000-000000000001": "fake-a/m1",
		"00000000-0000-4000-8000-000000000002": "fake-b/m1",
		"00000000-0000-4000-8000-000000000003": "fake-a/m1",
		"00000000-0000-4000-8000-000000000004": "fake-b/m1",
	};
	const firsts = Object.fromEntries(
		Object.keys(expected).map((id) => [id, answered(runPi(home, { model: "tier/default", prompt: "hello", extra: ["--session-id", id] }))]),
	);
	return check(
		Object.entries(expected).every(([id, f]) => firsts[id] === f),
		{ firsts, expected },
	);
});

scenario("a session resumed on the same session file picks its account again instead of keeping the old one", () => {
	const home = makeHome("resume");
	const id = "00000000-0000-4000-8000-0000000002aa";
	const first = runPi(home, { model: "tier/default", prompt: "hello", extra: ["--session-id", id] });
	// The account that served the session runs out between the first run and the restart.
	coolFromOtherProcess(home, "account:fake-a", 60_000);
	const resumed = runPi(home, { model: "tier/default", prompt: "hello again", extra: ["--session-id", id] });
	return check(answered(first) === "fake-a/m1" && answered(resumed) === "fake-b/m1", { first, resumed });
});

// ---- Live quota -------------------------------------------------------------------------------
const quotaPlan = join(OUT, "quota-plan.json");
const quotaLog = join(OUT, "quota-requests.log");
const quotaServer = spawn("node", [join(ROOT, "test/e2e/fake-quota-server.mjs"), quotaPlan, quotaLog], { stdio: ["ignore", "pipe", "inherit"] });
const quotaPort = await new Promise((resolveStart) => quotaServer.stdout.once("data", (d) => resolveStart(Number(String(d).trim()))));

/** Enables live quota for the fake accounts, reading from the fake server. */
function withQuota(home, quota = {}) {
	return withTiers(home, (t) => {
		t.quota = {
			providers: { "fake-a": "anthropic", "fake-b": "anthropic", "fake-c": "anthropic" },
			baseUrls: { anthropic: `http://127.0.0.1:${quotaPort}` },
			...quota,
		};
	});
}
/** What the fake server reports for each account: percent left in the 5h and 7d windows. */
function setQuota(plan) {
	const tokens = Object.fromEntries(Object.entries(plan).map(([provider, spec]) => [`key-${provider}`, spec]));
	writeFileSync(quotaPlan, JSON.stringify(tokens));
	writeFileSync(quotaLog, "");
}
const quotaRequests = () => readFileSync(quotaLog, "utf8").split("\n").filter(Boolean);
const quotaRoute = (r) => r.routes.at(-1)?.quota;

scenario("live quota: the account with more room left in its tightest window wins over the first in chain order", () => {
	setQuota({ "fake-a": { five: 90, seven: 30 }, "fake-b": { five: 50, seven: 80 } });
	const r = runPi(withQuota(makeHome("quota-room")), { model: "tier/default", prompt: "hello" });
	const q = quotaRoute(r);
	const logged = r.custom.some((c) => c.startsWith("tier: quota fake-a 5h 90%, 7d 30% (live); fake-b 5h 50%, 7d 80% (live)") && c.endsWith("chose fake-b/m1"));
	return check(answered(r) === "fake-b/m1" && q?.["fake-a"]?.source === "live" && logged, r);
});

scenario(
	"live quota: an account nearly out is skipped for the next account, and when every account of the entry is nearly out, for the next chain entry",
	() => {
		setQuota({ "fake-a": { five: 3, seven: 90 }, "fake-b": { five: 60, seven: 90 } });
		const next = runPi(withQuota(makeHome("quota-low-account")), { model: "tier/default", prompt: "hello" });
		setQuota({ "fake-a": { five: 90, seven: 4 }, "fake-b": { five: 2, seven: 90 } });
		const home = withQuota(makeHome("quota-low-entry"));
		const entry = runPi(home, { model: "tier/default", prompt: "hello" });
		// A configured threshold applies: 30% left is no longer enough.
		setQuota({ "fake-a": { five: 90, seven: 30 }, "fake-b": { five: 50, seven: 80 } });
		const strict = runPi(withQuota(makeHome("quota-low-config"), { minRemainingPercent: 40 }), { model: "tier/default", prompt: "hello" });
		const ok = answered(next) === "fake-b/m1" && answered(entry) === "fake-c/m2" && entry.routes.at(-1)?.position === 3 && answered(strict) === "fake-b/m1";
		return check(ok, { next, entry, strict });
	},
);

scenario("live quota: when every candidate is nearly out the session still starts, on the one that frees first", () => {
	setQuota({ "fake-a": { five: 1, seven: 90 }, "fake-b": { five: 1, seven: 90 } });
	const home = withQuota(makeHome("quota-all-low"), { providers: { "fake-a": "anthropic", "fake-b": "anthropic", "fake-c": "anthropic" } });
	withTiers(home, (t) => {
		t.tiers.default.chain = ["fake/m1:high"];
	});
	const r = runPi(home, { model: "tier/default", prompt: "hello" });
	return check(r.final?.stopReason === "stop", r);
});

scenario("live quota: a failed fetch falls back to the header-based score and still starts the session", () => {
	setQuota({ "fake-a": { status: 500 }, "fake-b": { status: 500 } });
	const home = makeHome("quota-failed");
	mkdirSync(join(home, "tiers/load"), { recursive: true });
	// The header-based score still ranks: fake-a is crowded, so fake-b wins.
	writeFileSync(
		join(home, "tiers/load/other.json"),
		JSON.stringify({ pid: process.pid, updatedMs: Date.now(), sessions: { s1: "fake-a", s2: "fake-a" }, usage: [], utilization: {} }),
	);
	const r = runPi(withQuota(home), { model: "tier/default", prompt: "hello" });
	const q = quotaRoute(r);
	const logged = r.custom.some((c) => c.includes("fake-a unavailable: HTTP 500"));
	return check(answered(r) === "fake-b/m1" && q?.["fake-a"]?.source === "failed" && logged, r);
});

scenario("live quota: a hung quota endpoint is cut off at quota.timeoutSeconds and never blocks the start", () => {
	setQuota({ "fake-a": { five: 90, seven: 90, delayMs: 20_000 }, "fake-b": { five: 90, seven: 90, delayMs: 20_000 } });
	const started = Date.now();
	const r = runPi(withQuota(makeHome("quota-timeout"), { timeoutSeconds: 1 }), { model: "tier/default", prompt: "hello" });
	r.tookMs = Date.now() - started;
	const q = quotaRoute(r);
	return check(answered(r) === "fake-a/m1" && q?.["fake-a"]?.source === "timeout" && r.tookMs < 15_000, r);
});

await scenarioAsync("live quota: parallel starts make one fetch per account and spread across accounts", async () => {
	setQuota({ "fake-a": { five: 80, seven: 80 }, "fake-b": { five: 80, seven: 80 } });
	const home = withQuota(makeHome("quota-parallel"));
	const ids = Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`);
	const runs = await Promise.all(ids.map((id) => runPiAsync(home, { model: "tier/default", prompt: "hello", extra: ["--session-id", id] })));
	const landed = runs.map(answered);
	const fetches = quotaRequests();
	const counts = Object.fromEntries(["key-fake-a", "key-fake-b"].map((t) => [t, fetches.filter((f) => f === t).length]));
	const ok = landed.every(Boolean) && counts["key-fake-a"] === 1 && counts["key-fake-b"] === 1 && new Set(landed).size === 2;
	return check(ok, { landed, counts, runs: runs.map((r) => r.stderr) });
});

const EXHAUSTED = (provider, window) => `${provider} ${window} quota has exhausted. Restart worker to launch on a new provider.`;
const visible = (r) => [r.final?.error, ...r.custom];

const USED_UP = { five: 0, seven: 0 };

scenario("(d) every provider used up: the failed turn ends with exactly one line naming the provider and window, with no retry or switch", () => {
	// The first reading (session start) is healthy; the one taken when the turn fails is not. Every other account is used up.
	setQuota({ "fake-a": { five: 80, seven: 80, after: 1, later: { five: 0, seven: 80 } }, "fake-b": USED_UP, "fake-c": USED_UP });
	const fiveH = runPi(withQuota(makeHome("exhausted-5h")), { model: "tier/default", prompt: "hello", plan: { "fake-a/m1": ["usage"] } });
	setQuota({ "fake-a": { five: 80, seven: 80, after: 1, later: { five: 90, seven: 2 } }, "fake-b": USED_UP, "fake-c": USED_UP });
	const sevenD = runPi(withQuota(makeHome("exhausted-7d")), { model: "tier/default", prompt: "hello", plan: { "fake-a/m1": ["429", "429", "429", "429"] } });
	const ok =
		fiveH.final?.error === EXHAUSTED("fake-a", "5h") &&
		sevenD.final?.error === EXHAUSTED("fake-a", "7d") &&
		fiveH.calls.join() === "fake-a/m1:usage" &&
		sevenD.calls.length === 1 &&
		!fiveH.custom.some((c) => c.includes("Not switching")) &&
		!sevenD.custom.some((c) => c.includes("Not switching"));
	return check(ok, { fiveH, sevenD });
});

scenario("a failed turn with quota left, or a failed quota read, keeps the provider's own error and prints nothing extra", () => {
	setQuota({ "fake-a": { five: 80, seven: 80 } });
	const left = runPi(withQuota(makeHome("exhausted-no")), { model: "tier/default", prompt: "hello", plan: { "fake-a/m1": ["usage"] } });
	setQuota({ "fake-a": { five: 80, seven: 80, after: 1, later: { status: 500 } } });
	const unreadable = runPi(withQuota(makeHome("exhausted-unreadable")), { model: "tier/default", prompt: "hello", plan: { "fake-a/m1": ["usage"] } });
	const own = (r) => r.final?.error?.includes("FreeUsageLimitError") && r.custom.some((c) => c.includes("Not switching models"));
	return check(own(left) && own(unreadable) && !visible(left).some((t) => t?.includes("quota has exhausted")), { left, unreadable });
});

scenario("PI_TIERS_AVOID excludes providers by exact name, on a fresh start and on a resumed session", () => {
	const home = makeHome("avoid");
	const id = "00000000-0000-4000-8000-0000000003aa";
	const fresh = runPi(home, { model: "tier/default", prompt: "hello", env: { PI_TIERS_AVOID: "fake-a" } });
	const first = runPi(home, { model: "tier/default", prompt: "hello", extra: ["--session-id", id] });
	const resumed = runPi(home, { model: "tier/default", prompt: "again", extra: ["--session-id", id], env: { PI_TIERS_AVOID: " fake-a , nope" } });
	const both = runPi(home, { model: "tier/default", prompt: "hello", env: { PI_TIERS_AVOID: "fake-a,fake-b" } });
	const ok = answered(fresh) === "fake-b/m1" && answered(first) === "fake-a/m1" && answered(resumed) === "fake-b/m1" && answered(both) === "fake-c/m2";
	return check(ok, { fresh, first, resumed, both });
});

scenario("PI_TIERS_AVOID that leaves nothing for the tier fails with one clear line and makes no request", () => {
	const r = runPi(makeHome("avoid-all"), { model: "tier/deep", prompt: "hello", env: { PI_TIERS_AVOID: "fake-c" } });
	return check(
		r.final?.stopReason === "error" && r.final.error === "pi-tiers: PI_TIERS_AVOID (fake-c) leaves no provider for tier 'deep'." && r.calls.length === 0,
		r,
	);
});

// ---- Jev provider pick, banked resets, subscriptions before pay-per-token -----------------------
const JEV = (spec) => ({ FAKE_JEV: JSON.stringify(spec) });
const rowKeys = (r) => Object.keys(r.jevAsked.at(-1)?.criteria ?? {});

scenario("the classifier picks the provider from the tier's candidate table, and the table, answer, and source are logged", () => {
	setQuota({ "fake-a": { five: 90, seven: 90 }, "fake-b": { five: 50, seven: 50 }, "fake-c": { five: 70, seven: 70 } });
	const home = withQuota(makeHome("jev-pick"));
	mkdirSync(join(home, "tiers/load"), { recursive: true });
	writeFileSync(
		join(home, "tiers/load/other.json"),
		JSON.stringify({ pid: process.pid, updatedMs: Date.now(), sessions: { s1: "fake-b", s2: "fake-b" }, usage: [], utilization: {} }),
	);
	const r = runPi(home, { model: "tier/default", prompt: "## Captain's intent\nFix the bug.", env: JEV({ choice: "fake-b/m1" }) });
	const pick = r.picks[0];
	const row = pick?.table?.find((t) => t.key === "fake-b/m1");
	const ok =
		answered(r) === "fake-b/m1" &&
		JSON.stringify(rowKeys(r)) === JSON.stringify(["fake-a/m1", "fake-b/m1", "fake-c/m2"]) &&
		pick.source === "jev" &&
		pick.answer === "fake-b/m1" &&
		pick.chosen === "fake-b/m1" &&
		!pick.fallback &&
		row?.agents === 2 &&
		row.windows.some((w) => w.label === "5h" && w.left === 50 && w.resetInMin >= 59) &&
		r.jevAsked[0].state.task.includes("Fix the bug");
	return check(ok, r);
});

scenario("a classifier timeout, an error, and an off-list answer each fall back to the code pick, and a single candidate skips the classifier", () => {
	setQuota({ "fake-a": { five: 90, seven: 90 }, "fake-b": { five: 50, seven: 50 } });
	const timeout = withTiers(withQuota(makeHome("jev-timeout")), (t) => {
		t.auto.providerTimeoutSeconds = 1;
	});
	const started = Date.now();
	const slow = runPi(timeout, { model: "tier/default", prompt: "do it", env: JEV({ delayMs: 20_000, choice: "fake-b/m1" }) });
	const tookMs = Date.now() - started;
	const errored = runPi(withQuota(makeHome("jev-error")), { model: "tier/default", prompt: "do it", env: JEV({ error: "upstream 503" }) });
	const offList = runPi(withQuota(makeHome("jev-off-list")), { model: "tier/default", prompt: "do it", env: JEV({ choice: "nope/m9" }) });
	const single = runPi(withQuota(makeHome("jev-single")), { model: "tier/deep", prompt: "do it", env: JEV({ choice: "fake-a/m1" }) });
	const ok =
		answered(slow) === "fake-a/m1" &&
		slow.picks[0]?.fallback === "timeout" &&
		slow.picks[0].source === "code" &&
		tookMs < 15_000 &&
		answered(errored) === "fake-a/m1" &&
		errored.picks[0]?.fallback === "error" &&
		answered(offList) === "fake-a/m1" &&
		offList.picks[0]?.fallback === "off-list" &&
		offList.picks[0].answer === null &&
		answered(single) === "fake-c/m2" &&
		single.jevAsked.length === 0 &&
		single.picks[0]?.fallback === "single";
	return check(ok, { slow, errored, offList, single });
});

scenario("a banked reset: live room before the old reset time clears the usage-limit mark at once, and without a live reading the mark holds", () => {
	setQuota({ "fake-a": { five: 90, seven: 90 }, "fake-b": { five: 40, seven: 40 } });
	const live = withQuota(makeHome("banked-live"));
	coolFromOtherProcess(live, "account:fake-a", 3600_000);
	const cleared = runPi(live, { model: "tier/default", prompt: "hello" });
	const plain = makeHome("banked-plain");
	coolFromOtherProcess(plain, "account:fake-a", 3600_000);
	const held = runPi(plain, { model: "tier/default", prompt: "hello" });
	// A usage-limit mark set after the reading was taken still holds: the reading predates it.
	setQuota({ "fake-a": { five: 0, seven: 90 }, "fake-b": { five: 40, seven: 40 } });
	const spent = withQuota(makeHome("banked-spent"));
	coolFromOtherProcess(spent, "account:fake-a", 3600_000);
	const stillOut = runPi(spent, { model: "tier/default", prompt: "hello" });
	const ok =
		answered(cleared) === "fake-a/m1" &&
		cleared.cleared[0]?.key === "account:fake-a" &&
		answered(held) === "fake-b/m1" &&
		answered(stillOut) === "fake-b/m1" &&
		stillOut.cleared.length === 0;
	return check(ok, { cleared, held, stillOut });
});

scenario(
	"a failed turn whose live check confirms an exhausted window marks only the account, until the live reset time, and sets no text-classified mark",
	() => {
		setQuota({ "fake-a": { five: 80, seven: 80, after: 1, later: { five: 0, seven: 80 } }, "fake-b": USED_UP, "fake-c": USED_UP });
		const home = withQuota(makeHome("exhausted-mark"));
		const before = Date.now();
		runPi(home, { model: "tier/default", prompt: "hello", plan: { "fake-a/m1": ["429", "429", "429", "429"] } });
		const marks = {};
		for (const f of readdirSync(join(home, "tiers/cooldowns"))) Object.assign(marks, JSON.parse(readFileSync(join(home, "tiers/cooldowns", f), "utf8")));
		const account = marks["account:fake-a"];
		// The fake endpoint resets an hour from the reading. The 429 itself marks nothing: fake-a has a live reader.
		const ok = account?.reason === "usage-limit" && account.untilMs - before > 3500_000 && !marks["model:fake-a/m1"] && Object.keys(marks).length === 1;
		return check(ok, { marks });
	},
);

scenario("pay-per-token providers are labelled in the table, ranked last by code, and chosen only when no subscription is usable", () => {
	setQuota({ "fake-a": { five: 90, seven: 90 }, "fake-b": { five: 50, seven: 50 } });
	const payg = (home) =>
		withTiers(home, (t) => {
			t.payg = ["fake-c"];
		});
	const offered = runPi(payg(withQuota(makeHome("payg-offered"))), { model: "tier/default", prompt: "do it", env: JEV({ choice: "fake-c/m2" }) });
	const labels = Object.fromEntries((offered.picks[0]?.table ?? []).map((t) => [t.key, t.payg]));
	const described = Object.entries(offered.jevAsked[0]?.criteria ?? {}).map(([k, v]) => [k, v.split(";")[0]]);
	// Pay-per-token first in the chain, no classifier answer: code still ranks the subscription first.
	const first = withTiers(payg(withQuota(makeHome("payg-first"))), (t) => {
		t.tiers.default.chain = ["fake-c/m2:low", "fake/m1:high"];
	});
	const ordered = runPi(first, { model: "tier/default", prompt: "do it" });
	// Every subscription used up: pay-per-token is all that is left, so the classifier is not asked.
	setQuota({ "fake-a": { five: 2, seven: 90 }, "fake-b": { five: 90, seven: 1 } });
	const last = runPi(payg(withQuota(makeHome("payg-last"))), { model: "tier/default", prompt: "do it", env: JEV({ first: true }) });
	const ok =
		answered(offered) === "fake-c/m2" &&
		offered.picks[0]?.source === "jev" &&
		labels["fake-c/m2"] === true &&
		labels["fake-a/m1"] === false &&
		JSON.stringify(described) ===
			JSON.stringify([
				["fake-a/m1", "subscription"],
				["fake-b/m1", "subscription"],
				["fake-c/m2", "PAYG"],
			]) &&
		answered(ordered) === "fake-a/m1" &&
		ordered.picks[0]?.fallback === "error" &&
		answered(last) === "fake-c/m2" &&
		last.jevAsked.length === 0;
	return check(ok, { offered, ordered, last });
});

scenario("the classifier sees providers from outside the tier's old chain, and can pick one", () => {
	setQuota({ "fake-a": { five: 90, seven: 90 }, "fake-b": { five: 50, seven: 50 } });
	const home = withTiers(withQuota(makeHome("jev-wide")), (t) => {
		// The tier used to name only the fake account group; now it names a model on every provider.
		t.tiers.quick = { description: "Small chores.", chain: ["fake/m1:low", "fake-c/m2:low", "fake-small/tiny:low"] };
	});
	const r = runPi(home, { model: "tier/quick", prompt: "do it", env: JEV({ choice: "fake-small/tiny" }) });
	const ok =
		answered(r) === "fake-small/tiny" &&
		JSON.stringify(rowKeys(r)) === JSON.stringify(["fake-a/m1", "fake-b/m1", "fake-c/m2", "fake-small/tiny"]) &&
		r.picks[0]?.source === "jev";
	return check(ok, r);
});

scenario("the compact tier is routed like any tier: subscriptions before pay-per-token, live quota first", () => {
	setQuota({ "fake-a": { five: 90, seven: 90 }, "fake-b": { five: 50, seven: 50 } });
	const payg = (home) =>
		withTiers(home, (t) => {
			t.payg = ["fake-c"];
			t.tiers.compact.chain = ["fake-c/m1:low", "fake/m1:low"];
		});
	const ordered = runPi(payg(withQuota(makeHome("compact-payg"))), { model: "tier/compact", prompt: "hello", env: JEV({ first: true }) });
	setQuota({ "fake-a": { five: 2, seven: 90 }, "fake-b": { five: 50, seven: 50 } });
	const quotaAware = runPi(withQuota(makeHome("compact-quota")), { model: "tier/compact", prompt: "hello", env: JEV({ first: true }) });
	return check(answered(ordered) === "fake-a/m1" && answered(quotaAware) === "fake-b/m1", { ordered, quotaAware });
});

scenario("PI_TIERS_AVOID and a forced rule still hold against the classifier's answer", () => {
	setQuota({ "fake-a": { five: 90, seven: 90 }, "fake-b": { five: 50, seven: 50 } });
	const avoided = runPi(withQuota(makeHome("jev-avoid")), {
		model: "tier/default",
		prompt: "do it",
		env: { ...JEV({ choice: "fake-a/m1" }), PI_TIERS_AVOID: "fake-a" },
	});
	const ruled = runPi(withQuota(makeHome("jev-rule")), {
		model: "tier/default",
		prompt: "do it",
		env: { ...JEV({ choice: "fake-a/m1" }), PI_TIERS_RULE: "acme" },
	});
	const ok = answered(avoided) === "fake-b/m1" && !rowKeys(avoided).includes("fake-a/m1") && answered(ruled) === "fake-c/m2" && ruled.jevAsked.length === 0;
	return check(ok, { avoided, ruled });
});

// ---- Retry with backoff on the same model, repick only on confirmed quota exhaustion -------------
// Pi's own retry settings carry the backoff: maxRetries 5, baseDelayMs 100, maxAgentDelayMs 1500 is the
// shape of the shipped 2s, 4s, 8s, 16s, 30s (60s in all), scaled down by 20 and capped the same way.
const BACKOFF = { maxRetries: 5, baseDelayMs: 100, maxAgentDelayMs: 1500 };
const gaps = (r) => r.callTimes.slice(1).map((t, i) => t - r.callTimes[i]);
const growing = (r) => {
	const g = gaps(r);
	return g.length >= 3 && g[1] > g[0] * 1.5 && g[2] > g[1] * 1.5;
};

scenario("(a) a retryable error recovers within the backoff on the same provider and model, with the delays doubling and nothing marked", () => {
	const home = withQuota(makeHome("retry-recovers", BACKOFF));
	setQuota({ "fake-a": { five: 90, seven: 90 }, "fake-b": { five: 50, seven: 50 } });
	const r = runPi(home, { model: "tier/default", prompt: "hello", plan: { "fake-a/m1": ["500", "500", "500"] } });
	const ok =
		answered(r) === "fake-a/m1" && r.calls.join() === "fake-a/m1:500,fake-a/m1:500,fake-a/m1:500,fake-a/m1:ok" && growing(r) && r.cooldowns.length === 0;
	return check(ok, { ...r, gaps: gaps(r) });
});

scenario("(b) the backoff budget spent with healthy quota surfaces the provider's error: same model throughout, no repick", () => {
	setQuota({ "fake-a": { five: 90, seven: 90 }, "fake-b": { five: 50, seven: 50 } });
	const home = withQuota(makeHome("retry-spent", BACKOFF));
	const r = runPi(home, { model: "tier/default", prompt: "hello", plan: { "fake-a/m1": Array(6).fill("500") } });
	const total = gaps(r).reduce((a, b) => a + b, 0);
	// 100 + 200 + 400 + 800 + 1500 = 3000ms of waiting across five retries.
	const ok =
		r.final?.stopReason === "error" &&
		r.final.error.includes("500") &&
		r.calls.length === 6 &&
		r.calls.every((c) => c === "fake-a/m1:500") &&
		total >= 2900 &&
		r.failures.length === 1 &&
		r.failures[0].recovery === "none" &&
		!r.custom.some((c) => c.includes("continuing"));
	return check(ok, { ...r, gaps: gaps(r), total });
});

scenario("(c) confirmed quota exhaustion mid-turn skips the retries, repicks (classifier among the usable), and the turn completes on another account", () => {
	// The reading at the failure (the second) shows fake-a used up; fake-b and fake-c have room.
	setQuota({
		"fake-a": { five: 90, seven: 90, after: 1, later: { five: 0, seven: 90 } },
		"fake-b": { five: 50, seven: 50 },
		"fake-c": { five: 70, seven: 70 },
	});
	const home = withQuota(makeHome("repick", BACKOFF));
	const r = runPi(home, {
		model: "tier/default",
		prompt: "## Captain's intent\nFix the bug.",
		plan: { "fake-a/m1": ["429", "429", "429"] },
		env: JEV({ sequence: ["first", "fake-c/m2"] }),
	});
	const marks = {};
	for (const f of readdirSync(join(home, "tiers/cooldowns"))) Object.assign(marks, JSON.parse(readFileSync(join(home, "tiers/cooldowns", f), "utf8")));
	const asked = r.jevAsked.at(-1);
	const ok =
		answered(r) === "fake-c/m2" &&
		r.calls.join() === "fake-a/m1:429,fake-c/m2:ok" &&
		marks["account:fake-a"]?.reason === "usage-limit" &&
		r.picks.at(-1)?.source === "jev" &&
		Object.keys(asked?.criteria ?? {}).join() === "fake-b/m1,fake-c/m2" &&
		r.custom.some((c) => c.includes("continuing the interrupted turn on another provider")) &&
		r.failures[0]?.recovery === "pool";
	return check(ok, { ...r, marks });
});

scenario("(c) the code pick continues the turn when the classifier gives no answer", () => {
	setQuota({ "fake-a": { five: 90, seven: 90, after: 1, later: { five: 0, seven: 90 } }, "fake-b": { five: 50, seven: 50 } });
	const r = runPi(withQuota(makeHome("repick-code", BACKOFF)), { model: "tier/default", prompt: "do it", plan: { "fake-a/m1": ["usage"] } });
	return check(answered(r) === "fake-b/m1" && r.calls.join() === "fake-a/m1:usage,fake-b/m1:ok", r);
});

scenario("(e) a banked reset: live room after an earlier exhaustion is picked again at once, with the mark cleared", () => {
	// Session 1 runs fake-a dry (marked for an hour) and finishes on fake-b. The quota is then restored early.
	setQuota({ "fake-a": { five: 90, seven: 90, after: 1, later: { five: 0, seven: 90 } }, "fake-b": { five: 60, seven: 60 } });
	const home = withQuota(makeHome("banked", BACKOFF), { cacheSeconds: 0 });
	const first = runPi(home, { model: "tier/default", prompt: "hello", plan: { "fake-a/m1": ["usage"] } });
	const marked = existsSync(join(home, "tiers/cooldowns")) && readdirSync(join(home, "tiers/cooldowns")).length > 0;
	setQuota({ "fake-a": { five: 95, seven: 95 }, "fake-b": { five: 60, seven: 60 } });
	const second = runPi(home, { model: "tier/default", prompt: "hello again" });
	const ok = answered(first) === "fake-b/m1" && marked && answered(second) === "fake-a/m1" && second.cleared[0]?.key === "account:fake-a";
	return check(ok, { first, second });
});

scenario("(f) the compact tier follows the same flow: retries on the same model, then repicks on confirmed exhaustion", () => {
	setQuota({ "fake-a": { five: 90, seven: 90 }, "fake-b": { five: 50, seven: 50 } });
	const retried = runPi(withQuota(makeHome("compact-retry", BACKOFF)), { model: "tier/compact", prompt: "hello", plan: { "fake-a/m1": ["500", "500"] } });
	setQuota({ "fake-a": { five: 90, seven: 90, after: 1, later: { five: 0, seven: 90 } }, "fake-b": { five: 50, seven: 50 } });
	const repicked = runPi(withQuota(makeHome("compact-repick", BACKOFF)), { model: "tier/compact", prompt: "hello", plan: { "fake-a/m1": ["429", "429"] } });
	const ok =
		answered(retried) === "fake-a/m1" &&
		retried.calls.join() === "fake-a/m1:500,fake-a/m1:500,fake-a/m1:ok" &&
		answered(repicked) === "fake-b/m1" &&
		repicked.calls.join() === "fake-a/m1:429,fake-b/m1:ok";
	return check(ok, { retried, repicked });
});

scenario("(f) a compactor's direct request leaves an account whose live quota is used up, and stays on the account that serves it otherwise", () => {
	setQuota({ "fake-a": { five: 90, seven: 90 }, "fake-b": { five: 50, seven: 50 } });
	const stays = runPi(withQuota(makeHome("direct-healthy"), { cacheSeconds: 0 }), {
		model: "tier/default",
		prompt: "/direct-probe compact",
		env: { DIRECT_OUT: join(OUT, "direct-healthy.json") },
		extra: ["-e", DIRECT],
	});
	// The first direct request starts on fake-a; its account is used up before the second one.
	setQuota({ "fake-a": { five: 90, seven: 90, after: 1, later: { five: 0, seven: 90 } }, "fake-b": { five: 50, seven: 50 } });
	const leaves = runPi(withQuota(makeHome("direct-exhausted"), { cacheSeconds: 0 }), {
		model: "tier/default",
		prompt: "/direct-probe compact",
		env: { DIRECT_OUT: join(OUT, "direct-exhausted.json") },
		extra: ["-e", DIRECT],
	});
	const results = (name) => JSON.parse(readFileSync(join(OUT, `${name}.json`), "utf8")).results;
	const ok = results("direct-healthy").every((x) => x === "fake-a/m1:stop") && results("direct-exhausted").join() === "fake-a/m1:stop,fake-b/m1:stop";
	return check(ok, { stays: results("direct-healthy"), leaves: results("direct-exhausted"), staysRun: stays, leavesRun: leaves });
});

scenario("(b) a failure with quota left never repicks, even when another account has more room", () => {
	setQuota({ "fake-a": { five: 20, seven: 90 }, "fake-b": { five: 99, seven: 99 } });
	const home = withTiers(withQuota(makeHome("no-repick", BACKOFF)), (t) => {
		t.tiers.default.chain = ["fake-a/m1:high", "fake-b/m1:high"];
	});
	// Chain order puts fake-a first and the single-account entries are not grouped, so the session starts on fake-a.
	const r = runPi(home, { model: "tier/default", prompt: "hello", plan: { "fake-a/m1": ["usage"] } });
	return check(r.final?.stopReason === "error" && r.calls.join() === "fake-a/m1:usage" && r.failures[0]?.recovery === "none", r);
});

quotaServer.kill();

const passed = results.filter((r) => r.ok).length;
const report = [
	`# pi-tiers end-to-end run`,
	"",
	`${new Date().toISOString()}, pi ${execFileSync("pi", ["--version"], { encoding: "utf8" }).trim()}: **${passed}/${results.length} passed**`,
	"",
	"| Scenario | Result | Answered by | Calls made |",
	"|---|---|---|---|",
	...results.map(
		(r) =>
			`| ${r.name} | ${r.ok ? "PASS" : "FAIL"} | ${r.evidence ? answered(r.evidence) || r.evidence.final?.stopReason || "-" : "-"} | ${r.evidence?.calls?.join(", ") ?? "-"} |`,
	),
	"",
	"## Evidence",
	"",
	...results.map((r) => `### ${r.name}\n\n\`\`\`json\n${JSON.stringify(r.evidence ?? r.detail, null, 1)}\n\`\`\``),
].join("\n");
writeFileSync(join(OUT, "report.md"), `${report}\n`);
console.log(`\n${passed}/${results.length} passed; report: ${join(OUT, "report.md")}`);
if (!process.argv.includes("--keep") && passed === results.length) {
	for (const entry of readdirSync(OUT)) if (entry !== "report.md") rmSync(join(OUT, entry), { recursive: true, force: true });
}
process.exit(passed === results.length ? 0 : 1);
