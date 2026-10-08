/**
 * Structural summaries of a whole-file read: the tree-sitter parse, its per-session memo, the
 * rendering of kept and elided spans, and the footer that states how to re-read an elided range.
 */

import type { ImageContent, TextContent } from "@veyyon/ai";
import { type SummaryResult, summarizeCode } from "@veyyon/natives";
import { isAbortError, isCancellation, isTimeoutError } from "@veyyon/utils/abortable";
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import { LRUCache } from "lru-cache/raw";
import { recordSeenLinesFromBody } from "../../edit/file-snapshot-store";
import type { ToolSession } from "../../sdk";
import { truncateLine } from "../../session/streaming-output";
import { resolveFileDisplayMode } from "../../utils/file-display-mode";
import { inlineBudgetFor } from "../core/output-artifact";
import { resolveOutputMaxColumns } from "../core/output-meta";
import type { ParsedSelector } from "../core/path-utils";
import { formatBytes } from "../core/render-utils";
import { throwIfAborted } from "../core/tool-errors";
import { routeReadThroughBridge } from "./read-in-memory";
import {
	countTextLines,
	formatSingleLine,
	numberedDisplay,
	prependHashlineHeader,
	readHashlineHeaderContext,
} from "./read-lines";
import type { ReadContext, ReadToolDetails } from "./read-types";

// Per-session memo for tree-sitter summaries. `summarizeCode` is a pure function
// of (code, path, fold settings) but costs ~12-18ms for a ~1500-line file, and a
// repeat summary read of the same unchanged file re-parses from scratch. Key on
// the content hash of the freshly-read bytes (+ path + fold settings): the file
// is still read fresh on every call, so a hit only reuses the deterministic
// parse — there is no staleness window and no stat guard is needed. Bounded LRU,
// aged out with the session via WeakMap.
// Unusable results (not parsed, or nothing elided) are memoized as `false`: the
// full SummaryResult embeds the whole source in kept segments, and the caller
// only ever renders `parsed && elided` summaries — caching the segments would
// retain up to 48 near-2MiB sources just to remember "no summary".
const SUMMARY_CACHE_MAX = 48;
const summaryParseCaches = new WeakMap<object, LRUCache<string, SummaryResult | false>>();
function getSummaryParseCache(session: object): LRUCache<string, SummaryResult | false> {
	let cache = summaryParseCaches.get(session);
	if (!cache) {
		cache = new LRUCache<string, SummaryResult | false>({ max: SUMMARY_CACHE_MAX });
		summaryParseCaches.set(session, cache);
	}
	return cache;
}

const MAX_SUMMARY_BYTES = 2 * 1024 * 1024;
const MAX_SUMMARY_LINES = 20_000;

/** Extensions summarized only when `read.summarize.prose` is on. */
const PROSE_SUMMARY_EXTENSIONS = new Set([".md", ".txt"]);

const BRACE_PAIRS: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
const BRACE_TAIL_TRAILING_RE = /^[;,)\]}]*$/;

/**
 * Decide whether the kept lines surrounding an elided range collapse to a
 * single brace-pair line in the rendered summary. Returns true when the head
 * line ends with `{` / `(` / `[` and the tail line is the matching closer
 * (optionally followed by terminating punctuation like `;`, `,`, or further
 * closers — e.g. `};`, `})`, `]);`).
 */
function canMergeBracePair(headLine: string, tailLine: string): boolean {
	const head = headLine.trimEnd();
	const tail = tailLine.trim();
	const opener = head.slice(-1);
	const closer = BRACE_PAIRS[opener];
	if (!closer) return false;
	if (!tail.startsWith(closer)) return false;
	return BRACE_TAIL_TRAILING_RE.test(tail.slice(closer.length));
}

function formatMergedBraceLine(
	startLine: number,
	endLine: number,
	headText: string,
	tailText: string,
	shouldAddHashLines: boolean,
	shouldAddLineNumbers: boolean,
): { model: string; display: string } {
	const merged = `${headText.trimEnd()} … ${tailText.trim()}`;
	if (shouldAddHashLines) {
		return { model: `${startLine}-${endLine}:${merged}`, display: merged };
	}
	if (shouldAddLineNumbers) {
		return { model: `${startLine}-${endLine}|${merged}`, display: merged };
	}
	return { model: merged, display: merged };
}

