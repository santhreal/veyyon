/**
 * The line window a range read collects from a file: the context padding around a requested range,
 * the byte and line budgets, the single in-memory materialization of the file, and the streaming
 * path for a file too large to hold.
 */

import * as fs from "node:fs/promises";
import { formatCount, formatMoreLines } from "@veyyon/utils/format";
import { SNAPSHOT_MAX_BYTES } from "../../edit/file-snapshot-store";
import { normalizeToLF } from "../../edit/normalize";
import { DEFAULT_MAX_LINES, type TruncationResult, truncateHeadBytes } from "../../session/streaming-output";
import { type InlinePricingSource, inlineBudgetFor } from "../core/output-artifact";
import { formatBytes } from "../core/render-utils";
import { throwIfAborted } from "../core/tool-errors";

/**
 * The one materialization of a file a read is allowed to make.
 *
 * A bounded range read used to touch the same file three times: the streamer scanned it for
 * the window and the total line count, bracket context read and split all of it, and the
 * snapshot read and normalized all of it again. Measured on a 3.5MiB, 100k-line source,
 * `read path:50000-50019` read 3.08x the file's bytes and cost 463ms.
 *
 * `windowLines` is the same split the streamer produces, and is present only when the file
 * has no CR: byte accounting (`outputBytes`, `totalBytes`, the byte-limit decisions) counts
 * source bytes, and a CRLF file's raw lines carry a byte the normalized ones do not. A file
 * with CRLF therefore keeps the streaming path for its window and shares only the text.
 */
interface MaterializedFile {
	/** Every line ending normalized to LF; what the snapshot tag fingerprints. */
	text: string;
	/** `text` split on LF. Bracket context and the multi-range display slice this. */
	lines: string[];
	/** `lines` again when the file's bytes are already LF-only, else undefined. */
	windowLines: string[] | undefined;
}

/** Preserves a leading BOM, which `Bun.file().text()` silently drops. */
const BOM_PRESERVING_DECODER = new TextDecoder("utf-8", { ignoreBOM: true });

export async function materializeFile(absolutePath: string, fileSize: number): Promise<MaterializedFile | undefined> {
	if (fileSize > SNAPSHOT_MAX_BYTES) return undefined;
	try {
		// Decoded with the BOM intact because the line streamer keeps it on line 1: a decode that
		// drops it reports a file whose first line differs from the one the reader is shown.
		const raw = BOM_PRESERVING_DECODER.decode(await Bun.file(absolutePath).bytes());
		const hasBom = raw.startsWith("\uFEFF");
		// The snapshot tag and the bracket context both fingerprint the file the way every other
		// reader of it does, BOM stripped, so a tag minted here still matches one minted by a
		// plain read of the same bytes.
		const text = normalizeToLF(hasBom ? raw.slice(1) : raw);
		const lines = text.split("\n");
		// A lone CR normalizes to LF without changing the string's length, so length equality is
		// not the test; and a BOM is a character the streamer displays and `text` does not. Either
		// one makes the raw and normalized splits different files to display.
		const sharesTheSplit = !raw.includes("\r") && !hasBom;
		return { text, lines, windowLines: sharesTheSplit ? lines : undefined };
	} catch {
		// Reading the whole file here is an optimization and a source of extras (bracket context,
		// the snapshot tag). The caller's own read of the same file reports the failure with the
		// path; undefined only means no context lines and no tag.
		return undefined;
	}
}

const READ_CHUNK_SIZE = 8 * 1024;

/**
 * Context lines added around an explicit range read. Anchor-stale failures
 * cluster on edits whose anchors land just outside the most recent read
 * window, but the data (`scripts/session-stats/analyze_selector_reads.py`)
 * shows most follow-up reads are disjoint hops, not adjacent extensions —
 * so symmetric padding rarely pays for itself.
 *
 * Leading=1 catches accidental single-line reads where the anchor is the
 * line immediately above the requested start. Trailing=3 buffers the
 * common case where the agent asks for a narrow range and then needs the
 * next few lines to disambiguate an anchor.
 */
const RANGE_LEADING_CONTEXT_LINES = 1;
const RANGE_TRAILING_CONTEXT_LINES = 3;

/**
 * How many context lines a range read gets on each side. The one owner of that
 * arithmetic: the in-memory range path and both streaming range paths (plain
 * file, artifact) each need the same two numbers, and each used to derive them
 * from the two constants itself.
 *
 * A start of 0 (no explicit offset) gets no leading context — that is already
 * an open-ended read from the top — and leading padding never runs past the
 * top of the file.
 */
