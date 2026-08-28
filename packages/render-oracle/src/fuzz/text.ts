import { CURSOR_MARKER } from "@veyyon/tui/tui";
import { visibleWidth } from "@veyyon/tui/utils";
import { BEL, ESC, SMILE } from "./constants";
import type { Rng } from "./random";
import type { CursorMode } from "./types";
import { CURSOR_MODES } from "./types";

export function wideText(label: string): string {
	return `${label}界${SMILE}한`;
}

export function arabicCombiningText(label: string): string {
	// Arabic tashkeel are nonspacing marks stored in the base cell. Stress them
	// alongside LTR labels because mis-measuring the marks used to overrun TUI
	// rows and crash on width verification (issue #643).
	return `${label}-بَسِمَ-قُرْآن`;
}

export function emojiPresentationText(label: string): string {
	// Text-default symbols promoted to emoji presentation by VS16 (U+FE0F) plus a
	// keycap sequence. With the Ghostty-backed terminal, these are now cell-exact:
	// Ghostty is the real modern terminal oracle, and both the renderer and the
	// terminal measure each sequence here as 2 cells.
	//
	// Keep randomized stress to VS16/keycap emoji for this migration baseline.
	// ZWJ and regional-indicator content should be enabled separately as renderer
	// bug triage: Ghostty will expose real under-measure and overrun failures
	// instead of hiding them behind a legacy model mismatch.
	return `${label} \u26A0\uFE0F\u2139\uFE0F 1\uFE0F\u20E3`;
}

export function styledText(label: string, color: number): string {
	return `${ESC}[${color}m${label}${ESC}[0m`;
}

export function backgroundStyledText(label: string, color: number): string {
	// Background SGR with NO trailing reset. Real components do leak unreset SGR
	// (markdown renderers, raw tool output), and BCE terminals (xterm.js included)
	// fill cells erased by \x1b[K / \x1b[2K with the *current* background — so a
	// leaked background paints whole phantom-colored rows. The renderer must
	// contain the leak to this row via its per-line terminators; the
	// no-background-bleed oracle asserts neighboring and blank rows never
	// inherit the color.
	return `${ESC}[${color}m${label}`;
}

export function linkedText(label: string): string {
	return `${ESC}]8;;https://example.test/${label}${BEL}${label}-link${ESC}]8;;${BEL}`;
}

export function longText(label: string, repeats: number): string {
	let text = `${label}-`;
	for (let i = 0; i < repeats; i++) {
		text += `${i}界`;
	}
	return `${text}-${label}`;
}

export function randomDecoratedText(rng: Rng, label: string): string {
	const roll = rng.next();
	if (roll < 0.18) return wideText(label);
	if (roll < 0.34) return styledText(`${label}界`, 31 + rng.int(0, 6));
	if (roll < 0.5) return linkedText(label);
	if (roll < 0.66) return longText(label, rng.int(2, 6));
	if (roll < 0.76) return arabicCombiningText(label);
	if (roll < 0.85) return emojiPresentationText(label);
	if (roll < 0.93) return backgroundStyledText(label, 41 + rng.int(0, 6));
	return label;
}

export function pickCursorMode(rng: Rng, text: string, width: number): CursorMode {
	if (text.includes("\x1b") || visibleWidth(text) === 0 || width <= 1) {
		return rng.chance(0.5) ? "start" : "end";
	}
	return rng.pick(CURSOR_MODES);
}

export function insertCursorMarker(text: string, mode: CursorMode, width: number): string {
	const index = cursorInsertionIndex(text, mode, width);
	return `${text.slice(0, index)}${CURSOR_MARKER}${text.slice(index)}`;
}

export const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function cursorInsertionIndex(text: string, mode: CursorMode, width: number): number {
	if (mode === "start") return 0;
	if (mode === "end" || text.includes("\x1b")) return text.length;
	const textWidth = visibleWidth(text);
	const target = mode === "wideBoundary" ? Math.max(0, Math.min(width - 1, textWidth)) : Math.floor(textWidth / 2);
	let offset = 0;
	let col = 0;
	for (const segment of SEGMENTER.segment(text)) {
		const nextCol = col + visibleWidth(segment.segment);
		if (nextCol > target) break;
		offset = segment.index + segment.segment.length;
		col = nextCol;
		if (col >= target) break;
	}
	return offset;
}