/** Inclusive line range describing one elided span in a structural summary. */
interface ElidedRange {
	start: number;
	end: number;
}

/** Sample ranges shown in the footer to demonstrate the multi-range syntax. */
const FOOTER_RANGE_SAMPLES = 2;

/**
 * Footer appended to summarized reads telling the model how to recover the
 * elided body. Without this hint, agents either ignore the `…`/`{ … }`
 * markers or burn a turn guessing the right selector (see issue #1046). The
 * footer demonstrates the multi-range selector syntax with concrete sample
 * ranges drawn from the actual elision so the model re-reads only what it
 * needs instead of falling back to `:raw` or whole-file reads.
 */
function formatSummaryElisionFooter(
	readPath: string,
	elidedRanges: ReadonlyArray<ElidedRange>,
	elidedLines: number,
): string {
	if (elidedRanges.length === 0) return "";
	const sampleCount = Math.min(elidedRanges.length, FOOTER_RANGE_SAMPLES);
	const selector = elidedRanges
		.slice(0, sampleCount)
		.map(r => `${r.start}-${r.end}`)
		.join(",");
	const example = `${readPath}:${selector}`;
	const tail = elidedRanges.length > sampleCount ? `, e.g. ${example}` : ` with ${example}`;
	return `[…${elidedLines}ln elided; re-read needed ranges${tail}]`;
}

/**
 * Whether a failed summarize attempt is worth reporting, and what to say about it.
 *
 * Summarizing a read is optional: when it fails you get the whole file where you would have got an
 * outline, which is still a correct read, so the failure must not propagate. It used to be swallowed
 * entirely, and a file that could not be parsed then looked like a file with nothing to fold.
 *
 * Cancellation is the one case that stays quiet, because it is not a failure of summarizing: the
 * caller asked for the read to stop, and the read path reports that itself. Returns the message to
 * log, or null when there is nothing to report.
 */
export function summarizeFailureReport(error: unknown): string | null {
	if (isAbortError(error) || isTimeoutError(error) || isCancellation(error)) return null;
	return errorMessage(error);
}

/** A structural summary rendered in place of a file's full text. */
type RenderedFileSummary = {
	readonly details: ReadToolDetails;
	readonly content: Array<TextContent | ImageContent>;
	readonly columnTruncated: number;
};

async function trySummarize(
	session: ToolSession,
	absolutePath: string,
	fileSize: number,
	signal?: AbortSignal,
): Promise<SummaryResult | null> {
	if (fileSize > MAX_SUMMARY_BYTES) return null;

	try {
		throwIfAborted(signal);
		const bridgePromise = routeReadThroughBridge(session, absolutePath);
		const code =
			bridgePromise !== undefined
				? await bridgePromise.catch(() => Bun.file(absolutePath).text())
				: await Bun.file(absolutePath).text();
		throwIfAborted(signal);
		const lineCount = countTextLines(code);
		if (lineCount > MAX_SUMMARY_LINES) return null;
		if (lineCount < session.settings.get("read.summarize.minTotalLines")) return null;

		const minBodyLines = session.settings.get("read.summarize.minBodyLines");
		const minCommentLines = session.settings.get("read.summarize.minCommentLines");
		const unfoldUntilLines = session.settings.get("read.summarize.unfoldUntil");
		const unfoldLimitLines = session.settings.get("read.summarize.unfoldLimit");
		const cache = getSummaryParseCache(session);
		const cacheKey = `${absolutePath}\0${Bun.hash(code)}\0${minBodyLines},${minCommentLines},${unfoldUntilLines},${unfoldLimitLines}`;
		const memoized = cache.get(cacheKey);
		if (memoized !== undefined) return memoized || null;
		const result = summarizeCode({
			code,
			path: absolutePath,
			minBodyLines,
			minCommentLines,
			unfoldUntilLines,
			unfoldLimitLines,
		});
		const usable = result.parsed && result.elided ? result : false;
		cache.set(cacheKey, usable);
		return usable || null;
	} catch (error) {
		const reason = summarizeFailureReport(error);
		if (reason !== null) {
			logger.warn("Read could not be summarized; returning the full file", { path: absolutePath, error: reason });
		}
		return null;
	}
}

