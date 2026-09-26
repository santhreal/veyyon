import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ToolTier } from "@veyyon/agent-core";
import { formatHashlineHeader } from "@veyyon/hashline";
import { type GrepMatch, type GrepOptions, GrepOutputMode, type GrepResult, grep } from "@veyyon/natives";
import { errorMessage, isRecord, logger, trimTrailingSlashes, untilAborted } from "@veyyon/utils";
import { recordFileSnapshot, recordSeenLinesFromBody } from "../../edit/file-snapshot-store";
import type { LocalProtocolOptions } from "../../internal-urls/local-protocol";
import { InternalUrlRouter } from "../../internal-urls/router";
import type { InternalResource, ResolveContext } from "../../internal-urls/types";
import {
	artifactFooter,
	DEFAULT_MAX_COLUMN,
	type TruncationResult,
	type TruncationSummary,
	truncateHead,
	truncateLine,
	truncationSummary,
} from "../../session/streaming-output";
import { resolveFileDisplayMode } from "../../utils/file-display-mode";
import {
	type ArchiveReader,
	type ExtractedArchiveFile,
	openArchive,
	parseArchivePathCandidates,
} from "../../utils/zip";
import type { ToolSession } from "..";
import { formatResultPath } from "../core/file-recorder";
import { classifyGroupedLines, formatGroupedFiles } from "../core/grouped-file-output";
import { inlineBudgetFor, saveOutputArtifact } from "../core/output-artifact";
import type { OutputMeta } from "../core/output-meta";
import {
	expandDelimitedPathEntries,
	hasGlobPathChars,
	isLineInRanges,
	type LineRange,
	parseLineRanges,
	pathTargetsSsh,
	resolveReadPath,
	resolveToCwd,
	selectorLineRanges,
	splitInternalUrlSel,
	splitPathAndSel,
	splitPathAndSelPreferringLiteral,
	toPathList,
} from "../core/path-utils";
import { formatCodeFrameLine, formatCount } from "../core/render-utils";
import { ToolError } from "../core/tool-errors";
import { toolResult } from "../core/tool-result";
import { loadUrlReader } from "../web/manifest";
import { parseReadUrlTarget } from "../web/read-url-target";
import { formatMatchLine } from "./match-line-format";
import {
	isImmutableSearchSourcePath,
	type ResolvedExternalSearchUrl,
	resolveToolSearchScope,
	type ToolScopeResolution,
} from "./search-scope";
import {
	type GrepPathSpec,
	lineRangeFetchCap,
	matchAbsolutePath,
	NATIVE_GREP_MAX_FILE_BYTES,
	TextSearchScopeProvenance,
} from "./text-search-scope";

export interface TextSearchInput {
	pattern: string;
	path?: string;
	case?: boolean;
	gitignore?: boolean;
	skip?: number | null;
}

/** Maximum number of distinct files surfaced in a single response. The
 * agent paginates further pages via `skip`. */
export const DEFAULT_FILE_LIMIT = 20;
/** Per-file match cap for multi-file searches — keeps a single hot file
 * from crowding out diverse hits. Applied in JS after grep returns. */
export const MULTI_FILE_PER_FILE_MATCHES = 20;
/** Per-file match cap for single-file searches — there's no diversity
 * concern when the scope is one file. */
export const SINGLE_FILE_MATCHES = 200;
/** Maximum budget in bytes for broad grouped multi-file search output before
 * progressive disclosure reduces the inline body. Feeds into the session's
 * turn-scaled budget curve (yielding ~2 KiB early). */
export const BROAD_SEARCH_INLINE_MAX_BYTES = 8 * 1024;
/** Maximum representative matches emitted per file in broad compact search output. */
export const BROAD_SEARCH_REPRESENTATIVE_MATCHES_PER_FILE = 2;
/** Hard safety ceiling on how many matches we fetch from native grep
 * before JS-side grouping. Sized to comfortably cover the file window
 * (DEFAULT_FILE_LIMIT files × MULTI_FILE_PER_FILE_MATCHES matches) plus
 * pagination headroom so the caller can see total file count. */
const INTERNAL_TOTAL_CAP = 2000;
/** Wall-clock budget for a single native grep invocation. Without it, an
 * aborted or runaway search (huge tree, network mount) keeps burning CPU on
 * the native thread pool after the JS promise is abandoned. */
const SEARCH_GREP_TIMEOUT_MS = 30_000;

/**
 * Mirror of read's `parseSel` selector grammar (`read.ts`) so `grep` accepts
 * exactly the internal-URL selectors `read` accepts: a single chunk that is a
 * line range, `raw`, or `conflicts`; or a two-chunk compound of exactly one `raw`
 * plus one line range. Everything else (`:-10`, `:1-1:1-2`, `:conflicts:1-1`,
 * `:raw:conflicts`) is rejected.
 *
 * This mirrors the *accepted set* of `parseSel`; `read` rejects the same shapes
 * caller-side when a peeled internal-URL selector parses as `none`, so neither
 * tool silently widens on a malformed compound. Keep in sync with `read.parseSel`.
 */
function isReadSelectorGrammar(sel: string): boolean {
	if (sel.includes(":")) {
		const chunks = sel.split(":");
		if (chunks.length !== 2) return false;
		const [a, b] = chunks as [string, string];
		const aIsRaw = a.toLowerCase() === "raw";
		const bIsRaw = b.toLowerCase() === "raw";
		const rangeChunk = aIsRaw ? b : bIsRaw ? a : null;
		return rangeChunk !== null && parseLineRanges(rangeChunk) !== null;
	}
	const lower = sel.toLowerCase();
	return lower === "raw" || lower === "conflicts" || parseLineRanges(sel) !== null;
}

async function parsePathSpecs(rawEntries: readonly string[], cwd: string): Promise<GrepPathSpec[]> {
	const specs: GrepPathSpec[] = [];
	for (const entry of rawEntries) {
		// Internal URLs (`artifact://`, `skill://`, …) use the URL-aware splitter,
		// which peels selector-shaped tails only for selector-capable schemes and
		// leaves opaque ones (`mcp://`) intact. Unlike filesystem paths, their
		// verbatim/index display modes (`raw`, `conflicts`) carry no meaning for
		// content search, so we accept them — searching the whole resource — and
		// still honor any embedded line range as a match filter.
		const internalSplit = splitInternalUrlSel(entry);
		if (internalSplit.sel !== undefined) {
			// Reject selectors read's parseSel would reject (`:-10`, `:1-1:1-2`,
			// `:conflicts:1-1`) instead of silently widening the search or dropping a chunk.
			if (!isReadSelectorGrammar(internalSplit.sel)) {
				throw new ToolError(
					`path entry "${entry}" has an invalid selector ":${internalSplit.sel}" — use ":N-M" line ranges, ":raw"/":conflicts", a range plus ":raw", or percent-encode a literal ":" as %3A`,
				);
			}
			specs.push({ original: entry, clean: internalSplit.path, ranges: selectorLineRanges(internalSplit.sel) });
			continue;
		}
		// Prefer a literal filesystem match when one exists — a real file named
		// `test:1-2` outranks the `:1-2` selector interpretation (issue #4618).
		const strictSplit = splitPathAndSel(entry);
		const split = await splitPathAndSelPreferringLiteral(entry, cwd);
		const literalFilesystemMatch = strictSplit.sel !== undefined && split.sel === undefined;
		let clean = literalFilesystemMatch ? resolveReadPath(entry, cwd) : entry;
		let ranges: [LineRange, ...LineRange[]] | undefined;
		if (!literalFilesystemMatch && split.sel) {
			const parsed = parseLineRanges(split.sel);
			if (!parsed) {
				throw new ToolError(
					`path entry "${entry}" — only line-range selectors like ":50-100" are supported (no ":raw"/":conflicts")`,
				);
			}
			if (hasGlobPathChars(split.path)) {
				let isLiteralFile = false;
				try {
					const st = await stat(resolveToCwd(split.path, cwd));
					isLiteralFile = st.isFile();
				} catch {
					isLiteralFile = false;
				}
				if (!isLiteralFile) {
					throw new ToolError(`Line-range selector requires a single file, not a glob: ${entry}`);
				}
			}
			clean = split.path;
			ranges = parsed;
		}
		specs.push({
			original: entry,
			clean,
			literalFilesystemMatch,
			ranges,
		});
	}
	return specs;
}

/** Path inputs after archive-member selectors are extracted to scratch files. */
interface ArchiveSearchPaths {
	resolvedPaths: string[];
	/** Scratch path of each extracted member to the selector the caller wrote. */
	displayMap: Map<string, string>;
	displaySet: Set<string>;
	unreadable: string[];
	cleanup: () => Promise<void>;
}

/**
 * Pre-resolve any `paths` entries that point at a member inside an archive
 * (e.g. `bundle.zip:src/foo.ts`, `release.tar.gz:notes.md`). Native grep
 * cannot read archive members, so we materialize each text member to a
 * temp scratch file and substitute that path into the search inputs. After
 * grep returns, callers remap `match.path` back to the original
 * `archive:member` selector so it round-trips through the `read` tool.
 *
 * Returns the rewritten paths array (same length/order as input), a map
 * from absolute scratch path → original selector, a list of entries we
 * could not materialize (binary member, missing archive, etc.), and a
 * cleanup hook the caller MUST invoke in a `finally`.
 */
