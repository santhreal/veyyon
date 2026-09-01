import * as fs from "node:fs/promises";
import * as path from "node:path";
import { formatHashlineHeader, formatNumberedLine, formatNumberedLines } from "@veyyon/hashline";
import { glob, type SummaryResult } from "@veyyon/natives";
import { isAbortError, isCancellation, isTimeoutError, untilAborted } from "@veyyon/utils/abortable";
import { isProbablyBinaryHeader } from "@veyyon/utils/binary";
import { getRemoteDir } from "@veyyon/utils/dirs";
import { formatCount } from "@veyyon/utils/format";
import { scopedTimeoutSignal } from "@veyyon/utils/scoped-timeout";
import { errorMessage } from "@veyyon/utils/type-guards";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import { type } from "arktype";
import { LRUCache } from "lru-cache/raw";
import { canonicalSnapshotKey, getFileSnapshotStore, SNAPSHOT_MAX_BYTES } from "../edit/file-snapshot-store";
import { normalizeToLF } from "../edit/normalize";
import type { ToolSession } from "../sdk";
import { DEFAULT_MAX_BYTES, type TruncationResult, truncateHeadBytes } from "../session/streaming-output";
import type { LineEntry } from "../utils/block-context";
import { MAX_IMAGE_INPUT_BYTES } from "../utils/image-loading";
import type { OutputMeta } from "./output-meta";
import { expandDelimitedPathEntriesSync, formatPathRelativeToCwd, type LineRange, parseLineRanges } from "./path-utils";
import { shortenPath } from "./render-utils";
import { ToolError, throwIfAborted } from "./tool-errors";

export const SUMMARY_CACHE_MAX = 48;
export const summaryParseCaches = new WeakMap<object, LRUCache<string, SummaryResult | false>>();
export function getSummaryParseCache(session: object): LRUCache<string, SummaryResult | false> {
	let cache = summaryParseCaches.get(session);
	if (!cache) {
		cache = new LRUCache<string, SummaryResult | false>({ max: SUMMARY_CACHE_MAX });
		summaryParseCaches.set(session, cache);
	}
	return cache;
}

export const MAX_SUMMARY_BYTES = 2 * 1024 * 1024;
export const MAX_SUMMARY_LINES = 20_000;
export const MAX_ARTIFACT_RAW_INLINE_BYTES = DEFAULT_MAX_BYTES;

export const PROSE_SUMMARY_EXTENSIONS = new Set([".md", ".txt"]);

export interface MaterializedFile {
	text: string;
	lines: string[];
	windowLines: string[] | undefined;
}

export const BOM_PRESERVING_DECODER = new TextDecoder("utf-8", { ignoreBOM: true });

export async function materializeFile(absolutePath: string, fileSize: number): Promise<MaterializedFile | undefined> {
	if (fileSize > SNAPSHOT_MAX_BYTES) return undefined;
	try {
		const raw = BOM_PRESERVING_DECODER.decode(await Bun.file(absolutePath).bytes());
		const hasBom = raw.startsWith("\uFEFF");
		const text = normalizeToLF(hasBom ? raw.slice(1) : raw);
		const lines = text.split("\n");
		const sharesTheSplit = !raw.includes("\r") && !hasBom;
		return { text, lines, windowLines: sharesTheSplit ? lines : undefined };
	} catch {
		return undefined;
	}
}

export function isRemoteMountPath(absolutePath: string): boolean {
	return absolutePath.startsWith(getRemoteDir() + path.sep);
}

export function prependLineNumbers(text: string, startNum: number): string {
	const textLines = text.split("\n");
	let result = "";
	for (let li = 0; li < textLines.length; li++) {
		if (li > 0) result += "\n";
		result += `${startNum + li}|${textLines[li]!}`;
	}
	return result;
}

export interface HashlineHeaderContext {
	header: string;
	tag: string;
	fullText?: string;
}

export function formatReadHashlineHeader(displayPath: string, tag: string): string {
	const anchor = path.isAbsolute(displayPath) ? shortenPath(displayPath) : path.basename(displayPath);
	return formatHashlineHeader(anchor, tag);
}

export function recordFullHashlineContext(
	session: ToolSession,
	absolutePath: string | undefined,
	displayPath: string,
	fullText: string,
): HashlineHeaderContext | undefined {
	if (!absolutePath || !path.isAbsolute(absolutePath)) return undefined;
	const normalized = normalizeToLF(fullText);
	const tag = getFileSnapshotStore(session).record(canonicalSnapshotKey(absolutePath), normalized);
	return {
		header: formatReadHashlineHeader(displayPath, tag),
		tag,
		fullText: normalized,
	};
}

