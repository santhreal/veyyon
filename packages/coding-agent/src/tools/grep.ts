import type { Stats } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolTier,
} from "@veyyon/agent-core";
import { formatHashlineHeader } from "@veyyon/hashline";
import { type GrepMatch, GrepOutputMode, type GrepResult, grep } from "@veyyon/natives";
import type { Component } from "@veyyon/tui";
import { Text } from "@veyyon/tui";
import { errorMessage, logger, prompt, trimTrailingSlashes, untilAborted } from "@veyyon/utils";
import { type } from "arktype";
import { recordFileSnapshot, recordSeenLinesFromBody } from "../edit/file-snapshot-store";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { LocalProtocolOptions } from "../internal-urls/local-protocol";
import { InternalUrlRouter } from "../internal-urls/router";
import type { InternalResource, ResolveContext } from "../internal-urls/types";
import type { Theme } from "../modes/theme/theme";
import { toolsPrompts } from "../prompts/tools/rows";
import {
	artifactFooter,
	DEFAULT_MAX_COLUMN,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "../session/streaming-output";
import {
	Ellipsis,
	fileHyperlink,
	framedBlock,
	outputBlockContentWidth,
	renderStatusLine,
	truncateToWidth,
	tryResolveInternalUrlSync,
	uriHyperlink,
} from "../tui";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import { type ArchiveReader, type ExtractedArchiveFile, openArchive, parseArchivePathCandidates } from "../utils/zip";
import type { ToolSession } from ".";
import { searchPathFilesystemTargets } from "./cwd-boundary";
import { materializeReadUrlToFile, parseReadUrlTarget } from "./fetch";
import { createFileRecorder, formatResultPath } from "./file-recorder";
import { classifyGroupedLines, formatGroupedFiles, groupLineIndicesByBlank } from "./grouped-file-output";
import { formatMatchLine } from "./match-line-format";
import { inlineBudgetFor, saveOutputArtifact } from "./output-artifact";
import type { OutputMeta } from "./output-meta";
import {
	expandDelimitedPathEntries,
	hasGlobPathChars,
	isInternalUrlPath,
	isLineInRanges,
	type LineRange,
	parseLineRanges,
	pathTargetsSsh,
	type ResolvedSearchTarget,
	resolveReadPath,
	selectorLineRanges,
	splitInternalUrlSel,
	splitPathAndSel,
	splitPathAndSelPreferringLiteral,
	toPathList,
} from "./path-utils";
import {
	formatCodeFrameLine,
	formatCount,
	formatEmptyMessage,
	formatErrorMessage,
	formatMoreItems,
	formatScopeMeta,
	PREVIEW_LIMITS,
	replaceTabs,
} from "./render-utils";
import { resolveToolSearchScope } from "./search-scope";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

const searchPathEntry = type("string").describe(
	'file, directory, glob, internal URL, or "<file>:<lines>" selector to search (e.g. "src/foo.ts:50-100", "src/foo.ts:50+10", "src/foo.ts:50-100,200-300")',
);
const searchSchema = type({
	pattern: type("string").describe("regex pattern"),
	"path?": searchPathEntry.describe(
		'file, directory, glob, internal URL, or "<file>:<lines>" selector to search; pass several as a semicolon-delimited list ("src; tests"). Omitted -> searches the workspace root (".")',
	),
	"case?": type("boolean").describe("case-sensitive search"),
	"gitignore?": type("boolean").describe("respect gitignore"),
	"skip?": type("number")
		.or("null")
		.describe("files to skip before collecting results — use to paginate when the prior call hit the file limit"),
});

export type GrepToolInput = typeof searchSchema.infer;

export const DEFAULT_FILE_LIMIT = 20;
export const MULTI_FILE_PER_FILE_MATCHES = 20;
export const SINGLE_FILE_MATCHES = 200;
const INTERNAL_TOTAL_CAP = 2000;
const NATIVE_GREP_MAX_FILE_BYTES = 4 * 1024 * 1024;
const SEARCH_GREP_TIMEOUT_MS = 30_000;

interface GrepPathSpec {
	original: string;
	clean: string;
	literalFilesystemMatch?: boolean;
	ranges?: [LineRange, ...LineRange[]];
}
function isReadSelectorGrammar(sel: string | undefined): boolean {
	if (sel === undefined) return true;
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
		if (isInternalUrlPath(entry)) {
			const internalSplit = splitInternalUrlSel(entry);
			if (!isReadSelectorGrammar(internalSplit.sel)) {
				throw new ToolError(
					`path entry "${entry}" has an invalid selector ":${internalSplit.sel}" — use ":N-M" line ranges, ":raw"/":conflicts", a range plus ":raw", or percent-encode a literal ":" as %3A`,
				);
			}
			specs.push({ original: entry, clean: internalSplit.path, ranges: selectorLineRanges(internalSplit.sel) });
			continue;
		}
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
				throw new ToolError(`Line-range selector requires a single file, not a glob: ${entry}`);
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

function mergeRangesInto(map: Map<string, LineRange[]>, absKey: string, ranges: LineRange[]): void {
	const existing = map.get(absKey);
	if (existing) {
		for (let i = 0; i < ranges.length; i++) existing.push(ranges[i]!);
	} else {
		map.set(absKey, ranges.slice());
	}
}

function matchAbsolutePath(matchPath: string, searchPath: string): string {
	if (matchPath === "") return searchPath;
	if (path.isAbsolute(matchPath)) return matchPath;
	return path.resolve(searchPath, matchPath);
}

async function resolveArchiveSearchPaths(
	pathSpecs: readonly GrepPathSpec[],
	cwd: string,
): Promise<{
	resolvedPaths: string[];
	displayMap: Map<string, string>;
	displaySet: Set<string>;
	unreadable: string[];
	cleanup: () => Promise<void>;
}> {
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

			const safeBase = path.basename(member.subPath).replace(/[^\w.-]+/g, "_") || "entry";
			const tempPath = path.join(tempDir, `${idx}-${safeBase}`);
			await writeFile(tempPath, text);
			resolvedPaths[idx] = tempPath;
			displayMap.set(tempPath, entry);
			displaySet.add(entry);
		}
	} catch (error) {
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

function isImmutableSourcePath(filePath: string, immutableSourcePaths: ReadonlySet<string>): boolean {
	for (const immutablePath of immutableSourcePaths) {
		if (filePath === immutablePath || filePath.startsWith(`${immutablePath}${path.sep}`)) {
			return true;
		}
	}
	return false;
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

function lineRangeFetchCap(pathSpecs: readonly GrepPathSpec[], perFileKeep: number): number {
	let cap = 0;
	for (const spec of pathSpecs) {
		if (!spec.ranges) continue;
		for (const range of spec.ranges) {
			cap = Math.max(cap, range.endLine ?? range.startLine - 1 + perFileKeep);
		}
	}
	return Math.min(cap, NATIVE_GREP_MAX_FILE_BYTES);
}

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

function makeContextLine(lines: readonly string[], lineIndex: number): { lineNumber: number; line: string } {
	const { text } = truncateLine(lines[lineIndex] ?? "", DEFAULT_MAX_COLUMN);
	return { lineNumber: lineIndex + 1, line: text };
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

		pathOnly: true,
	};

	for (let idx = 0; idx < paths.length; idx++) {
		const rawPath = paths[idx];
		if (!rawPath || opts.archiveDisplayMap.has(rawPath) || !internalRouter.canHandle(rawPath)) {
			continue;
		}

		const globTarget = /^ssh:\/\//i.test(rawPath) ? rawPath.replace(/^ssh:\/\/[^/]*/i, "") : rawPath;
		if (hasGlobPathChars(globTarget)) {
			throw new ToolError(`Glob patterns are not supported for internal URLs: ${rawPath}`);
		}
		let resource = await internalRouter.resolve(rawPath, context);

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

export interface GrepToolDetails {
	truncation?: TruncationResult;
	fileLimitReached?: number;
	perFileLimitReached?: number;
	linesTruncated?: boolean;
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

type SearchParams = typeof searchSchema.infer;

interface ResolvedGrepScope {
	pathSpecs: GrepPathSpec[];
	searchablePaths: string[];
	virtualResources: VirtualSearchResource[];
	virtualPathSet: Set<string>;
	archiveDisplayMap: Map<string, string>;
	archiveDisplaySet: Set<string>;
	archiveUnreadable: string[];
	cleanupArchiveScratch: () => Promise<void>;
	rangesByAbsPath: Map<string, LineRange[]>;
	searchPath: string;
	scopePath: string;
	globFilter: string | undefined;
	isDirectory: boolean;
	multiTargets: ResolvedSearchTarget[] | undefined;
	exactFilePaths: string[] | undefined;
	missingPaths: string[];
	immutableSourcePaths: Set<string>;
	isMultiScope: boolean;
	perFileMatchCap: number;
}

interface GrepExecutionOutput {
	result: GrepResult;
	skippedOversizedCount: number;
	literalFallbackError?: string;
}

interface PaginatedGrepMatches {
	selectedMatches: GrepMatch[];
	fileOrder: string[];
	matchesByPath: Map<string, GrepMatch[]>;
	totalFiles: number;
	totalFilesLabel: string;
	canPaginate: boolean;
	skipFiles: number;
	fileLimitReached: boolean;
	perFileLimitReached: boolean;
	nextSkip: number;
	limitMessage: string;
}

export class GrepTool implements AgentTool<typeof searchSchema, GrepToolDetails> {
	readonly name = "grep";
	readonly approval = (args: unknown): ToolTier => {
		const a = args as { path?: string | string[]; paths?: string | string[] };
		return toPathList(a.path ?? a.paths).some(pathTargetsSsh) ? "exec" : "read";
	};
	readonly filesystemTargets = (args: unknown, cwd = this.session.cwd): string[] =>
		searchPathFilesystemTargets(args, cwd);
	readonly label = "Grep";
	readonly loadMode = "discoverable";
	readonly summary = "Grep file contents using ripgrep (fast regex search)";
	readonly description: string;
	readonly parameters = searchSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {
		const displayMode = resolveFileDisplayMode(session);
		this.description = prompt.render(toolsPrompts["tools/grep"].text, {
			IS_HL_MODE: displayMode.hashLines,
			IS_LINE_NUMBER_MODE: !displayMode.hashLines && displayMode.lineNumbers,
		});
	}

	#validateParams(
		pattern: string,
		skip: number | null | undefined,
	): { normalizedPattern: string; normalizedSkip: number } {
		if (!pattern.trim()) {
			throw new ToolError("Pattern must not be empty");
		}
		const normalizedSkip =
			skip === undefined || skip === null ? 0 : Number.isFinite(skip) ? Math.floor(skip) : Number.NaN;
		if (normalizedSkip < 0 || !Number.isFinite(normalizedSkip)) {
			throw new ToolError("Skip must be a non-negative number");
		}
		return { normalizedPattern: pattern, normalizedSkip };
	}

	async #expandScope(rawPath: string | string[] | undefined, signal?: AbortSignal): Promise<ResolvedGrepScope> {
		const scopedPaths = toPathList(rawPath);
		const effectivePaths = scopedPaths.length > 0 ? scopedPaths : ["."];
		const rawEntries = await expandDelimitedPathEntries(effectivePaths, this.session.cwd);
		const pathSpecs = await parsePathSpecs(rawEntries, this.session.cwd);
		const materializedExternalPaths = new Map<string, string>();
		const materializeExternalUrlForSearch = async (targetPath: string) => {
			const target = parseReadUrlTarget(targetPath);
			if (!target) return undefined;
			const materialized = await materializeReadUrlToFile(
				this.session,
				{ path: target.path, raw: target.raw },
				signal,
			);
			materializedExternalPaths.set(targetPath, materialized.path);
			return { sourcePath: materialized.path, immutable: true };
		};
		const {
			resolvedPaths,
			displayMap: archiveDisplayMap,
			displaySet: archiveDisplaySet,
			unreadable: archiveUnreadable,
			cleanup: cleanupArchiveScratch,
		} = await resolveArchiveSearchPaths(pathSpecs, this.session.cwd);

		try {
			const internalResolution = await resolveInternalSearchInputs({
				pathSpecs,
				resolvedPaths,
				cwd: this.session.cwd,
				settings: this.session.settings,
				signal,
				archiveDisplayMap,
				localProtocolOptions: this.session.localProtocolOptions,
				skills: this.session.skills,
			});
			const searchablePaths = internalResolution.paths;
			const { virtualResources, virtualPathSet, virtualInputIndexes } = internalResolution;
			const rangesByAbsPath = new Map<string, LineRange[]>();

			if (
				archiveUnreadable.length > 0 &&
				searchablePaths.length === archiveUnreadable.length &&
				virtualResources.length === 0
			) {
				throw new ToolError(
					`Cannot search archive member(s): ${archiveUnreadable.join(", ")}. ` +
						`Read the member with \`read <archive>:<member>\` and inspect the returned text, ` +
						`or pass a UTF-8 text member.`,
				);
			}

			let searchPath: string;
			let scopePath: string;
			let globFilter: string | undefined;
			let isDirectory: boolean;
			let multiTargets: ResolvedSearchTarget[] | undefined;
			let exactFilePaths: string[] | undefined;
			let missingPaths: string[];
			const immutableSourcePaths = new Set(internalResolution.immutableSourcePaths);

			if (searchablePaths.length > 0) {
				const scope = await resolveToolSearchScope({
					rawPaths: searchablePaths,
					cwd: this.session.cwd,
					internalUrlAction: "search",
					trackImmutableSources: true,
					surfaceExactFilePaths: true,
					fanOutFileTargets: true,
					multipathStatHint: " (`path` list entries must each exist relative to cwd)",
					settings: this.session.settings,
					signal,
					localProtocolOptions: this.session.localProtocolOptions,
					skills: this.session.skills,
					resolveExternalUrl: materializeExternalUrlForSearch,
				});
				searchPath = scope.searchPath;
				isDirectory = scope.isDirectory;
				multiTargets = scope.multiTargets;
				exactFilePaths = scope.exactFilePaths;
				missingPaths = scope.missingPaths;
				globFilter = scope.globFilter;
				for (const immutablePath of scope.immutableSourcePaths) {
					immutableSourcePaths.add(immutablePath);
				}
				for (let idx = 0; idx < pathSpecs.length; idx++) {
					const spec = pathSpecs[idx];
					if (!spec.ranges) continue;
					if (virtualInputIndexes.has(idx)) continue;
					const resolved = internalResolution.resolvedPathsByInput[idx];
					if (!resolved) continue;
					const materializedExternalPath = materializedExternalPaths.get(spec.clean);
					if (materializedExternalPath) {
						mergeRangesInto(rangesByAbsPath, path.resolve(materializedExternalPath), spec.ranges);
						continue;
					}
					if (resolved === spec.clean && !archiveDisplayMap.has(resolved)) {
						const absKey = path.resolve(resolveReadPath(resolved, this.session.cwd));
						let stats: Stats | undefined;
						try {
							stats = await stat(absKey);
						} catch (error) {
							const code = (error as { code?: string }).code;
							if (code === "ENOENT") {
								throw new ToolError(`Path not found for line-range selector: ${spec.original}`);
							}
							throw new ToolError(
								`Could not read path for line-range selector: ${spec.original}: ${errorMessage(error)}`,
							);
						}
						if (!stats.isFile()) {
							throw new ToolError(`Line-range selector requires a single file: ${spec.original} is a directory`);
						}
						mergeRangesInto(rangesByAbsPath, absKey, spec.ranges);
					} else {
						mergeRangesInto(rangesByAbsPath, path.resolve(resolved), spec.ranges);
					}
				}
				const physicalScopePath =
					searchablePaths.length === 1 && archiveDisplayMap.get(searchPath)
						? (archiveDisplayMap.get(searchPath) as string)
						: scope.scopePath;
				scopePath = internalResolution.virtualScopePath
					? `${physicalScopePath}, ${internalResolution.virtualScopePath}`
					: physicalScopePath;
			} else {
				searchPath = this.session.cwd;
				scopePath = internalResolution.virtualScopePath ?? ".";
				globFilter = undefined;
				isDirectory = false;
				multiTargets = undefined;
				exactFilePaths = undefined;
				missingPaths = [];
			}

			if (
				missingPaths.length > 0 &&
				missingPaths.length === searchablePaths.length &&
				virtualResources.length === 0
			) {
				const archiveHint =
					archiveUnreadable.length > 0
						? ` (archive members were not searchable: ${archiveUnreadable.join(", ")})`
						: "";
				throw new ToolError(
					`Path not found: ${missingPaths.join(", ")}; list each target in the semicolon-delimited \`path\`${archiveHint}`,
				);
			}

			const isMultiScope =
				isDirectory ||
				Boolean(exactFilePaths) ||
				Boolean(multiTargets) ||
				(virtualResources.length > 0 && (virtualResources.length > 1 || searchablePaths.length > 0));
			const perFileMatchCap = isMultiScope ? MULTI_FILE_PER_FILE_MATCHES : SINGLE_FILE_MATCHES;

			return {
				pathSpecs,
				searchablePaths,
				virtualResources,
				virtualPathSet,
				archiveDisplayMap,
				archiveDisplaySet,
				archiveUnreadable,
				cleanupArchiveScratch,
				rangesByAbsPath,
				searchPath,
				scopePath,
				globFilter,
				isDirectory,
				multiTargets,
				exactFilePaths,
				missingPaths,
				immutableSourcePaths,
				isMultiScope,
				perFileMatchCap,
			};
		} catch (error) {
			await cleanupArchiveScratch();
			throw error;
		}
	}

	async #executeGrep(
		scope: ResolvedGrepScope,
		normalizedPattern: string,
		caseSensitive: boolean | undefined,
		gitignore: boolean | undefined,
		signal?: AbortSignal,
	): Promise<GrepExecutionOutput> {
		const normalizedContextBefore = this.session.settings.get("grep.contextBefore");
		const normalizedContextAfter = this.session.settings.get("grep.contextAfter");
		const ignoreCase = !(caseSensitive ?? true);
		const useGitignore = gitignore ?? true;
		const effectiveMultiline = normalizedPattern.includes("\n") || normalizedPattern.includes("\\n");
		const effectiveOutputMode = GrepOutputMode.Content;

		const hasLineRangeFilters = scope.pathSpecs.some(spec => spec.ranges);
		const nativeMaxCountPerFile = hasLineRangeFilters
			? Math.max(scope.perFileMatchCap + 1, lineRangeFetchCap(scope.pathSpecs, scope.perFileMatchCap + 1))
			: scope.perFileMatchCap + 1;
		const nativeMaxCount = hasLineRangeFilters
			? Math.ceil(INTERNAL_TOTAL_CAP / (scope.perFileMatchCap + 1)) * nativeMaxCountPerFile
			: INTERNAL_TOTAL_CAP;

		let result: GrepResult = {
			matches: [],
			totalMatches: 0,
			filesWithMatches: 0,
			filesSearched: 0,
			limitReached: false,
		};
		let skippedOversizedCount = 0;
		let literalFallbackError: string | undefined;

		try {
			if (scope.searchablePaths.length > 0) {
				if (scope.exactFilePaths || scope.multiTargets) {
					const matches: GrepMatch[] = [];
					const seenMatchKeys = new Set<string>();
					let limitReached = false;
					let totalMatches = 0;
					let filesSearched = 0;
					const targets = scope.exactFilePaths
						? scope.exactFilePaths.map(filePath => ({
								basePath: filePath,
								glob: undefined as string | undefined,
							}))
						: (scope.multiTargets ?? []);
					for (const target of targets) {
						const targetResult = await grep(
							{
								pattern: normalizedPattern,
								path: target.basePath,
								glob: target.glob,
								ignoreCase,
								multiline: effectiveMultiline,
								hidden: true,
								gitignore: useGitignore,
								maxCount: nativeMaxCount,
								contextBefore: normalizedContextBefore,
								contextAfter: normalizedContextAfter,
								maxColumns: DEFAULT_MAX_COLUMN,
								mode: effectiveOutputMode,
								maxCountPerFile: nativeMaxCountPerFile,
								signal,
								timeoutMs: SEARCH_GREP_TIMEOUT_MS,
							},
							undefined,
						);
						skippedOversizedCount += targetResult.skippedOversized ?? 0;
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
							const rebased = path.relative(scope.searchPath, absolute).replace(/\\/g, "/");
							matches.push({ ...match, path: rebased });
						}
					}
					result = {
						matches,
						totalMatches: scope.exactFilePaths ? matches.length : totalMatches,
						filesWithMatches: new Set(matches.map(match => match.path)).size,
						filesSearched: scope.exactFilePaths ? scope.exactFilePaths.length : filesSearched,
						limitReached,
					};
				} else {
					result = await grep(
						{
							pattern: normalizedPattern,
							path: scope.searchPath,
							glob: scope.globFilter,
							ignoreCase,
							multiline: effectiveMultiline,
							hidden: true,
							gitignore: useGitignore,
							maxCount: nativeMaxCount,
							contextBefore: normalizedContextBefore,
							contextAfter: normalizedContextAfter,
							maxColumns: DEFAULT_MAX_COLUMN,
							mode: effectiveOutputMode,
							maxCountPerFile: nativeMaxCountPerFile,
							signal,
							timeoutMs: SEARCH_GREP_TIMEOUT_MS,
						},
						undefined,
					);
					skippedOversizedCount = result.skippedOversized ?? 0;
					literalFallbackError ??= result.patternTreatedAsLiteral ?? undefined;
				}
			}
		} catch (err) {
			if (err instanceof Error && /^regex(?: parse)? error/i.test(err.message)) {
				throw new ToolError(err.message.replace(/^regex(?: parse)? error:?\s*/i, "Invalid regex: "));
			}
			if (err instanceof Error && err.message.includes("Aborted: Timeout")) {
				throw new ToolError(
					`Grep timed out after ${SEARCH_GREP_TIMEOUT_MS / 1000}s; narrow paths or pattern, or scope with \`glob\` first`,
				);
			}
			throw err;
		}

		let virtualResult: GrepResult;
		try {
			virtualResult = await searchVirtualResources(
				scope.virtualResources,
				normalizedPattern,
				ignoreCase,
				effectiveMultiline,
				normalizedContextBefore,
				normalizedContextAfter,
				INTERNAL_TOTAL_CAP,
				signal,
			);
		} catch (err) {
			if (err instanceof Error && /^regex(?: parse)? error/i.test(err.message)) {
				throw new ToolError(err.message.replace(/^regex(?: parse)? error:?\s*/i, "Invalid regex: "));
			}
			if (err instanceof SyntaxError) {
				throw new ToolError(`Invalid regex: ${err.message}`);
			}
			throw err;
		}

		result = mergeGrepResults(result, virtualResult, nativeMaxCount);

		if (scope.rangesByAbsPath.size > 0) {
			const filteredMatches: GrepMatch[] = [];
			for (const match of result.matches) {
				const abs = matchAbsolutePath(match.path, scope.searchPath);
				const ranges = scope.rangesByAbsPath.get(abs);
				if (!ranges) {
					filteredMatches.push(match);
					continue;
				}
				if (!isLineInRanges(match.lineNumber, ranges)) continue;
				const trimBefore = match.contextBefore?.filter(c => isLineInRanges(c.lineNumber, ranges));
				const trimAfter = match.contextAfter?.filter(c => isLineInRanges(c.lineNumber, ranges));
				filteredMatches.push({
					...match,
					contextBefore: trimBefore && trimBefore.length > 0 ? trimBefore : undefined,
					contextAfter: trimAfter && trimAfter.length > 0 ? trimAfter : undefined,
				});
			}
			result = {
				matches: filteredMatches,
				totalMatches: filteredMatches.length,
				filesWithMatches: new Set(filteredMatches.map(match => match.path)).size,
				filesSearched: result.filesSearched,
				limitReached: result.limitReached,
			};
		}

		if (scope.archiveDisplayMap.size > 0) {
			for (const match of result.matches) {
				const abs = matchAbsolutePath(match.path, scope.searchPath);
				const display = scope.archiveDisplayMap.get(abs);
				if (display) match.path = display;
			}
		}

		return { result, skippedOversizedCount, literalFallbackError };
	}

	#paginateMatches(result: GrepResult, scope: ResolvedGrepScope, normalizedSkip: number): PaginatedGrepMatches {
		const fileOrder: string[] = [];
		const matchesByPath = new Map<string, GrepMatch[]>();
		for (const match of result.matches) {
			if (!matchesByPath.has(match.path)) {
				fileOrder.push(match.path);
				matchesByPath.set(match.path, []);
			}
			matchesByPath.get(match.path)!.push(match);
		}
		let perFileLimitReached = false;
		for (const file of fileOrder) {
			const list = matchesByPath.get(file)!;
			if (list.length > scope.perFileMatchCap) {
				perFileLimitReached = true;
				list.length = scope.perFileMatchCap;
			}
		}
		const totalFiles = fileOrder.length;
		const totalFilesLabel = result.limitReached ? `${totalFiles}+` : `${totalFiles}`;
		const canPaginate = scope.isMultiScope;
		const skipFiles = canPaginate ? Math.min(normalizedSkip, totalFiles) : 0;
		const windowFiles = canPaginate ? fileOrder.slice(skipFiles, skipFiles + DEFAULT_FILE_LIMIT) : fileOrder;
		const fileLimitReached = canPaginate && totalFiles > skipFiles + DEFAULT_FILE_LIMIT;
		const selectedMatches: GrepMatch[] = [];
		if (windowFiles.length > 0) {
			const lists = windowFiles.map(file => matchesByPath.get(file) ?? []);
			const cursors = new Array<number>(lists.length).fill(0);
			let anyAdded = true;
			while (anyAdded) {
				anyAdded = false;
				for (let i = 0; i < lists.length; i++) {
					if (cursors[i] < lists[i].length) {
						selectedMatches.push(lists[i][cursors[i]++]);
						anyAdded = true;
					}
				}
			}
		}
		const nextSkip = skipFiles + windowFiles.length;
		const limitMessage = fileLimitReached
			? `Showing files ${skipFiles + 1}-${nextSkip} of ${totalFilesLabel}. Use skip=${nextSkip} for the next page, or narrow paths/pattern.`
			: "";

		return {
			selectedMatches,
			fileOrder,
			matchesByPath,
			totalFiles,
			totalFilesLabel,
			canPaginate,
			skipFiles,
			fileLimitReached,
			perFileLimitReached,
			nextSkip,
			limitMessage,
		};
	}

	async #detectOversizedFiles(scope: ResolvedGrepScope): Promise<string | undefined> {
		const explicitFileTargets: string[] = [];
		if (scope.exactFilePaths) {
			for (let ei = 0; ei < scope.exactFilePaths.length; ei++) explicitFileTargets.push(scope.exactFilePaths[ei]!);
		} else if (scope.searchablePaths.length > 0 && !scope.isDirectory && !scope.multiTargets) {
			explicitFileTargets.push(scope.searchPath);
		}
		if (explicitFileTargets.length === 0) return undefined;
		const oversized: string[] = [];
		await Promise.all(
			explicitFileTargets.map(async target => {
				try {
					const st = await stat(target);
					if (st.isFile() && st.size > NATIVE_GREP_MAX_FILE_BYTES) {
						oversized.push(path.relative(this.session.cwd, target) || target);
					}
				} catch {
					// Stat failure handled elsewhere
				}
			}),
		);
		if (oversized.length === 0) return undefined;
		const limitMb = Math.floor(NATIVE_GREP_MAX_FILE_BYTES / (1024 * 1024));
		return `Searched only the first ${limitMb}MB of large files (matches past the ${limitMb}MB window are not shown; use \`read\` for the rest): ${oversized.join(", ")}`;
	}

	#renderFileMatches(
		relativePath: string,
		matchesByFile: Map<string, GrepMatch[]>,
		hashContexts: Map<string, { tag: string }>,
		fileMatchCounts: Map<string, number>,
	): { model: string[]; display: string[]; linesTruncated: boolean } {
		const modelOut: string[] = [];
		const displayOut: string[] = [];
		let linesTruncated = false;
		const fileMatches = matchesByFile.get(relativePath) ?? [];
		const hashContext = hashContexts.get(relativePath);
		const useHashLines = hashContext !== undefined;
		const lineNumberWidth = fileMatches.reduce((width, match) => {
			let nextWidth = Math.max(width, String(match.lineNumber).length);
			for (const ctx of match.contextBefore ?? []) {
				nextWidth = Math.max(nextWidth, String(ctx.lineNumber).length);
			}
			for (const ctx of match.contextAfter ?? []) {
				nextWidth = Math.max(nextWidth, String(ctx.lineNumber).length);
			}
			return nextWidth;
		}, 0);
		let lastEmittedLine: number | undefined;
		const gutterPad = " ".repeat(lineNumberWidth + 1);
		const clippedLines = new Set<number>();
		const isNativeTruncated = (line: string): boolean => line.length >= DEFAULT_MAX_COLUMN && line.endsWith("...");

		for (const match of fileMatches) {
			const pushLine = (lineNumber: number, line: string, isMatch: boolean) => {
				if (lastEmittedLine !== undefined && lineNumber > lastEmittedLine + 1) {
					modelOut.push("...");
					displayOut.push(`${gutterPad}│...`);
				}
				modelOut.push(formatMatchLine(lineNumber, line, isMatch, { useHashLines }));
				displayOut.push(formatCodeFrameLine(isMatch ? "*" : " ", lineNumber, line, lineNumberWidth));
				lastEmittedLine = lineNumber;
			};
			if (match.contextBefore) {
				for (const ctx of match.contextBefore) {
					pushLine(ctx.lineNumber, ctx.line, false);
					if (isNativeTruncated(ctx.line)) clippedLines.add(ctx.lineNumber);
				}
			}
			pushLine(match.lineNumber, match.line, true);
			if (match.truncated) {
				linesTruncated = true;
				clippedLines.add(match.lineNumber);
			}
			if (match.contextAfter) {
				for (const ctx of match.contextAfter) {
					pushLine(ctx.lineNumber, ctx.line, false);
					if (isNativeTruncated(ctx.line)) clippedLines.add(ctx.lineNumber);
				}
			}
			fileMatchCounts.set(relativePath, (fileMatchCounts.get(relativePath) ?? 0) + 1);
		}
		if (hashContext?.tag) {
			const absoluteFilePath = path.resolve(this.session.cwd, relativePath);
			recordSeenLinesFromBody(this.session, absoluteFilePath, hashContext.tag, modelOut.join("\n"), clippedLines);
		}
		return { model: modelOut, display: displayOut, linesTruncated };
	}

	async #formatResult(
		paginated: PaginatedGrepMatches,
		searchOutput: GrepExecutionOutput,
		scope: ResolvedGrepScope,
		normalizedSkip: number,
	): Promise<AgentToolResult<GrepToolDetails>> {
		const {
			selectedMatches,
			totalFiles,
			totalFilesLabel,
			canPaginate,
			skipFiles,
			fileLimitReached,
			perFileLimitReached,
			limitMessage,
		} = paginated;
		const { result, skippedOversizedCount, literalFallbackError } = searchOutput;
		const {
			searchPath,
			scopePath,
			isDirectory,
			isMultiScope,
			archiveDisplaySet,
			virtualPathSet,
			archiveUnreadable,
			missingPaths,
			immutableSourcePaths,
			perFileMatchCap,
		} = scope;

		const oversizedNote = await this.#detectOversizedFiles(scope);
		const oversizedScanNote =
			!oversizedNote && skippedOversizedCount > 0
				? `Skipped ${skippedOversizedCount} unreadable large file(s); target them directly with \`read\``
				: undefined;
		const archiveNote =
			archiveUnreadable.length > 0
				? `Skipped archive entries (search supports text members only): ${archiveUnreadable.join(", ")}`
				: undefined;
		const archiveUnreadablePaths = new Set(archiveUnreadable.map(s => s.replace(/ \(.*\)$/, "")));
		const missingPathsForNote = missingPaths.filter(p => !archiveUnreadablePaths.has(p));
		const missingPathsNote =
			missingPathsForNote.length > 0 ? `Skipped missing paths: ${missingPathsForNote.join(", ")}` : undefined;
		const literalFallbackNote = literalFallbackError
			? `Pattern did not compile as a regex (${literalFallbackError}); searched for it literally instead. Matches reflect the exact text, not the intended pattern — fix the regex or escape it if a literal search was intended.`
			: undefined;
		const warningNote =
			[literalFallbackNote, missingPathsNote, archiveNote, oversizedNote, oversizedScanNote]
				.filter((s): s is string => Boolean(s))
				.join("\n") || undefined;

		if (selectedMatches.length === 0) {
			const details: GrepToolDetails = {
				scopePath,
				searchPath,
				cwd: this.session.cwd,
				matchCount: 0,
				fileCount: 0,
				files: [],
				truncated: false,
				missingPaths: missingPaths.length > 0 ? missingPaths : undefined,
			};
			const skipPastEnd = canPaginate && normalizedSkip > 0 && totalFiles > 0 && skipFiles >= totalFiles;
			const noMatchText = skipPastEnd
				? `No more results (${totalFilesLabel} files total; skip=${normalizedSkip} is past the end)`
				: "No matches found";
			const text = warningNote ? `${noMatchText}\n${warningNote}` : noMatchText;
			return toolResult(details).text(text).useless().done();
		}

		const formatPath = (filePath: string): string =>
			archiveDisplaySet.has(filePath) || virtualPathSet.has(filePath)
				? filePath
				: formatResultPath(filePath, isDirectory, searchPath, this.session.cwd);

		const { record: recordFile, list: fileList } = createFileRecorder();
		const matchesByFile = new Map<string, GrepMatch[]>();
		for (const match of selectedMatches) {
			const relativePath = formatPath(match.path);
			recordFile(relativePath);
			if (!matchesByFile.has(relativePath)) {
				matchesByFile.set(relativePath, []);
			}
			matchesByFile.get(relativePath)!.push(match);
		}

		const baseDisplayMode = resolveFileDisplayMode(this.session);
		const hashContexts = new Map<string, { tag: string }>();
		if (baseDisplayMode.hashLines) {
			for (const relativePath of fileList) {
				if (archiveDisplaySet.has(relativePath) || virtualPathSet.has(relativePath)) continue;
				const absoluteFilePath = path.resolve(this.session.cwd, relativePath);
				if (isImmutableSourcePath(absoluteFilePath, immutableSourcePaths)) continue;
				const tag = await recordFileSnapshot(this.session, absoluteFilePath);
				if (tag) hashContexts.set(relativePath, { tag });
			}
		}

		const outputLines: string[] = [];
		const displayLines: string[] = [];
		const fileMatchCounts = new Map<string, number>();
		let anyLinesTruncated = false;

		const useGroupedOutput = isDirectory || isMultiScope;
		if (useGroupedOutput) {
			const grouped = formatGroupedFiles(fileList, relativePath => {
				const rendered = this.#renderFileMatches(relativePath, matchesByFile, hashContexts, fileMatchCounts);
				if (rendered.linesTruncated) anyLinesTruncated = true;
				const hashContext = hashContexts.get(relativePath);
				return {
					modelLines: rendered.model,
					displayLines: rendered.display,
					headerSuffix: hashContext?.tag ? `#${hashContext.tag}` : "",
					skip: rendered.model.length === 0,
				};
			});
			for (let gi = 0; gi < grouped.model.length; gi++) outputLines.push(grouped.model[gi]!);
			for (let gi = 0; gi < grouped.display.length; gi++) displayLines.push(grouped.display[gi]!);
		} else {
			for (const relativePath of fileList) {
				const rendered = this.#renderFileMatches(relativePath, matchesByFile, hashContexts, fileMatchCounts);
				if (rendered.linesTruncated) anyLinesTruncated = true;
				if (rendered.model.length === 0) continue;
				if (outputLines.length > 0) {
					outputLines.push("");
					displayLines.push("");
				}
				const hashContext = hashContexts.get(relativePath);
				if (hashContext?.tag) {
					outputLines.push(formatHashlineHeader(relativePath, hashContext.tag));
				}
				for (let li = 0; li < rendered.model.length; li++) outputLines.push(rendered.model[li]!);
				for (let li = 0; li < rendered.display.length; li++) displayLines.push(rendered.display[li]!);
			}
		}

		if (limitMessage) outputLines.push("", limitMessage);
		if (warningNote) outputLines.push("", warningNote);

		const rawOutput = outputLines.join("\n");
		const truncation = truncateHead(rawOutput, {
			maxLines: Number.MAX_SAFE_INTEGER,
			maxBytes: inlineBudgetFor(this.session),
		});
		let output = truncation.content;
		let spillArtifactId: string | undefined;
		if (truncation.truncated) {
			spillArtifactId = await saveOutputArtifact(this.session, "grep", rawOutput);
			if (spillArtifactId) {
				const sep = output.endsWith("\n") ? "" : "\n";
				output += `${sep}${artifactFooter(spillArtifactId)}`;
			}
		}

		const displayText = displayLines.join("\n");
		const truncated = Boolean(
			fileLimitReached || perFileLimitReached || result.limitReached || truncation.truncated || anyLinesTruncated,
		);
		const details: GrepToolDetails = {
			scopePath,
			searchPath,
			cwd: this.session.cwd,
			matchCount: selectedMatches.length,
			fileCount: fileList.length,
			files: fileList,
			fileMatches: fileList.map(p => ({
				path: p,
				count: fileMatchCounts.get(p) ?? 0,
			})),
			truncated,
			fileLimitReached: fileLimitReached ? DEFAULT_FILE_LIMIT : undefined,
			perFileLimitReached: perFileLimitReached ? perFileMatchCap : undefined,
			displayContent: displayText,
			missingPaths: missingPaths.length > 0 ? missingPaths : undefined,
		};
		if (truncation.truncated) details.truncation = truncation;
		if (anyLinesTruncated) details.linesTruncated = true;
		const resultBuilder = toolResult(details)
			.text(output)
			.limits({ columnMax: anyLinesTruncated ? DEFAULT_MAX_COLUMN : undefined });
		if (truncation.truncated) {
			resultBuilder.truncation(truncation, { direction: "head", artifactId: spillArtifactId });
		}
		return resultBuilder.done();
	}

	async execute(
		_toolCallId: string,
		params: SearchParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<GrepToolDetails>,
		_toolContext?: AgentToolContext,
	): Promise<AgentToolResult<GrepToolDetails>> {
		const { pattern, path: rawPath, case: caseSensitive, gitignore, skip } = params;

		return untilAborted(signal, async () => {
			const { normalizedPattern, normalizedSkip } = this.#validateParams(pattern, skip);
			const scope = await this.#expandScope(rawPath, signal);
			try {
				const searchOutput = await this.#executeGrep(scope, normalizedPattern, caseSensitive, gitignore, signal);
				const paginated = this.#paginateMatches(searchOutput.result, scope, normalizedSkip);
				return await this.#formatResult(paginated, searchOutput, scope, normalizedSkip);
			} finally {
				await scope.cleanupArchiveScratch();
			}
		});
	}
}