async function resolveArchiveSearchPaths(pathSpecs: readonly GrepPathSpec[], cwd: string): Promise<ArchiveSearchPaths> {
	const resolvedPaths = pathSpecs.map(spec => spec.clean);
	const displayMap = new Map<string, string>();
	const displaySet = new Set<string>();
	const unreadable: string[] = [];
	let tempDir: string | undefined;
	const archiveCache = new Map<string, ArchiveReader>();

	const cleanup = async () => {
		if (tempDir) {
			// A failed cleanup must not fail the grep the caller asked for, but it leaves a temp directory
			// behind, and a silently leaked directory grows without bound across a long session. Report it.
			await rm(tempDir, { recursive: true, force: true }).catch((error: unknown) => {
				logger.warn("grep could not remove its temp directory", { dir: tempDir, error: errorMessage(error) });
			});
		}
	};

	try {
		for (let idx = 0; idx < pathSpecs.length; idx++) {
			const spec = pathSpecs[idx];
			if (!spec || spec.literalFilesystemMatch) continue;
			const entry = spec.clean;
			const candidates = parseArchivePathCandidates(entry);
			const member = candidates.find(c => c.subPath !== "" && c.archivePath !== entry);
			if (!member) continue;

			const archiveAbs = resolveReadPath(member.archivePath, cwd);
			let archive = archiveCache.get(archiveAbs);
			if (!archive) {
				try {
					archive = await openArchive(archiveAbs);
				} catch (err) {
					unreadable.push(`${entry} (cannot open archive: ${errorMessage(err)})`);
					continue;
				}
				archiveCache.set(archiveAbs, archive);
			}

			let extracted: ExtractedArchiveFile;
			try {
				extracted = await archive.readFile(member.subPath);
			} catch (err) {
				unreadable.push(`${entry} (${errorMessage(err)})`);
				continue;
			}
			// UTF-8 only — binary members would just produce noise through ripgrep.
			if (extracted.bytes.some(byte => byte === 0)) {
				unreadable.push(`${entry} (binary archive entry)`);
				continue;
			}
			let text: string;
			try {
				text = new TextDecoder("utf-8", { fatal: true }).decode(extracted.bytes);
			} catch {
				unreadable.push(`${entry} (non-UTF-8 archive entry)`);
				continue;
			}

			if (!tempDir) {
				tempDir = await mkdtemp(path.join(tmpdir(), "veyyon-search-archive-"));
			}
			// Per-entry filename keeps the scratch path unique even when two selectors
			// resolve to members with the same basename.
			const safeBase = path.basename(member.subPath).replace(/[^\w.-]+/g, "_") || "entry";
			const tempPath = path.join(tempDir, `${idx}-${safeBase}`);
			await writeFile(tempPath, text);
			resolvedPaths[idx] = tempPath;
			displayMap.set(tempPath, entry);
			displaySet.add(entry);
		}
	} catch (error) {
		// The caller receives `cleanup` only on the success path, so a throw once the
		// scratch directory exists would strand it for the life of the host. Later
		// entries can throw after an earlier one already created it, so this covers
		// the whole loop rather than the write that happens to be nearest.
		await cleanup();
		throw error;
	}

	return { resolvedPaths, displayMap, displaySet, unreadable, cleanup };
}

interface VirtualSearchResource {
	path: string;
	content: string;
	ranges?: readonly LineRange[];
}

interface InternalSearchInputResolution {
	paths: string[];
	resolvedPathsByInput: string[];
	virtualResources: VirtualSearchResource[];
	virtualPathSet: Set<string>;
	virtualInputIndexes: Set<number>;
	immutableSourcePaths: Set<string>;
	virtualScopePath?: string;
}

interface IndexedContentLines {
	lines: string[];
	starts: number[];
}

const VEYYON_ROOT_URL_RE = /^veyyon:\/\/(?:\/?|docs\/?)$/i;

function normalizeSearchLine(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function splitSearchLines(content: string): string[] {
	const lines = content.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines.map(normalizeSearchLine);
}

function indexSearchLines(content: string): IndexedContentLines {
	const rawLines = content.split("\n");
	if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
		rawLines.pop();
	}
	const lines: string[] = [];
	const starts: number[] = [];
	let offset = 0;
	for (const rawLine of rawLines) {
		starts.push(offset);
		lines.push(normalizeSearchLine(rawLine));
		offset += rawLine.length + 1;
	}
	return { lines, starts };
}

function lineAllowed(lineNumber: number, ranges: readonly LineRange[] | undefined): boolean {
	return !ranges || isLineInRanges(lineNumber, ranges);
}

