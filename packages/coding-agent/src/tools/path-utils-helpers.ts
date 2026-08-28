import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { isEnoent, isMissingPath } from "@veyyon/utils/fs-error";
import { tryParseJson } from "@veyyon/utils/json";
import { expandTilde, stripWindowsExtendedLengthPathPrefix } from "@veyyon/utils/path";
import { READ_SELECTOR_RANGE_LIST_SRC, splitReadSelector } from "@veyyon/utils/read-selector";
import { trimTrailingSlashes, URL_SCHEME_PREFIX_RE } from "@veyyon/utils/url";
import { ToolError } from "./tool-errors";

import {
	fileExists,
	formatPathRelativeToCwd,
	hasGlobPathChars,
	isInternalUrlPath,
	normalizePathLikeInput,
	normalizePathSeparators,
	resolveToCwd,
	splitPathAndSel,
	tryCurlyQuoteVariant,
	tryMacOSScreenshotPath,
	tryNFDVariant,
	tryShellEscapedPath,
} from "./path-utils";

type PathEntrySplitter = (item: string) => { basePath: string };

const TOP_LEVEL_WHITESPACE_RE = /\s/;

type DelimitedPathSplitMode = "comma" | "semicolon" | "whitespace" | "mixed";

function hasTopLevelPathDelimiter(entry: string): boolean {
	let braceDepth = 0;
	for (let i = 0; i < entry.length; i++) {
		const ch = entry[i];
		if (ch === "\\" && i + 1 < entry.length) {
			i++;
			continue;
		}
		if (ch === "{") {
			braceDepth++;
			continue;
		}
		if (ch === "}") {
			if (braceDepth > 0) braceDepth--;
			continue;
		}
		if (braceDepth === 0 && (ch === "," || ch === ";" || TOP_LEVEL_WHITESPACE_RE.test(ch))) {
			return true;
		}
	}
	return false;
}

function splitTopLevelDelimitedPath(entry: string, mode: DelimitedPathSplitMode): string[] {
	const parts: string[] = [];
	let braceDepth = 0;
	let start = 0;
	for (let i = 0; i < entry.length; i++) {
		const ch = entry[i];
		if (ch === "\\" && i + 1 < entry.length) {
			i++;
			continue;
		}
		if (ch === "{") {
			braceDepth++;
			continue;
		}
		if (ch === "}") {
			if (braceDepth > 0) braceDepth--;
			continue;
		}
		const isSep =
			mode === "comma"
				? ch === ","
				: mode === "semicolon"
					? ch === ";"
					: mode === "whitespace"
						? TOP_LEVEL_WHITESPACE_RE.test(ch)
						: ch === "," || ch === ";" || TOP_LEVEL_WHITESPACE_RE.test(ch);
		if (braceDepth !== 0 || !isSep) continue;
		parts.push(entry.slice(start, i));
		start = i + 1;
	}
	parts.push(entry.slice(start));
	return parts;
}

function getDelimitedCandidates(entry: string, mode: DelimitedPathSplitMode): string[] | null {
	const rawParts = splitTopLevelDelimitedPath(entry, mode);
	if (rawParts.length < 2) return null;
	const parts = rawParts.map(normalizePathLikeInput).filter(part => part.length > 0);
	if (parts.length === 0 || (parts.length < 2 && rawParts.length === parts.length)) return null;
	return parts;
}

type DelimitedResolveRequirement = "all" | "some" | "none";

const DELIMITED_SPLIT_LADDER: ReadonlyArray<{
	mode: DelimitedPathSplitMode;
	requirement: DelimitedResolveRequirement;
}> = [
	{ mode: "semicolon", requirement: "none" },
	{ mode: "comma", requirement: "some" },
	{ mode: "whitespace", requirement: "all" },
	{ mode: "mixed", requirement: "all" },
];

function probeLiteralExistsSync(filePath: string, cwd: string): boolean {
	try {
		fs.lstatSync(resolveReadPath(filePath, cwd));
		return true;
	} catch (err) {
		if (isMissingPath(err)) return false;
		return true;
	}
}

