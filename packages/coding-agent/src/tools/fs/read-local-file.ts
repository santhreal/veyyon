/**
 * Reads of a plain-text file on disk: the binary check, the structural summary, and the single-
 * range and multi-range windows.
 */

import type { AgentToolResult } from "@veyyon/agent-core";
import type { ImageContent, TextContent } from "@veyyon/ai";
import { isProbablyBinary } from "@veyyon/utils/binary";
import {
	canonicalSnapshotKey,
	contiguousLineNumbers,
	getFileSnapshotStore,
	recordFileSnapshot,
	recordSeenLinesFromBody,
	SNAPSHOT_MAX_BYTES,
} from "../../edit/file-snapshot-store";
import { normalizeToLF } from "../../edit/normalize";
import type { ToolSession } from "../../sdk";
import { DEFAULT_MAX_LINES, type TruncationResult, truncationSummary } from "../../session/streaming-output";
import { buildLineEntriesWithBlockContext } from "../../utils/block-context";
import { type FileDisplayMode, resolveFileDisplayMode } from "../../utils/file-display-mode";
import { resolveOutputMaxColumns, type TruncationOptions } from "../core/output-meta";
import { formatPathRelativeToCwd, isRawSelector, type LineRange, type ParsedSelector } from "../core/path-utils";
import { formatBytes } from "../core/render-utils";
import { toolResult } from "../core/tool-result";
import { windowConflictWarning } from "./read-conflicts";
import type { ReadDisplayContent } from "./read-display";
import { isMultiRange, selToOffsetLimit, tryBridgeRead } from "./read-in-memory";
import {
	ColumnClip,
	entriesDisplay,
	formatLineEntriesWithMode,
	formatReadHashlineHeader,
	formatTextWithMode,
	type HashlineHeaderContext,
	hashlineHeaderContext,
	lineNumbersFromSpans,
	oversizedFirstLineText,
	SelectionFormatter,
} from "./read-lines";
import { prependSuffixResolutionNotice, type ResolvedReadPath } from "./read-paths";
import { renderFileSummary } from "./read-summary";
import type { ReadContext, ReadToolDetails } from "./read-types";
import {
	collectFileWindow,
	collectWindowFromLines,
	computeRangeWindow,
	formatContextPaddingNotice,
	formatMoreLinesFooter,
	formatOutOfBoundsMessage,
	materializeFile,
	readWindowMaxBytes,
	streamLinesFromFile,
	windowTruncation,
} from "./read-window";

/** A local file read's content, before the suffix-resolution notice and the result are assembled. */
type LocalReadContent = {
	readonly content: Array<TextContent | ImageContent>;
	readonly details: ReadToolDetails;
	readonly sourcePath?: string;
	readonly columnTruncated: number;
	readonly truncation?: { readonly result: TruncationResult; readonly options: TruncationOptions };
};

/** What reading a resolved local file came to: a finished result, or content still to assemble. */
export type LocalReadOutcome =
	| { readonly kind: "result"; readonly result: AgentToolResult<ReadToolDetails> }
	| { readonly kind: "content"; readonly read: LocalReadContent };

/** Assemble a local file read's result, leading its first text block with the suffix-resolution notice. */
export function finishLocalRead(
	read: LocalReadContent,
	suffixResolution: { from: string; to: string } | undefined,
): AgentToolResult<ReadToolDetails> {
	let { content } = read;
	const { details } = read;
	if (suffixResolution) {
		details.suffixResolution = suffixResolution;
		// Inline resolution notice into first text block so the model sees the actual path
		const notice = `[Path '${suffixResolution.from}' not found; resolved to '${suffixResolution.to}' via suffix match]`;
		const firstText = content.find((c): c is TextContent => c.type === "text");
		if (firstText) {
			firstText.text = `${notice}\n${firstText.text}`;
		} else {
			content = [{ type: "text", text: notice }, ...content];
		}
	}
	const resultBuilder = toolResult(details).content(content);
	if (read.sourcePath) resultBuilder.sourcePath(read.sourcePath);
	if (read.truncation) resultBuilder.truncation(read.truncation.result, read.truncation.options);
	if (read.columnTruncated > 0) resultBuilder.limits({ columnMax: read.columnTruncated });
	return resultBuilder.done();
}

