// Picks a work tier for a session from its first user message with a classifier model.
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutoConfig, Config } from "./config.ts";

export interface AutoDecision {
	tier: string;
	confidence?: number;
	/** Set when the classifier was unsure, unavailable, or failed and the fallback tier was used. */
	fallback?: "low-confidence" | "no-classifier" | "error" | "empty";
	detail?: string;
}

export function messageText(message: Message | undefined): string {
	if (!message) return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((b: { type?: string; text?: string }) => (b?.type === "text" && b.text ? [b.text] : [])).join("\n");
}

export function lastUserText(messages: readonly Message[]): string {
	return messageText([...messages].reverse().find((m) => m.role === "user"));
}

/**
 * The configured sections of `text`, or all of it. A `#` heading runs through the next heading of the same or
 * higher level. A plain label such as "Spec:" (which may end a longer line, like a `[fleet] ... Captain's
 * intent:` header) runs through the line before the next configured label, or to the end.
 */
export function extractSections(text: string, headings: string[], maxChars: number): string {
	if (headings.length === 0) return text.slice(0, maxChars);
	const lines = text.split("\n");
	const picked: string[] = [];
	for (const heading of headings) {
		const h = heading.trim();
		const level = /^#+/.exec(h)?.[0].length ?? 0;
		const others = headings.map((o) => o.trim()).filter((o) => o !== h);
		const start = lines.findIndex((l) => (level > 0 ? l.trim() === h : l.trim().endsWith(h)));
		if (start < 0) continue;
		let end = lines.length;
		for (let i = start + 1; i < lines.length; i++) {
			const m = /^(#+)\s/.exec(lines[i]);
			if (level > 0 ? m && m[1].length <= level : others.some((o) => lines[i].trim().startsWith(o))) {
				end = i;
				break;
			}
		}
		const first = level > 0 ? lines[start] : lines[start].slice(lines[start].lastIndexOf(h));
		picked.push([first, ...lines.slice(start + 1, end)].join("\n"));
	}
	return (picked.length ? picked.join("\n\n") : text).slice(0, maxChars);
}

export async function decideTier(config: Config, auto: AutoConfig, text: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<AutoDecision> {
	const body = extractSections(text, auto.sections, auto.maxChars).trim();
	if (!body) return { tier: auto.fallback, fallback: "empty" };
	const classifier = ctx.modelRegistry.findOfType("classifier", auto.classifierProvider, auto.classifierModel);
	if (!classifier) return { tier: auto.fallback, fallback: "no-classifier", detail: `${auto.classifierProvider}/${auto.classifierModel} not found` };
	const criteria = Object.fromEntries(auto.tiers.map((t) => [t, config.tiers.get(t)!.description]));
	const result = await ctx.modelRegistry.classify(
		classifier,
		{
			state: { task: body },
			questions: {
				tier: {
					type: "choice",
					instructions: "Which ONE work tier fits the request in `task`?",
					criteria,
				},
			},
		},
		{ signal },
	);
	const answer = result.answers?.tier;
	if (result.stopReason !== "stop" || answer?.type !== "choice" || !config.tiers.has(answer.choice)) {
		return { tier: auto.fallback, fallback: "error", detail: result.errorMessage ?? "unexpected classifier answer" };
	}
	if (answer.confidence < auto.minConfidence) {
		// Unsure but above the floor: the classifier's own top pick beats the fallback.
		if (answer.confidence >= auto.floor) return { tier: answer.choice, confidence: answer.confidence, detail: "below minConfidence, above floor" };
		return { tier: auto.fallback, fallback: "low-confidence", confidence: answer.confidence, detail: `picked ${answer.choice}` };
	}
	return { tier: answer.choice, confidence: answer.confidence };
}
