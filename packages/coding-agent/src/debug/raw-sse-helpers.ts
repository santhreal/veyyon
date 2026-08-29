import { replaceTabs, truncateToWidth } from "@veyyon/tui";
import { sanitizeText } from "@veyyon/utils";
import { theme } from "../modes/theme/theme";
import type { RawSseDebugBuffer } from "./raw-sse-buffer";

export const MIN_VIEWER_WIDTH = 40;
export const VIEWER_CHROME_LINES = 6;
// `data:` lines below this width render fine on a single row; anything wider gets pretty-printed
// across multiple `data:` lines so streamed JSON blobs stop getting clipped by `truncateToWidth`.
export const PRETTY_PRINT_DATA_THRESHOLD = 100;

/** Shared ScrollView theme — avoids per-frame closure allocation. */
export const SCROLL_LIST_THEME = {
	track: (t: string) => theme.fg("muted", t),
	thumb: (t: string) => theme.fg("accent", t),
};

export function sanitizeFrameLine(line: string, width: number): string {
	return truncateToWidth(replaceTabs(sanitizeText(line)), width);
}

// Walks the SSE wire lines and replaces single-line `data: <json>` payloads with multi-line `data: <indented-json>` entries when the JSON is wide enough to clip.
/** @internal Exported for tests. */
export function expandPrettyDataLines(raw: readonly string[]): string[] {
	const out: string[] = [];
	for (const line of raw) {
		if (!line.startsWith("data: ") || line.length <= PRETTY_PRINT_DATA_THRESHOLD) {
			out.push(line);
			continue;
		}
		const body = line.slice("data: ".length);
		const trimmed = body.trim();
		if (trimmed.length === 0 || (trimmed[0] !== "{" && trimmed[0] !== "[")) {
			out.push(line);
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			out.push(line);
			continue;
		}
		const pretty = JSON.stringify(parsed, null, 2);
		for (const prettyLine of pretty.split("\n")) {
			out.push(`data: ${prettyLine}`);
		}
	}
	return out;
}

export interface RawSseViewerOptions {
	buffer: RawSseDebugBuffer;
	terminalRows: number;
	onExit: () => void;
	onStatus?: (message: string) => void;
	onUpdate?: () => void;
}
