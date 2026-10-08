/**
 * Line selectors applied to text already in memory: a converted document, an archive member, a URL
 * body, an internal resource, or an editor buffer read through the client bridge.
 */

import type { AgentToolResult } from "@veyyon/agent-core";
import type { TextContent } from "@veyyon/ai";
import { formatMoreLines } from "@veyyon/utils/format";
import * as logger from "@veyyon/utils/logger";
import { contiguousLineNumbers, recordSeenLines } from "../../edit/file-snapshot-store";
import type { ToolSession } from "../../sdk";
import {
	DEFAULT_MAX_LINES,
	noTruncResult,
	type TruncationResult,
	truncateHead,
	truncateHeadBytes,
	truncationSummary,
} from "../../session/streaming-output";
import { buildLineEntriesWithBlockContext, type LineEntry } from "../../utils/block-context";
import { resolveFileDisplayMode } from "../../utils/file-display-mode";
import { inlineBudgetFor } from "../core/output-artifact";
import type { TruncationOptions } from "../core/output-meta";
import { isRawSelector, type LineRange, type ParsedSelector } from "../core/path-utils";
import { toolResult } from "../core/tool-result";
import {
	countTextLines,
	entriesDisplay,
	formatLineEntriesWithMode,
	formatTextWithMode,
	lineNumbersFromEntries,
	lineNumbersFromSpans,
	oversizedFirstLineText,
	prependHashlineHeader,
	recordFullHashlineContext,
	recordInMemorySeenLines,
} from "./read-lines";
import type { ReadToolDetails } from "./read-types";
import { expandRangeWithContext, formatContextPaddingNotice, formatOutOfBoundsMessage } from "./read-window";

/** Returns true when the selector requested multiple line ranges. */
export function isMultiRange(parsed: ParsedSelector): boolean {
	return parsed.kind === "lines" && parsed.ranges.length > 1;
}

/**
 * Convert a single-range selector to the offset/limit pair used by internal pagination.
 * Returns the FIRST range only — multi-range callers MUST branch on `isMultiRange` before
 * calling this helper.
 */
export function selToOffsetLimit(parsed: ParsedSelector): { offset?: number; limit?: number } {
	if (parsed.kind === "lines") {
		const first = parsed.ranges[0];
		const limit = first.endLine !== undefined ? first.endLine - first.startLine + 1 : undefined;
		return { offset: first.startLine, limit };
	}
	return {};
}