/**
 * Render a structural summary, stopping at whichever bound it reaches first:
 * `maxBytes` of model-facing text, or `maxLines` rendered lines. A summary is
 * a projection over the whole file, so a declaration-dense file (generated
 * protobuf bindings, a large `.d.ts`) keeps nearly every line and renders
 * hundreds of kilobytes from a selector-free read. That text is re-sent on
 * every later request of the session, so it takes the same two bounds a
 * selector-free file window takes — `read.defaultLimit` lines and the output
 * budget in bytes — and the caller states which bound stopped it and the line
 * that continues it.
 */
function renderSummary(
	session: ToolSession,
	summary: SummaryResult,
	maxBytes: number,
	maxLines: number,
): {
	text: string;
	displayText: string;
	/** The line each display row stands for: a merged brace pair its opening line, an elision `null`. */
	displayLineNumbers: Array<number | null>;
	elidedRanges: ElidedRange[];
	elidedLines: number;
	stoppedBy: "bytes" | "lines" | undefined;
	nextLine: number;
	columnTruncated: number;
} {
	const displayMode = resolveFileDisplayMode(session);
	const shouldAddHashLines = displayMode.hashLines;
	const shouldAddLineNumbers = shouldAddHashLines ? false : displayMode.lineNumbers;
	const maxColumns = resolveOutputMaxColumns(session.settings);

	// Flatten segments into per-line units so we can merge a kept-head /
	// elided / kept-tail sandwich into a single brace-pair line when the
	// boundary lines look like `… {` and `}` (or matching variants).
	type Unit =
		| { kind: "line"; line: number; text: string }
		| { kind: "elided"; startLine: number; endLine: number }
		| {
				kind: "merged";
				startLine: number;
				endLine: number;
				headText: string;
				tailText: string;
		  };

	const raw: Unit[] = [];
	for (const segment of summary.segments) {
		if (segment.kind === "elided") {
			raw.push({ kind: "elided", startLine: segment.startLine, endLine: segment.endLine });
			continue;
		}
		const text = segment.text ?? "";
		if (text.length === 0) continue;
		const lines = text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			raw.push({ kind: "line", line: segment.startLine + i, text: lines[i] });
		}
	}

	const units: Unit[] = [];
	let i = 0;
	while (i < raw.length) {
		const cur = raw[i];
		if (cur.kind === "elided") {
			const prev = units.length > 0 ? units[units.length - 1] : null;
			const next = i + 1 < raw.length ? raw[i + 1] : null;
			if (prev?.kind === "line" && next?.kind === "line" && canMergeBracePair(prev.text, next.text)) {
				units.pop();
				units.push({
					kind: "merged",
					startLine: prev.line,
					endLine: next.line,
					headText: prev.text,
					tailText: next.text,
				});
				i += 2;
				continue;
			}
		}
		units.push(cur);
		i++;
	}

	const modelParts: string[] = [];
	const displayParts: string[] = [];
	const displayLineNumbers: Array<number | null> = [];
	const elidedRanges: ElidedRange[] = [];
	let elidedLines = 0;
	let modelBytes = 0;
	let stoppedBy: "bytes" | "lines" | undefined;
	let nextLine = 0;
	let columnTruncated = 0;
	const clip = (text: string): string => {
		if (maxColumns <= 0) return text;
		const result = truncateLine(text, maxColumns);
		if (result.wasTruncated) columnTruncated = maxColumns;
		return result.text;
	};
	for (const unit of units) {
		const unitStartLine = unit.kind === "line" ? unit.line : unit.startLine;
		let modelPart: string;
		let displayPart: string;
		if (unit.kind === "elided") {
			modelPart = "…";
			displayPart = "…";
		} else if (unit.kind === "merged") {
			const formatted = formatMergedBraceLine(
				unit.startLine,
				unit.endLine,
				clip(unit.headText),
				clip(unit.tailText),
				shouldAddHashLines,
				shouldAddLineNumbers,
			);
			modelPart = formatted.model;
			displayPart = formatted.display;
		} else {
			const text = clip(unit.text);
			modelPart = formatSingleLine(unit.line, text, shouldAddHashLines, shouldAddLineNumbers);
			displayPart = text;
		}

		const cost = Buffer.byteLength(modelPart, "utf-8") + (modelParts.length > 0 ? 1 : 0);
		if (modelParts.length > 0 && modelParts.length >= maxLines) {
			stoppedBy = "lines";
			nextLine = unitStartLine;
			break;
		}
		if (modelParts.length > 0 && modelBytes + cost > maxBytes) {
			stoppedBy = "bytes";
			nextLine = unitStartLine;
			break;
		}
		modelBytes += cost;
		modelParts.push(modelPart);
		displayParts.push(displayPart);
		displayLineNumbers.push(unit.kind === "elided" ? null : unitStartLine);

		if (unit.kind === "elided") {
			elidedRanges.push({ start: unit.startLine, end: unit.endLine });
			elidedLines += unit.endLine - unit.startLine + 1;
		} else if (unit.kind === "merged") {
			// Suggest the full brace range so re-reading shows both braces
			// plus the elided body in one shot.
			elidedRanges.push({ start: unit.startLine, end: unit.endLine });
			// Merged brace pair encloses (start+1)..(end-1) as elided.
			elidedLines += Math.max(0, unit.endLine - unit.startLine - 1);
		}
	}

	return {
		text: modelParts.join("\n"),
		displayText: displayParts.join("\n"),
		displayLineNumbers,
		elidedRanges,
		elidedLines,
		stoppedBy,
		nextLine,
		columnTruncated,
	};
}

