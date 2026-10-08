/** Small pure formatting helpers shared across collab-web components. */

/** "950", "12.3k", "1.2M" — tolerant of non-finite input. */
export function fmtTokens(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) {
		const k = n / 1000;
		return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
	}
	const m = n / 1_000_000;
	return `${m >= 100 ? Math.round(m) : m.toFixed(1)}M`;
}

/** "$0.004", "$0.42", "$4.20" — tolerant of non-finite input. */
export function fmtCost(usd: number): string {
	if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
	return `$${usd >= 1 ? usd.toFixed(2) : usd.toFixed(3)}`;
}

/** "847ms", "12.3s", "4m05s", "1h12m". */
export function fmtDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0ms";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const min = Math.floor(s / 60);
	if (min < 60) return `${min}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
	const h = Math.floor(min / 60);
	return `${h}h${String(min % 60).padStart(2, "0")}m`;
}

/** "now", "42s ago", "5m ago", "3h ago", "2d ago". Input: epoch ms. */
export function relTime(tsMs: number): string {
	if (!Number.isFinite(tsMs)) return "";
	const delta = Date.now() - tsMs;
	if (delta < 10_000) return "now";
	const s = Math.floor(delta / 1000);
	if (s < 60) return `${s}s ago`;
	const min = Math.floor(s / 60);
	if (min < 60) return `${min}m ago`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

/** "73%" from a 0–100 percent; em dash for null/non-finite. */
export function fmtPercent(p: number | null | undefined): string {
	if (p === null || p === undefined || !Number.isFinite(p)) return "—";
	return `${Math.round(Math.min(100, Math.max(0, p)))}%`;
}

/** Home-relative, middle-elided path: "~/…/clients/web". */
// `shortenPath` has one owner in `@veyyon/tool-render` (browser-safe). Re-export
// it here so existing `../../lib/format` imports keep working without a second,
// drifting copy. Callers that want the header's long-middle elision pass
// `{ collapseAfter: 4 }` (see HeaderBar).
export { shortenPath } from "@veyyon/tool-render";

/** Tolerant text extraction from string | content-block array | message-like objects. */
export function messageText(m: unknown): string {
	if (typeof m === "string") return m;
	if (Array.isArray(m)) {
		const parts: string[] = [];
		for (const block of m) {
			const text = blockText(block);
			if (text !== undefined) parts.push(text);
		}
		return parts.join("\n");
	}
	if (m === null || typeof m !== "object") return "";
	const rec = m as Record<string, unknown>;
	if (typeof rec.text === "string") return rec.text;
	return "content" in rec ? messageText(rec.content) : "";
}

/** A content block's text: a bare string, or the block's `text` field, else its `thinking` field. */
function blockText(block: unknown): string | undefined {
	if (typeof block === "string") return block;
	if (!block || typeof block !== "object") return undefined;
	const rec = block as Record<string, unknown>;
	if (typeof rec.text === "string") return rec.text;
	return typeof rec.thinking === "string" ? rec.thinking : undefined;
}