export function buildInMemoryTextResult(
	session: ToolSession,
	text: string,
	offset: number | undefined,
	limit: number | undefined,
	options: {
		details?: ReadToolDetails;
		sourcePath?: string;
		sourceUrl?: string;
		sourceInternal?: string;
		entityLabel: string;
		ignoreResultLimits?: boolean;
		raw?: boolean;
		immutable?: boolean;
	},
): AgentToolResult<ReadToolDetails> {
	const displayMode = resolveFileDisplayMode(session, {
		raw: options.raw,
		immutable: options.immutable,
		ranged: offset !== undefined || limit !== undefined,
	});
	const details = options.details ?? {};
	const allLines = text.split("\n");
	const totalLines = allLines.length;
	// User-requested 0-indexed range start. Lines BEFORE this are leading
	// context (added below if offset is explicit).
	const requestedStart = offset ? Math.max(0, offset - 1) : 0;
	const ignoreResultLimits = options.ignoreResultLimits ?? false;
	const requestedEnd = limit !== undefined ? Math.min(requestedStart + limit, allLines.length) : allLines.length;
	// Expand only on sides the user actually constrained: leading context
	// when offset>1, trailing context when a finite limit was set. Raw mode
	// never expands — without line numbers the padding is indistinguishable
	// from requested content, so `raw:31-31` must return line 31 and nothing
	// else (verbatim-extraction contract).
	const rawDisplay = options.raw === true;
	const expanded = expandRangeWithContext(
		requestedStart,
		requestedEnd,
		allLines.length,
		!rawDisplay && offset !== undefined && offset > 1,
		!rawDisplay && limit !== undefined,
	);
	const startLine = expanded.startLine;
	const endLineExpanded = expanded.endLine;
	const startLineDisplay = startLine + 1;

	const resultBuilder = toolResult(details);
	if (options.sourcePath) {
		resultBuilder.sourcePath(options.sourcePath);
	}
	if (options.sourceUrl) {
		resultBuilder.sourceUrl(options.sourceUrl);
	}
	if (options.sourceInternal) {
		resultBuilder.sourceInternal(options.sourceInternal);
	}

	if (requestedStart >= allLines.length) {
		return resultBuilder.text(formatOutOfBoundsMessage(requestedStart, allLines.length, options.entityLabel)).done();
	}
	const endLine = endLineExpanded;
	const selectedContent = allLines.slice(startLine, endLine).join("\n");
	const userLimitedLines = limit !== undefined ? endLine - startLine : undefined;
	// A notebook, document, archive entry, URL body or internal resource is
	// bounded by the same budget as a file window: the setting that states how
	// many bytes a tool result carries, not a constant it cannot reach.
	const truncation = ignoreResultLimits
		? noTruncResult(selectedContent)
		: truncateHead(selectedContent, { maxBytes: inlineBudgetFor(session), maxLines: DEFAULT_MAX_LINES });

	const shouldAddHashLines = displayMode.hashLines;
	const shouldAddLineNumbers = shouldAddHashLines ? false : displayMode.lineNumbers;
	const hashContext = recordFullHashlineContext(session, shouldAddHashLines, options.sourcePath, text);
	let emittedHashlineHeader = false;
	let seenLines: number[] | undefined;
	let rawSeenLines: number[] | undefined;
	const formatText = (content: string, startNum: number): string => {
		details.displayContent = { text: content, startLine: startNum };
		if (shouldAddHashLines) seenLines = contiguousLineNumbers(startNum, countTextLines(content));
		const formatted = formatTextWithMode(content, startNum, shouldAddHashLines, shouldAddLineNumbers);
		if (!hashContext || emittedHashlineHeader) return formatted;
		emittedHashlineHeader = true;
		return prependHashlineHeader(formatted, hashContext);
	};
	const formatLineEntries = (entries: readonly LineEntry[], startNum: number): string => {
		details.displayContent = entriesDisplay(entries, startNum);
		if (shouldAddHashLines) seenLines = lineNumbersFromEntries(entries);
		const formatted = formatLineEntriesWithMode(entries, shouldAddHashLines, shouldAddLineNumbers);
		if (!hashContext || emittedHashlineHeader) return formatted;
		emittedHashlineHeader = true;
		return prependHashlineHeader(formatted, hashContext);
	};
	const buildLineEntries = (endLineDisplay: number): LineEntry[] =>
		buildLineEntriesWithBlockContext(allLines, [{ startLine: startLineDisplay, endLine: endLineDisplay }], {
			path: options.sourcePath,
		});

	let outputText: string;
	let truncationInfo: { result: TruncationResult; options: TruncationOptions } | undefined;

	if (truncation.firstLineExceedsLimit) {
		const firstLine = allLines[startLine] ?? "";
		const firstLineBytes = Buffer.byteLength(firstLine, "utf-8");
		const budget = inlineBudgetFor(session);
		const snippet = truncateHeadBytes(firstLine, budget);

		outputText = oversizedFirstLineText(
			startLineDisplay,
			firstLineBytes,
			budget,
			snippet.text,
			shouldAddHashLines,
			formatText,
		);

		details.truncation = truncationSummary(truncation);
		truncationInfo = {
			result: truncation,
			options: { direction: "head", startLine: startLineDisplay, totalFileLines: totalLines },
		};
	} else if (truncation.truncated) {
		const outputLines = truncation.outputLines ?? countTextLines(truncation.content);
		const endLineDisplay = startLineDisplay + Math.max(0, outputLines - 1);
		if (options.raw === true) {
			rawSeenLines = contiguousLineNumbers(startLineDisplay, outputLines);
			outputText = formatText(truncation.content, startLineDisplay);
		} else {
			outputText = formatLineEntries(buildLineEntries(endLineDisplay), startLineDisplay);
		}
		details.truncation = truncationSummary(truncation);
		truncationInfo = {
			result: truncation,
			options: { direction: "head", startLine: startLineDisplay, totalFileLines: totalLines },
		};
	} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
		const remaining = allLines.length - (startLine + userLimitedLines);
		const nextOffset = startLine + userLimitedLines + 1;

		if (options.raw === true) {
			rawSeenLines = contiguousLineNumbers(startLineDisplay, userLimitedLines);
			outputText = formatText(selectedContent, startLineDisplay);
		} else {
			outputText = formatLineEntries(buildLineEntries(endLine), startLineDisplay);
		}
		outputText += `\n\n[${formatMoreLines(remaining)} in ${options.entityLabel}. Use :${nextOffset} to continue]`;
	} else {
		if (options.raw === true) {
			rawSeenLines = contiguousLineNumbers(startLineDisplay, endLine - startLine);
			outputText = formatText(truncation.content, startLineDisplay);
		} else {
			outputText = formatLineEntries(buildLineEntries(endLine), startLineDisplay);
		}
	}

	// Self-disclose the padding, once, after whichever branch built the body.
	const displayedLastLine = Math.min(endLine, startLineDisplay + Math.max(0, countTextLines(truncation.content) - 1));
	const paddingNotice = formatContextPaddingNotice({
		requestedFirstLine: requestedStart + 1,
		requestedLastLine: limit !== undefined ? requestedEnd : undefined,
		displayedFirstLine: startLineDisplay,
		displayedLastLine,
	});
	if (paddingNotice) outputText += `\n\n${paddingNotice}`;

	if (hashContext?.tag && options.sourcePath && seenLines) {
		recordSeenLines(session, options.sourcePath, hashContext.tag, seenLines);
	}
	if (options.raw === true && options.sourcePath && options.immutable !== true && rawSeenLines) {
		recordInMemorySeenLines(session, options.sourcePath, text, rawSeenLines);
	}
	resultBuilder.text(outputText);
	if (truncationInfo) {
		resultBuilder.truncation(truncationInfo.result, truncationInfo.options);
	}
	return resultBuilder.done();
}

