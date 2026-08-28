import { formatCount } from "@veyyon/utils";

export type ShakeMode = "elide" | "images";

export interface ShakeResult {
	mode: ShakeMode;
	toolResultsDropped: number;
	blocksDropped: number;
	imagesDropped?: number;
	tokensFreed: number;
	artifactId?: string;
}

export function formatShakeSummary(result: ShakeResult): string {
	if (result.mode === "images") {
		const n = result.imagesDropped ?? 0;
		return n === 0 ? "No images found in this session." : `Dropped ${formatCount("image", n)} from this session.`;
	}
	const parts: string[] = [];
	if (result.toolResultsDropped > 0) {
		parts.push(formatCount("tool result", result.toolResultsDropped));
	}
	if (result.blocksDropped > 0) {
		parts.push(formatCount("block", result.blocksDropped));
	}
	if (parts.length === 0) return "Nothing to shake.";
	return `Shook ${parts.join(" + ")} (~${result.tokensFreed} tokens freed).`;
}
