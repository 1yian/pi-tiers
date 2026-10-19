// The route summary published to footers: a plain status string plus a structured event.
export interface RouteStatus {
	/** What the user selected: a tier name or "auto". */
	selected: string;
	tier: string;
	/** Present when auto picked the tier; `unsure` when it fell back. */
	auto?: { confidence?: number; unsure: boolean };
	provider: string;
	model: string;
	thinking: string;
	/** 1-based position in the expanded chain; 1 means the first choice answered. Override is 0. */
	position: number;
	/** True for providers listed in `warnProviders` (last-resort fallbacks). */
	warn: boolean;
	rule?: string;
}

/** `claude-sonnet-5-5` -> `sonnet-5.5`; other ids pass through. */
export function shortModel(id: string): string {
	return id.replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, "-$1.$2");
}

export function formatStatus(s: RouteStatus): string {
	const head = s.auto ? `${s.auto.unsure ? "auto?" : "auto"} → ${s.tier}` : s.tier;
	const drop = s.position > 1 ? ` ↓${s.position}` : "";
	return `${head}${drop} → ${shortModel(s.model)} ${s.thinking} · ${s.provider}${s.warn ? " ⚠" : ""}`;
}
