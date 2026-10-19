#!/usr/bin/env node
// End-to-end suite: drives real `pi --mode json` processes with pi-tiers and a scripted fake
// provider, then checks which model answered, which calls were made, and what was cooled down.
// Usage: node test/e2e/run.mjs [--keep]   (writes a markdown report to .e2e-<timestamp>/report.md)
import { execFileSync, spawnSync } from "node:child_process";
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
	},
	auto: { classifier: "fake-cls/jev", tiers: ["default", "deep"], fallback: "default", minConfidence: 0.6, sections: ["## Captain's intent"] },
	rules: [{ name: "acme", match: { gitRemote: "github\\.com[:/]acme-corp/" }, tiers: { default: ["fake-c/m2:max"] } }],
	override: "^Model override:\\s*(\\S+)(?:\\s+(\\S+))?",
	warnProviders: ["fake-c"],
	cooldowns: { rateLimitSeconds: 600, serverErrorSeconds: 30, usageLimitSeconds: 3600, authSeconds: 3600 },
};

function makeHome(name) {
	const dir = join(OUT, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "settings.json"),
		JSON.stringify({ quietStartup: true, retry: { enabled: true, maxRetries: 3, baseDelayMs: 10, maxAgentDelayMs: 50 } }),
	);
	writeFileSync(join(dir, "tiers.json"), JSON.stringify(TIERS, null, 1));
	return dir;
}

function runPi(home, { model, prompt, plan = {}, classify, cwd = home, env = {}, extra = [] }) {
	const calls = join(home, "calls.tsv");
	const before = existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).length : 0;
	const res = spawnSync("pi", ["--mode", "json", "--offline", "--no-skills", "--no-context-files", "--model", model, "-e", EXT, "-e", FAKE, ...extra, prompt], {
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
	});
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
		custom,
		routes: log.filter((r) => r.event === "route").slice(-3),
		autos: log.filter((r) => r.event === "auto"),
		cooldowns: Object.keys(cooldowns).sort(),
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
function scenario(name, fn) {
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
scenario("retryable 429 fails over to the next account of the same model", () => {
	sharedHome = makeHome("ratelimit");
	const r = runPi(sharedHome, { model: "tier/default", prompt: "hello", plan: { "fake-a/m1": ["429"] } });
	return check(answered(r) === "fake-b/m1" && r.calls.join() === "fake-a/m1:429,fake-b/m1:ok" && r.cooldowns.includes("model:fake-a/m1"), r);
});

scenario("a cooldown set by one process is honored by the next process", () => {
	const r = runPi(sharedHome, { model: "tier/default", prompt: "hello again" });
	return check(answered(r) === "fake-b/m1" && r.calls.join() === "fake-b/m1:ok", r);
});

scenario("non-retryable usage limit cools the account and continues on the next one", () => {
	const r = runPi(makeHome("usage"), { model: "tier/default", prompt: "hello", plan: { "fake-a/m1": ["usage"] } });
	const ok =
		answered(r) === "fake-b/m1" &&
		r.calls.join() === "fake-a/m1:usage,fake-b/m1:ok" &&
		r.cooldowns.includes("account:fake-a") &&
		r.custom.some((c) => c.includes("pi-tiers"));
	return check(ok, r);
});

scenario("a 403 on one model cools only that model, so the same account's next model still answers", () => {
	const home = makeHome("forbidden");
	const tiers = JSON.parse(readFileSync(join(home, "tiers.json"), "utf8"));
	tiers.tiers.default.chain = ["fake-c/m1:low", "fake-c/m2:low"];
	writeFileSync(join(home, "tiers.json"), JSON.stringify(tiers));
	const r = runPi(home, { model: "tier/default", prompt: "hello", plan: { "fake-c/m1": ["403"] } });
	const ok = answered(r) === "fake-c/m2" && r.cooldowns.includes("model:fake-c/m1") && !r.cooldowns.includes("account:fake-c");
	return check(ok, r);
});

scenario("whole account group down falls to the next chain entry (warn provider)", () => {
	const r = runPi(makeHome("groupdown"), { model: "tier/default", prompt: "hello", plan: { "fake-a/m1": ["usage"], "fake-b/m1": ["usage"] } });
	return check(answered(r) === "fake-c/m2" && r.routes.at(-1)?.position === 3, r);
});

scenario("every candidate down ends with a clear error instead of looping", () => {
	const plan = { "fake-a/m1": ["usage"], "fake-b/m1": ["usage"], "fake-c/m2": ["usage"] };
	const r = runPi(makeHome("alldown"), { model: "tier/default", prompt: "hello", plan });
	return check(r.final?.stopReason === "error" && r.calls.length === 3, r);
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
	runPi(home, { model: "tier/default", prompt: "hello", plan: { "fake-a/m1": ["429"] } });
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

scenario("the same small-window model is used when the conversation fits", () => {
	const r = runPi(makeHome("context-fits"), { model: "tier/big", prompt: "short" });
	return check(answered(r) === "fake-small/tiny", r);
});

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