/**
 * Render a structural summary for a whole-file read, when one applies.
 *
 * Returns undefined when summarizing is off for this file, when it does not parse, or when
 * nothing was elided; the caller then reads the file the ordinary way.
 */
export async function renderFileSummary(
	ctx: ReadContext,
	options: {
		readonly absolutePath: string;
		readonly localReadPath: string;
		readonly ext: string;
		readonly fileSize: number;
		readonly parsed: ParsedSelector;
		readonly hashLines: boolean;
		readonly signal?: AbortSignal;
	},
): Promise<RenderedFileSummary | undefined> {
	const { absolutePath, localReadPath, ext, fileSize, parsed, hashLines, signal } = options;
	if (
		parsed.kind !== "none" ||
		!ctx.session.settings.get("read.summarize.enabled") ||
		(!ctx.session.settings.get("read.summarize.prose") && PROSE_SUMMARY_EXTENSIONS.has(ext))
	) {
		return undefined;
	}
	const summary = await trySummarize(ctx.session, absolutePath, fileSize, signal);
	if (!summary?.parsed || !summary.elided) return undefined;

	const summaryBudget = inlineBudgetFor(ctx.session);
	const rendered = renderSummary(ctx.session, summary, summaryBudget, ctx.defaultLimit);
	const footer = formatSummaryElisionFooter(localReadPath, rendered.elidedRanges, rendered.elidedLines);
	const budgetNotice =
		rendered.stoppedBy === "lines"
			? `[Summary reached the ${ctx.defaultLimit}-line default. Use :${rendered.nextLine} to continue]`
			: rendered.stoppedBy === "bytes"
				? `[Summary reached the ${formatBytes(summaryBudget)} output budget. Use :${rendered.nextLine} to continue]`
				: "";
	const hashContext = hashLines ? await readHashlineHeaderContext(ctx.session, absolutePath) : undefined;
	const bodyText = [rendered.text, footer, budgetNotice].filter(part => part).join("\n\n");
	const modelText = prependHashlineHeader(bodyText, hashContext);
	if (hashContext?.tag) {
		recordSeenLinesFromBody(ctx.session, absolutePath, hashContext.tag, rendered.text);
	}
	let displayText = rendered.displayText;
	if (budgetNotice) {
		// The budget notice follows a blank row, and neither stands for a line of the file.
		displayText += `\n\n${budgetNotice}`;
		rendered.displayLineNumbers.push(null, null);
	}
	return {
		details: {
			displayContent: numberedDisplay(displayText, rendered.displayLineNumbers, 1),
			summary: {
				lines: countTextLines(rendered.text),
				elidedSpans: rendered.elidedRanges.length,
				elidedLines: rendered.elidedLines,
			},
		},
		content: [{ type: "text", text: modelText }],
		columnTruncated: rendered.columnTruncated,
	};
}