/** Binary search for the index of the line containing byte `offset`. */
function findLineIndex(starts: readonly number[], offset: number): number {
	if (starts.length === 0) return -1;
	let low = 0;
	let high = starts.length - 1;
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		if (starts[mid] <= offset) {
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return Math.max(0, high);
}

/**
 * JS-`RegExp` fallback returning matched line indexes for a virtual resource too
 * large for native grep (>`NATIVE_GREP_MAX_FILE_BYTES`, which native grep silently
 * skips). Mirrors the native probe's output (sorted, deduped indexes) so
 * `buildVirtualMatches` rebuilds context/ranges identically; only the regex dialect
 * differs for these oversized inputs (the pre-RE2-parity behavior).
 */
function jsMatchedLineIndexes(
	content: string,
	lines: readonly string[],
	pattern: string,
	ignoreCase: boolean,
	multiline: boolean,
): number[] {
	const flags = `${ignoreCase ? "i" : ""}${multiline ? "gm" : ""}`;
	let regex: RegExp;
	try {
		regex = new RegExp(pattern, flags);
	} catch (err) {
		const message = errorMessage(err);
		throw new ToolError(`Invalid regex: ${message.replace(/^Invalid regular expression:\s*/i, "")}`);
	}
	if (!multiline) {
		const out: number[] = [];
		for (let i = 0; i < lines.length; i++) {
			regex.lastIndex = 0;
			if (regex.test(lines[i] ?? "")) out.push(i);
		}
		return out;
	}
	const { starts } = indexSearchLines(content);
	const seen = new Set<number>();
	const out: number[] = [];
	let match = regex.exec(content);
	while (match !== null) {
		const lineIndex = findLineIndex(starts, match.index);
		if (lineIndex >= 0 && !seen.has(lineIndex)) {
			seen.add(lineIndex);
			out.push(lineIndex);
		}
		if (match[0].length === 0) regex.lastIndex++;
		match = regex.exec(content);
	}
	out.sort((a, b) => a - b);
	return out;
}

/**
 * Native-grep an oversized (>NATIVE_GREP_MAX_FILE_BYTES) line-mode virtual resource
 * in line-boundary chunks (each <= the cap) so it keeps RE2 dialect parity instead of
 * the JS fallback. Each chunk's matched line numbers are offset by its starting line
 * index. A single line larger than the cap can't be native-grepped, so that one line
 * is JS-tested. Returns sorted 0-based line indexes.
 */
async function nativeChunkedLineIndexes(
	dir: string,
	resourceIdx: number,
	content: string,
	pattern: string,
	ignoreCase: boolean,
	signal: AbortSignal | undefined,
): Promise<number[]> {
	const rawLines = content.split("\n");
	if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
	const indexes: number[] = [];
	let chunkStart = 0;
	let chunkBytes = 0;
	let chunkLines: string[] = [];
	let chunkSeq = 0;
	const flush = async (): Promise<void> => {
		if (chunkLines.length === 0) return;
		const scratch = path.resolve(dir, `${resourceIdx}-chunk-${chunkSeq++}`);
		await writeFile(scratch, chunkLines.join("\n"));
		const probe = await grep(
			{
				pattern,
				path: scratch,
				ignoreCase,
				multiline: false,
				hidden: true,
				gitignore: false,
				maxCount: chunkLines.length,
				contextBefore: 0,
				contextAfter: 0,
				maxColumns: DEFAULT_MAX_COLUMN,
				mode: GrepOutputMode.Content,
				signal,
				timeoutMs: SEARCH_GREP_TIMEOUT_MS,
			},
			undefined,
		);
		for (const match of probe.matches) indexes.push(chunkStart + match.lineNumber - 1);
		chunkLines = [];
		chunkBytes = 0;
	};
	let lineRegex: RegExp | undefined;
	for (let i = 0; i < rawLines.length; i++) {
		const line = rawLines[i];
		const lineBytes = Buffer.byteLength(line, "utf8") + 1;
		if (lineBytes > NATIVE_GREP_MAX_FILE_BYTES) {
			await flush();
			if (!lineRegex) {
				try {
					lineRegex = new RegExp(pattern, ignoreCase ? "i" : "");
				} catch (err) {
					const message = errorMessage(err);
					throw new ToolError(`Invalid regex: ${message.replace(/^Invalid regular expression:\s*/i, "")}`);
				}
			}
			lineRegex.lastIndex = 0;
			if (lineRegex.test(line)) indexes.push(i);
			chunkStart = i + 1;
			continue;
		}
		if (chunkLines.length > 0 && chunkBytes + lineBytes > NATIVE_GREP_MAX_FILE_BYTES) {
			await flush();
			chunkStart = i;
		}
		if (chunkLines.length === 0) chunkStart = i;
		chunkLines.push(line);
		chunkBytes += lineBytes;
	}
	await flush();
	indexes.sort((a, b) => a - b);
	return indexes;
}

function makeContextLine(lines: readonly string[], lineIndex: number): NonNullable<GrepMatch["contextBefore"]>[number] {
	const { text, wasTruncated } = truncateLine(lines[lineIndex] ?? "", DEFAULT_MAX_COLUMN);
	return {
		lineNumber: lineIndex + 1,
		line: text,
		...(wasTruncated ? { truncated: true } : {}),
	};
}

function makeVirtualMatch(
	resource: VirtualSearchResource,
	lines: readonly string[],
	lineIndex: number,
	contextBefore: number,
	contextAfter: number,
	lastEmittedLine: number,
	nextMatchLine: number,
): GrepMatch {
	const lineNumber = lineIndex + 1;
	const { text, wasTruncated } = truncateLine(lines[lineIndex] ?? "", DEFAULT_MAX_COLUMN);
	const match: GrepMatch = {
		path: resource.path,
		lineNumber,
		line: text,
	};
	if (wasTruncated) match.truncated = true;

	if (contextBefore > 0) {
		const before: NonNullable<GrepMatch["contextBefore"]> = [];
		// Start after the previous match's last emitted line so adjacent matches
		// never repeat or rewind context lines (mirrors native grep's sink).
		const start = Math.max(0, lineIndex - contextBefore, lastEmittedLine);
		for (let idx = start; idx < lineIndex; idx++) {
			const contextLineNumber = idx + 1;
			if (lineAllowed(contextLineNumber, resource.ranges)) {
				before.push(makeContextLine(lines, idx));
			}
		}
		if (before.length > 0) match.contextBefore = before;
	}

	if (contextAfter > 0) {
		const after: NonNullable<GrepMatch["contextAfter"]> = [];
		// Stop before the next match line; it is emitted as a match itself.
		const end = Math.min(lines.length - 1, lineIndex + contextAfter, nextMatchLine - 2);
		for (let idx = lineIndex + 1; idx <= end; idx++) {
			const contextLineNumber = idx + 1;
			if (lineAllowed(contextLineNumber, resource.ranges)) {
				after.push(makeContextLine(lines, idx));
			}
		}
		if (after.length > 0) match.contextAfter = after;
	}

	return match;
}

/** Build matches for ascending matched line indexes with forward-only,
 * deduplicated context windows (line numbers never repeat or go backwards
 * within one resource). */
function buildVirtualMatches(
	resource: VirtualSearchResource,
	lines: readonly string[],
	matchedIndexes: readonly number[],
	contextBefore: number,
	contextAfter: number,
	maxCount: number,
): GrepMatch[] {
	const matches: GrepMatch[] = [];
	let lastEmittedLine = 0;
	for (let i = 0; i < matchedIndexes.length && matches.length < maxCount; i++) {
		const lineIndex = matchedIndexes[i];
		const nextMatchLine = i + 1 < matchedIndexes.length ? matchedIndexes[i + 1] + 1 : Number.POSITIVE_INFINITY;
		const match = makeVirtualMatch(
			resource,
			lines,
			lineIndex,
			contextBefore,
			contextAfter,
			lastEmittedLine,
			nextMatchLine,
		);
		const after = match.contextAfter;
		lastEmittedLine = after && after.length > 0 ? after[after.length - 1].lineNumber : match.lineNumber;
		matches.push(match);
	}
	return matches;
}

async function searchVirtualResources(
	resources: readonly VirtualSearchResource[],
	pattern: string,
	ignoreCase: boolean,
	multiline: boolean,
	contextBefore: number,
	contextAfter: number,
	maxCount: number,
	signal?: AbortSignal,
): Promise<GrepResult> {
	if (resources.length === 0) {
		return { matches: [], totalMatches: 0, filesWithMatches: 0, filesSearched: 0, limitReached: false };
	}
	const matches: GrepMatch[] = [];
	const filesWithMatches = new Set<string>();
	let totalMatches = 0;
	let limitReached = false;
	// Detect matched line numbers with native grep (RE2) — the SAME matcher local
	// search uses — so a pattern valid for local grep but not JS `RegExp` (`(?i)x`,
	// `[[:digit:]]`) behaves identically on virtual/remote resources. The JS helpers
	// below then rebuild the exact forward-only, range-trimmed context windows the
	// virtual-search contract requires.
	const dir = await mkdtemp(path.join(tmpdir(), "veyyon-search-virtual-"));
	try {
		for (let idx = 0; idx < resources.length; idx++) {
			const resource = resources[idx];
			const remaining = Math.max(maxCount - matches.length, 0);
			if (remaining === 0) {
				limitReached = true;
				break;
			}
			const lines = multiline ? indexSearchLines(resource.content).lines : splitSearchLines(resource.content);
			let matchedIndexes: number[];
			if (Buffer.byteLength(resource.content, "utf8") > NATIVE_GREP_MAX_FILE_BYTES) {
				// Native grep skips files above its 4 MiB cap. Search oversized content in
				// line-boundary chunks so line-mode keeps RE2 parity; multiline can't be chunked
				// without missing matches that span a chunk boundary, so it falls back to JS
				// (dialect-as-JS only for these oversized multiline inputs).
				matchedIndexes = (
					multiline
						? jsMatchedLineIndexes(resource.content, lines, pattern, ignoreCase, true)
						: await nativeChunkedLineIndexes(dir, idx, resource.content, pattern, ignoreCase, signal)
				).filter(lineIndex => lineAllowed(lineIndex + 1, resource.ranges));
			} else {
				const scratch = path.resolve(dir, `${idx}`);
				await writeFile(scratch, resource.content);
				const probe = await grep(
					{
						pattern,
						path: scratch,
						ignoreCase,
						multiline,
						hidden: true,
						gitignore: false,
						// A ranged selector must see every match so the range filter below never
						// drops in-range hits that fall after the cap; matches can't exceed the
						// line count. Unranged search keeps the overall result cap.
						maxCount: resource.ranges ? Math.max(lines.length, 1) : INTERNAL_TOTAL_CAP,
						contextBefore: 0,
						contextAfter: 0,
						maxColumns: DEFAULT_MAX_COLUMN,
						mode: GrepOutputMode.Content,
						signal,
						timeoutMs: SEARCH_GREP_TIMEOUT_MS,
					},
					undefined,
				);
				matchedIndexes = Array.from(new Set(probe.matches.map(match => match.lineNumber - 1)))
					.filter(lineIndex => lineAllowed(lineIndex + 1, resource.ranges))
					.sort((a, b) => a - b);
			}
			const resourceMatches = buildVirtualMatches(
				resource,
				lines,
				matchedIndexes,
				contextBefore,
				contextAfter,
				remaining,
			);
			if (matchedIndexes.length > 0) filesWithMatches.add(resource.path);
			totalMatches += matchedIndexes.length;
			limitReached = limitReached || matchedIndexes.length > resourceMatches.length;
			for (let ri = 0; ri < resourceMatches.length; ri++) matches.push(resourceMatches[ri]!);
		}
	} finally {
		// Same as `cleanup` above: the search result stands, and the leaked directory is named in the log.
		await rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
			logger.warn("grep could not remove its temp directory", { dir, error: errorMessage(error) });
		});
	}
	return {
		matches,
		totalMatches,
		filesWithMatches: filesWithMatches.size,
		filesSearched: resources.length,
		limitReached,
	};
}

function mergeGrepResults(left: GrepResult, right: GrepResult, maxCount: number): GrepResult {
	if (left.matches.length === 0) return right;
	if (right.matches.length === 0) return left;
	const combinedMatches = left.matches.concat(right.matches);
	const matches = combinedMatches.length > maxCount ? combinedMatches.slice(0, maxCount) : combinedMatches;
	return {
		matches,
		totalMatches: left.totalMatches + right.totalMatches,
		filesWithMatches: new Set(matches.map(match => match.path)).size,
		filesSearched: left.filesSearched + right.filesSearched,
		limitReached: left.limitReached || right.limitReached || matches.length < combinedMatches.length,
	};
}

async function expandVirtualInternalResource(
	rawPath: string,
	resource: InternalResource,
	internalRouter: InternalUrlRouter,
	context: ResolveContext,
	ranges: readonly LineRange[] | undefined,
): Promise<VirtualSearchResource[]> {
	if (VEYYON_ROOT_URL_RE.test(rawPath)) {
		const completions = await internalRouter.complete("veyyon", "");
		if (completions && completions.length > 0) {
			const resources: VirtualSearchResource[] = [];
			const seen = new Set<string>();
			for (const completion of completions) {
				if (seen.has(completion.value)) continue;
				seen.add(completion.value);
				const docUrl = `veyyon://${completion.value}`;
				const doc = await internalRouter.resolve(docUrl, context);
				if (!doc.sourcePath) {
					resources.push({ path: docUrl, content: doc.content, ranges });
				}
			}
			if (resources.length > 0) return resources;
		}
	}

	return [{ path: rawPath, content: resource.content, ranges }];
}