export async function readHashlineHeaderContext(
	session: ToolSession,
	absolutePath: string,
	cwd: string,
): Promise<HashlineHeaderContext> {
	const fullText = await Bun.file(absolutePath).text();
	const context = recordFullHashlineContext(
		session,
		absolutePath,
		formatPathRelativeToCwd(absolutePath, cwd),
		fullText,
	);
	if (!context) throw new ToolError(`Cannot record hashline snapshot for non-absolute path: ${absolutePath}`);
	return context;
}

export function hashlineHeaderContext(displayPath: string, tag: string): HashlineHeaderContext {
	return { header: formatReadHashlineHeader(displayPath, tag), tag };
}

export function prependHashlineHeader(text: string, context: HashlineHeaderContext | undefined): string {
	return context ? `${context.header}\n${text}` : text;
}

export function formatTextWithMode(
	text: string,
	startNum: number,
	shouldAddHashLines: boolean,
	shouldAddLineNumbers: boolean,
): string {
	if (shouldAddHashLines) return formatNumberedLines(text, startNum);
	if (shouldAddLineNumbers) return prependLineNumbers(text, startNum);
	return text;
}

export const BRACKET_CONTEXT_ELLIPSIS = "…";

export function formatLineEntryWithMode(
	entry: LineEntry,
	shouldAddHashLines: boolean,
	shouldAddLineNumbers: boolean,
): string {
	if (entry.kind === "ellipsis") return BRACKET_CONTEXT_ELLIPSIS;
	return formatSingleLine(entry.lineNumber, entry.text, shouldAddHashLines, shouldAddLineNumbers);
}

export function formatLineEntriesWithMode(
	entries: readonly LineEntry[],
	shouldAddHashLines: boolean,
	shouldAddLineNumbers: boolean,
): string {
	return entries.map(entry => formatLineEntryWithMode(entry, shouldAddHashLines, shouldAddLineNumbers)).join("\n");
}

export const BRACE_PAIRS: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
export const BRACE_TAIL_TRAILING_RE = /^[;,)\]}]*$/;

export function canMergeBracePair(headLine: string, tailLine: string): boolean {
	const head = headLine.trimEnd();
	const tail = tailLine.trim();
	const opener = head.slice(-1);
	const closer = BRACE_PAIRS[opener];
	if (!closer) return false;
	if (!tail.startsWith(closer)) return false;
	return BRACE_TAIL_TRAILING_RE.test(tail.slice(closer.length));
}

export function formatSingleLine(
	line: number,
	text: string,
	shouldAddHashLines: boolean,
	shouldAddLineNumbers: boolean,
): string {
	if (shouldAddHashLines) return formatNumberedLine(line, text);
	if (shouldAddLineNumbers) return `${line}|${text}`;
	return text;
}

export function formatMergedBraceLine(
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

export function countTextLines(text: string): number {
	if (text.length === 0) return 0;

	let lines = 1;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) lines++;
	}
	return lines;
}

export function lineNumbersFromSpans(spans: readonly { startLine: number; endLine: number }[]): number[] {
	const lines: number[] = [];
	for (const span of spans) {
		for (let line = span.startLine; line <= span.endLine; line++) lines.push(line);
	}
	return lines;
}

export function recordInMemorySeenLines(
	session: ToolSession,
	absolutePath: string | undefined,
	fullText: string,
	seenLines: readonly number[] | undefined,
): void {
	if (!absolutePath || !path.isAbsolute(absolutePath) || !seenLines || seenLines.length === 0) return;
	getFileSnapshotStore(session).record(canonicalSnapshotKey(absolutePath), normalizeToLF(fullText), seenLines);
}

export function lineNumbersFromEntries(entries: readonly LineEntry[]): number[] {
	const lines: number[] = [];
	for (const entry of entries) {
		if (entry.kind === "line") lines.push(entry.lineNumber);
	}
	return lines;
}

export interface ElidedRange {
	start: number;
	end: number;
}

export const FOOTER_RANGE_SAMPLES = 2;