/**
 * Stream multiple non-contiguous ranges from a local file. ACP bridge takes
 * priority when present (editor buffer is source of truth); otherwise each
 * range is streamed independently with its own line/byte budget. Out-of-bounds
 * ranges surface as inline notices rather than aborting the read.
 */
export async function readLocalFileMultiRange(
	ctx: ReadContext,
	absolutePath: string,
	ranges: readonly LineRange[],
	fileSize: number,
	parsed: ParsedSelector,
	displayMode: { hashLines: boolean; lineNumbers: boolean },
	suffixResolution: { from: string; to: string } | undefined,
	signal: AbortSignal | undefined,
	allowBridge = true,
): Promise<{
	outputText: string;
	columnTruncated: number;
	displayContent?: ReadDisplayContent;
	bridgeResult?: AgentToolResult<ReadToolDetails>;
}> {
	const rawSelector = isRawSelector(parsed);

	if (allowBridge) {
		const bridgeResult = await tryBridgeRead(ctx.session, absolutePath, parsed, suffixResolution);
		if (bridgeResult) return { outputText: "", columnTruncated: 0, bridgeResult };
	}

	const shouldAddHashLines = !rawSelector && displayMode.hashLines;
	const shouldAddLineNumbers = rawSelector ? false : shouldAddHashLines ? false : displayMode.lineNumbers;
	const maxColumns = resolveOutputMaxColumns(ctx.session.settings);

	const blocks: string[] = [];
	const notices: string[] = [];
	const visibleSpans: Array<{ startLine: number; endLine: number }> = [];
	const materialized = rawSelector ? undefined : await materializeFile(absolutePath, fileSize);
	const fullLines = materialized?.lines;
	const clip = new ColumnClip(maxColumns);
	let displayContent: ReadDisplayContent | undefined;

	for (const range of ranges) {
		const rangeStart = range.startLine - 1; // 0-indexed
		const requestedLength = range.endLine !== undefined ? range.endLine - range.startLine + 1 : undefined;
		const maxLines = Math.min(requestedLength ?? ctx.defaultLimit, DEFAULT_MAX_LINES);
		const maxBytesForRead = readWindowMaxBytes(ctx.session, requestedLength, maxLines);

		// When the full file is already in memory (the common case for files
		// within the snapshot byte cap), take ranges from it instead of
		// re-streaming the file once per range. The window is collected rather
		// than sliced so an open-ended range is priced the same however the
		// lines were obtained.
		let collectedLines: string[];
		let totalFileLines: number;
		let stoppedByByteLimit: boolean;
		let firstLineByteLength: number | undefined;
		if (fullLines) {
			const window = collectWindowFromLines(fullLines, rangeStart, maxLines, maxBytesForRead, maxLines);
			totalFileLines = window.totalFileLines;
			collectedLines = window.lines;
			stoppedByByteLimit = window.stoppedByByteLimit;
			firstLineByteLength = window.firstLineByteLength;
		} else {
			const streamResult = await streamLinesFromFile(
				absolutePath,
				rangeStart,
				maxLines,
				maxBytesForRead,
				maxLines,
				signal,
				fileSize > SNAPSHOT_MAX_BYTES, // giant file: collected ranges don't need an exact EOF line count
			);
			totalFileLines = streamResult.totalFileLines;
			collectedLines = streamResult.lines;
			stoppedByByteLimit = streamResult.stoppedByByteLimit;
			firstLineByteLength = streamResult.firstLineByteLength;
		}

		if (rangeStart >= totalFileLines) {
			const bound = range.endLine !== undefined ? `${range.startLine}-${range.endLine}` : `${range.startLine}`;
			notices.push(`[Range ${bound} is beyond end of file (${totalFileLines} lines total); skipped]`);
			continue;
		}

		if (stoppedByByteLimit) {
			// Zero lines collected means the range's own first line is over the
			// budget, so `${startLine}-${startLine - 1}` would be a backwards range
			// and the continuation selector would point back at the line that just
			// failed. Name the line instead.
			if (collectedLines.length === 0) {
				const size = firstLineByteLength === undefined ? "" : `${formatBytes(firstLineByteLength)}, `;
				notices.push(
					`[Line ${range.startLine} is ${size}over the ${formatBytes(maxBytesForRead)} output budget; nothing shown for this range]`,
				);
			} else {
				const shown = range.startLine + collectedLines.length - 1;
				notices.push(
					`[Lines ${range.startLine}-${shown} reached the ${formatBytes(maxBytesForRead)} output budget. Use :${shown + 1} to continue]`,
				);
			}
		}

		// Column truncation is display-only; the on-disk lines stay intact for display reconstruction.
		const displayLines = rawSelector ? collectedLines : clip.clip(collectedLines, range.startLine);
		if (displayLines.length > 0) {
			const endLine = range.startLine + displayLines.length - 1;
			visibleSpans.push({ startLine: range.startLine, endLine });
			clip.display(displayLines, range.startLine);
			if (!fullLines || rawSelector) {
				const blockText = displayLines.join("\n");
				blocks.push(formatTextWithMode(blockText, range.startLine, shouldAddHashLines, shouldAddLineNumbers));
			}
		}
	}

	let outputText: string;
	if (!rawSelector && fullLines && visibleSpans.length > 0) {
		const entries = buildLineEntriesWithBlockContext(
			fullLines,
			visibleSpans,
			{ path: absolutePath, text: materialized?.text },
			{ lineText: clip.lineText },
		);
		displayContent = entriesDisplay(entries, visibleSpans[0]?.startLine ?? 1);
		outputText = formatLineEntriesWithMode(entries, shouldAddHashLines, shouldAddLineNumbers);
	} else {
		outputText = blocks.join("\n\n…\n\n");
	}
	if (shouldAddHashLines && outputText) {
		const tag = await recordFileSnapshot(ctx.session, absolutePath, undefined, materialized?.text);
		if (tag) {
			recordSeenLinesFromBody(ctx.session, absolutePath, tag, outputText, clip.clippedLines);
			outputText = `${formatReadHashlineHeader(formatPathRelativeToCwd(absolutePath, ctx.session.cwd), tag)}\n${outputText}`;
		}
	} else if (rawSelector && visibleSpans.length > 0) {
		const rawSeenLines = lineNumbersFromSpans(visibleSpans);
		if (rawSeenLines.length > 0) await recordFileSnapshot(ctx.session, absolutePath, rawSeenLines);
	}
	if (notices.length > 0) {
		outputText = outputText ? `${outputText}\n${notices.join("\n")}` : notices.join("\n");
	}
	return { outputText, columnTruncated: clip.columnTruncated, displayContent };
}

