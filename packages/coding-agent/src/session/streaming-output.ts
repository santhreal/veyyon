import type { AgentToolUpdateCallback } from "@veyyon/agent-core";
import { capTextBytes, truncateHeadBytes, truncateTailBytes } from "@veyyon/utils/byte-truncate";
import { clampLow } from "@veyyon/utils/math";
import { sanitizeText, splitTrailingPartialEscape } from "@veyyon/utils/sanitize-text";

export { type ByteTruncationResult, truncateHeadBytes, truncateTailBytes } from "@veyyon/utils/byte-truncate";

import { DEFAULT_INLINE_FLOOR_FRACTION, DEFAULT_INLINE_OUTPUT_MAX_BYTES } from "../config/settings-domains/shared";
import { formatBytes } from "../tools/render-utils";
import { sanitizeWithOptionalSixelPassthrough } from "../utils/sixel";

export const DEFAULT_MAX_LINES = 3000;
export const DEFAULT_MAX_BYTES = DEFAULT_INLINE_OUTPUT_MAX_BYTES;
export const DEFAULT_MAX_COLUMN = 512; // Max chars per grep match line

export const ARTIFACT_DEFAULT_MAX_BYTES = 0;
export const ARTIFACT_DEFAULT_HEAD_BYTES = 3 * 1024 * 1024; // 3 MiB

const NL = "\n";
const ELLIPSIS = "…";

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