function rangeContextLines(
	requestedStart: number,
	expandStart: boolean,
	expandEnd: boolean,
): { leading: number; trailing: number } {
	return {
		leading: expandStart ? Math.min(requestedStart, RANGE_LEADING_CONTEXT_LINES) : 0,
		trailing: expandEnd ? RANGE_TRAILING_CONTEXT_LINES : 0,
	};
}

/**
 * Expand a [start, end) range with leading/trailing context lines on the
 * sides where the user actually constrained the range.
 */
export function expandRangeWithContext(
	requestedStart: number,
	requestedEnd: number,
	totalLines: number,
	expandStart: boolean,
	expandEnd: boolean,
): { startLine: number; endLine: number } {
	const context = rangeContextLines(requestedStart, expandStart, expandEnd);
	return {
		startLine: requestedStart - context.leading,
		endLine: Math.min(totalLines, requestedEnd + context.trailing),
	};
}

/**
 * Say, in the result itself, that some of the returned lines are padding.
 *
 * A bounded selector returns more lines than it asked for: `read file:1-3`
 * answers with six lines, three requested and three of trailing context. The
 * expansion is deliberate (it saves the follow-up read that a one-line-off
 * anchor would need), and documenting it in `docs/tools/read.md` was not
 * enough: the surprise happens at CALL TIME, where the result looked like the
 * selector had been ignored. A dogfooder flagged the same read twice for that
 * reason, which is what this notice answers.
 *
 * Returns `undefined` when nothing was padded, so an exact read stays exact
 * and unannotated. Line numbers are 1-indexed and inclusive, as displayed.
 */
export function formatContextPaddingNotice(options: {
	requestedFirstLine: number;
	/** Undefined for an open-ended read, which never gets trailing padding. */
	requestedLastLine: number | undefined;
	displayedFirstLine: number;
	displayedLastLine: number;
}): string | undefined {
	const leading = Math.max(0, options.requestedFirstLine - options.displayedFirstLine);
	const trailing =
		options.requestedLastLine === undefined ? 0 : Math.max(0, options.displayedLastLine - options.requestedLastLine);
	if (leading === 0 && trailing === 0) return undefined;

	const requested =
		options.requestedLastLine === undefined || options.requestedLastLine === options.requestedFirstLine
			? `line ${options.requestedFirstLine}`
			: `lines ${options.requestedFirstLine}-${options.requestedLastLine}`;
	const padding: string[] = [];
	if (leading > 0) padding.push(`${formatCount("line", leading)} of leading context`);
	if (trailing > 0) padding.push(`${formatCount("line", trailing)} of trailing context`);
	return `[Showing lines ${options.displayedFirstLine}-${options.displayedLastLine}: you requested ${requested}, plus ${padding.join(" and ")}]`;
}

/**
 * The byte budget for one read window.
 *
 * A caller who named a line count is asking for those lines, so the budget
 * scales to hold them at about 512 bytes a line and never falls below the
 * session's inline budget. A caller who named none is reading the head of a
 * file whose line lengths it does not know yet, and the 300-line default over
 * prose returned 79KB in a single result: more than the whole tool prelude,
 * re-sent on every later request of the session. That window is bounded by
 * `inlineBudgetFor`, the one owner of how many bytes a tool result may carry,
 * and the truncation notice states the selector that pages the rest.
 */
export function readWindowMaxBytes(
	session: InlinePricingSource,
	requestedLimit: number | undefined,
	maxLinesToCollect: number,
): number {
	const budget = inlineBudgetFor(session);
	return requestedLimit === undefined ? budget : Math.max(budget, maxLinesToCollect * 512);
}
export function formatOutOfBoundsMessage(
	requestedStart: number,
	totalLines: number,
	entityLabel: string,
	prefix = ":",
): string {
	const suggestion =
		totalLines === 0
			? `The ${entityLabel} is empty.`
			: `Use ${prefix}1 to read from the start, or ${prefix}${totalLines} to read the last line.`;
	return `Line ${requestedStart + 1} is beyond end of ${entityLabel} (${totalLines} lines total). ${suggestion}`;
}

/** The lines a range read collects: the requested start, the context padded around it, and its budgets. */
interface RangeWindow {
	requestedStart: number;
	startLine: number;
	startLineDisplay: number;
	maxLinesToCollect: number;
	selectedLineLimit: number;
	maxBytesForRead: number;
}