async function resolveInternalSearchInputs(opts: {
	pathSpecs: readonly GrepPathSpec[];
	resolvedPaths: string[];
	cwd: string;
	settings: unknown;
	signal?: AbortSignal;
	archiveDisplayMap: ReadonlyMap<string, string>;
	localProtocolOptions?: LocalProtocolOptions;
	skills?: ResolveContext["skills"];
}): Promise<InternalSearchInputResolution> {
	const internalRouter = InternalUrlRouter.instance();
	const paths = opts.resolvedPaths.slice();
	const virtualResources: VirtualSearchResource[] = [];
	const virtualPathSet = new Set<string>();
	const virtualInputIndexes = new Set<number>();
	const immutableSourcePaths = new Set<string>();
	let virtualScopePath: string | undefined;
	const context: ResolveContext = {
		cwd: opts.cwd,
		settings: opts.settings,
		signal: opts.signal,
		localProtocolOptions: opts.localProtocolOptions,
		skills: opts.skills,
		skipDirectoryListing: true,
		// Try path-only first so large artifacts (and any other handler that
		// separates path from content) resolve without materializing bytes.
		// Handlers that ignore the flag still return content, and virtual
		// resources without a sourcePath fall through to a second resolve.
		pathOnly: true,
	};

	for (let idx = 0; idx < paths.length; idx++) {
		const rawPath = paths[idx];
		if (!rawPath || opts.archiveDisplayMap.has(rawPath) || !internalRouter.canHandle(rawPath)) {
			continue;
		}
		// `ssh://[::1]/path` carries `[`/`]` in the IPv6 authority — glob metacharacters
		// — so check only the path portion for ssh:// (the SSH handler reads a single
		// remote file; there is no glob expansion). A glob in the remote path still trips.
		const globTarget = /^ssh:\/\//i.test(rawPath) ? rawPath.replace(/^ssh:\/\/[^/]*/i, "") : rawPath;
		if (hasGlobPathChars(globTarget)) {
			throw new ToolError(`Glob patterns are not supported for internal URLs: ${rawPath}`);
		}
		let resource = await internalRouter.resolve(rawPath, context);
		// A directory listing with no backing local path (e.g. a remote ssh:// dir)
		// has no real contents to grep — searching its listing text would be
		// misleading. Local/skill/vault dir resources set `sourcePath` and skip this.
		if (resource.isDirectory && !resource.sourcePath) {
			throw new ToolError(
				`search cannot recurse the directory listing at ${rawPath}; search a specific file under it (e.g. ${trimTrailingSlashes(rawPath)}/<file>) or read ${rawPath} to list its entries`,
			);
		}
		if (resource.sourcePath) {
			paths[idx] = resource.sourcePath;
			if (resource.immutable) {
				immutableSourcePaths.add(path.resolve(resource.sourcePath));
			}
			continue;
		}

		// No sourcePath: this handler needs its content materialized so the
		// virtual expansion can search it. Re-resolve without pathOnly.
		if (context.pathOnly) {
			resource = await internalRouter.resolve(rawPath, { ...context, pathOnly: false });
		}

		const ranges = opts.pathSpecs[idx]?.ranges;
		const expanded = await expandVirtualInternalResource(
			rawPath,
			resource,
			internalRouter,
			{ ...context, pathOnly: false },
			ranges,
		);
		virtualInputIndexes.add(idx);
		for (const virtual of expanded) {
			virtualResources.push(virtual);
			virtualPathSet.add(virtual.path);
		}
		virtualScopePath = virtualScopePath ? `${virtualScopePath}, ${rawPath}` : rawPath;
	}

	return {
		resolvedPathsByInput: paths,
		paths: paths.filter((_, idx) => !virtualInputIndexes.has(idx)),
		virtualResources,
		virtualPathSet,
		virtualInputIndexes,
		immutableSourcePaths,
		virtualScopePath,
	};
}

export interface TextSearchDetails {
	truncation?: TruncationSummary;
	fileLimitReached?: number;
	perFileLimitReached?: number;
	linesTruncated?: boolean;
	/** Set when the result lists matching files instead of match lines, so the
	 * frame counts rows in files rather than in matches. */
	pathsOnly?: boolean;
	meta?: OutputMeta;
	scopePath?: string;
	matchCount?: number;
	fileCount?: number;
	files?: string[];
	fileMatches?: Array<{ path: string; count: number }>;
	truncated?: boolean;
	error?: string;
	/** Pre-formatted text for the user-visible TUI render. Mirrors the model-facing
	 * `result.text` lines but uses a `│` gutter and `*` to mark match lines (vs space for
	 * context). The TUI uses this directly so it never parses model-facing hashline anchors. */
	displayContent?: string;
	/** Absolute base directory used during search. Used by the renderer to resolve
	 * display-relative paths to absolute paths for OSC 8 hyperlinks. */
	searchPath?: string;
	/** Session cwd at search time. The renderer resolves the display-relative
	 * (cwd-relative) header/match paths against this for OSC 8 hyperlinks;
	 * `searchPath` is the scope label target, not the display-path base. */
	cwd?: string;
	/** User-supplied paths whose base directory was missing on disk. The tool
	 * skipped these and continued with the surviving entries; surfaced as a
	 * non-fatal warning in the renderer and in the model-facing text. */
	missingPaths?: string[];
}

export function textSearchApproval(args: unknown): ToolTier {
	if (!isRecord(args)) return "read";
	return toPathList(args.path).some(pathTargetsSsh) ? "exec" : "read";
}

/** The native grep options every sub-search of one call shares; each target adds its path and glob. */
type NativeGrepRequest = Omit<GrepOptions, "path" | "glob">;

/** Where native grep runs, and how the scope reads back to the caller. */
type TextSearchScope = Omit<ToolScopeResolution, "immutableSourcePaths">;

/** What native grep returned for the call's physical paths. */
interface NativeSearchOutcome {
	result: GrepResult;
	/** Files native could not map even a prefix of (rare mmap failures); it cannot name them. */
	skippedOversized: number;
	/**
	 * Set when native grep could not compile the pattern as a regex on either engine and demoted
	 * it to a literal search (Law 10: the demotion must not be silent). Same pattern across every
	 * sub-search, so the first non-empty notice is authoritative.
	 */
	literalFallbackError: string | undefined;
}

/** A finished search, before it is paged and rendered. */
interface TextSearchOutcome {
	scope: TextSearchScope;
	result: GrepResult;
	isMultiScope: boolean;
	perFileMatchCap: number;
	hasLineRangeFilters: boolean;
	immutableSourcePaths: ReadonlySet<string>;
	/** Result paths of archive members, which name no file on disk. */
	archiveDisplaySet: ReadonlySet<string>;
	/** Result paths of virtual internal resources, which name no file on disk. */
	virtualPathSet: ReadonlySet<string>;
	warningNote: string | undefined;
}

/** The page of matching files one call shows, and the matches drawn from it. */
interface MatchPage {
	totalFiles: number;
	skipFiles: number;
	windowFiles: string[];
	fileLimitReached: boolean;
	/** A file on this page had more matches than the per-file cap. */
	perFileLimitReached: boolean;
	/** The page's matches, one per file per round, so every file on the page is represented. */
	selectedMatches: GrepMatch[];
}

/** One file's matches as model lines and display lines. */
interface RenderedFileMatches {
	model: string[];
	display: string[];
	/**
	 * Match/context lines whose displayed text was column-truncated (by native grep or JS string
	 * truncation). Excluded from seenLines so a follow-up edit anchored at that line still requires a
	 * full-width re-read — the model saw only the prefix.
	 */
	clippedLines: Set<number>;
}

/** The page's matches grouped by display path and rendered per file. */
interface RenderedSearch {
	/** Display paths, in the order their first match was selected. */
	fileList: string[];
	matchesByFile: Map<string, GrepMatch[]>;
	rendered: Map<string, RenderedFileMatches>;
	/** Whole-file content tag per editable file, so anchors in its lines validate. */
	hashTags: Map<string, string>;
}

/** The output the model is shown, after fitting it to the inline budget. */
interface ShownSearchOutput {
	output: string;
	truncation: TruncationResult | undefined;
	spillArtifactId: string | undefined;
}

const REGEX_ERROR_RE = /^regex(?: parse)? error/i;
const REGEX_ERROR_PREFIX_RE = /^regex(?: parse)? error:?\s*/i;

/** `skip` as a whole number of files; a negative or non-finite value is rejected. */
function normalizeFileSkip(skip: number | null | undefined): number {
	if (skip === undefined || skip === null) return 0;
	if (!Number.isFinite(skip) || skip < 0) throw new ToolError("Skip must be a non-negative number");
	return Math.floor(skip);
}

/** A regex compile failure from either grep engine as the tool error, or undefined for any other failure. */
function invalidRegexError(err: unknown): ToolError | undefined {
	if (!(err instanceof Error) || !REGEX_ERROR_RE.test(err.message)) return undefined;
	return new ToolError(err.message.replace(REGEX_ERROR_PREFIX_RE, "Invalid regex: "));
}

/** A native grep failure as the error the caller can act on. */
function nativeGrepError(err: unknown): unknown {
	const invalidRegex = invalidRegexError(err);
	if (invalidRegex) return invalidRegex;
	if (err instanceof Error && err.message.includes("Aborted: Timeout")) {
		return new ToolError(
			`Text search timed out after ${SEARCH_GREP_TIMEOUT_MS / 1000}s; narrow \`path\` or \`input\`, or locate a tighter scope with \`type: "files"\` first`,
		);
	}
	return err;
}

/** A virtual-resource search failure as the error the caller can act on. */
function virtualSearchError(err: unknown): unknown {
	const invalidRegex = invalidRegexError(err);
	if (invalidRegex) return invalidRegex;
	return err instanceof SyntaxError ? new ToolError(`Invalid regex: ${err.message}`) : err;
}