/**
 * Render a multi-range read against in-memory text. Each range emits a
 * formatted block with its own anchors / line numbers, blocks are joined
 * with an elision separator, and ranges past EOF surface as `[…]` notices
 * so the model can correct the next call. No leading/trailing context is
 * added — multi-range callers always specify exact bounds.
 */
export function buildInMemoryMultiRangeResult(
	session: ToolSession,
	text: string,
	ranges: readonly LineRange[],
	options: {
		details?: ReadToolDetails;
		sourcePath?: string;
		sourceUrl?: string;
		sourceInternal?: string;
		entityLabel: string;
		raw?: boolean;
		immutable?: boolean;
	},
): AgentToolResult<ReadToolDetails> {
	const displayMode = resolveFileDisplayMode(session, {
		raw: options.raw,
		immutable: options.immutable,
		ranged: true,
	});
	const details = options.details ?? {};
	const allLines = text.split("\n");
	const totalLines = allLines.length;
	const shouldAddHashLines = displayMode.hashLines;
	const shouldAddLineNumbers = shouldAddHashLines ? false : displayMode.lineNumbers;
	const hashContext = recordFullHashlineContext(session, shouldAddHashLines, options.sourcePath, text);
	let emittedHashlineHeader = false;

	let seenLines: number[] | undefined;
	const resultBuilder = toolResult(details);
	if (options.sourcePath) resultBuilder.sourcePath(options.sourcePath);
	if (options.sourceUrl) resultBuilder.sourceUrl(options.sourceUrl);
	if (options.sourceInternal) resultBuilder.sourceInternal(options.sourceInternal);

	const outOfBounds: LineRange[] = [];
	const visibleSpans: Array<{ startLine: number; endLine: number }> = [];
	const rawParts: string[] = [];
	for (const range of ranges) {
		if (range.startLine > totalLines) {
			outOfBounds.push(range);
			continue;
		}
		const effectiveEnd = Math.min(range.endLine ?? totalLines, totalLines);
		visibleSpans.push({ startLine: range.startLine, endLine: effectiveEnd });
		if (options.raw === true) {
			rawParts.push(allLines.slice(range.startLine - 1, effectiveEnd).join("\n"));
		}
	}

	let outputText = "";
	if (options.raw === true) {
		outputText = rawParts.length > 0 ? rawParts.join("\n\n…\n\n") : "";
	} else if (visibleSpans.length > 0) {
		const entries = buildLineEntriesWithBlockContext(allLines, visibleSpans, { path: options.sourcePath });
		if (shouldAddHashLines) seenLines = lineNumbersFromEntries(entries);
		if (entries.some(entry => entry.kind === "line")) {
			details.displayContent = entriesDisplay(entries, 1);
		}
		const formatted = formatLineEntriesWithMode(entries, shouldAddHashLines, shouldAddLineNumbers);
		outputText = hashContext && !emittedHashlineHeader ? prependHashlineHeader(formatted, hashContext) : formatted;
		if (hashContext) emittedHashlineHeader = true;
	}
	const notices: string[] = [];
	for (const range of outOfBounds) {
		const bound = range.endLine !== undefined ? `${range.startLine}-${range.endLine}` : `${range.startLine}`;
		notices.push(`[Range ${bound} is beyond end of ${options.entityLabel} (${totalLines} lines total); skipped]`);
	}
	const finalText =
		notices.length > 0 ? (outputText ? `${outputText}\n${notices.join("\n")}` : notices.join("\n")) : outputText;
	if (hashContext?.tag && options.sourcePath && seenLines) {
		recordSeenLines(session, options.sourcePath, hashContext.tag, seenLines);
	}
	if (options.raw === true && options.sourcePath && options.immutable !== true && visibleSpans.length > 0) {
		recordInMemorySeenLines(session, options.sourcePath, text, lineNumbersFromSpans(visibleSpans));
	}
	resultBuilder.text(finalText);
	return resultBuilder.done();
}