export function computeRangeWindow(
	offset: number | undefined,
	limit: number | undefined,
	rawSelector: boolean,
	defaultLimit: number,
	pricingSession: InlinePricingSource,
): RangeWindow {
	const requestedStart = offset ? Math.max(0, offset - 1) : 0;
	const expandStart = !rawSelector && offset !== undefined && offset > 1;
	const expandEnd = !rawSelector && limit !== undefined;
	const { leading: leadingContext, trailing: trailingContext } = rangeContextLines(
		requestedStart,
		expandStart,
		expandEnd,
	);
	const startLine = requestedStart - leadingContext;
	const startLineDisplay = startLine + 1;
	const effectiveLimit = limit ?? defaultLimit;
	const maxLinesToCollect = Math.min(effectiveLimit + leadingContext + trailingContext, DEFAULT_MAX_LINES);
	const selectedLineLimit = effectiveLimit + leadingContext + trailingContext;
	const maxBytesForRead = readWindowMaxBytes(pricingSession, limit, maxLinesToCollect);
	return {
		requestedStart,
		startLine,
		startLineDisplay,
		maxLinesToCollect,
		selectedLineLimit,
		maxBytesForRead,
	};
}

/** What a bounded window of a file's lines came to, however the lines were obtained. */
interface CollectedWindow {
	lines: string[];
	totalFileLines: number;
	collectedBytes: number;
	stoppedByByteLimit: boolean;
	firstLinePreview?: { text: string; bytes: number };
	firstLineByteLength?: number;
	reachedEof: boolean;
}

/**
 * The same window {@link streamLinesFromFile} collects, taken from lines already in memory.
 *
 * The byte accounting is deliberately the streamer's, rule for rule: a line is dropped when it
 * alone exceeds the budget, the separator counts as one byte from the second line on, and the
 * first line's length is recorded whether or not it was kept. It is written twice because the
 * two sources are different shapes -- one decodes byte segments as it goes, the other has every
 * line already -- and a caller cannot tell which one answered it.
 */
export function collectWindowFromLines(
	lines: readonly string[],
	startLine: number,
	maxLinesToCollect: number,
	maxBytes: number,
	selectedLineLimit: number | null,
): CollectedWindow {
	const collected: string[] = [];
	let collectedBytes = 0;
	let stoppedByByteLimit = false;
	let doneCollecting = false;
	let firstLineByteLength: number | undefined;
	let selectedLinesSeen = 0;
	let firstLinePreview: { text: string; bytes: number } | undefined;

	for (let index = startLine; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const lineBytes = Buffer.byteLength(line, "utf-8");

		if (selectedLineLimit !== null && selectedLinesSeen < selectedLineLimit) selectedLinesSeen++;
		if (doneCollecting) {
			// The streamer records the first selected line's length even when collection had already
			// stopped, which is reachable with a zero-line window: the caller still reports how long
			// the line it refused to show was.
			firstLineByteLength ??= lineBytes;
			if (selectedLineLimit !== null && selectedLinesSeen >= selectedLineLimit) break;
			continue;
		}

		const separatorBytes = collected.length > 0 ? 1 : 0;
		if (collected.length >= maxLinesToCollect) {
			doneCollecting = true;
		} else if (collected.length === 0 && lineBytes > maxBytes) {
			// The streamer captures the head of an over-long first line for the preview, capped at
			// the same budget, and reports the line's full length so the caller can say how far over.
			stoppedByByteLimit = true;
			doneCollecting = true;
			firstLineByteLength ??= lineBytes;
			firstLinePreview = truncateHeadBytes(Buffer.from(line, "utf-8").subarray(0, maxBytes), maxBytes);
		} else if (collected.length > 0 && collectedBytes + separatorBytes + lineBytes > maxBytes) {
			stoppedByByteLimit = true;
			doneCollecting = true;
		} else {
			collected.push(line);
			collectedBytes += separatorBytes + lineBytes;
			firstLineByteLength ??= lineBytes;
			if (collectedBytes > maxBytes) {
				stoppedByByteLimit = true;
				doneCollecting = true;
			} else if (collected.length >= maxLinesToCollect) {
				doneCollecting = true;
			}
		}
		if (doneCollecting && selectedLineLimit !== null && selectedLinesSeen >= selectedLineLimit) break;
	}

	return {
		lines: collected,
		totalFileLines: lines.length,
		collectedBytes,
		stoppedByByteLimit,
		firstLinePreview,
		firstLineByteLength,
		reachedEof: true,
	};
}