async function probeLiteralExistsAsync(filePath: string, cwd: string): Promise<boolean> {
	try {
		await fs.promises.lstat(resolveReadPath(filePath, cwd));
		return true;
	} catch (err) {
		if (isMissingPath(err) || isEnoent(err)) return false;
		return true;
	}
}

function probePartResolvesSync(entry: string, cwd: string, splitter: PathEntrySplitter): boolean {
	if (isInternalUrlPath(entry)) return true;
	const peeled = splitPathAndSel(entry).path;
	const { basePath } = splitter(peeled);
	try {
		fs.statSync(resolveToCwd(basePath, cwd));
		return true;
	} catch (err) {
		if (isMissingPath(err)) return false;
		return true;
	}
}

async function probePartResolvesAsync(entry: string, cwd: string, splitter: PathEntrySplitter): Promise<boolean> {
	if (isInternalUrlPath(entry)) return true;
	const peeled = splitPathAndSel(entry).path;
	const { basePath } = splitter(peeled);
	try {
		await fs.promises.stat(resolveToCwd(basePath, cwd));
		return true;
	} catch (err) {
		if (isEnoent(err) || isMissingPath(err)) return false;
		return true;
	}
}

function validatePartsSync(
	parts: string[],
	cwd: string,
	splitter: PathEntrySplitter,
	requirement: DelimitedResolveRequirement,
): boolean {
	if (requirement === "none") return true;
	if (requirement === "all") return parts.every(part => probePartResolvesSync(part, cwd, splitter));
	return parts.some(part => probePartResolvesSync(part, cwd, splitter));
}

async function validatePartsAsync(
	parts: string[],
	cwd: string,
	splitter: PathEntrySplitter,
	requirement: DelimitedResolveRequirement,
): Promise<boolean> {
	if (requirement === "none") return true;
	const resolved = await Promise.all(parts.map(part => probePartResolvesAsync(part, cwd, splitter)));
	return requirement === "all" ? resolved.every(Boolean) : resolved.some(Boolean);
}

export interface DelimitedPathSplitOptions {
	splitter?: PathEntrySplitter;
	internalUrls?: "keep" | "split-on-semicolon";
}

export function splitDelimitedPathEntrySync(
	entry: string,
	cwd: string = process.cwd(),
	options: DelimitedPathSplitOptions = {},
): string[] | null {
	const normalizedEntry = normalizePathLikeInput(entry);
	if (!hasTopLevelPathDelimiter(normalizedEntry)) return null;
	if (isInternalUrlPath(normalizedEntry)) {
		if (options.internalUrls !== "split-on-semicolon") return null;
		return getDelimitedCandidates(normalizedEntry, "semicolon");
	}
	if (probeLiteralExistsSync(normalizedEntry, cwd)) return null;
	const splitter = options.splitter ?? parseSearchPath;
	const peeledEntry = splitPathAndSel(normalizedEntry).path;
	if (!hasGlobPathChars(peeledEntry) && probePartResolvesSync(normalizedEntry, cwd, splitter)) {
		return null;
	}

	for (const { mode, requirement } of DELIMITED_SPLIT_LADDER) {
		const parts = getDelimitedCandidates(normalizedEntry, mode);
		if (parts && validatePartsSync(parts, cwd, splitter, requirement)) return parts;
	}
	return null;
}

export function expandDelimitedPathEntriesSync(
	entries: readonly string[],
	cwd: string = process.cwd(),
	options: DelimitedPathSplitOptions = {},
): string[] {
	const expanded: string[] = [];
	for (const entry of entries) {
		const normalizedEntry = normalizePathLikeInput(entry);
		const split = splitDelimitedPathEntrySync(normalizedEntry, cwd, options);
		if (split) expanded.push(...split);
		else expanded.push(normalizedEntry);
	}
	return expanded;
}

