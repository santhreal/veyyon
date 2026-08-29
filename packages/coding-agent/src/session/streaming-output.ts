import { capTextBytes, truncateTailBytes } from "@veyyon/utils/byte-truncate";
import { clampLow } from "@veyyon/utils/math";

import { DEFAULT_INLINE_FLOOR_FRACTION, DEFAULT_INLINE_OUTPUT_MAX_BYTES } from "../config/settings-domains/shared";

export { type ByteTruncationResult, truncateHeadBytes, truncateTailBytes } from "@veyyon/utils/byte-truncate";
export const DEFAULT_MAX_LINES = 3000;
export const DEFAULT_MAX_BYTES = DEFAULT_INLINE_OUTPUT_MAX_BYTES;
export const DEFAULT_MAX_COLUMN = 512; // Max chars per grep match line

export const ARTIFACT_DEFAULT_MAX_BYTES = 0;
export const ARTIFACT_DEFAULT_HEAD_BYTES = 3 * 1024 * 1024; // 3 MiB

export const NL = "\n";

export interface OutputSummary {
	output: string;
	truncated: boolean;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	elidedBytes?: number;
	elidedLines?: number;
	columnDroppedBytes?: number;
	columnTruncatedLines?: number;
	artifactId?: string;
}

export interface OutputSinkOptions {
	artifactPath?: string;
	artifactId?: string;
	spillThreshold?: number;
	headBytes?: number;
	maxColumns?: number;
	onChunk?: (chunk: string) => void;
	chunkThrottleMs?: number;
	artifactMaxBytes?: number;
	artifactHeadBytes?: number;
}

export interface TruncationResult {
	content: string;
	truncated?: boolean;
	truncatedBy?: "lines" | "bytes" | "middle";
	totalLines: number;
	totalBytes: number;
	outputLines?: number;
	outputBytes?: number;
	elidedBytes?: number;
	elidedLines?: number;
	headLines?: number;
	tailLines?: number;
	lastLinePartial?: boolean;
	firstLineExceedsLimit?: boolean;
}

export interface TruncationOptions {
	maxLines?: number;
	maxBytes?: number;
	maxHeadBytes?: number;
	maxHeadLines?: number;
}

export interface TailTruncationNoticeOptions {
	fullOutputPath?: string;
	originalContent?: string;
	suffix?: string;
}

export interface HeadTruncationNoticeOptions {
	startLine?: number;
	totalFileLines?: number;
}

export function countNewlines(text: string): number {
	let count = 0;
	let pos = text.indexOf(NL);
	while (pos !== -1) {
		count++;
		pos = text.indexOf(NL, pos + 1);
	}
	return count;
}

export function truncateLine(
	line: string,
	maxChars: number = DEFAULT_MAX_COLUMN,
): { text: string; wasTruncated: boolean } {
	if (line.length <= maxChars) return { text: line, wasTruncated: false };
	return { text: `${line.slice(0, maxChars)}…`, wasTruncated: true };
}

export function noTruncResult(content: string, totalLines?: number, totalBytes?: number): TruncationResult {
	if (totalLines == null) totalLines = countNewlines(content) + 1;
	if (totalBytes == null) totalBytes = Buffer.byteLength(content, "utf-8");
	return { content, totalLines, totalBytes };
}

export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const totalLines = countNewlines(content) + 1;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return noTruncResult(content, totalLines, totalBytes);
	}

	let includedLines = 0;
	let bytesUsed = 0;
	let cutIndex = 0; // char index where we cut (exclusive)
	let cursor = 0;

	let truncatedBy: "lines" | "bytes" = "lines";

	while (includedLines < maxLines) {
		const nl = content.indexOf(NL, cursor);
		const lineEnd = nl === -1 ? content.length : nl;

		const sepBytes = includedLines > 0 ? 1 : 0;
		const remaining = maxBytes - bytesUsed - sepBytes;

		if (remaining < 0) {
			truncatedBy = "bytes";
			break;
		}

		const lineCodeUnits = lineEnd - cursor;
		if (lineCodeUnits > remaining) {
			truncatedBy = "bytes";
			if (includedLines === 0) {
				return {
					content: "",
					truncated: true,
					truncatedBy: "bytes",
					totalLines,
					totalBytes,
					outputLines: 0,
					outputBytes: 0,
					lastLinePartial: false,
					firstLineExceedsLimit: true,
				};
			}
			break;
		}

		const lineText = content.slice(cursor, lineEnd);
		const lineBytes = Buffer.byteLength(lineText, "utf-8");

		if (lineBytes > remaining) {
			truncatedBy = "bytes";
			if (includedLines === 0) {
				return {
					content: "",
					truncated: true,
					truncatedBy: "bytes",
					totalLines,
					totalBytes,
					outputLines: 0,
					outputBytes: 0,
					lastLinePartial: false,
					firstLineExceedsLimit: true,
				};
			}
			break;
		}

		bytesUsed += sepBytes + lineBytes;
		includedLines++;

		cutIndex = nl === -1 ? content.length : nl; // exclude the newline after the last included line
		if (nl === -1) break;
		cursor = nl + 1;
	}

	if (includedLines >= maxLines && bytesUsed <= maxBytes) truncatedBy = "lines";

	return {
		content: content.slice(0, cutIndex),
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: includedLines,
		outputBytes: bytesUsed,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
	};
}