/** Download a URL `path` entry to a local file native grep can open, recording where it landed. */
async function materializeExternalUrl(
	session: ToolSession,
	rawPath: string,
	materializedExternalPaths: Map<string, string>,
	signal: AbortSignal | undefined,
): Promise<ResolvedExternalSearchUrl | undefined> {
	const target = parseReadUrlTarget(rawPath);
	if (!target) return undefined;
	const { materializeReadUrlToFile } = await loadUrlReader(session);
	const materialized = await materializeReadUrlToFile(session, { path: target.path, raw: target.raw }, signal);
	materializedExternalPaths.set(rawPath, materialized.path);
	return { sourcePath: materialized.path, immutable: true };
}

/**
 * Resolve the physical search scope, adding each immutable source the resolver reports to
 * `immutableSourcePaths`. With no physical path the scope is the virtual resources alone.
 */
async function resolveTextSearchScope(
	session: ToolSession,
	internalResolution: InternalSearchInputResolution,
	archiveDisplayMap: ReadonlyMap<string, string>,
	immutableSourcePaths: Set<string>,
	materializedExternalPaths: Map<string, string>,
	signal: AbortSignal | undefined,
): Promise<TextSearchScope> {
	const searchablePaths = internalResolution.paths;
	if (searchablePaths.length === 0) {
		return {
			searchPath: session.cwd,
			scopePath: internalResolution.virtualScopePath ?? ".",
			globFilter: undefined,
			isDirectory: false,
			missingPaths: [],
		};
	}
	const { immutableSourcePaths: scopeImmutablePaths, ...scope } = await resolveToolSearchScope({
		rawPaths: searchablePaths,
		cwd: session.cwd,
		internalUrlAction: "search",
		trackImmutableSources: true,
		surfaceExactFilePaths: true,
		fanOutFileTargets: true,
		multipathStatHint: " (`path` list entries must each exist relative to cwd)",
		settings: session.settings,
		signal,
		localProtocolOptions: session.localProtocolOptions,
		skills: session.skills,
		resolveExternalUrl: rawPath => materializeExternalUrl(session, rawPath, materializedExternalPaths, signal),
	});
	for (const immutablePath of scopeImmutablePaths) {
		immutableSourcePaths.add(immutablePath);
	}
	// When the only input was an archive selector, surface that selector instead
	// of the temp scratch path the resolver substituted in.
	const physicalScopePath =
		(searchablePaths.length === 1 && archiveDisplayMap.get(scope.searchPath)) || scope.scopePath;
	return {
		...scope,
		scopePath: internalResolution.virtualScopePath
			? `${physicalScopePath}, ${internalResolution.virtualScopePath}`
			: physicalScopePath,
	};
}

/** Run native grep over the physical scope: one call over the scope, or one per target. */
async function searchPhysicalScope(scope: TextSearchScope, request: NativeGrepRequest): Promise<NativeSearchOutcome> {
	try {
		if (scope.exactFilePaths || scope.multiTargets) return await grepTargets(scope, request);
		const result = await grep({ ...request, path: scope.searchPath, glob: scope.globFilter }, undefined);
		return {
			result,
			skippedOversized: result.skippedOversized ?? 0,
			literalFallbackError: result.patternTreatedAsLiteral ?? undefined,
		};
	} catch (err) {
		throw nativeGrepError(err);
	}
}

/**
 * Grep each target in turn and rebase every match onto the scope's search path. Overlapping
 * targets (a directory plus a file nested inside it) surface the same physical line twice; the
 * first occurrence is kept.
 */
async function grepTargets(scope: TextSearchScope, request: NativeGrepRequest): Promise<NativeSearchOutcome> {
	const { exactFilePaths, searchPath } = scope;
	const targets = exactFilePaths
		? exactFilePaths.map(filePath => ({ basePath: filePath, glob: undefined as string | undefined }))
		: (scope.multiTargets ?? []);
	const matches: GrepMatch[] = [];
	const seenMatchKeys = new Set<string>();
	let skippedOversized = 0;
	let literalFallbackError: string | undefined;
	let limitReached = false;
	let totalMatches = 0;
	let filesSearched = 0;
	for (const target of targets) {
		const targetResult = await grep({ ...request, path: target.basePath, glob: target.glob }, undefined);
		skippedOversized += targetResult.skippedOversized ?? 0;
		literalFallbackError ??= targetResult.patternTreatedAsLiteral ?? undefined;
		limitReached = limitReached || Boolean(targetResult.limitReached);
		totalMatches += targetResult.totalMatches;
		filesSearched += targetResult.filesSearched;
		for (const match of targetResult.matches) {
			const absolute = path.resolve(target.basePath, match.path);
			const matchKey = `${absolute}\0${match.lineNumber}`;
			if (seenMatchKeys.has(matchKey)) {
				totalMatches = Math.max(0, totalMatches - 1);
				continue;
			}
			seenMatchKeys.add(matchKey);
			matches.push({ ...match, path: path.relative(searchPath, absolute).replace(/\\/g, "/") });
		}
	}
	return {
		result: {
			matches,
			totalMatches: exactFilePaths ? matches.length : totalMatches,
			filesWithMatches: new Set(matches.map(match => match.path)).size,
			filesSearched: exactFilePaths ? exactFilePaths.length : filesSearched,
			limitReached,
		},
		skippedOversized,
		literalFallbackError,
	};
}

/** Keep only the matches inside each target's line ranges. */
function filterToLineRanges(
	result: GrepResult,
	scopeProvenance: TextSearchScopeProvenance,
	searchPath: string,
): GrepResult {
	const matches = scopeProvenance.filterMatches(result.matches, searchPath);
	return {
		matches,
		totalMatches: matches.length,
		filesWithMatches: new Set(matches.map(match => match.path)).size,
		filesSearched: result.filesSearched,
		limitReached: result.limitReached,
	};
}

/** The file targets the caller named directly; a directory or glob scope names none. */
function explicitFileTargets(scope: TextSearchScope, hasPhysicalPaths: boolean): readonly string[] {
	if (scope.exactFilePaths) return scope.exactFilePaths;
	return hasPhysicalPaths && !scope.isDirectory && !scope.multiTargets ? [scope.searchPath] : [];
}

/**
 * Name the explicit file targets past the native grep size cap. Native searches only their first
 * NATIVE_GREP_MAX_FILE_BYTES; without this note the caller might miss that matches beyond the
 * window (or "no matches") reflect partial coverage, not the whole file.
 */
async function oversizedTargetsNote(cwd: string, targets: readonly string[]): Promise<string | undefined> {
	if (targets.length === 0) return undefined;
	const oversized: string[] = [];
	await Promise.all(
		targets.map(async target => {
			try {
				const st = await stat(target);
				if (st.isFile() && st.size > NATIVE_GREP_MAX_FILE_BYTES) {
					oversized.push(path.relative(cwd, target) || target);
				}
			} catch {
				// Stat failures here are surfaced by other code paths.
			}
		}),
	);
	if (oversized.length === 0) return undefined;
	const limitMb = Math.floor(NATIVE_GREP_MAX_FILE_BYTES / (1024 * 1024));
	return `Searched only the first ${limitMb}MB of large files (matches past the ${limitMb}MB window are not shown; use \`read\` for the rest): ${oversized.join(", ")}`;
}

/** The non-fatal warnings printed after the result, one per line, or undefined when there are none. */
function warningNoteText(
	native: NativeSearchOutcome,
	missingPaths: readonly string[],
	archiveUnreadable: readonly string[],
	oversizedNote: string | undefined,
): string | undefined {
	const notes: string[] = [];
	// The pattern did not compile as a regex on either engine, so native
	// grep matched it literally instead of failing. Surface that loudly —
	// a silent literal demotion hides the recall gap (regex metacharacters
	// were matched as plain text). Listed first: it reframes every result.
	if (native.literalFallbackError) {
		notes.push(
			`Pattern did not compile as a regex (${native.literalFallbackError}); searched for it literally instead. Matches reflect the exact text, not the intended pattern — fix the regex or escape it if a literal search was intended.`,
		);
	}
	// Suppress entries the archive note already explains — they would otherwise
	// double up (the unreadable selector also failed the scope's existence check).
	const archiveUnreadablePaths = new Set(archiveUnreadable.map(s => s.replace(/ \(.*\)$/, "")));
	const missingPathsForNote = missingPaths.filter(p => !archiveUnreadablePaths.has(p));
	if (missingPathsForNote.length > 0) notes.push(`Skipped missing paths: ${missingPathsForNote.join(", ")}`);
	if (archiveUnreadable.length > 0) {
		notes.push(`Skipped archive entries (search supports text members only): ${archiveUnreadable.join(", ")}`);
	}
	if (oversizedNote) {
		notes.push(oversizedNote);
	} else if (native.skippedOversized > 0) {
		// Directory/multi-target scopes: native counts files it could not map
		// even a prefix of (rare mmap failures), but cannot name them.
		notes.push(`Skipped ${native.skippedOversized} unreadable large file(s); target them directly with \`read\``);
	}
	return notes.length > 0 ? notes.join("\n") : undefined;
}

/** Take one match from each list per round until every list is spent. */
function interleaveByFile(lists: readonly (readonly GrepMatch[])[]): GrepMatch[] {
	const out: GrepMatch[] = [];
	const rounds = lists.reduce((longest, list) => Math.max(longest, list.length), 0);
	for (let round = 0; round < rounds; round++) {
		for (const list of lists) {
			if (round < list.length) out.push(list[round]!);
		}
	}
	return out;
}

/**
 * Group matches by file in encounter order, cap each file at `perFileMatchCap`, and select the
 * page of files `skip` names. Per-file overflow is detected BEFORE the cap so the renderer can
 * surface that a hot file was trimmed for diversity.
 */