/** Read a file meant to be plain text: its summary, its line ranges, or its head. */
export async function readTextFile(
	ctx: ReadContext,
	resolved: ResolvedReadPath,
	localReadPath: string,
	ext: string,
	parsed: ParsedSelector,
	signal: AbortSignal | undefined,
): Promise<LocalReadOutcome> {
	const { absolutePath, suffixResolution } = resolved;
	const fileSize = resolved.stat.size;
	// Binary sniff before any UTF-8 text materialization. A binary file
	// (font, object, archive, packed blob) decodes to NUL/control bytes and
	// U+FFFD mojibake that corrupts the terminal and burns context. Images,
	// notebooks, and markit-convertible documents were already routed away;
	// everything reaching here is meant to be plain text. `:raw` stays the
	// explicit escape hatch for reading bytes verbatim. This single guard
	// covers both the multi-range and single-range disk paths below.
	if (!isRawSelector(parsed) && (await isProbablyBinary(absolutePath))) {
		const result = toolResult<ReadToolDetails>({
			resolvedPath: absolutePath,
			suffixResolution,
			contentUnavailable: { reason: "binary" },
		})
			.text(
				prependSuffixResolutionNotice(
					`[Cannot read binary file '${formatPathRelativeToCwd(absolutePath, ctx.session.cwd)}' (${formatBytes(fileSize)}); not valid UTF-8 text. Use ':raw' to read bytes verbatim.]`,
					suffixResolution,
				),
			)
			.sourcePath(absolutePath)
			.done();
		return { kind: "result", result };
	}

	const displayMode = resolveFileDisplayMode(ctx.session);
	const fileSummary = await renderFileSummary(ctx, {
		absolutePath,
		localReadPath,
		ext,
		fileSize,
		parsed,
		hashLines: displayMode.hashLines,
		signal,
	});
	if (fileSummary) {
		return {
			kind: "content",
			read: {
				content: fileSummary.content,
				details: fileSummary.details,
				sourcePath: absolutePath,
				columnTruncated: fileSummary.columnTruncated,
			},
		};
	}

	if (isMultiRange(parsed) && parsed.kind === "lines") {
		const multiResult = await readLocalFileMultiRange(
			ctx,
			absolutePath,
			parsed.ranges,
			fileSize,
			parsed,
			displayMode,
			suffixResolution,
			undefined, // plain-file read: deterministic and fast, never abort mid-read
		);
		if (multiResult.bridgeResult) return { kind: "result", result: multiResult.bridgeResult };
		return {
			kind: "content",
			read: {
				content: [{ type: "text", text: multiResult.outputText }],
				details: multiResult.displayContent ? { displayContent: multiResult.displayContent } : {},
				sourcePath: absolutePath,
				columnTruncated: multiResult.columnTruncated,
			},
		};
	}
	return readLocalFileRange(ctx, absolutePath, fileSize, parsed, displayMode, suffixResolution);
}

