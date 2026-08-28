import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type GrepMatch, GrepOutputMode, type GrepResult, grep } from "@veyyon/natives";
import { errorMessage, logger, trimTrailingSlashes } from "@veyyon/utils";
import { type } from "arktype";
import type { LocalProtocolOptions } from "../internal-urls/local-protocol";
import { InternalUrlRouter } from "../internal-urls/router";
import type { InternalResource, ResolveContext } from "../internal-urls/types";
import { DEFAULT_MAX_COLUMN, type TruncationResult, truncateLine } from "../session/streaming-output";
import { type ArchiveReader, type ExtractedArchiveFile, openArchive, parseArchivePathCandidates } from "../utils/zip";
import type { OutputMeta } from "./output-meta";
import {
	hasGlobPathChars,
	isInternalUrlPath,
	isLineInRanges,
	type LineRange,
	parseLineRanges,
	type ResolvedSearchTarget,
	resolveReadPath,
	selectorLineRanges,
	splitInternalUrlSel,
	splitPathAndSel,
	splitPathAndSelPreferringLiteral,
} from "./path-utils";
import { ToolError } from "./tool-errors";

export const searchPathEntry = type("string").describe(
	'file, directory, glob, internal URL, or "<file>:<lines>" selector to search (e.g. "src/foo.ts:50-100", "src/foo.ts:50+10", "src/foo.ts:50-100,200-300")',
);
export const searchSchema = type({
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
export const INTERNAL_TOTAL_CAP = 2000;
export const NATIVE_GREP_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const SEARCH_GREP_TIMEOUT_MS = 30_000;
export interface GrepPathSpec {
	original: string;
	clean: string;
	literalFilesystemMatch?: boolean;
	ranges?: [LineRange, ...LineRange[]];
}
export function isReadSelectorGrammar(sel: string | undefined): boolean {
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
export async function parsePathSpecs(rawEntries: readonly string[], cwd: string): Promise<GrepPathSpec[]> {
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
export function mergeRangesInto(map: Map<string, LineRange[]>, absKey: string, ranges: LineRange[]): void {
	const existing = map.get(absKey);
	if (existing) {
		for (let i = 0; i < ranges.length; i++) existing.push(ranges[i]!);
	} else {
		map.set(absKey, ranges.slice());
	}
}
export function matchAbsolutePath(matchPath: string, searchPath: string): string {
	if (matchPath === "") return searchPath;
	if (path.isAbsolute(matchPath)) return matchPath;
	return path.resolve(searchPath, matchPath);
}
export async function resolveArchiveSearchPaths(
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
export interface VirtualSearchResource {
	path: string;
	content: string;
	ranges?: readonly LineRange[];
}
export interface InternalSearchInputResolution {
	paths: string[];
	resolvedPathsByInput: string[];
	virtualResources: VirtualSearchResource[];
	virtualPathSet: Set<string>;
	virtualInputIndexes: Set<number>;
	immutableSourcePaths: Set<string>;
	virtualScopePath?: string;
}
export function isImmutableSourcePath(filePath: string, immutableSourcePaths: ReadonlySet<string>): boolean {
	for (const immutablePath of immutableSourcePaths) {
		if (filePath === immutablePath || filePath.startsWith(`${immutablePath}${path.sep}`)) {
			return true;
		}
	}
	return false;
}
export interface IndexedContentLines {
	lines: string[];
	starts: number[];
}
export const VEYYON_ROOT_URL_RE = /^veyyon:\/\/(?:\/?|docs\/?)$/i;
export function normalizeSearchLine(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}
export function splitSearchLines(content: string): string[] {
	const lines = content.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines.map(normalizeSearchLine);
}
export function indexSearchLines(content: string): IndexedContentLines {
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
export function lineAllowed(lineNumber: number, ranges: readonly LineRange[] | undefined): boolean {
	return !ranges || isLineInRanges(lineNumber, ranges);
}
export function lineRangeFetchCap(pathSpecs: readonly GrepPathSpec[], perFileKeep: number): number {
	let cap = 0;
	for (const spec of pathSpecs) {
		if (!spec.ranges) continue;
		for (const range of spec.ranges) {
			cap = Math.max(cap, range.endLine ?? range.startLine - 1 + perFileKeep);
		}
	}
	return Math.min(cap, NATIVE_GREP_MAX_FILE_BYTES);
}
export function findLineIndex(starts: readonly number[], offset: number): number {
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
export function jsMatchedLineIndexes(
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
export async function nativeChunkedLineIndexes(
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
export function makeContextLine(lines: readonly string[], lineIndex: number): { lineNumber: number; line: string } {
	const { text } = truncateLine(lines[lineIndex] ?? "", DEFAULT_MAX_COLUMN);
	return { lineNumber: lineIndex + 1, line: text };
}
export function makeVirtualMatch(
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
export function buildVirtualMatches(
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
export async function searchVirtualResources(
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
export function mergeGrepResults(left: GrepResult, right: GrepResult, maxCount: number): GrepResult {
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
export async function expandVirtualInternalResource(
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
export async function resolveInternalSearchInputs(opts: {
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
	displayContent?: string;
	searchPath?: string;
	cwd?: string;
	missingPaths?: string[];
}
export type SearchParams = typeof searchSchema.infer;
export interface ResolvedGrepScope {
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
export interface GrepExecutionOutput {
	result: GrepResult;
	skippedOversizedCount: number;
	literalFallbackError?: string;
}
export interface PaginatedGrepMatches {
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