interface GrepRenderArgs {
	pattern: string;
	path?: string | string[];
	/** Legacy pre-`path` argument name; kept so historical transcripts still render a scope. */
	paths?: string | string[];
	case?: boolean;
	gitignore?: boolean;
	skip?: number;
}

const COLLAPSED_TEXT_LIMIT = PREVIEW_LIMITS.COLLAPSED_LINES * 2;
/** Line budget for the expanded view. Larger than collapsed so expanding
 * reveals more matches with context, but still bounded so a single hot file
 * whose matches span the whole file can't dump its entire length. */
const EXPANDED_TEXT_LIMIT = PREVIEW_LIMITS.EXPANDED_LINES * 2;

const SEARCH_CODE_FRAME_LINE_RE = /^\s*\*?(\d+)│/;

function searchScopeMeta(details: GrepToolDetails | undefined): string | undefined {
	if (!details?.scopePath) return undefined;
	const label = details.searchPath ? fileHyperlink(details.searchPath, details.scopePath) : details.scopePath;
	return `in ${label}`;
}

function linkUrlLikeSearchHeader(raw: string, styled: string): { line: string; absPath?: string } {
	const resolvedPath = tryResolveInternalUrlSync(raw);
	if (resolvedPath) return { line: fileHyperlink(resolvedPath, styled), absPath: resolvedPath };
	return { line: uriHyperlink(raw, styled) };
}