export async function splitDelimitedPathEntry(
	entry: string,
	cwd: string = process.cwd(),
	options: DelimitedPathSplitOptions = {},
): Promise<string[] | null> {
	const normalizedEntry = normalizePathLikeInput(entry);
	if (!hasTopLevelPathDelimiter(normalizedEntry)) return null;
	if (isInternalUrlPath(normalizedEntry)) {
		if (options.internalUrls !== "split-on-semicolon") return null;
		return getDelimitedCandidates(normalizedEntry, "semicolon");
	}
	if (await probeLiteralExistsAsync(normalizedEntry, cwd)) return null;
	const splitter = options.splitter ?? parseSearchPath;
	const peeledEntry = splitPathAndSel(normalizedEntry).path;
	if (!hasGlobPathChars(peeledEntry) && (await probePartResolvesAsync(normalizedEntry, cwd, splitter))) {
		return null;
	}

	for (const { mode, requirement } of DELIMITED_SPLIT_LADDER) {
		const parts = getDelimitedCandidates(normalizedEntry, mode);
		if (parts && (await validatePartsAsync(parts, cwd, splitter, requirement))) return parts;
	}
	return null;
}

export async function expandDelimitedPathEntries(
	entries: readonly string[],
	cwd: string = process.cwd(),
	options: DelimitedPathSplitOptions = {},
): Promise<string[]> {
	const expanded: string[] = [];
	for (const entry of entries) {
		const normalizedEntry = normalizePathLikeInput(entry);
		const split = await splitDelimitedPathEntry(normalizedEntry, cwd, options);
		if (split) {
			for (let si = 0; si < split.length; si++) expanded.push(split[si]!);
		} else expanded.push(normalizedEntry);
	}
	return expanded;
}

export interface ParsedSearchPath {
	basePath: string;
	glob?: string;
}

export interface ParsedFindPattern {
	basePath: string;
	globPattern: string;
	hasGlob: boolean;
}

export interface ResolvedSearchTarget {
	basePath: string;
	glob?: string;
}

export interface ResolvedMultiSearchPath {
	basePath: string;
	glob?: string;
	scopePath: string;
	exactFilePaths?: string[];
	targets?: ResolvedSearchTarget[];
}

export interface ResolvedFindTarget {
	basePath: string;
	globPattern: string;
	hasGlob: boolean;
}

export interface ResolvedMultiFindPattern {
	targets: ResolvedFindTarget[];
	scopePath: string;
}
export function parseSearchPath(filePath: string): ParsedSearchPath {
	const normalizedPath = normalizePathSeparators(filePath);
	const segments = normalizedPath.split("/");
	let firstGlobIndex = -1;
	for (let i = 0; i < segments.length; i++) {
		if (hasGlobPathChars(segments[i])) {
			firstGlobIndex = i;
			break;
		}
	}

	if (firstGlobIndex === -1) {
		return { basePath: normalizedPath };
	}

	if (firstGlobIndex <= 0) {
		return { basePath: ".", glob: normalizedPath };
	}

	return {
		basePath: segments.slice(0, firstGlobIndex).join("/"),
		glob: segments.slice(firstGlobIndex).join("/"),
	};
}

export async function parseSearchPathPreferringLiteral(filePath: string, cwd: string): Promise<ParsedSearchPath> {
	if (!hasGlobPathChars(filePath) || isInternalUrlPath(filePath)) return parseSearchPath(filePath);
	try {
		await fs.promises.stat(resolveToCwd(filePath, cwd));
		return { basePath: normalizePathSeparators(filePath) };
	} catch {
		return parseSearchPath(filePath);
	}
}

export function parseFindPattern(pattern: string): ParsedFindPattern {
	const normalizedPattern = normalizePathSeparators(pattern);
	const segments = normalizedPattern.split("/");
	let firstGlobIndex = -1;
	for (let i = 0; i < segments.length; i++) {
		if (hasGlobPathChars(segments[i])) {
			firstGlobIndex = i;
			break;
		}
	}

	if (firstGlobIndex === -1) {
		return { basePath: normalizedPattern, globPattern: "**/*", hasGlob: false };
	}

	if (firstGlobIndex === 0) {
		const needsRecursive = !normalizedPattern.startsWith("**/");
		return {
			basePath: ".",
			globPattern: needsRecursive ? `**/${normalizedPattern}` : normalizedPattern,
			hasGlob: true,
		};
	}

	return {
		basePath: segments.slice(0, firstGlobIndex).join("/"),
		globPattern: segments.slice(firstGlobIndex).join("/"),
		hasGlob: true,
	};
}