export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const totalLines = countNewlines(content) + 1;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return noTruncResult(content, totalLines, totalBytes);
	}

	let includedLines = 0;
	let bytesUsed = 0;
	let startIndex = content.length; // char index where output starts
	let end = content.length; // char index where current line ends (exclusive)

	let truncatedBy: "lines" | "bytes" = "lines";

	while (includedLines < maxLines) {
		const nl = content.lastIndexOf(NL, end - 1);
		const lineStart = nl === -1 ? 0 : nl + 1;

		const sepBytes = includedLines > 0 ? 1 : 0;
		const remaining = maxBytes - bytesUsed - sepBytes;

		if (remaining < 0) {
			truncatedBy = "bytes";
			break;
		}

		const lineCodeUnits = end - lineStart;

		if (lineCodeUnits > remaining) {
			truncatedBy = "bytes";
			if (includedLines === 0) {
				const windowStart = Math.max(lineStart, end - maxBytes);
				const window = content.substring(windowStart, end);
				const tail = truncateTailBytes(window, maxBytes);
				return {
					content: tail.text,
					truncated: true,
					truncatedBy: "bytes",
					totalLines,
					totalBytes,
					outputLines: 1,
					outputBytes: tail.bytes,
					lastLinePartial: true,
					firstLineExceedsLimit: false,
				};
			}
			break;
		}

		const lineText = content.slice(lineStart, end);
		const lineBytes = Buffer.byteLength(lineText, "utf-8");

		if (lineBytes > remaining) {
			truncatedBy = "bytes";
			if (includedLines === 0) {
				const tail = truncateTailBytes(lineText, maxBytes);
				return {
					content: tail.text,
					truncated: true,
					truncatedBy: "bytes",
					totalLines,
					totalBytes,
					outputLines: 1,
					outputBytes: tail.bytes,
					lastLinePartial: true,
					firstLineExceedsLimit: false,
				};
			}
			break;
		}

		bytesUsed += sepBytes + lineBytes;
		includedLines++;
		startIndex = lineStart;

		if (nl === -1) break;
		end = nl; // exclude the newline itself; it'll be accounted as sepBytes in the next iteration
	}

	if (includedLines >= maxLines && bytesUsed <= maxBytes) truncatedBy = "lines";

	return {
		content: content.slice(startIndex),
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: includedLines,
		outputBytes: bytesUsed,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
	};
}

export function formatMiddleElisionMarker(elidedLines: number, elidedBytes: number): string {
	if (elidedLines <= 1) return `[…${elidedBytes}B elided…]`;
	return `[…${elidedLines}ln elided…]`;
}

export function truncateMiddle(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const headBytes = options.maxHeadBytes ?? Math.floor(maxBytes / 2);
	const tailBytes = Math.max(0, maxBytes - headBytes);
	const headLines = options.maxHeadLines ?? Math.max(1, Math.floor(maxLines / 2));
	const tailLines = Math.max(0, maxLines - headLines);

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const totalLines = countNewlines(content) + 1;

	if (totalBytes <= maxBytes && totalLines <= maxLines) {
		return noTruncResult(content, totalLines, totalBytes);
	}

	if (headBytes <= 0 || headLines <= 0) {
		return truncateTail(content, { maxBytes: tailBytes || maxBytes, maxLines: tailLines || maxLines });
	}
	if (tailBytes <= 0 || tailLines <= 0) {
		return truncateHead(content, { maxBytes: headBytes, maxLines: headLines });
	}

	const head = truncateHead(content, { maxBytes: headBytes, maxLines: headLines });
	const tail = truncateTail(content, { maxBytes: tailBytes, maxLines: tailLines });

	const headLinesKept = head.outputLines ?? 0;
	const tailLinesKept = tail.outputLines ?? 0;
	const headBytesKept = head.outputBytes ?? Buffer.byteLength(head.content, "utf-8");
	const tailBytesKept = tail.outputBytes ?? Buffer.byteLength(tail.content, "utf-8");

	if (headLinesKept === 0 || head.firstLineExceedsLimit) return tail;
	if (tailLinesKept === 0) return head;
	if (headLinesKept + tailLinesKept >= totalLines) {
		return noTruncResult(content, totalLines, totalBytes);
	}

	const elidedLines = totalLines - headLinesKept - tailLinesKept;
	const elidedBytes = Math.max(0, totalBytes - headBytesKept - tailBytesKept);
	const marker = formatMiddleElisionMarker(elidedLines, elidedBytes);
	const composed = `${head.content}\n${marker}\n${tail.content}`;
	const markerBytes = Buffer.byteLength(marker, "utf-8");

	return {
		content: composed,
		truncated: true,
		truncatedBy: "middle",
		totalLines,
		totalBytes,
		outputLines: headLinesKept + tailLinesKept + 1,
		outputBytes: headBytesKept + tailBytesKept + markerBytes + 2,
		elidedLines,
		elidedBytes,
		headLines: headLinesKept,
		tailLines: tailLinesKept,
		lastLinePartial: tail.lastLinePartial,
		firstLineExceedsLimit: false,
	};
}