function parseSearchDisplayLineNumber(line: string): number | undefined {
	const match = SEARCH_CODE_FRAME_LINE_RE.exec(line);
	if (!match) return undefined;
	return Number.parseInt(match[1]!, 10);
}

const SEARCH_MATCH_LINE_RE = /^\s*\*\d+(?:│|[:|])/;

interface RenderedSearchLine {
	raw: string;
	styled: string;
}

function isSearchMatchLine(line: string): boolean {
	return SEARCH_MATCH_LINE_RE.test(line);
}

function isSearchHeaderLine(line: string): boolean {
	return /^#+ /.test(line);
}

const URL_HEADER_PREFIX_RE = /^#+\s+/;

function renderSearchDisplayLines(
	lines: readonly string[],
	headerBase: string | undefined,
	fileScope: string | undefined,
	uiTheme: Theme,
): RenderedSearchLine[] {
	const contexts = classifyGroupedLines(lines, headerBase, fileScope);
	// `classifyGroupedLines` can't resolve internal URLs (TUI-only), so track the
	// resolved URL target here and use it for the body lines that follow.
	let urlFile: string | undefined;
	return lines.map((line, index) => {
		const ctx = contexts[index]!;
		if (ctx.kind === "dir") {
			urlFile = undefined;
			const styled = uiTheme.fg("accent", line);
			return { raw: line, styled: ctx.headerPath ? fileHyperlink(ctx.headerPath, styled) : styled };
		}
		if (ctx.kind === "file") {
			if (ctx.isUrl) {
				const raw = line
					.replace(URL_HEADER_PREFIX_RE, "")
					.trimEnd()
					.replace(/\s+\([^)]*\)\s*$/, "");
				const linked = linkUrlLikeSearchHeader(raw, uiTheme.fg("accent", line));
				urlFile = linked.absPath;
				return { raw: line, styled: linked.line };
			}
			urlFile = undefined;
			// Root-level files keep the bright accent; nested file headers are dimmed.
			const styled = uiTheme.fg(ctx.depth === 1 ? "accent" : "dim", line);
			return { raw: line, styled: ctx.headerPath ? fileHyperlink(ctx.headerPath, styled) : styled };
		}
		const styled = uiTheme.fg("toolOutput", line);
		const lineNumber = parseSearchDisplayLineNumber(line);
		const filePath = ctx.filePath ?? urlFile;
		return {
			raw: line,
			styled: filePath && lineNumber !== undefined ? fileHyperlink(filePath, styled, { line: lineNumber }) : styled,
		};
	});
}

