// Fake quota endpoint for the end-to-end suite, shaped like Anthropic's api/oauth/usage.
// Usage: node fake-quota-server.mjs <plan.json> <requests.log>
// The plan maps a bearer token to {five, seven, sevenHours, fable, status, delayMs}; it is re-read on every request.
// sevenHours is how far away the 7d reset is (default 1); fable adds a model-scoped "Claude Fable" weekly window with that percent left.
// credits answers in the shape of xAI's billing credits endpoint instead, with that percent of credits left.
// A spec with `later` and `after: N` reports `later` from the Nth request on (a quota used up mid-session).
// Each request appends its token to the log. Prints the listening port on its first line.
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";

const [planFile, logFile] = process.argv.slice(2);
let seen = {};
let planStamp = 0;

createServer((req, res) => {
	const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
	appendFileSync(logFile, `${token}\n`);
	// Request counts start over whenever the plan is rewritten.
	const stamp = statSync(planFile).mtimeMs;
	if (stamp !== planStamp) [planStamp, seen] = [stamp, {}];
	seen[token] = (seen[token] ?? 0) + 1;
	const planned = JSON.parse(readFileSync(planFile, "utf8"))[token] ?? { status: 404 };
	const spec = planned.later && seen[token] > planned.after ? planned.later : planned;
	setTimeout(() => {
		if (spec.status && spec.status !== 200) {
			res.writeHead(spec.status).end("{}");
			return;
		}
		if (spec.credits !== undefined) {
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ config: { creditUsagePercent: 100 - spec.credits } }));
			return;
		}
		const resetsAt = (hours) => new Date(Date.now() + hours * 3600_000).toISOString();
		const window = (used, hours = 1) => ({ utilization: used, resets_at: resetsAt(hours) });
		const body = { five_hour: window(100 - spec.five), seven_day: window(100 - spec.seven, spec.sevenHours) };
		if (spec.fable !== undefined)
			body.limits = [
				{ kind: "weekly_scoped", percent: 100 - spec.fable, scope: { model: { display_name: "Claude Fable" } }, resets_at: resetsAt(spec.sevenHours ?? 1) },
			];
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
	}, spec.delayMs ?? 0);
}).listen(0, "127.0.0.1", function () {
	console.log(this.address().port);
});