function pageMatches(
	matches: readonly GrepMatch[],
	perFileMatchCap: number,
	canPaginate: boolean,
	skip: number,
): MatchPage {
	const matchesByPath = new Map<string, GrepMatch[]>();
	for (const match of matches) {
		const list = matchesByPath.get(match.path);
		if (list) list.push(match);
		else matchesByPath.set(match.path, [match]);
	}
	const cappedFiles = new Set<string>();
	for (const [file, list] of matchesByPath) {
		if (list.length > perFileMatchCap) {
			cappedFiles.add(file);
			list.length = perFileMatchCap;
		}
	}
	const fileOrder = [...matchesByPath.keys()];
	const totalFiles = fileOrder.length;
	// Single-file scopes can't paginate — there is one file by definition.
	const skipFiles = canPaginate ? Math.min(skip, totalFiles) : 0;
	const windowFiles = canPaginate ? fileOrder.slice(skipFiles, skipFiles + DEFAULT_FILE_LIMIT) : fileOrder;
	return {
		totalFiles,
		skipFiles,
		windowFiles,
		fileLimitReached: canPaginate && totalFiles > skipFiles + DEFAULT_FILE_LIMIT,
		// The notice prints beside the window's per-file counts, so it has to describe THAT
		// data. Testing every matching file claimed "at least one file had more than 20
		// matches" over a window whose largest count was 12, because the capped file sat
		// past the 20-file page.
		perFileLimitReached: windowFiles.some(file => cappedFiles.has(file)),
		selectedMatches: interleaveByFile(windowFiles.map(file => matchesByPath.get(file) ?? [])),
	};
}

/** The notices that state what the page leaves out, one per line. */
function limitNoticeText(
	page: MatchPage,
	totalFilesLabel: string,
	isMultiScope: boolean,
	perFileMatchCap: number,
	fetchCeilingReached: boolean,
): string {
	const notices: string[] = [];
	if (page.fileLimitReached) {
		const nextSkip = page.skipFiles + page.windowFiles.length;
		notices.push(
			`Showing files ${page.skipFiles + 1}-${nextSkip} of ${totalFilesLabel}. Use skip=${nextSkip} for the next page, or narrow paths/pattern.`,
		);
	}
	if (page.perFileLimitReached) {
		// `skip` pages files, so it reaches nothing past a per-file cap. Left
		// unsaid, a capped count reads as the file's total and the caller
		// stops looking.
		notices.push(
			isMultiScope
				? `At least one file had more than ${perFileMatchCap} matches; each file's count is a floor. Narrow the pattern, or search one file at a time.`
				: `Showing the first ${perFileMatchCap} matches in this file; more matched. Narrow the pattern, or read the region.`,
		);
	}
	if (fetchCeilingReached) {
		// The native fetch stopped at its own ceiling, so files past it were
		// never opened: the file count is a lower bound, and a caller reading
		// it as a total concludes the pattern appears nowhere else.
		notices.push(
			`Search stopped at its internal ceiling of ${INTERNAL_TOTAL_CAP} matches; files past it were not examined, so the file count is a floor. Narrow the pattern or the path.`,
		);
	}
	return notices.join("\n");
}

/** The result of a page with no matches: a skip past the last page, or a search that matched nothing. */
function noMatchResult(
	session: ToolSession,
	outcome: TextSearchOutcome,
	page: MatchPage,
	totalFilesLabel: string,
	skip: number,
): AgentToolResult<TextSearchDetails> {
	const { scope } = outcome;
	const skipPastEnd = outcome.isMultiScope && skip > 0 && page.totalFiles > 0 && page.skipFiles >= page.totalFiles;
	const details: TextSearchDetails = {
		scopePath: scope.scopePath,
		searchPath: scope.searchPath,
		cwd: session.cwd,
		matchCount: skipPastEnd ? outcome.result.totalMatches : 0,
		fileCount: skipPastEnd ? page.totalFiles : 0,
		files: [],
		truncated: false,
		missingPaths: scope.missingPaths.length > 0 ? scope.missingPaths : undefined,
	};
	const noMatchText = skipPastEnd
		? `No more results (${totalFilesLabel} files total; skip=${skip} has exhausted the result set)`
		: "No matches found";
	const text = outcome.warningNote ? `${noMatchText}\n${outcome.warningNote}` : noMatchText;
	const resultBuilder = toolResult(details).text(text);
	if (skipPastEnd) return resultBuilder.done();
	// A true zero-match result is useless: by the time compaction runs,
	// the follow-up call has already corrected course.
	return resultBuilder.useless().done();
}

/** Widest line number among a file's match and context lines. */
function lineNumberWidth(fileMatches: readonly GrepMatch[]): number {
	let width = 0;
	for (const match of fileMatches) {
		width = Math.max(width, String(match.lineNumber).length);
		for (const ctx of match.contextBefore ?? []) width = Math.max(width, String(ctx.lineNumber).length);
		for (const ctx of match.contextAfter ?? []) width = Math.max(width, String(ctx.lineNumber).length);
	}
	return width;
}

/** Render one file's matches with their context, marking a gap between non-adjacent lines. */
function renderFileMatches(fileMatches: readonly GrepMatch[], useHashLines: boolean): RenderedFileMatches {
	const model: string[] = [];
	const display: string[] = [];
	const clippedLines = new Set<number>();
	const width = lineNumberWidth(fileMatches);
	const gutterPad = " ".repeat(width + 1);
	let lastEmittedLine: number | undefined;
	const pushLine = (lineNumber: number, line: string, isMatch: boolean, truncated: boolean | undefined): void => {
		if (lastEmittedLine !== undefined && lineNumber > lastEmittedLine + 1) {
			model.push("...");
			display.push(`${gutterPad}│...`);
		}
		model.push(formatMatchLine(lineNumber, line, isMatch, { useHashLines }));
		display.push(formatCodeFrameLine(isMatch ? "*" : " ", lineNumber, line, width));
		lastEmittedLine = lineNumber;
		if (truncated) clippedLines.add(lineNumber);
	};
	for (const match of fileMatches) {
		for (const ctx of match.contextBefore ?? []) pushLine(ctx.lineNumber, ctx.line, false, ctx.truncated);
		pushLine(match.lineNumber, match.line, true, match.truncated);
		for (const ctx of match.contextAfter ?? []) pushLine(ctx.lineNumber, ctx.line, false, ctx.truncated);
	}
	return { model, display, clippedLines };
}

/**
 * Mint a whole-file content tag for each editable result file so any anchor validates while the
 * file is unchanged. Archive members, virtual resources and immutable sources are not editable;
 * over-cap and unreadable files get no tag (and therefore plain, non-editable line output).
 */
async function mintHashTags(
	session: ToolSession,
	outcome: TextSearchOutcome,
	fileList: readonly string[],
): Promise<Map<string, string>> {
	const hashTags = new Map<string, string>();
	for (const relativePath of fileList) {
		if (outcome.archiveDisplaySet.has(relativePath) || outcome.virtualPathSet.has(relativePath)) continue;
		const absoluteFilePath = path.resolve(session.cwd, relativePath);
		if (isImmutableSearchSourcePath(absoluteFilePath, outcome.immutableSourcePaths)) continue;
		const tag = await recordFileSnapshot(session, absoluteFilePath);
		if (tag) hashTags.set(relativePath, tag);
	}
	return hashTags;
}

/** Group the page's matches by display path and render each file. */
async function renderSearch(
	session: ToolSession,
	outcome: TextSearchOutcome,
	selectedMatches: readonly GrepMatch[],
): Promise<RenderedSearch> {
	const { isDirectory, searchPath } = outcome.scope;
	const matchesByFile = new Map<string, GrepMatch[]>();
	for (const match of selectedMatches) {
		const relativePath =
			outcome.archiveDisplaySet.has(match.path) || outcome.virtualPathSet.has(match.path)
				? match.path
				: formatResultPath(match.path, isDirectory, searchPath, session.cwd);
		const list = matchesByFile.get(relativePath);
		if (list) list.push(match);
		else matchesByFile.set(relativePath, [match]);
	}
	const fileList = [...matchesByFile.keys()];
	const hashTags = resolveFileDisplayMode(session).hashLines
		? await mintHashTags(session, outcome, fileList)
		: new Map<string, string>();
	const rendered = new Map<string, RenderedFileMatches>();
	for (const [relativePath, fileMatches] of matchesByFile) {
		rendered.set(relativePath, renderFileMatches(fileMatches, hashTags.has(relativePath)));
	}
	return { fileList, matchesByFile, rendered, hashTags };
}

/** The rendered files as one body: a grouped directory tree, or files one after another. */
function formatSearchBody(search: RenderedSearch, grouped: boolean): { model: string[]; display: string[] } {
	const { fileList, rendered, hashTags } = search;
	if (grouped) {
		return formatGroupedFiles(fileList, relativePath => {
			const file = rendered.get(relativePath)!;
			const tag = hashTags.get(relativePath);
			return {
				modelLines: file.model,
				displayLines: file.display,
				headerSuffix: tag ? `#${tag}` : "",
				skip: file.model.length === 0,
			};
		});
	}
	const model: string[] = [];
	const display: string[] = [];
	for (const relativePath of fileList) {
		const file = rendered.get(relativePath)!;
		if (file.model.length === 0) continue;
		if (model.length > 0) {
			model.push("");
			display.push("");
		}
		const tag = hashTags.get(relativePath);
		if (tag) model.push(formatHashlineHeader(relativePath, tag));
		model.push(...file.model);
		display.push(...file.display);
	}
	return { model, display };
}