/** Read one line range of a text file, or its head when the selector names no range. */
async function readLocalFileRange(
	ctx: ReadContext,
	absolutePath: string,
	fileSize: number,
	parsed: ParsedSelector,
	displayMode: FileDisplayMode,
	suffixResolution: { from: string; to: string } | undefined,
): Promise<LocalReadOutcome> {
	const { offset, limit } = selToOffsetLimit(parsed);
	const bridgeResult = await tryBridgeRead(ctx.session, absolutePath, parsed, suffixResolution);
	if (bridgeResult) return { kind: "result", result: bridgeResult };

	const rawSelector = isRawSelector(parsed);
	const window = computeRangeWindow(offset, limit, rawSelector, ctx.defaultLimit, ctx.session);
	const { requestedStart, startLine, startLineDisplay, maxBytesForRead } = window;
	// One materialization, three consumers: this window, the bracket context below, and
	// the snapshot tag. A file over the snapshot cap, or one whose raw bytes and
	// normalized text split differently, still streams -- see materializeFile.
	const materialized = rawSelector ? undefined : await materializeFile(absolutePath, fileSize);
	const collected = await collectFileWindow(absolutePath, fileSize, window, materialized);
	const { lines: collectedLines, totalFileLines, reachedEof } = collected;

	// Check if offset is out of bounds - return graceful message instead of throwing
	if (requestedStart >= totalFileLines) {
		const result = toolResult<ReadToolDetails>({ resolvedPath: absolutePath, suffixResolution })
			.text(formatOutOfBoundsMessage(requestedStart, totalFileLines, "file"))
			.done();
		return { kind: "result", result };
	}

	// Per-line column cap. Skipped in raw mode so `:raw` always returns
	// verbatim bytes for paste-back-into-tool workflows. Total byte/line
	// counts in `truncation` keep reflecting the source, not the trimmed
	// view — column truncation surfaces separately via `.limits()`.
	// Column truncation is display-only. `collectedLines` MUST stay
	// byte-for-byte with the on-disk content so the snapshot recorded
	// below can be verified against the live file. Mutating it with
	// ellipsis-truncated text made every long-line file uneditable on
	// the next edit attempt.
	const clip = new ColumnClip(resolveOutputMaxColumns(ctx.session.settings));
	const displayLines = rawSelector ? collectedLines : clip.clip(collectedLines, startLineDisplay);
	clip.display(displayLines, startLineDisplay);
	const displayedEndLine = startLineDisplay + Math.max(0, displayLines.length - 1);
	const truncation = windowTruncation(collected, startLine, displayLines.join("\n"), maxBytesForRead);
	const firstLineExceedsLimit = truncation.firstLineExceedsLimit === true;

	const hashLines = !rawSelector && displayMode.hashLines;
	const lineNumbers = !rawSelector && !hashLines && displayMode.lineNumbers;
	const hashContext =
		hashLines && collectedLines.length > 0 && !firstLineExceedsLimit
			? await selectionHashContext(
					ctx.session,
					absolutePath,
					collectedLines,
					offset === undefined && limit === undefined && !truncation.truncated,
					materialized?.text,
				)
			: undefined;
	const formatter = new SelectionFormatter(hashLines, lineNumbers, hashContext);

	let outputText: string;
	if (firstLineExceedsLimit) {
		outputText = oversizedFirstLineText(
			startLineDisplay,
			collected.firstLineByteLength ?? 0,
			maxBytesForRead,
			collected.firstLinePreview?.text ?? "",
			hashLines,
			(text, startNum) => formatter.text(text, startNum),
		);
	} else {
		const entries =
			materialized &&
			buildLineEntriesWithBlockContext(
				materialized.lines,
				[{ startLine: startLineDisplay, endLine: displayedEndLine }],
				{ path: absolutePath, text: materialized.text },
				{ lineText: clip.lineText },
			);
		outputText = entries
			? formatter.entries(entries, startLineDisplay)
			: formatter.text(truncation.content, startLineDisplay);
		const shownEnd = startLine + collectedLines.length;
		if (!truncation.truncated && (shownEnd < totalFileLines || !reachedEof)) {
			outputText += formatMoreLinesFooter(shownEnd, totalFileLines, reachedEof, fileSize);
		}
	}

	const truncated = firstLineExceedsLimit || truncation.truncated;
	const details: ReadToolDetails = truncated ? { truncation: truncationSummary(truncation) } : {};
	const paddingNotice = formatContextPaddingNotice({
		requestedFirstLine: requestedStart + 1,
		requestedLastLine: limit !== undefined ? requestedStart + limit : undefined,
		displayedFirstLine: startLineDisplay,
		displayedLastLine: displayedEndLine,
	});
	if (paddingNotice) outputText += `\n\n${paddingNotice}`;

	if (hashContext?.tag) {
		recordSeenLinesFromBody(ctx.session, absolutePath, hashContext.tag, outputText, clip.clippedLines);
	}
	if (rawSelector && !firstLineExceedsLimit && collectedLines.length > 0) {
		await recordFileSnapshot(
			ctx.session,
			absolutePath,
			contiguousLineNumbers(startLineDisplay, collectedLines.length),
		);
	}
	if (formatter.displayContent) {
		details.displayContent = formatter.displayContent;
	}
	if (!firstLineExceedsLimit) {
		const conflicts = await windowConflictWarning(ctx.session, absolutePath, collectedLines, startLineDisplay);
		if (conflicts) {
			outputText += conflicts.text;
			details.conflictCount = conflicts.count;
		}
	}

	return {
		kind: "content",
		read: {
			content: [{ type: "text", text: outputText }],
			details,
			sourcePath: absolutePath,
			columnTruncated: clip.columnTruncated,
			truncation: truncated
				? {
						result: truncation,
						options: {
							direction: "head",
							startLine: startLineDisplay,
							totalFileLines: reachedEof ? totalFileLines : undefined,
							totalLinesUnknown: !reachedEof,
						},
					}
				: undefined,
		},
	};
}

/**
 * The hashline header for a displayed selection. The tag is a content hash of the WHOLE file:
 * a whole-file read already holds every line in memory, and a range read re-reads the file
 * (bounded by SNAPSHOT_MAX_BYTES) so the tag fingerprints the full file and any anchor
 * validates while the file is unchanged.
 */
async function selectionHashContext(
	session: ToolSession,
	absolutePath: string,
	collectedLines: readonly string[],
	isWholeFile: boolean,
	materializedText: string | undefined,
): Promise<HashlineHeaderContext | undefined> {
	const tag = isWholeFile
		? getFileSnapshotStore(session).record(
				canonicalSnapshotKey(absolutePath),
				normalizeToLF(collectedLines.join("\n")),
			)
		: await recordFileSnapshot(session, absolutePath, undefined, materializedText);
	return tag ? hashlineHeaderContext(formatPathRelativeToCwd(absolutePath, session.cwd), tag) : undefined;
}
