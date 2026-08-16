import type { AgentMessage } from "@veyyon/agent-core";

// Single-slot-per-mode memo for formatThinkingForDisplay. During a streaming
// tick the same growing thinking text is formatted up to three times (reveal
// count, reveal slice, component render); this collapses them to one
// computation. Prose and raw modes produce different output for the same text,
// so each mode keeps its own slot. One entry per mode is enough for the common
// case of one active thinking block and never regresses (a miss recomputes
// exactly as before).
let proseCacheKey = "";
let proseCacheValue = "";
let rawCacheKey = "";
let rawCacheValue = "";

export function canonicalizeMessage(text: string | null | undefined): string {
	if (!text) return "";
	const trimmed = text.trim();
	for (let i = 0; i < trimmed.length; i++) {
		const code = trimmed.charCodeAt(i);
		if (code !== 0x2e && code !== 0x2026 && code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
			return trimmed;
		}
	}
	return "";
}

// gpt-5.x reasoning summaries pad every summary part with an empty HTML
// comment (`**Headline**\n\n<!-- -->`), streamed as a `<!--` delta followed by
// ` -->`. Comments with actual content are left untouched.
const EMPTY_COMMENT_RE = /^<!--\s*-->$/;
const OPEN_COMMENT_RE = /^<!--\s*$/;

/**
 * Whether `line` is reasoning-summary comment noise: an empty HTML comment,
 * or its still-unterminated `<!--` prefix on the last line while streaming.
 */
function isCommentNoise(line: string, isLastLine: boolean): boolean {
	const trimmed = line.trim();
	return EMPTY_COMMENT_RE.test(trimmed) || (isLastLine && OPEN_COMMENT_RE.test(trimmed));
}

/**
 * Trailing marker prose-only mode leaves where it elided a fenced code block.
 *
 * The line count is the point of it. Without one, a reasoning trace that opens
 * a fence and then emits a document for minutes renders as a sentence that
 * simply stops — `Acceptance criteria:` followed by `1...` and nothing more,
 * for the rest of the turn — which reads as output that was truncated or
 * killed rather than reasoning that is still arriving. The count grows on every
 * streamed tick while the fence is open, so the block visibly keeps moving, and
 * a finished block states how much of itself it is hiding.
 */
function elisionMarker(hidden: number): string {
	if (hidden <= 0) return "...";
	return `... (${hidden} ${hidden === 1 ? "line" : "lines"} of code)`;
}

/** Matches {@link elisionMarker} at the end of a line, capturing its count. */
const ELISION_MARKER_PATTERN = /\.\.\.(?: \((\d+) lines? of code\))?$/;

/**
 * Thinking text prepared for display. Both modes drop empty `<!-- -->`
 * sentinel lines outside code fences (see {@link isCommentNoise}); prose-only
 * mode additionally elides fenced code down to a trailing ellipsis that names
 * how many lines it hid (see {@link elisionMarker}).
 */
export function formatThinkingForDisplay(text: string, proseOnly: boolean): string {
	if (!text) return text;
	const hasComment = text.includes("<!--");
	if (proseOnly) {
		if (text === proseCacheKey) return proseCacheValue;
	} else {
		if (!hasComment) return text;
		if (text === rawCacheKey) return rawCacheValue;
	}

	const lines = text.split("\n");
	const resultLines: string[] = [];
	let inFence = false;
	let fenceChar = "";
	let fenceLen = 0;
	/** Content lines hidden by the fence currently open, delimiters excluded. */
	let fenceHiddenLines = 0;

	const FENCE = /^( {0,3})([`~]{3,})/;
	const appendElision = (hidden: number) => {
		let lastLineIdx = resultLines.length - 1;
		while (lastLineIdx >= 0 && resultLines[lastLineIdx]!.trim() === "") {
			lastLineIdx--;
		}

		if (lastLineIdx < 0) {
			resultLines.push(elisionMarker(hidden));
			return;
		}
		const trimmed = resultLines[lastLineIdx]!.trimEnd();
		const existing = ELISION_MARKER_PATTERN.exec(trimmed);
		if (existing) {
			// Fences separated only by blank lines collapse onto one marker
			// rather than stacking ellipses on the same sentence.
			const already = existing[1] === undefined ? 0 : Number(existing[1]);
			resultLines[lastLineIdx] = trimmed.slice(0, existing.index) + elisionMarker(already + hidden);
			return;
		}
		const stem = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
		resultLines[lastLineIdx] = stem + elisionMarker(hidden);
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;

		if (inFence) {
			const close = FENCE.exec(line);
			// A closing fence is the same char, at least as long, with nothing else on the line.
			if (
				close &&
				close[2]![0] === fenceChar &&
				close[2]!.length >= fenceLen &&
				line.slice(close[1]!.length + close[2]!.length).trim() === ""
			) {
				inFence = false;
				fenceChar = "";
				fenceLen = 0;
				// The marker lands when the fence closes, because only then is
				// its size known.
				if (proseOnly) {
					appendElision(fenceHiddenLines);
					fenceHiddenLines = 0;
				}
			} else if (proseOnly) {
				fenceHiddenLines++;
			}
			// Prose mode skips all fence lines; raw mode keeps them verbatim
			// (comment markers inside fences are code, not noise).
			if (!proseOnly) resultLines.push(line);
			continue;
		}

		// Drop the whole line so `**Headline**\n\n<!-- -->` leaves no blank tail.
		if (hasComment && isCommentNoise(line, i === lines.length - 1)) continue;

		const open = FENCE.exec(line);
		if (open) {
			const marker = open[2]!;
			const ch = marker[0]!;
			// A backtick fence's info string may not contain a backtick.
			if (!(ch === "`" && line.slice(open[1]!.length + marker.length).includes("`"))) {
				inFence = true;
				fenceChar = ch;
				fenceLen = marker.length;
				fenceHiddenLines = 0;
				if (!proseOnly) resultLines.push(line);
				continue;
			}
		}
		resultLines.push(line);
	}
	// A fence the model never closed hides everything after it: still
	// streaming, or nested fences of equal length that flipped the parity.
	if (inFence && proseOnly) appendElision(fenceHiddenLines);

	const formatted = resultLines.join("\n");
	if (proseOnly) {
		proseCacheKey = text;
		proseCacheValue = formatted;
	} else {
		rawCacheKey = text;
		rawCacheValue = formatted;
	}
	return formatted;
}

/** Whether a formatted thinking block has non-placeholder content worth rendering. */
export function hasDisplayableThinking(
	text: string | null | undefined,
	formattedText: string | null | undefined,
): boolean {
	if (!text || !formattedText) return false;
	// Visibility keys off the formatted text: a block whose raw text is only
	// comment noise (`<!-- -->\n`) formats to whitespace and stays hidden. The
	// raw canonicalize check still hides dot/ellipsis-only placeholder blocks.
	return formattedText.trim().length > 0 && canonicalizeMessage(text).length > 0;
}

/** Whether an assistant message contains thinking content the TUI can reveal. */
export function messageHasDisplayableThinking(message: AgentMessage, proseOnly: boolean): boolean {
	if (message.role !== "assistant") return false;
	for (const content of message.content) {
		if (content.type !== "thinking") continue;
		if (hasDisplayableThinking(content.thinking, formatThinkingForDisplay(content.thinking, proseOnly))) {
			return true;
		}
	}
	return false;
}