export function combineSearchGlobs(prefixGlob?: string, suffixGlob?: string): string | undefined {
	if (!prefixGlob) return suffixGlob;
	if (!suffixGlob) return prefixGlob;

	const normalizedPrefix = trimTrailingSlashes(prefixGlob);
	const normalizedSuffix = suffixGlob.replace(/^\/+/, "");

	return `${normalizedPrefix}/${normalizedSuffix}`;
}

export function normalizePosixPath(filePath: string): string {
	return filePath.replace(/\\/g, "/");
}

function joinRelativeGlob(basePath: string | undefined, globPattern: string): string {
	if (!basePath || basePath === ".") return normalizePosixPath(globPattern).replace(/^\/+/, "");
	const normalizedBase = trimTrailingSlashes(normalizePosixPath(basePath));
	const normalizedGlob = normalizePosixPath(globPattern).replace(/^\/+/, "");
	return `${normalizedBase}/${normalizedGlob}`;
}

function buildBraceUnion(patterns: string[]): string | undefined {
	const uniquePatterns = Array.from(
		new Set(patterns.map(pattern => normalizePosixPath(pattern).trim()).filter(Boolean)),
	);
	if (uniquePatterns.length === 0) return undefined;
	if (uniquePatterns.length === 1) return uniquePatterns[0];
	return `{${uniquePatterns.join(",")}}`;
}

function findCommonBasePath(paths: string[]): string {
	if (paths.length === 0) return ".";
	let commonParts = path.resolve(paths[0]).split(path.sep);
	for (const candidatePath of paths.slice(1)) {
		const candidateParts = path.resolve(candidatePath).split(path.sep);
		let sharedCount = 0;
		const maxShared = Math.min(commonParts.length, candidateParts.length);
		while (sharedCount < maxShared && commonParts[sharedCount] === candidateParts[sharedCount]) {
			sharedCount += 1;
		}
		commonParts = commonParts.slice(0, sharedCount);
	}
	if (commonParts.length === 0) {
		return path.parse(path.resolve(paths[0])).root;
	}
	const joined = commonParts.join(path.sep);
	return joined || path.parse(path.resolve(paths[0])).root;
}

function toScopeDisplay(items: string[], cwd: string): string {
	return items
		.map(item =>
			formatPathRelativeToCwd(item, cwd, {
				trailingSlash: item.endsWith("/") || item.endsWith("\\"),
			}),
		)
		.join(", ");
}

async function resolveSearchPathItems(
	pathItems: string[],
	cwd: string,
	suffixGlob?: string,
	fanOutFileItems = false,
): Promise<ResolvedMultiSearchPath | undefined> {
	if (pathItems.length < 1) {
		return undefined;
	}

	const parsedItems = await Promise.all(
		pathItems.map(async item => {
			const parsedPath = await parseSearchPathPreferringLiteral(item, cwd);
			const absoluteBasePath = resolveToCwd(parsedPath.basePath, cwd);
			const stat = await fs.promises.stat(absoluteBasePath);
			return { raw: item, parsedPath, absoluteBasePath, stat };
		}),
	);

	const allExactFiles = !suffixGlob && parsedItems.every(item => !item.parsedPath.glob && item.stat.isFile());
	const commonBasePath = findCommonBasePath(parsedItems.map(item => item.absoluteBasePath));
	const combinedPatterns = parsedItems.map(item => {
		const relativeBasePath = normalizePosixPath(path.relative(commonBasePath, item.absoluteBasePath)) || ".";
		if (item.parsedPath.glob) {
			const pathGlob = joinRelativeGlob(relativeBasePath, item.parsedPath.glob);
			return combineSearchGlobs(pathGlob, suffixGlob) ?? pathGlob;
		}
		if (suffixGlob) {
			const pathPrefix = relativeBasePath === "." ? undefined : relativeBasePath;
			return combineSearchGlobs(pathPrefix, suffixGlob) ?? suffixGlob;
		}
		if (item.stat.isDirectory()) {
			return joinRelativeGlob(relativeBasePath, "**/*");
		}
		return relativeBasePath === "." ? path.basename(item.absoluteBasePath) : relativeBasePath;
	});
	const commonIsRequestedScope = parsedItems.some(item => item.absoluteBasePath === commonBasePath);
	const demotesFileItem =
		fanOutFileItems && !allExactFiles && parsedItems.some(item => !item.parsedPath.glob && item.stat.isFile());
	const targets =
		parsedItems.length > 1 && (!commonIsRequestedScope || demotesFileItem)
			? parsedItems.map(item => ({
					basePath: item.absoluteBasePath,
					glob: item.parsedPath.glob ? combineSearchGlobs(item.parsedPath.glob, suffixGlob) : suffixGlob,
				}))
			: undefined;

	return {
		basePath: commonBasePath,
		glob: buildBraceUnion(combinedPatterns),
		scopePath: toScopeDisplay(pathItems, cwd),
		exactFilePaths: allExactFiles ? parsedItems.map(item => item.absoluteBasePath) : undefined,
		targets,
	};
}