function compactSearchPreviewGroup(group: RenderedSearchLine[]): RenderedSearchLine[] {
	const compact = group.filter(line => isSearchHeaderLine(line.raw) || isSearchMatchLine(line.raw));
	return compact.length > 0 ? compact : group;
}

function countPreviewMatches(lines: readonly RenderedSearchLine[], hasMarkedMatches: boolean): number {
	if (hasMarkedMatches) return lines.reduce((count, line) => count + (isSearchMatchLine(line.raw) ? 1 : 0), 0);
	return lines.reduce((count, line) => count + (!isSearchHeaderLine(line.raw) && line.raw.length > 0 ? 1 : 0), 0);
}

function renderBudgetedSearchGroups(
	groups: RenderedSearchLine[][],
	maxLines: number,
	matchCount: number,
	uiTheme: Theme,
	compact: boolean,
): string[] {
	if (maxLines <= 0) return [];
	const renderedGroups = groups
		.map(group => (compact ? compactSearchPreviewGroup(group) : group))
		.filter(group => group.length > 0);
	if (renderedGroups.length === 0) return [];

	let totalLines = 0;
	let totalMarkedMatches = 0;
	let totalFallbackMatches = 0;
	for (const group of renderedGroups) {
		totalLines += group.length;
		totalMarkedMatches += countPreviewMatches(group, true);
		totalFallbackMatches += countPreviewMatches(group, false);
	}
	const hasMarkedMatches = totalMarkedMatches > 0;
	const needsSummary = totalLines > maxLines;
	const contentBudget = needsSummary ? Math.max(maxLines - 1, 0) : maxLines;
	const visibleGroups: RenderedSearchLine[][] = [];
	let visibleLineCount = 0;
	let visibleMatches = 0;
	for (const group of renderedGroups) {
		if (visibleLineCount >= contentBudget) break;
		const available = contentBudget - visibleLineCount;
		const take = Math.min(group.length, available);
		if (take <= 0) break;
		const visibleGroup = group.slice(0, take);
		visibleGroups.push(visibleGroup);
		visibleLineCount += visibleGroup.length;
		visibleMatches += countPreviewMatches(visibleGroup, hasMarkedMatches);
	}

	const totalMatches = hasMarkedMatches ? totalMarkedMatches : Math.max(matchCount, totalFallbackMatches);
	const hiddenMatches = Math.max(totalMatches - visibleMatches, 0);
	const hiddenLines = Math.max(totalLines - visibleLineCount, 0);
	const hasSummary = needsSummary && (hiddenMatches > 0 || hiddenLines > 0);
	const lines: string[] = [];
	for (let i = 0; i < visibleGroups.length; i++) {
		const group = visibleGroups[i]!;
		lines.push(replaceTabs(group[0]!.styled));
		for (let j = 1; j < group.length; j++) {
			lines.push(`  ${replaceTabs(group[j]!.styled)}`);
		}
	}
	if (hasSummary) {
		const hiddenLabel =
			hiddenMatches > 0 ? formatMoreItems(hiddenMatches, "match") : formatMoreItems(hiddenLines, "line");
		lines.push(uiTheme.fg("dim", hiddenLabel));
	}
	return lines;
}