export async function streamLinesFromFile(
	filePath: string,
	startLine: number,
	maxLinesToCollect: number,
	maxBytes: number,
	selectedLineLimit: number | null,
	signal?: AbortSignal,
	stopScanAfterCollect = false,
): Promise<{
	lines: string[];
	totalFileLines: number;
	collectedBytes: number;
	stoppedByByteLimit: boolean;
	firstLinePreview?: { text: string; bytes: number };
	firstLineByteLength?: number;
	selectedBytesTotal: number;
	/** False when `stopScanAfterCollect` cut the scan short — `totalFileLines` is then a lower bound. */
	reachedEof: boolean;
}> {
	const bufferChunk = Buffer.allocUnsafe(READ_CHUNK_SIZE);
	const collectedLines: string[] = [];
	let lineIndex = 0;
	let collectedBytes = 0;
	let stoppedByByteLimit = false;
	let doneCollecting = false;
	let reachedEof = true;
	let fileHandle: fs.FileHandle | null = null;
	let currentLineLength = 0;
	let currentLineChunks: Buffer[] = [];
	let sawAnyByte = false;
	let endedWithNewline = false;
	let firstLinePreviewBytes = 0;
	const firstLinePreviewChunks: Buffer[] = [];
	let firstLineByteLength: number | undefined;
	let selectedBytesTotal = 0;
	let selectedLinesSeen = 0;
	let captureLine = false;
	let discardLineChunks = false;
	let lineCaptureLimit = 0;

	const setupLineState = () => {
		captureLine = !doneCollecting && lineIndex >= startLine;
		discardLineChunks = !captureLine;
		if (captureLine) {
			const separatorBytes = collectedLines.length > 0 ? 1 : 0;
			lineCaptureLimit = maxBytes - collectedBytes - separatorBytes;
			if (lineCaptureLimit <= 0) {
				discardLineChunks = true;
			}
		} else {
			lineCaptureLimit = 0;
		}
	};

	const decodeLine = (): string => {
		if (currentLineLength === 0) return "";
		if (currentLineChunks.length === 1 && currentLineChunks[0]?.length === currentLineLength) {
			return currentLineChunks[0].toString("utf-8");
		}
		return Buffer.concat(currentLineChunks, currentLineLength).toString("utf-8");
	};

	const maybeCapturePreview = (segment: Uint8Array) => {
		if (doneCollecting || lineIndex < startLine || collectedLines.length !== 0) return;
		if (firstLinePreviewBytes >= maxBytes || segment.length === 0) return;
		const remaining = maxBytes - firstLinePreviewBytes;
		const slice = segment.length > remaining ? segment.subarray(0, remaining) : segment;
		if (slice.length === 0) return;
		firstLinePreviewChunks.push(Buffer.from(slice));
		firstLinePreviewBytes += slice.length;
	};

	const appendSegment = (segment: Uint8Array) => {
		currentLineLength += segment.length;
		maybeCapturePreview(segment);
		if (!captureLine || discardLineChunks || segment.length === 0) return;
		if (currentLineLength <= lineCaptureLimit) {
			currentLineChunks.push(Buffer.from(segment));
		} else {
			discardLineChunks = true;
		}
	};

	const finalizeLine = () => {
		if (lineIndex >= startLine && (selectedLineLimit === null || selectedLinesSeen < selectedLineLimit)) {
			selectedBytesTotal += currentLineLength + (selectedLinesSeen > 0 ? 1 : 0);
			selectedLinesSeen++;
		}

		if (!doneCollecting && lineIndex >= startLine) {
			const separatorBytes = collectedLines.length > 0 ? 1 : 0;
			if (collectedLines.length >= maxLinesToCollect) {
				doneCollecting = true;
			} else if (collectedLines.length === 0 && currentLineLength > maxBytes) {
				stoppedByByteLimit = true;
				doneCollecting = true;
				if (firstLineByteLength === undefined) {
					firstLineByteLength = currentLineLength;
				}
			} else if (collectedLines.length > 0 && collectedBytes + separatorBytes + currentLineLength > maxBytes) {
				stoppedByByteLimit = true;
				doneCollecting = true;
			} else {
				const lineText = decodeLine();
				collectedLines.push(lineText);
				collectedBytes += separatorBytes + currentLineLength;
				if (firstLineByteLength === undefined) {
					firstLineByteLength = currentLineLength;
				}
				if (collectedBytes > maxBytes) {
					stoppedByByteLimit = true;
					doneCollecting = true;
				} else if (collectedLines.length >= maxLinesToCollect) {
					doneCollecting = true;
				}
			}
		} else if (lineIndex >= startLine && firstLineByteLength === undefined) {
			firstLineByteLength = currentLineLength;
		}

		lineIndex++;
		currentLineLength = 0;
		currentLineChunks = [];
		setupLineState();
	};

	setupLineState();

	try {
		fileHandle = await fs.open(filePath, "r");

		while (true) {
			throwIfAborted(signal);
			const { bytesRead } = await fileHandle.read(bufferChunk, 0, bufferChunk.length, null);
			if (bytesRead === 0) break;

			sawAnyByte = true;
			const chunk = bufferChunk.subarray(0, bytesRead);
			endedWithNewline = chunk[bytesRead - 1] === 0x0a;

			// Once collection and selected-line accounting are both finished, the
			// remaining scan only computes `totalFileLines` — count newlines with
			// native indexOf instead of the per-byte JS loop (a multi-GB tail
			// otherwise stalls the read for seconds to minutes).
			if (doneCollecting && selectedLineLimit !== null && selectedLinesSeen >= selectedLineLimit) {
				if (stopScanAfterCollect) {
					reachedEof = false;
					break;
				}
				let searchFrom = 0;
				let newlineAt = chunk.indexOf(0x0a);
				while (newlineAt !== -1) {
					lineIndex++;
					searchFrom = newlineAt + 1;
					newlineAt = chunk.indexOf(0x0a, searchFrom);
				}
				if (searchFrom === 0) {
					currentLineLength += chunk.length;
				} else {
					currentLineLength = chunk.length - searchFrom;
				}
				continue;
			}

			let start = 0;
			for (let i = 0; i < chunk.length; i++) {
				if (chunk[i] === 0x0a) {
					const segment = chunk.subarray(start, i);
					if (segment.length > 0) {
						appendSegment(segment);
					}
					finalizeLine();
					start = i + 1;
				}
			}

			if (start < chunk.length) {
				appendSegment(chunk.subarray(start));
			}
		}
	} finally {
		if (fileHandle) {
			await fileHandle.close();
		}
	}

	if (reachedEof && (endedWithNewline || currentLineLength > 0 || !sawAnyByte)) {
		finalizeLine();
	}

	let firstLinePreview: { text: string; bytes: number } | undefined;
	if (firstLinePreviewBytes > 0) {
		const { text, bytes } = truncateHeadBytes(Buffer.concat(firstLinePreviewChunks, firstLinePreviewBytes), maxBytes);
		firstLinePreview = { text, bytes };
	}

	return {
		lines: collectedLines,
		totalFileLines: lineIndex,
		collectedBytes,
		stoppedByByteLimit,
		firstLinePreview,
		firstLineByteLength,
		selectedBytesTotal,
		reachedEof,
	};
}

