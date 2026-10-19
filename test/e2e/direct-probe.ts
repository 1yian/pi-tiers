// Fixture: makes two direct (non-agent-loop) requests on a tier through the model registry, the way
// OptChat's compactor does, and records which model answered each.
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("direct-probe", {
		description: "two direct tier requests",
		handler: async (args, ctx) => {
			const model = ctx.modelRegistry.find("tier", args.trim() || "default");
			const results: string[] = [];
			for (let i = 0; i < 2; i++) {
				if (!model) break;
				const stream = ctx.modelRegistry.streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] } as never, {});
				const msg = await (stream as unknown as { result(): Promise<{ provider: string; model: string; stopReason: string }> }).result();
				results.push(`${msg.provider}/${msg.model}:${msg.stopReason}`);
			}
			writeFileSync(process.env.DIRECT_OUT!, JSON.stringify(results));
		},
	});
}