export function buildInMemoryResult(
	session: ToolSession,
	text: string,
	parsed: ParsedSelector,
	options: {
		details?: ReadToolDetails;
		sourcePath?: string;
		sourceUrl?: string;
		sourceInternal?: string;
		entityLabel: string;
		ignoreResultLimits?: boolean;
		raw?: boolean;
		immutable?: boolean;
	},
): AgentToolResult<ReadToolDetails> {
	if (isMultiRange(parsed) && parsed.kind === "lines") {
		return buildInMemoryMultiRangeResult(session, text, parsed.ranges, options);
	}
	const { offset, limit } = selToOffsetLimit(parsed);
	return buildInMemoryTextResult(session, text, offset, limit, {
		...options,
		raw: options.raw ?? isRawSelector(parsed),
	});
}

export async function tryBridgeRead(
	session: ToolSession,
	absolutePath: string,
	parsed: ParsedSelector,
	suffixResolution: { from: string; to: string } | undefined,
): Promise<AgentToolResult<ReadToolDetails> | null> {
	const bridgePromise = routeReadThroughBridge(session, absolutePath);
	if (bridgePromise === undefined) return null;
	try {
		const bridgeText = await bridgePromise;
		const bridgeResult = buildInMemoryResult(session, bridgeText, parsed, {
			details: { resolvedPath: absolutePath, suffixResolution },
			sourcePath: absolutePath,
			entityLabel: "file",
		});
		if (suffixResolution) {
			const notice = `[Path '${suffixResolution.from}' not found; resolved to '${suffixResolution.to}' via suffix match]`;
			const firstText = bridgeResult.content.find((c): c is TextContent => c.type === "text");
			if (firstText) firstText.text = `${notice}\n${firstText.text}`;
		}
		return bridgeResult;
	} catch (error) {
		logger.warn("ACP fs readTextFile failed; falling back to disk", { path: absolutePath, error });
		return null;
	}
}

export function routeReadThroughBridge(
	session: ToolSession,
	absolutePath: string,
	options?: { line?: number; limit?: number },
): Promise<string> | undefined {
	const bridge = session.getClientBridge?.();
	if (!bridge?.capabilities.readTextFile || !bridge.readTextFile) return undefined;
	return bridge.readTextFile({ path: absolutePath, ...options });
}
