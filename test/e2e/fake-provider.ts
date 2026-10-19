// Scripted providers for the end-to-end suite. Every call is appended to $FAKE_CALLS; the outcome
// of the Nth call to provider/model is $FAKE_PLAN[provider/model][N] (default "ok").
//   ok      answers "OK from provider/model"
//   429     retryable rate limit with retry-after: 120 (Pi retries it)
//   usage   non-retryable usage limit (Pi does not retry it)
//   500     retryable server error
//   401     authentication failure
//   403     model refused for this account (not an auth failure)
// The classifier answers with $FAKE_CLASSIFY ({"choice","confidence"} or {"error": "..."}).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { Api, AssistantMessage, AssistantMessageEventStream, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ERRORS: Record<string, { status: number; message: string; headers?: Record<string, string> }> = {
	"429": { status: 429, message: "429 rate_limit_error: Too many requests", headers: { "retry-after": "120" } },
	usage: { status: 429, message: "FreeUsageLimitError: free usage limit reached for this account" },
	"500": { status: 500, message: "500 Internal server error" },
	"401": { status: 401, message: "401 authentication_error: invalid x-api-key" },
	"403": { status: 403, message: '403: {"type":"FreeTierError","message":"free tier can only be used from within the vendor app"}' },
};

function inputTokens(context: unknown): number {
	return Math.ceil(JSON.stringify((context as { messages?: unknown })?.messages ?? []).length / 4);
}

function nextOutcome(key: string): string {
	const callsFile = process.env.FAKE_CALLS!;
	const prior = existsSync(callsFile)
		? readFileSync(callsFile, "utf8")
				.split("\n")
				.filter((l) => l.split("\t")[0] === key).length
		: 0;
	const plan = JSON.parse(process.env.FAKE_PLAN || "{}") as Record<string, string[]>;
	const outcome = plan[key]?.[prior] ?? "ok";
	appendFileSync(callsFile, `${key}\t${outcome}\n`);
	return outcome;
}

function stream(model: Model<Api>, context: unknown, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	const key = `${model.provider}/${model.id}`;
	(async () => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			// Report realistic input usage (about 4 characters per token) so Pi's context accounting,
			// and with it compaction, sees the real conversation size.
			usage: {
				input: inputTokens(context),
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: inputTokens(context) + 5,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};
		const outcome = nextOutcome(key);
		const error = ERRORS[outcome];
		await options?.onResponse?.({ status: error?.status ?? 200, headers: error?.headers ?? {} }, model);
		if (error) {
			message.stopReason = "error";
			message.errorMessage = error.message;
			out.push({ type: "error", reason: "error", error: message });
			out.end();
			return;
		}
		const text = `OK from ${key}`;
		out.push({ type: "start", partial: message });
		message.content.push({ type: "text", text: "" });
		out.push({ type: "text_start", contentIndex: 0, partial: message });
		(message.content[0] as { text: string }).text = text;
		out.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		out.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
		message.stopReason = "stop";
		out.push({ type: "done", reason: "stop", message });
		out.end();
	})();
	return out;
}

const chat = (id: string, contextWindow = 200_000) => ({
	id,
	name: id,
	reasoning: true,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow,
	maxTokens: 8192,
});

export default function (pi: ExtensionAPI) {
	for (const provider of ["fake-a", "fake-b", "fake-c"]) {
		pi.registerProvider(provider, { baseUrl: "https://fake.invalid", apiKey: "fake", api: "fake-api", models: [chat("m1"), chat("m2")], streamSimple: stream });
	}
	pi.registerProvider("fake-small", { baseUrl: "https://fake.invalid", apiKey: "fake", api: "fake-api", models: [chat("tiny", 64_000)], streamSimple: stream });
	pi.registerProvider("fake-cls", {
		baseUrl: "https://fake.invalid",
		apiKey: "fake",
		models: [
			{
				type: "classifier",
				id: "jev",
				name: "Fake Jev",
				api: "fake-cls-api",
				baseUrl: "https://fake.invalid",
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
			},
		],
		classifiers: {
			"fake-cls-api": {
				classify: async (model: { provider: string; id: string; api: string }) => {
					const spec = JSON.parse(process.env.FAKE_CLASSIFY || '{"choice":"default","confidence":1}');
					appendFileSync(process.env.FAKE_CALLS!, `classifier\t${spec.choice ?? spec.error}\n`);
					const base = { api: model.api, provider: model.provider, model: model.id, timestamp: Date.now() };
					if (spec.error) return { ...base, answers: {}, stopReason: "error", errorMessage: spec.error };
					return {
						...base,
						stopReason: "stop",
						answers: { tier: { type: "choice", choice: spec.choice, confidence: spec.confidence, probabilities: { [spec.choice]: spec.confidence } } },
					};
				},
			},
		},
	} as never);
}