/** Record the lines of each hash-tagged file that `visibleBodyLines` shows, so an edit anchored on one validates. */
function recordVisibleBodyLines(
	session: ToolSession,
	searchPath: string,
	search: RenderedSearch,
	visibleBodyLines: readonly string[],
): void {
	const visibleContexts = classifyGroupedLines(visibleBodyLines, session.cwd, searchPath);
	const visibleLinesByFile = new Map<string, string[]>();
	for (let index = 0; index < visibleBodyLines.length; index++) {
		const context = visibleContexts[index];
		if (context?.kind !== "content" || !context.filePath) continue;
		const absoluteFilePath = path.resolve(context.filePath);
		const fileLines = visibleLinesByFile.get(absoluteFilePath);
		if (fileLines) fileLines.push(visibleBodyLines[index]!);
		else visibleLinesByFile.set(absoluteFilePath, [visibleBodyLines[index]!]);
	}
	for (const [relativePath, tag] of search.hashTags) {
		const absoluteFilePath = path.resolve(session.cwd, relativePath);
		const visibleLines = visibleLinesByFile.get(absoluteFilePath);
		if (!visibleLines) continue;
		recordSeenLinesFromBody(
			session,
			absoluteFilePath,
			tag,
			visibleLines.join("\n"),
			search.rendered.get(relativePath)?.clippedLines,
		);
	}
}

/** Record every rendered line of each hash-tagged file; the output was shown in full. */
function recordAllSeenLines(session: ToolSession, search: RenderedSearch): void {
	for (const [relativePath, tag] of search.hashTags) {
		const file = search.rendered.get(relativePath);
		if (!file) continue;
		recordSeenLinesFromBody(
			session,
			path.resolve(session.cwd, relativePath),
			tag,
			file.model.join("\n"),
			file.clippedLines,
		);
	}
}

/** A file's first representative matches, with a gap marker between non-adjacent lines and after a remainder. */
function representativeLines(fileMatches: readonly GrepMatch[], useHashLines: boolean): string[] {
	const out: string[] = [];
	const representative = fileMatches.slice(0, BROAD_SEARCH_REPRESENTATIVE_MATCHES_PER_FILE);
	let lastEmittedLine: number | undefined;
	for (const match of representative) {
		if (lastEmittedLine !== undefined && match.lineNumber > lastEmittedLine + 1) out.push("...");
		out.push(formatMatchLine(match.lineNumber, match.line, true, { useHashLines }));
		lastEmittedLine = match.lineNumber;
	}
	if (fileMatches.length > representative.length) out.push("...");
	return out;
}

/**
 * The compact page of a broad search: representative matches per file, dropping trailing files
 * and then head-truncating until the page and `footer` fit `budget`.
 */
function compactSearchPage(
	search: RenderedSearch,
	matchCount: number,
	trailer: readonly string[],
	budget: number,
	footer: string,
): { output: string; body: string; lines: string[] } {
	const { fileList, hashTags } = search;
	const representativeByFile = new Map<string, string[]>();
	for (const relativePath of fileList) {
		const fileMatches = search.matchesByFile.get(relativePath) ?? [];
		representativeByFile.set(relativePath, representativeLines(fileMatches, hashTags.has(relativePath)));
	}
	const buildLines = (previewFiles: string[]): string[] => {
		const lines = formatGroupedFiles(previewFiles, relativePath => {
			const tag = hashTags.get(relativePath);
			const modelLines = representativeByFile.get(relativePath) ?? [];
			return { modelLines, headerSuffix: tag ? `#${tag}` : "", skip: modelLines.length === 0 };
		}).model;
		const previewSummary =
			previewFiles.length < fileList.length
				? `[Showing representative matches from ${previewFiles.length} of ${fileList.length} files; ${formatCount("match", matchCount)} total. Narrow path or recover the full output.]`
				: `[Showing up to ${BROAD_SEARCH_REPRESENTATIVE_MATCHES_PER_FILE} representative matches per file; ${formatCount("match", matchCount)} in ${formatCount("file", fileList.length)}.]`;
		lines.push("", previewSummary);
		for (const note of trailer) lines.push("", note);
		return lines;
	};
	const assemble = (body: string): string => `${body}${body.length > 0 && !body.endsWith("\n") ? "\n" : ""}${footer}`;
	let previewFileCount = fileList.length;
	let lines = buildLines(fileList);
	let body = lines.join("\n");
	let output = assemble(body);
	while (previewFileCount > 1 && Buffer.byteLength(output, "utf-8") > budget) {
		previewFileCount -= 1;
		lines = buildLines(fileList.slice(0, previewFileCount));
		body = lines.join("\n");
		output = assemble(body);
	}
	if (Buffer.byteLength(output, "utf-8") > budget) {
		const bodyBudget = Math.max(0, budget - Buffer.byteLength(footer, "utf-8") - 1);
		body = truncateHead(body, { maxLines: Number.MAX_SAFE_INTEGER, maxBytes: bodyBudget }).content;
		lines = body.length > 0 ? body.split("\n") : [];
		output = assemble(body);
	}
	return { output, body, lines };
}

/**
 * A broad multi-file search over the discovery budget: the full output saved to an artifact and a
 * compact page of representative matches per file shown with the recovery footer. Undefined when
 * the output fits the budget or the artifact cannot be written.
 */
async function compactBroadSearch(
	session: ToolSession,
	searchPath: string,
	search: RenderedSearch,
	rawOutput: string,
	totalLines: number,
	trailer: readonly string[],
	matchCount: number,
): Promise<ShownSearchOutput | undefined> {
	const budget = inlineBudgetFor(session, BROAD_SEARCH_INLINE_MAX_BYTES);
	const totalBytes = Buffer.byteLength(rawOutput, "utf-8");
	if (totalBytes <= budget) return undefined;
	const spillArtifactId = await saveOutputArtifact(session, "search-text", rawOutput);
	if (!spillArtifactId) return undefined;
	const page = compactSearchPage(search, matchCount, trailer, budget, artifactFooter(spillArtifactId));
	recordVisibleBodyLines(session, searchPath, search, page.lines);
	return {
		output: page.output,
		spillArtifactId,
		truncation: {
			truncated: true,
			truncatedBy: "bytes",
			content: page.body,
			totalBytes,
			outputBytes: Buffer.byteLength(page.output, "utf-8"),
			totalLines,
			outputLines: page.lines.length,
		},
	};
}

/**
 * Fit the output to the inline budget and record the lines the model is shown.
 *
 * A single query can return a match set that dwarfs the inline floor (the line/column budget
 * alone permits well over a megabyte). A broad multi-file search goes through
 * {@link compactBroadSearch}; a narrow or single-file scope, or a broad one whose artifact cannot
 * be written, is head-truncated to the generic turn-scaled byte budget.
 */
async function fitSearchOutput(
	session: ToolSession,
	searchPath: string,
	search: RenderedSearch,
	outputLines: readonly string[],
	bodyLineCount: number,
	trailer: readonly string[],
	broad: boolean,
	matchCount: number,
): Promise<ShownSearchOutput> {
	const rawOutput = outputLines.join("\n");
	if (broad) {
		const compact = await compactBroadSearch(
			session,
			searchPath,
			search,
			rawOutput,
			outputLines.length,
			trailer,
			matchCount,
		);
		if (compact) return compact;
	}
	const headTruncation = truncateHead(rawOutput, {
		maxLines: Number.MAX_SAFE_INTEGER,
		maxBytes: inlineBudgetFor(session),
	});
	if (!headTruncation.truncated) {
		recordAllSeenLines(session, search);
		return { output: headTruncation.content, truncation: undefined, spillArtifactId: undefined };
	}
	const visibleBodyLines = outputLines.slice(0, Math.min(headTruncation.outputLines ?? 0, bodyLineCount));
	recordVisibleBodyLines(session, searchPath, search, visibleBodyLines);
	const spillArtifactId = await saveOutputArtifact(session, "search-text", rawOutput);
	let output = headTruncation.content;
	if (spillArtifactId) {
		output += `${output.endsWith("\n") ? "" : "\n"}${artifactFooter(spillArtifactId)}`;
	}
	return { output, truncation: headTruncation, spillArtifactId };
}