export async function resolveExplicitSearchPaths(
	pathItems: string[],
	cwd: string,
	suffixGlob?: string,
	fanOutFileItems = false,
): Promise<ResolvedMultiSearchPath | undefined> {
	return resolveSearchPathItems(Array.from(new Set(pathItems)), cwd, suffixGlob, fanOutFileItems);
}

async function resolveFindPatternItems(
	patternItems: string[],
	cwd: string,
): Promise<ResolvedMultiFindPattern | undefined> {
	if (patternItems.length <= 1) {
		return undefined;
	}

	const targets = patternItems.map(item => {
		const parsedPattern = parseFindPattern(item);
		return {
			basePath: resolveToCwd(parsedPattern.basePath, cwd),
			globPattern: parsedPattern.globPattern,
			hasGlob: parsedPattern.hasGlob,
		};
	});

	return {
		targets,
		scopePath: toScopeDisplay(patternItems, cwd),
	};
}

export async function resolveExplicitFindPatterns(
	patternItems: string[],
	cwd: string,
): Promise<ResolvedMultiFindPattern | undefined> {
	return resolveFindPatternItems(Array.from(new Set(patternItems)), cwd);
}

export interface PartitionedPaths {
	valid: string[];
	missing: string[];
}

export async function partitionExistingPaths(
	items: string[],
	cwd: string,
	splitter: (item: string) => { basePath: string },
): Promise<PartitionedPaths> {
	const settled = await Promise.all(
		items.map(async item => {
			const { basePath } = splitter(item);
			const absoluteBasePath = resolveToCwd(basePath, cwd);
			try {
				await fs.promises.stat(absoluteBasePath);
				return { item, exists: true } as const;
			} catch (err) {
				if (isEnoent(err)) return { item, exists: false } as const;
				throw err;
			}
		}),
	);
	const valid: string[] = [];
	const missing: string[] = [];
	for (const entry of settled) {
		if (entry.exists) valid.push(entry.item);
		else missing.push(entry.item);
	}
	return { valid, missing };
}

export function resolveReadPath(filePath: string, cwd: string): string {
	const resolved = resolveToCwd(filePath, cwd);
	const shellEscapedVariant = tryShellEscapedPath(resolved);
	const baseCandidates = shellEscapedVariant !== resolved ? [resolved, shellEscapedVariant] : [resolved];

	for (const baseCandidate of baseCandidates) {
		if (fileExists(baseCandidate)) {
			return baseCandidate;
		}
	}

	for (const baseCandidate of baseCandidates) {
		const amPmVariant = tryMacOSScreenshotPath(baseCandidate);
		if (amPmVariant !== baseCandidate && fileExists(amPmVariant)) {
			return amPmVariant;
		}

		const nfdVariant = tryNFDVariant(baseCandidate);
		if (nfdVariant !== baseCandidate && fileExists(nfdVariant)) {
			return nfdVariant;
		}

		const curlyVariant = tryCurlyQuoteVariant(baseCandidate);
		if (curlyVariant !== baseCandidate && fileExists(curlyVariant)) {
			return curlyVariant;
		}

		const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
		if (nfdCurlyVariant !== baseCandidate && fileExists(nfdCurlyVariant)) {
			return nfdCurlyVariant;
		}
	}

	return resolved;
}
