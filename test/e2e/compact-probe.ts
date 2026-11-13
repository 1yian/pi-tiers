import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("compact-probe", {
		description: "Run actual session compaction and record its completion",
		handler: async (_args, ctx) => {
			const result = await new Promise((resolve) => {
				ctx.compact({
					onComplete: (compaction) => resolve({ ok: true, compaction }),
					onError: (error) => resolve({ ok: false, error: error.message }),
				});
			});
			writeFileSync(process.env.COMPACT_OUT!, JSON.stringify(result));
		},
	});
}