/** Page, render and fit a finished search into the tool result. */
async function presentTextSearch(
	session: ToolSession,
	outcome: TextSearchOutcome,
	skip: number,
): Promise<AgentToolResult<TextSearchDetails>> {
	const { scope, result, isMultiScope, perFileMatchCap } = outcome;
	const page = pageMatches(result.matches, perFileMatchCap, isMultiScope, skip);
	// Only the fetch ceiling leaves FILES unopened. `limitReached` is also set when a
	// single file's match list was clipped, and reading it here reported "84+" for a
	// search that had enumerated all 84 matching files.
	const fetchCeilingReached = result.totalMatches >= INTERNAL_TOTAL_CAP;
	const totalFilesLabel = fetchCeilingReached ? `${page.totalFiles}+` : `${page.totalFiles}`;
	if (page.selectedMatches.length === 0) return noMatchResult(session, outcome, page, totalFilesLabel, skip);

	const limitMessage = limitNoticeText(page, totalFilesLabel, isMultiScope, perFileMatchCap, fetchCeilingReached);
	const search = await renderSearch(session, outcome, page.selectedMatches);
	const { fileList } = search;
	const useGroupedOutput = scope.isDirectory || isMultiScope;
	const body = formatSearchBody(search, useGroupedOutput);
	const outputLines = body.model;
	const bodyLineCount = outputLines.length;
	const trailer = [limitMessage, outcome.warningNote].filter((note): note is string => Boolean(note));
	for (const note of trailer) outputLines.push("", note);
	const shown = await fitSearchOutput(
		session,
		scope.searchPath,
		search,
		outputLines,
		bodyLineCount,
		trailer,
		useGroupedOutput && !outcome.hasLineRangeFilters && fileList.length > 1,
		page.selectedMatches.length,
	);

	let linesTruncated = false;
	for (const file of search.rendered.values()) linesTruncated ||= file.clippedLines.size > 0;
	const { truncation, spillArtifactId } = shown;
	const truncated = Boolean(
		page.fileLimitReached ||
			page.perFileLimitReached ||
			result.limitReached ||
			truncation?.truncated ||
			linesTruncated,
	);
	const details: TextSearchDetails = {
		scopePath: scope.scopePath,
		searchPath: scope.searchPath,
		cwd: session.cwd,
		matchCount: page.selectedMatches.length,
		fileCount: fileList.length,
		files: fileList,
		fileMatches: fileList.map(file => ({ path: file, count: search.matchesByFile.get(file)?.length ?? 0 })),
		truncated,
		fileLimitReached: page.fileLimitReached ? DEFAULT_FILE_LIMIT : undefined,
		perFileLimitReached: page.perFileLimitReached ? perFileMatchCap : undefined,
		displayContent: body.display.join("\n"),
		missingPaths: scope.missingPaths.length > 0 ? scope.missingPaths : undefined,
	};
	if (truncation?.truncated) details.truncation = truncationSummary(truncation);
	if (linesTruncated) details.linesTruncated = true;
	const resultBuilder = toolResult(details)
		.text(shown.output)
		.limits({ columnMax: linesTruncated ? DEFAULT_MAX_COLUMN : undefined });
	if (truncation?.truncated) {
		resultBuilder.truncation(truncation, { direction: "head", artifactId: spillArtifactId });
	}
	return resultBuilder.done();
}

/** Resolve the inputs past archive extraction, run every search, and merge the results. */
async function runTextSearch(
	session: ToolSession,
	params: TextSearchInput,
	pathSpecs: GrepPathSpec[],
	archives: ArchiveSearchPaths,
	signal: AbortSignal | undefined,
): Promise<TextSearchOutcome> {
	const { pattern } = params;
	const internalResolution = await resolveInternalSearchInputs({
		pathSpecs,
		resolvedPaths: archives.resolvedPaths,
		cwd: session.cwd,
		settings: session.settings,
		signal,
		archiveDisplayMap: archives.displayMap,
		localProtocolOptions: session.localProtocolOptions,
		skills: session.skills,
	});
	const searchablePaths = internalResolution.paths;
	const { virtualResources, virtualInputIndexes } = internalResolution;
	if (
		archives.unreadable.length > 0 &&
		searchablePaths.length === archives.unreadable.length &&
		virtualResources.length === 0
	) {
		// All inputs were archive selectors we couldn't materialize; surface the
		// reason instead of a downstream "path not found" from the scope resolver.
		throw new ToolError(
			`Cannot search archive member(s): ${archives.unreadable.join(", ")}. ` +
				`Read the member with \`read <archive>:<member>\` and inspect the returned text, ` +
				`or pass a UTF-8 text member.`,
		);
	}
	const immutableSourcePaths = new Set(internalResolution.immutableSourcePaths);
	const materializedExternalPaths = new Map<string, string>();
	const scope = await resolveTextSearchScope(
		session,
		internalResolution,
		archives.displayMap,
		immutableSourcePaths,
		materializedExternalPaths,
		signal,
	);
	// Scope provenance is built after scope resolution.
	const scopeProvenance = await TextSearchScopeProvenance.build({
		pathSpecs,
		resolvedPathsByInput: internalResolution.resolvedPathsByInput,
		virtualInputIndexes,
		materializedExternalPaths,
		archiveDisplayMap: archives.displayMap,
		cwd: session.cwd,
	});
	const { missingPaths, searchPath } = scope;
	if (missingPaths.length > 0 && missingPaths.length === searchablePaths.length && virtualResources.length === 0) {
		const archiveHint =
			archives.unreadable.length > 0
				? ` (archive members were not searchable: ${archives.unreadable.join(", ")})`
				: "";
		throw new ToolError(
			`Path not found: ${missingPaths.join(", ")}; list each target in the semicolon-delimited \`path\`${archiveHint}`,
		);
	}

	const isMultiScope =
		scope.isDirectory ||
		Boolean(scope.exactFilePaths) ||
		Boolean(scope.multiTargets) ||
		(virtualResources.length > 0 && (virtualResources.length > 1 || searchablePaths.length > 0));
	const perFileMatchCap = isMultiScope ? MULTI_FILE_PER_FILE_MATCHES : SINGLE_FILE_MATCHES;
	// Range filtering happens in JS after the native fetch, so out-of-range
	// matches consume fetch budget. Widen the per-file budget just enough
	// that filtering can still yield `perFileMatchCap` in-range hits, and
	// scale the global safety ceiling by the same amplification so ranged
	// searches keep the baseline file coverage while staying finite.
	const hasLineRangeFilters = scopeProvenance.hasActiveLineRangeFilters();
	const nativeMaxCountPerFile = hasLineRangeFilters
		? Math.max(perFileMatchCap + 1, lineRangeFetchCap(pathSpecs, perFileMatchCap + 1))
		: perFileMatchCap + 1;
	const nativeMaxCount = hasLineRangeFilters
		? Math.ceil(INTERNAL_TOTAL_CAP / (perFileMatchCap + 1)) * nativeMaxCountPerFile
		: INTERNAL_TOTAL_CAP;
	const ignoreCase = !(params.case ?? true);
	const multiline = pattern.includes("\n") || pattern.includes("\\n");
	const contextBefore = session.settings.get("search.contextBefore");
	const contextAfter = session.settings.get("search.contextAfter");

	const native: NativeSearchOutcome =
		searchablePaths.length > 0
			? await searchPhysicalScope(scope, {
					pattern,
					ignoreCase,
					multiline,
					hidden: true,
					gitignore: params.gitignore ?? true,
					maxCount: nativeMaxCount,
					contextBefore,
					contextAfter,
					maxColumns: DEFAULT_MAX_COLUMN,
					mode: GrepOutputMode.Content,
					maxCountPerFile: nativeMaxCountPerFile,
					signal,
					timeoutMs: SEARCH_GREP_TIMEOUT_MS,
				})
			: {
					result: { matches: [], totalMatches: 0, filesWithMatches: 0, filesSearched: 0, limitReached: false },
					skippedOversized: 0,
					literalFallbackError: undefined,
				};
	let virtualResult: GrepResult;
	try {
		virtualResult = await searchVirtualResources(
			virtualResources,
			pattern,
			ignoreCase,
			multiline,
			contextBefore,
			contextAfter,
			INTERNAL_TOTAL_CAP,
			signal,
		);
	} catch (err) {
		throw virtualSearchError(err);
	}
	let result = mergeGrepResults(native.result, virtualResult, nativeMaxCount);
	if (hasLineRangeFilters) result = filterToLineRanges(result, scopeProvenance, searchPath);
	if (archives.displayMap.size > 0) {
		for (const match of result.matches) {
			const display = archives.displayMap.get(matchAbsolutePath(match.path, searchPath));
			if (display) match.path = display;
		}
	}
	const oversizedNote = await oversizedTargetsNote(
		session.cwd,
		explicitFileTargets(scope, searchablePaths.length > 0),
	);
	return {
		scope,
		result,
		isMultiScope,
		perFileMatchCap,
		hasLineRangeFilters,
		immutableSourcePaths,
		archiveDisplaySet: archives.displaySet,
		virtualPathSet: internalResolution.virtualPathSet,
		warningNote: warningNoteText(native, missingPaths, archives.unreadable, oversizedNote),
	};
}

export async function executeTextSearch(
	session: ToolSession,
	params: TextSearchInput,
	signal?: AbortSignal,
): Promise<AgentToolResult<TextSearchDetails>> {
	return untilAborted(signal, async () => {
		// Preserve the pattern verbatim — leading/trailing whitespace is
		// meaningful in regexes (indentation anchors, trailing-space matches).
		if (!params.pattern.trim()) {
			throw new ToolError("Pattern must not be empty");
		}
		const skip = normalizeFileSkip(params.skip);
		const scopedPaths = toPathList(params.path);
		const rawEntries = await expandDelimitedPathEntries(scopedPaths.length > 0 ? scopedPaths : ["."], session.cwd);
		const pathSpecs = await parsePathSpecs(rawEntries, session.cwd);
		const archives = await resolveArchiveSearchPaths(pathSpecs, session.cwd);
		try {
			const outcome = await runTextSearch(session, params, pathSpecs, archives, signal);
			return await presentTextSearch(session, outcome, skip);
		} finally {
			await archives.cleanup();
		}
	});
}

// =============================================================================
// TUI Renderer
// =============================================================================

export interface TextSearchRenderArgs {
	input: string;
	path?: string;
	case?: boolean;
	gitignore?: boolean;
	skip?: number;
}