/**
 * Collect a range read's window from the file's materialized lines when they are its bytes' own
 * split, and by streaming the file otherwise.
 */
export async function collectFileWindow(
	absolutePath: string,
	fileSize: number,
	window: RangeWindow,
	materialized: MaterializedFile | undefined,
): Promise<CollectedWindow> {
	const { startLine, maxLinesToCollect, maxBytesForRead, selectedLineLimit } = window;
	if (materialized?.windowLines) {
		return collectWindowFromLines(
			materialized.windowLines,
			startLine,
			maxLinesToCollect,
			maxBytesForRead,
			selectedLineLimit,
		);
	}
	return streamLinesFromFile(
		absolutePath,
		startLine,
		maxLinesToCollect,
		maxBytesForRead,
		selectedLineLimit,
		undefined, // plain-file read: deterministic and fast, never abort mid-read
		fileSize > SNAPSHOT_MAX_BYTES, // giant file: don't scan to EOF just for an exact line count
	);
}

/**
 * The truncation record of a collected window. Its totals count the selection from `startLine` to
 * the end of the file; `content` is the displayed text, which column clipping may have shortened.
 */
export function windowTruncation(
	window: CollectedWindow,
	startLine: number,
	content: string,
	maxBytes: number,
): TruncationResult {
	const totalLines = window.totalFileLines - startLine;
	const truncated = window.lines.length < totalLines || window.stoppedByByteLimit;
	return {
		content,
		truncated,
		truncatedBy: window.stoppedByByteLimit ? "bytes" : truncated ? "lines" : undefined,
		totalLines,
		totalBytes: window.collectedBytes,
		outputLines: window.lines.length,
		outputBytes: window.collectedBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: window.firstLineByteLength !== undefined && window.firstLineByteLength > maxBytes,
	};
}

/** The footer of a range read that stopped at its line limit, `shownEnd` lines into the file. */
export function formatMoreLinesFooter(
	shownEnd: number,
	totalFileLines: number,
	reachedEof: boolean,
	fileSize: number,
): string {
	const nextOffset = shownEnd + 1;
	return reachedEof
		? `\n\n[${formatMoreLines(totalFileLines - shownEnd)} in file. Use :${nextOffset} to continue]`
		: `\n\n[More lines in file (${formatBytes(fileSize)} total; not scanned to EOF). Use :${nextOffset} to continue]`;
}