export function artifactFooter(id: string): string {
	return `[raw output: artifact://${id}]`;
}

export function expectedRereads(turnIndex: number, horizon = DEFAULT_SESSION_HORIZON_TURNS): number {
	return Math.max(1, horizon - Math.max(0, turnIndex));
}

export const DEFAULT_SESSION_HORIZON_TURNS = 60;

export function inlineCapForTurn(
	maxBytes: number,
	turnIndex: number,
	horizon = DEFAULT_SESSION_HORIZON_TURNS,
	floorFraction = DEFAULT_INLINE_FLOOR_FRACTION,
): number {
	const floor = Number.isFinite(floorFraction)
		? Math.min(1, Math.max(0, floorFraction))
		: DEFAULT_INLINE_FLOOR_FRACTION;
	const rereads = expectedRereads(turnIndex, horizon);
	const scaled = Math.round((maxBytes * expectedRereads(horizon, horizon)) / rereads);
	return clampLow(scaled, Math.round(maxBytes * floor), maxBytes);
}

export interface InlineByteCapOptions {
	maxBytes?: number;
	turnIndex?: number;
	floorFraction?: number;
	saveArtifact?: (full: string) => string | undefined | Promise<string | undefined>;
}

export function resolveInlineCap(options: InlineByteCapOptions): number {
	const budget = options.maxBytes ?? DEFAULT_MAX_BYTES;
	if (options.turnIndex === undefined) return budget;
	return inlineCapForTurn(budget, options.turnIndex, DEFAULT_SESSION_HORIZON_TURNS, options.floorFraction);
}

export async function enforceInlineByteCap(text: string, options: InlineByteCapOptions): Promise<string> {
	const capped = capTextBytes(text, resolveInlineCap(options));
	if (capped.elidedBytes === 0) return capped.text;

	const artifactId = await options.saveArtifact?.(text);
	if (!artifactId) return capped.text;
	const sep = capped.text.endsWith(NL) ? "" : NL;
	return `${capped.text}${sep}${artifactFooter(artifactId)}`;
}

export const MAX_PENDING = 10;

export class TailBuffer {
	#pending: string[] = [];
	#pos = 0; // byte count of the currently-held tail (after trims)

	constructor(readonly maxBytes: number) {}

	append(text: string): void {
		if (!text) return;

		const max = this.maxBytes;
		if (max === 0) {
			this.#pending.length = 0;
			this.#pos = 0;
			return;
		}

		const n = Buffer.byteLength(text, "utf-8");

		if (n >= max) {
			const { text: t, bytes } = truncateTailBytes(text, max);
			this.#pending[0] = t;
			this.#pending.length = 1;
			this.#pos = bytes;
			return;
		}

		this.#pos += n;

		if (this.#pending.length === 0) {
			this.#pending[0] = text;
			this.#pending.length = 1;
		} else {
			this.#pending.push(text);
			if (this.#pending.length > MAX_PENDING) this.#compact();
		}

		if (this.#pos > max * 2) this.#trimTo(max);
	}

	text(): string {
		const max = this.maxBytes;
		this.#trimTo(max);
		return this.#flush();
	}

	bytes(): number {
		const max = this.maxBytes;
		this.#trimTo(max);
		return this.#pos;
	}

	#compact(): void {
		this.#pending[0] = this.#pending.join("");
		this.#pending.length = 1;
	}

	#flush(): string {
		if (this.#pending.length === 0) return "";
		if (this.#pending.length > 1) this.#compact();
		return this.#pending[0];
	}

	#trimTo(max: number): void {
		if (max === 0) {
			this.#pending.length = 0;
			this.#pos = 0;
			return;
		}
		if (this.#pos <= max) return;

		const joined = this.#flush();
		const { text, bytes } = truncateTailBytes(joined, max);
		this.#pos = bytes;
		this.#pending[0] = text;
		this.#pending.length = 1;
	}
}

// circular import: class and functions moved to helpers
export {
	formatHeadTruncationNotice,
	formatTailTruncationNotice,
	OutputSink,
	streamTailUpdates,
} from "./streaming-output-helpers";

import { ELLIPSIS } from "../modes/components/status-line/component-helpers";

export { ELLIPSIS };