function countNewlines(text: string): number {
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

const MAX_PENDING = 10;

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

export class OutputSink {
	#buffer = "";
	#bufferBytes = 0;
	#head = "";
	#headBytes = 0;
	#headLines = 0; // newline count inside #head
	#headRetentionDisabled = false;
	#totalLines = 0; // newline count
	#totalBytes = 0;
	#sawData = false;
	#truncated = false;
	#lastChunkTime = 0;
	#pendingChunk = "";
	#pendingChunkTimer: Timer | undefined;
	#partialEscape = "";

	#currentLineBytes = 0;
	#columnEllipsisAdded = false;
	#columnDroppedBytes = 0;
	#columnTruncatedLines = 0;
	#file?: {
		path: string;
		artifactId?: string;
		sink: Bun.FileSink;
	};

	#pendingFileWrites?: string[];
	#fileReady = false;

	readonly #artifactPath?: string;
	readonly #artifactId?: string;
	readonly #spillThreshold: number;
	readonly #headLimit: number;
	readonly #onChunk?: (chunk: string) => void;
	readonly #chunkThrottleMs: number;
	readonly #maxColumns: number;

	readonly #artifactMaxBytes: number;
	readonly #artifactHeadBudget: number;
	readonly #artifactTailBudget: number;
	#artifactHeadBytesWritten = 0;
	#artifactHeadClosed = false;
	#artifactTailRing = "";
	#artifactTailRingBytes = 0;
	#artifactTailIncomingBytes = 0;

	constructor(options?: OutputSinkOptions) {
		const {
			artifactPath,
			artifactId,
			spillThreshold = DEFAULT_MAX_BYTES,
			headBytes = 0,
			maxColumns = 0,
			onChunk,
			chunkThrottleMs = 0,
			artifactMaxBytes = ARTIFACT_DEFAULT_MAX_BYTES,
			artifactHeadBytes = ARTIFACT_DEFAULT_HEAD_BYTES,
		} = options ?? {};
		this.#artifactPath = artifactPath;
		this.#artifactId = artifactId;
		this.#spillThreshold = spillThreshold;
		this.#headLimit = Math.max(0, headBytes);
		this.#maxColumns = Math.max(0, maxColumns);
		this.#onChunk = onChunk;
		this.#chunkThrottleMs = chunkThrottleMs;
		this.#artifactMaxBytes = Math.max(0, artifactMaxBytes);
		this.#artifactHeadBudget = clampLow(artifactHeadBytes, 0, this.#artifactMaxBytes);
		this.#artifactTailBudget = Math.max(0, this.#artifactMaxBytes - this.#artifactHeadBudget);
	}

	push(chunk: string): void {
		const { head, partial } = splitTrailingPartialEscape(this.#partialEscape + chunk);
		this.#partialEscape = partial;
		if (head.length === 0) return;
		chunk = sanitizeWithOptionalSixelPassthrough(head, sanitizeText);

		if (this.#onChunk) {
			const now = Date.now();
			if (now - this.#lastChunkTime >= this.#chunkThrottleMs) {
				this.#emitPendingChunkWith(chunk, now);
			} else {
				this.#pendingChunk += chunk;
				this.#schedulePendingChunkFlush();
			}
		}

		const rawBytes = Buffer.byteLength(chunk, "utf-8");
		this.#totalBytes += rawBytes;

		if (chunk.length > 0) {
			this.#sawData = true;
			this.#totalLines += countNewlines(chunk);
		}

		const capped = this.#maxColumns > 0 ? this.#applyColumnCap(chunk) : chunk;
		const cappedBytes = capped === chunk ? rawBytes : Buffer.byteLength(capped, "utf-8");
		const cappedThisChunk = cappedBytes < rawBytes;
		if (cappedThisChunk) this.#truncated = true;

		if (this.#artifactPath && (this.#file != null || cappedThisChunk || this.#willOverflow(cappedBytes))) {
			this.#writeToFile(chunk);
		}

		if (cappedBytes === 0) return;

		let tailChunk = capped;
		let tailBytes = cappedBytes;
		if (this.#headLimit > 0 && !this.#headRetentionDisabled && this.#headBytes < this.#headLimit) {
			const room = this.#headLimit - this.#headBytes;
			if (cappedBytes <= room) {
				this.#head += capped;
				this.#headBytes += cappedBytes;
				this.#headLines += countNewlines(capped);
				return;
			}
			const headSlice = truncateHeadBytes(capped, room);
			if (headSlice.bytes > 0) {
				this.#head += headSlice.text;
				this.#headBytes += headSlice.bytes;
				this.#headLines += countNewlines(headSlice.text);
				tailChunk = capped.substring(headSlice.text.length);
				tailBytes = cappedBytes - headSlice.bytes;
			}
		}

		this.#pushTail(tailChunk, tailBytes);
	}

	#applyColumnCap(chunk: string): string {
		if (chunk.length === 0) return chunk;
		const max = this.#maxColumns;
		const parts: string[] = [];
		let cursor = 0;
		while (cursor < chunk.length) {
			const nlIdx = chunk.indexOf(NL, cursor);
			const segEnd = nlIdx === -1 ? chunk.length : nlIdx;
			if (segEnd > cursor) {
				const segment = chunk.substring(cursor, segEnd);
				if (this.#columnEllipsisAdded) {
					this.#columnDroppedBytes += Buffer.byteLength(segment, "utf-8");
				} else {
					const segBytes = Buffer.byteLength(segment, "utf-8");
					const remaining = max - this.#currentLineBytes;
					if (segBytes <= remaining) {
						parts.push(segment);
						this.#currentLineBytes += segBytes;
					} else {
						const ellipsisBytes = 3; // "…" in UTF-8
						const headRoom = Math.max(0, remaining - ellipsisBytes);
						let kept = "";
						let keptBytes = 0;
						if (headRoom > 0) {
							const sliced = truncateHeadBytes(segment, headRoom);
							kept = sliced.text;
							keptBytes = sliced.bytes;
							parts.push(kept);
						}
						parts.push(ELLIPSIS);
						this.#columnDroppedBytes += segBytes - keptBytes;
						this.#columnTruncatedLines++;
						this.#currentLineBytes += keptBytes + ellipsisBytes;
						this.#columnEllipsisAdded = true;
					}
				}
			}
			if (nlIdx === -1) break;
			parts.push(NL);
			this.#currentLineBytes = 0;
			this.#columnEllipsisAdded = false;
			cursor = nlIdx + 1;
		}
		return parts.join("");
	}

	#willOverflow(dataBytes: number): boolean {
		return this.#bufferBytes + dataBytes > this.#spillThreshold;
	}

	#pushTail(chunk: string, dataBytes: number): void {
		if (dataBytes === 0) return;

		const threshold = this.#spillThreshold;
		const willOverflow = this.#bufferBytes + dataBytes > threshold;

		if (!willOverflow) {
			this.#buffer += chunk;
			this.#bufferBytes += dataBytes;
			return;
		}

		this.#truncated = true;

		if (dataBytes >= threshold) {
			const { text, bytes } = truncateTailBytes(chunk, threshold);
			this.#buffer = text;
			this.#bufferBytes = bytes;
		} else {
			this.#buffer += chunk;
			this.#bufferBytes += dataBytes;

			const { text, bytes } = truncateTailBytes(this.#buffer, threshold);
			this.#buffer = text;
			this.#bufferBytes = bytes;
		}
	}

	#writeToFile(chunk: string): void {
		if (this.#fileReady && this.#file) {
			this.#emitToSink(chunk);
			return;
		}
		if (!this.#pendingFileWrites) {
			this.#pendingFileWrites = [chunk];
			void this.#createFileSink();
		} else {
			this.#pendingFileWrites.push(chunk);
		}
	}

	#emitToSink(chunk: string): void {
		if (!this.#file || chunk.length === 0) return;
		if (this.#artifactMaxBytes === 0) {
			this.#file.sink.write(chunk);
			return;
		}
		const chunkBytes = Buffer.byteLength(chunk, "utf-8");
		const room = this.#artifactHeadClosed ? 0 : this.#artifactHeadBudget - this.#artifactHeadBytesWritten;
		if (room >= chunkBytes) {
			this.#file.sink.write(chunk);
			this.#artifactHeadBytesWritten += chunkBytes;
			return;
		}
		let overflow = chunk;
		if (room > 0) {
			const headSlice = truncateHeadBytes(chunk, room);
			if (headSlice.bytes > 0) {
				this.#file.sink.write(headSlice.text);
				this.#artifactHeadBytesWritten += headSlice.bytes;
			}
			this.#artifactHeadClosed = true;
			overflow = chunk.substring(headSlice.text.length);
		}
		if (overflow.length === 0 || this.#artifactTailBudget === 0) {
			if (overflow.length > 0) {
				this.#artifactTailIncomingBytes += Buffer.byteLength(overflow, "utf-8");
			}
			return;
		}
		this.#pushArtifactTail(overflow);
	}

	#pushArtifactTail(chunk: string): void {
		const chunkBytes = Buffer.byteLength(chunk, "utf-8");
		this.#artifactTailIncomingBytes += chunkBytes;
		const budget = this.#artifactTailBudget;
		if (chunkBytes >= budget) {
			const { text, bytes } = truncateTailBytes(chunk, budget);
			this.#artifactTailRing = text;
			this.#artifactTailRingBytes = bytes;
			return;
		}
		this.#artifactTailRing += chunk;
		this.#artifactTailRingBytes += chunkBytes;
		if (this.#artifactTailRingBytes > budget) {
			const { text, bytes } = truncateTailBytes(this.#artifactTailRing, budget);
			this.#artifactTailRing = text;
			this.#artifactTailRingBytes = bytes;
		}
	}

	async #createFileSink(): Promise<void> {
		if (!this.#artifactPath || this.#fileReady) return;
		try {
			const sink = Bun.file(this.#artifactPath).writer();
			this.#file = { path: this.#artifactPath, artifactId: this.#artifactId, sink };
			this.#fileReady = true;

			if (this.#head.length > 0) {
				this.#emitToSink(this.#head);
			}

			if (this.#buffer.length > 0) {
				this.#emitToSink(this.#buffer);
			}

			if (this.#pendingFileWrites) {
				for (const pending of this.#pendingFileWrites) {
					this.#emitToSink(pending);
				}
				this.#pendingFileWrites = undefined;
			}
		} catch {
			try {
				await this.#file?.sink?.end();
			} catch {}
			this.#file = undefined;
			this.#pendingFileWrites = undefined;
			this.#fileReady = false;
		}
	}

	createInput(): WritableStream<Uint8Array | string> {
		const dec = new TextDecoder("utf-8", { ignoreBOM: true });
		const finalize = () => {
			this.push(dec.decode());
		};
		return new WritableStream({
			write: chunk => {
				this.push(typeof chunk === "string" ? chunk : dec.decode(chunk, { stream: true }));
			},
			close: finalize,
			abort: finalize,
		});
	}

	replace(text: string): void {
		this.#clearPendingChunkTimer();
		this.#buffer = text;
		this.#bufferBytes = Buffer.byteLength(text, "utf-8");
		this.#head = "";
		this.#headBytes = 0;
		this.#headLines = 0;
		this.#headRetentionDisabled = true;
		this.#totalBytes = this.#bufferBytes;
		this.#totalLines = countNewlines(text);
		this.#sawData = text.length > 0;
		this.#truncated = false;
		this.#currentLineBytes = 0;
		this.#columnEllipsisAdded = false;
		this.#columnDroppedBytes = 0;
		this.#columnTruncatedLines = 0;
		this.#pendingChunk = "";
		this.#partialEscape = "";
	}

	#clearPendingChunkTimer(): void {
		if (!this.#pendingChunkTimer) return;
		clearTimeout(this.#pendingChunkTimer);
		this.#pendingChunkTimer = undefined;
	}

	#emitPendingChunkWith(chunk: string, now: number): void {
		this.#clearPendingChunkTimer();
		this.#lastChunkTime = now;
		const merged = this.#pendingChunk + chunk;
		this.#pendingChunk = "";
		this.#onChunk?.(merged);
	}

	#flushPendingChunk(): void {
		if (this.#pendingChunk.length === 0) {
			this.#clearPendingChunkTimer();
			return;
		}
		this.#emitPendingChunkWith("", Date.now());
	}

	#schedulePendingChunkFlush(): void {
		if (this.#chunkThrottleMs <= 0 || this.#pendingChunkTimer) return;
		const elapsed = Date.now() - this.#lastChunkTime;
		const delay = Math.max(0, this.#chunkThrottleMs - elapsed);
		this.#pendingChunkTimer = setTimeout(() => {
			this.#pendingChunkTimer = undefined;
			this.#flushPendingChunk();
		}, delay);
	}

	#flushArtifactTailIfCapped(): void {
		if (!this.#file) return;
		if (this.#artifactMaxBytes === 0) return;
		const tailBytes = this.#artifactTailRingBytes;
		const droppedBytes = Math.max(0, this.#artifactTailIncomingBytes - tailBytes);
		if (tailBytes === 0 && droppedBytes === 0) return;

		if (droppedBytes > 0) {
			const headWritten = this.#artifactHeadBytesWritten;
			const totalCapped = headWritten + this.#artifactTailIncomingBytes;
			const headSep = headWritten > 0 ? "\n" : "";
			const tailSep = tailBytes > 0 && !this.#artifactTailRing.startsWith("\n") ? "\n" : "";
			const notice =
				`${headSep}[ARTIFACT TRUNCATED: kept first ${formatBytes(headWritten)} + last ${formatBytes(tailBytes)} ` +
				`of ${formatBytes(totalCapped)}; ${formatBytes(droppedBytes)} elided from the middle]${tailSep}`;
			this.#file.sink.write(notice);
		}
		if (tailBytes > 0) {
			this.#file.sink.write(this.#artifactTailRing);
		}
	}

	async dump(notice?: string): Promise<OutputSummary> {
		const noticeLine = notice ? `[${notice}]\n` : "";

		this.#flushPendingChunk();
		this.#partialEscape = "";
		const totalLines = this.#sawData ? this.#totalLines + 1 : 0;

		if (this.#file) {
			this.#flushArtifactTailIfCapped();
			await this.#file.sink.end();
		}

		const headBytes = this.#headBytes;
		const tailBuf = this.#buffer;
		const tailBytes = this.#bufferBytes;
		const headLines = this.#headLines + (headBytes > 0 && !this.#head.endsWith("\n") ? 1 : 0);
		const tailLines = tailBuf.length > 0 ? countNewlines(tailBuf) + 1 : 0;

		const effectiveTotalBytes = Math.max(0, this.#totalBytes - this.#columnDroppedBytes);

		let body: string;
		let outputBytes: number;
		let outputLines: number;
		let elidedBytes: number | undefined;
		let elidedLines: number | undefined;

		if (headBytes > 0 && effectiveTotalBytes > headBytes + tailBytes) {
			elidedBytes = Math.max(0, effectiveTotalBytes - headBytes - tailBytes);
			elidedLines = Math.max(0, totalLines - headLines - tailLines);
			const marker = formatMiddleElisionMarker(elidedLines, elidedBytes);
			const markerBytes = Buffer.byteLength(marker, "utf-8");
			const headSep = this.#head.endsWith("\n") ? "" : "\n";
			const tailSep = tailBuf.startsWith("\n") ? "" : "\n";
			body = `${this.#head}${headSep}${marker}${tailSep}${tailBuf}`;
			outputBytes =
				headBytes +
				markerBytes +
				tailBytes +
				Buffer.byteLength(headSep, "utf-8") +
				Buffer.byteLength(tailSep, "utf-8");
			outputLines = headLines + 1 + tailLines;
			this.#truncated = true;
		} else if (headBytes > 0) {
			body = `${this.#head}${tailBuf}`;
			outputBytes = headBytes + tailBytes;
			outputLines = body.length > 0 ? countNewlines(body) + 1 : 0;
		} else {
			body = tailBuf;
			outputBytes = tailBytes;
			outputLines = tailLines;
		}

		return {
			output: `${noticeLine}${body}`,
			truncated: this.#truncated,
			totalLines,
			totalBytes: this.#totalBytes,
			outputLines,
			outputBytes,
			elidedBytes,
			elidedLines,
			columnDroppedBytes: this.#columnDroppedBytes > 0 ? this.#columnDroppedBytes : undefined,
			columnTruncatedLines: this.#columnTruncatedLines > 0 ? this.#columnTruncatedLines : undefined,
			artifactId: this.#file?.artifactId,
		};
	}
}

export function formatTailTruncationNotice(
	truncation: TruncationResult,
	options: TailTruncationNoticeOptions = {},
): string {
	if (!truncation.truncated) return "";

	const { fullOutputPath, originalContent, suffix = "" } = options;
	const startLine = truncation.totalLines - (truncation.outputLines ?? truncation.totalLines) + 1;
	const endLine = truncation.totalLines;
	const fullOutputPart = fullOutputPath ? `. Full output: ${fullOutputPath}` : "";

	let notice: string;
	if (truncation.lastLinePartial) {
		let lastLineSizePart = "";
		if (originalContent) {
			const lastNl = originalContent.lastIndexOf(NL);
			const lastLine = lastNl === -1 ? originalContent : originalContent.substring(lastNl + 1);
			lastLineSizePart = ` (line is ${formatBytes(Buffer.byteLength(lastLine, "utf-8"))})`;
		}
		notice = `[Showing last ${formatBytes(truncation.outputBytes ?? truncation.totalBytes)} of line ${endLine}${lastLineSizePart}${fullOutputPart}${suffix}]`;
	} else {
		notice = `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}${fullOutputPart}${suffix}]`;
	}

	return `\n\n${notice}`;
}

export function formatHeadTruncationNotice(
	truncation: TruncationResult,
	options: HeadTruncationNoticeOptions = {},
): string {
	if (!truncation.truncated) return "";

	const startLineDisplay = options.startLine ?? 1;
	const totalFileLines = options.totalFileLines ?? truncation.totalLines;
	const endLineDisplay = startLineDisplay + (truncation.outputLines ?? truncation.totalLines) - 1;
	const nextOffset = endLineDisplay + 1;
	const notice = `[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use :${nextOffset} to continue]`;
	return `\n\n${notice}`;
}

export function streamTailUpdates<TDetails, TInput = unknown>(
	tailBuffer: TailBuffer,
	onUpdate: AgentToolUpdateCallback<TDetails, TInput> | undefined,
): (chunk: string) => void {
	return chunk => {
		tailBuffer.append(chunk);
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: tailBuffer.text() }],
				details: {} as TDetails,
			});
		}
	};
}