function grepStatusIcon(uiTheme: Theme): string {
	return uiTheme.fg("toolTitle", uiTheme.symbol("icon.search"));
}

export const grepToolRenderer = {
	inline: true,
	renderCall(args: GrepRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const paths = toPathList(args.path ?? args.paths);
		const meta: string[] = [];
		if (paths.length) meta.push(formatScopeMeta(paths));
		if (args.case === false) meta.push("case:insensitive");
		if (args.gitignore === false) meta.push("gitignore:false");
		if (args.skip !== undefined && args.skip > 0) meta.push(`skip:${args.skip}`);

		const text = renderStatusLine(
			{ icon: "pending", title: "Grep", titleColor: "toolTitle", description: args.pattern || "?", meta },
			uiTheme,
		);
		return new Text(text, 1, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: GrepToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: GrepRenderArgs,
	): Component {
		const details = result.details;

		if (result.isError || details?.error) {
			const errorText = details?.error || result.content?.find(c => c.type === "text")?.text || "Unknown error";
			return new Text(formatErrorMessage(errorText, uiTheme), 1, 0);
		}

		const hasDetailedData = details?.matchCount !== undefined || details?.fileCount !== undefined;

		if (!hasDetailedData) {
			const textContent = result.details?.displayContent ?? result.content?.find(c => c.type === "text")?.text;
			if (!textContent || textContent === "No matches found") {
				return new Text(formatEmptyMessage("No matches found", uiTheme), 1, 0);
			}
			const lines = textContent.split("\n").filter(line => line.trim() !== "");
			const description = args?.pattern ?? undefined;
			const header = renderStatusLine(
				{
					iconOverride: grepStatusIcon(uiTheme),
					title: "Grep",
					titleColor: "toolTitle",
					description,
					meta: [formatCount("item", lines.length)],
				},
				uiTheme,
			);
			return framedBlock(uiTheme, width => {
				const maxLines = options.expanded ? lines.length : COLLAPSED_TEXT_LIMIT;
				const needsSummary = !options.expanded && lines.length > maxLines;
				const contentBudget = needsSummary ? Math.max(maxLines - 1, 0) : maxLines;
				const visible = lines.slice(0, contentBudget);
				const remaining = lines.length - visible.length;
				const bodyLines: string[] = new Array(visible.length);
				for (let vi = 0; vi < visible.length; vi++)
					bodyLines[vi] = uiTheme.fg("toolOutput", replaceTabs(visible[vi]!));
				if (needsSummary && remaining > 0) {
					bodyLines.push(uiTheme.fg("dim", formatMoreItems(remaining, "item")));
				}
				const innerWidth = outputBlockContentWidth(width);
				const truncatedLines: string[] = new Array(bodyLines.length);
				for (let ti = 0; ti < bodyLines.length; ti++) {
					truncatedLines[ti] = truncateToWidth(bodyLines[ti]!, innerWidth, Ellipsis.Omit);
				}
				return {
					header,
					sections: [{ lines: truncatedLines }],
					state: "success",
					width,
				};
			});
		}

		const matchCount = details?.matchCount ?? 0;
		const fileCount = details?.fileCount ?? 0;
		const truncation = details?.meta?.truncation;
		const limits = details?.meta?.limits;
		const truncated = Boolean(details?.truncated || truncation || limits?.columnTruncated);

		const missingPathsList = details?.missingPaths ?? [];
		const missingNote =
			missingPathsList.length > 0
				? uiTheme.fg("warning", `skipped missing: ${missingPathsList.join(", ")}`)
				: undefined;

		if (matchCount === 0) {
			const meta = ["0 matches"];
			const scopeMeta = searchScopeMeta(details);
			if (scopeMeta) meta.push(scopeMeta);
			const header = renderStatusLine(
				{ icon: "warning", title: "Grep", titleColor: "toolTitle", description: args?.pattern, meta },
				uiTheme,
			);
			const lines = [header, formatEmptyMessage("No matches found", uiTheme)];
			if (missingNote) lines.push(missingNote);
			return new Text(lines.join("\n"), 1, 0);
		}

		const summaryParts = [formatCount("match", matchCount), formatCount("file", fileCount)];
		const meta = summaryParts.slice();
		const scopeMeta = searchScopeMeta(details);
		if (scopeMeta) meta.push(scopeMeta);
		if (truncated) meta.push(uiTheme.fg("warning", "truncated"));
		const description = args?.pattern ?? undefined;
		const header = renderStatusLine(
			{
				...(truncated ? { icon: "warning" as const } : { iconOverride: grepStatusIcon(uiTheme) }),
				title: "Grep",
				titleColor: "toolTitle",
				description,
				meta,
			},
			uiTheme,
		);

		const textContent = result.details?.displayContent ?? result.content?.find(c => c.type === "text")?.text ?? "";
		const allLines = textContent.split("\n");
		// Resolve hyperlinks once over the whole output so a nested directory stack reconstructs correctly across blank-line group boundaries.
		const renderedLines = renderSearchDisplayLines(
			allLines,
			details?.cwd ?? details?.searchPath,
			details?.searchPath,
			uiTheme,
		);
		const groupIndices = groupLineIndicesByBlank(allLines);
		const matchGroups: RenderedSearchLine[][] = new Array(groupIndices.length);
		for (let gi = 0; gi < groupIndices.length; gi++) {
			const indices = groupIndices[gi]!;
			const group: RenderedSearchLine[] = new Array(indices.length);
			for (let ii = 0; ii < indices.length; ii++) group[ii] = renderedLines[indices[ii]!]!;
			matchGroups[gi] = group;
		}

		const extraLines: string[] = [];
		if (missingNote) extraLines.push(missingNote);

		return framedBlock(uiTheme, width => {
			const budget = Math.max(
				(options.expanded ? EXPANDED_TEXT_LIMIT : COLLAPSED_TEXT_LIMIT) - extraLines.length,
				0,
			);
			const matchLines = renderBudgetedSearchGroups(matchGroups, budget, matchCount, uiTheme, !options.expanded);
			const innerWidth = outputBlockContentWidth(width);
			const bodyLines: string[] = new Array(matchLines.length + extraLines.length);
			for (let mi = 0; mi < matchLines.length; mi++) {
				bodyLines[mi] = truncateToWidth(matchLines[mi]!, innerWidth, Ellipsis.Omit);
			}
			for (let ei = 0; ei < extraLines.length; ei++) {
				bodyLines[matchLines.length + ei] = truncateToWidth(extraLines[ei]!, innerWidth, Ellipsis.Omit);
			}
			return {
				header,
				sections: [{ lines: bodyLines }],
				state: truncated ? "warning" : "success",
				width,
			};
		});
	},
	mergeCallAndResult: true,
};
