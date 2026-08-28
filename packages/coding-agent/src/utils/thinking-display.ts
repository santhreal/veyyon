import type { AgentMessage } from "@veyyon/agent-core";

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

const EMPTY_COMMENT_RE = /^<!--\s*-->$/;
const OPEN_COMMENT_RE = /^<!--\s*$/;

function isCommentNoise(line: string, isLastLine: boolean): boolean {
	const trimmed = line.trim();
	return EMPTY_COMMENT_RE.test(trimmed) || (isLastLine && OPEN_COMMENT_RE.test(trimmed));
}

function elisionMarker(hidden: number): string {
	if (hidden <= 0) return "...";
	return `... (${hidden} ${hidden === 1 ? "line" : "lines"} of code)`;
}

const ELISION_MARKER_PATTERN = /\.\.\.(?: \((\d+) lines? of code\))?$/;

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
			if (
				close &&
				close[2]![0] === fenceChar &&
				close[2]!.length >= fenceLen &&
				line.slice(close[1]!.length + close[2]!.length).trim() === ""
			) {
				inFence = false;
				fenceChar = "";
				fenceLen = 0;
				if (proseOnly) {
					appendElision(fenceHiddenLines);
					fenceHiddenLines = 0;
				}
			} else if (proseOnly) {
				fenceHiddenLines++;
			}
			if (!proseOnly) resultLines.push(line);
			continue;
		}

		if (hasComment && isCommentNoise(line, i === lines.length - 1)) continue;

		const open = FENCE.exec(line);
		if (open) {
			const marker = open[2]!;
			const ch = marker[0]!;
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

export function hasDisplayableThinking(
	text: string | null | undefined,
	formattedText: string | null | undefined,
): boolean {
	if (!text || !formattedText) return false;
	return formattedText.trim().length > 0 && canonicalizeMessage(text).length > 0;
}

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