export function formatSummaryElisionFooter(
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
export const READ_CHUNK_SIZE = 8 * 1024;

export const RANGE_LEADING_CONTEXT_LINES = 1;
export const RANGE_TRAILING_CONTEXT_LINES = 3;

export function rangeContextLines(
	requestedStart: number,
	expandStart: boolean,
	expandEnd: boolean,
): { leading: number; trailing: number } {
	return {
		leading: expandStart ? Math.min(requestedStart, RANGE_LEADING_CONTEXT_LINES) : 0,
		trailing: expandEnd ? RANGE_TRAILING_CONTEXT_LINES : 0,
	};
}

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

export function formatContextPaddingNotice(options: {
	requestedFirstLine: number;
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

export interface CollectedWindow {
	lines: string[];
	totalFileLines: number;
	collectedBytes: number;
	stoppedByByteLimit: boolean;
	firstLinePreview?: { text: string; bytes: number };
	firstLineByteLength?: number;
	reachedEof: boolean;
}

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
			firstLineByteLength ??= lineBytes;
			if (selectedLineLimit !== null && selectedLinesSeen >= selectedLineLimit) break;
			continue;
		}

		const separatorBytes = collected.length > 0 ? 1 : 0;
		if (collected.length >= maxLinesToCollect) {
			doneCollecting = true;
		} else if (collected.length === 0 && lineBytes > maxBytes) {
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

export const MAX_IMAGE_SIZE = MAX_IMAGE_INPUT_BYTES;
export const GLOB_TIMEOUT_MS = 5000;

export function escapeGlobMetachars(value: string): string {
	return value.replace(/[*?[{]/g, "[$&]");
}

export async function findUniqueSuffixMatch(
	rawPath: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<{ absolutePath: string; displayPath: string } | null> {
	const normalized = trimTrailingSlashes(rawPath.replace(/\\/g, "/").replace(/^\.\//, ""));
	if (!normalized) return null;
	const pattern = `**/${escapeGlobMetachars(normalized)}`;

	const { signal: combinedSignal, cancel } = scopedTimeoutSignal(GLOB_TIMEOUT_MS, signal);

	let matches: string[];
	try {
		const result = await untilAborted(combinedSignal, () =>
			glob({
				pattern,
				path: cwd,
				hidden: true,
			}),
		);
		matches = result.matches.map(m => m.path);
	} catch (error) {
		if (isTimeoutError(error)) return null;
		if (isAbortError(error)) throwIfAborted(signal, "read");
		return null;
	} finally {
		cancel();
	}

	if (matches.length !== 1) return null;

	return {
		absolutePath: path.resolve(cwd, matches[0]),
		displayPath: matches[0],
	};
}

export function summarizeFailureReport(error: unknown): string | null {
	if (isAbortError(error) || isTimeoutError(error) || isCancellation(error)) return null;
	return errorMessage(error);
}

export function decodeUtf8Text(bytes: Uint8Array): string | null {
	if (isProbablyBinaryHeader(bytes)) return null;

	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

export function prependSuffixResolutionNotice(text: string, suffixResolution?: { from: string; to: string }): string {
	if (!suffixResolution) return text;

	const notice = `[Path '${suffixResolution.from}' not found; resolved to '${suffixResolution.to}' via suffix match]`;
	return text ? `${notice}\n${text}` : notice;
}
export const PDF_IMAGE_PLACEHOLDER_RE = /<!--\s*image:\s*([^\s<>]+)(.*?)-->/g;
export const PDF_IMAGE_MEMBER_RE = /^(.*\.pdf):(.*)$/i;
export const PDF_IMAGE_MEMBER_EXTENSION_RE = /\.png$/i;

export function pdfImageMemberPath(pdfPath: string, imageId: string): string {
	const member = PDF_IMAGE_MEMBER_EXTENSION_RE.test(imageId) ? imageId : `${imageId}.png`;
	return `${pdfPath}:${member}`;
}

export function rewritePdfImagePlaceholders(markdown: string, pdfPath: string): string {
	return markdown.replace(PDF_IMAGE_PLACEHOLDER_RE, (_match: string, imageId: string, metadataText: string) => {
		const metadata = metadataText.trim();
		const suffix = metadata.length > 0 ? ` (${metadata})` : "";
		return `Image ${imageId}${suffix}: read \`${pdfImageMemberPath(pdfPath, imageId)}\``;
	});
}

export function splitPdfImageMemberReadPath(readPath: string): { pdfPath: string; member: string } | null {
	const match = PDF_IMAGE_MEMBER_RE.exec(readPath);
	if (!match) return null;
	const pdfPath = match[1];
	const member = match[2];
	if (pdfPath === undefined || member === undefined) return null;
	if (member.length !== 0 && !PDF_IMAGE_MEMBER_EXTENSION_RE.test(member)) return null;
	return { pdfPath, member };
}

export const readSchema = type({
	path: type("string").describe(
		"Local path, internal URI (e.g. memory://, skill://), or URL. Inline selectors are supported.",
	),
	"depth?": type("number.integer > 0").describe(
		"Directory listings only: recursion depth (1 = top level). Default 2.",
	),
	"limit?": type("number.integer > 0").describe(
		"Directory listings only: max entries returned; omitted entries are reported with the limit and how to see more.",
	),
});

export type ReadToolInput = typeof readSchema.infer;

export interface ReadToolDetails {
	kind?: "file" | "url";
	truncation?: TruncationResult;
	isDirectory?: boolean;
	resolvedPath?: string;
	suffixResolution?: { from: string; to: string };
	url?: string;
	finalUrl?: string;
	contentType?: string;
	method?: string;
	notes?: string[];
	meta?: OutputMeta;
	displayContent?: {
		text: string;
		startLine: number;
		lineNumbers?: Array<number | null>;
	};
	summary?: { lines: number; elidedSpans: number; elidedLines: number };
	conflictCount?: number;
	displayReadTargets?: string[];

	contentUnavailable?: { reason: "binary" | "conversion-failed" };
}

export type ReadParams = ReadToolInput;

export type ParsedSelector =
	| { kind: "none" }
	| { kind: "raw" }
	| { kind: "conflicts" }
	| { kind: "lines"; ranges: [LineRange, ...LineRange[]]; raw?: boolean };

export function isRawSelector(parsed: ParsedSelector): boolean {
	return parsed.kind === "raw" || (parsed.kind === "lines" && parsed.raw === true);
}

export function isMultiRange(parsed: ParsedSelector): boolean {
	return parsed.kind === "lines" && parsed.ranges.length > 1;
}

export function selectorChunkLooksReadLike(chunk: string): boolean {
	const lower = chunk.toLowerCase();
	return (
		lower === "raw" || lower === "conflicts" || /^-\d+(?:[-+]\d+)?$/.test(chunk) || parseLineRanges(chunk) !== null
	);
}

export function invalidSelector(sel: string): ToolError {
	return new ToolError(
		`Invalid selector ':${sel}'. Use :N, :N-M, :N+K, :N- (open-ended), a comma-separated list of ranges, :raw, or a range combined with raw (e.g. :raw:50-100).`,
	);
}

export function parseSel(sel: string | undefined): ParsedSelector {
	if (!sel || sel.length === 0) return { kind: "none" };

	if (sel.includes(":")) {
		const chunks = sel.split(":");
		if (chunks.length === 2) {
			const [a, b] = chunks as [string, string];
			const aIsRaw = a.toLowerCase() === "raw";
			const bIsRaw = b.toLowerCase() === "raw";
			const rangeChunk = aIsRaw ? b : bIsRaw ? a : null;
			const rawChunk = aIsRaw ? a : bIsRaw ? b : null;
			if (rangeChunk !== null && rawChunk !== null) {
				const ranges = parseLineRanges(rangeChunk);
				if (ranges) {
					return { kind: "lines", ranges, raw: true };
				}
			}
		}
		if (chunks.every(selectorChunkLooksReadLike)) throw invalidSelector(sel);
		return { kind: "none" };
	}

	if (sel.toLowerCase() === "raw") return { kind: "raw" };
	if (sel.toLowerCase() === "conflicts") return { kind: "conflicts" };
	const ranges = parseLineRanges(sel);
	if (ranges) {
		return { kind: "lines", ranges };
	}
	return { kind: "none" };
}

export function selToOffsetLimit(parsed: ParsedSelector): { offset?: number; limit?: number } {
	if (parsed.kind === "lines") {
		const first = parsed.ranges[0];
		const limit = first.endLine !== undefined ? first.endLine - first.startLine + 1 : undefined;
		return { offset: first.startLine, limit };
	}
	return {};
}

export interface ResolvedArchiveReadPath {
	absolutePath: string;
	archiveSubPath: string;
	suffixResolution?: { from: string; to: string };
}

export interface ResolvedSqliteReadPath {
	absolutePath: string;
	sqliteSubPath: string;
	queryString: string;
	suffixResolution?: { from: string; to: string };
}

export type SuffixMatchCache = Map<string, { absolutePath: string; displayPath: string } | null>;

export function readFilesystemTargets(args: unknown, cwd = process.cwd()): string[] {
	if (!args || typeof args !== "object" || !("path" in args)) return [];
	const rawPath = args.path;
	if (typeof rawPath !== "string") return [];
	const expanded = expandDelimitedPathEntriesSync([rawPath], cwd, { internalUrls: "split-on-semicolon" });
	return expanded.filter(entry => entry.length > 0);
}
