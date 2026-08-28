import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { isEnoent, isMissingPath } from "@veyyon/utils/fs-error";
import { tryParseJson } from "@veyyon/utils/json";
import { expandTilde, stripWindowsExtendedLengthPathPrefix } from "@veyyon/utils/path";
import { READ_SELECTOR_RANGE_LIST_SRC, splitReadSelector } from "@veyyon/utils/read-selector";
import { trimTrailingSlashes, URL_SCHEME_PREFIX_RE } from "@veyyon/utils/url";
import { ToolError } from "./tool-errors";

export { expandTilde };

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const INTERNAL_URL_SELECTOR_PART_RE = new RegExp(
	String.raw`^(?:raw|conflicts|${READ_SELECTOR_RANGE_LIST_SRC}|-\d+(?:[-+]\d+)?)$`,
	"i",
);
const INTERNAL_SCHEMES_WITH_SELECTORS: Record<string, true> = {
	agent: true,
	artifact: true,
	history: true,
	issue: true,
	local: true,
	memory: true,
	veyyon: true,
	pr: true,
	rule: true,
	skill: true,
	ssh: true,
	vault: true,
};
const OPAQUE_RESOURCE_SCHEMES: ReadonlySet<string> = new Set(["mcp"]);
const NARROW_NO_BREAK_SPACE = "\u202F";
const CURRENT_PLATFORM: NodeJS.Platform = process.platform;
const TOP_LEVEL_INTERNAL_URL_PREFIXES = [
	"agent://",
	"artifact://",
	"history://",
	"issue://",
	"local://",
	"mcp://",
	"memory://",
	"pr://",
	"rule://",
	"skill://",
	"ssh://",
	"vault://",
	"veyyon://",
] as const;

function normalizeUnicodeSpaces(str: string): string {
	return str.replace(UNICODE_SPACES, " ");
}

function tryMacOSScreenshotPath(filePath: string): string {
	return filePath.replace(/ (AM|PM)\./g, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNFDVariant(filePath: string): string {
	return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
	return filePath.replace(/'/g, "\u2019");
}

function tryShellEscapedPath(filePath: string): string {
	if (!filePath.includes("\\") || !filePath.includes("/")) return filePath;
	return filePath.replace(/\\([ \t"'(){}[\]])/g, "$1");
}

function fileExists(filePath: string): boolean {
	try {
		fs.accessSync(filePath, fs.constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function normalizeAtPrefix(filePath: string): string {
	if (!filePath.startsWith("@")) return filePath;

	const withoutAt = filePath.slice(1);

	if (
		withoutAt.startsWith("/") ||
		withoutAt === "~" ||
		withoutAt.startsWith("~/") ||
		path.win32.isAbsolute(withoutAt) ||
		withoutAt.startsWith("agent://") ||
		withoutAt.startsWith("artifact://") ||
		withoutAt.startsWith("skill://") ||
		withoutAt.startsWith("rule://") ||
		withoutAt.startsWith("local:") ||
		withoutAt.startsWith("mcp://")
	) {
		return withoutAt;
	}

	return filePath;
}

function stripFileUrl(filePath: string): string {
	if (!filePath.toLowerCase().startsWith("file://")) return filePath;

	try {
		return url.fileURLToPath(filePath);
	} catch {
		return filePath;
	}
}

export function expandPath(filePath: string): string {
	const deColoned = /^:(?=[/~]|\.\.?\/)/.test(filePath) ? filePath.slice(1) : filePath;
	const normalized = stripWindowsExtendedLengthPathPrefix(
		stripFileUrl(normalizeUnicodeSpaces(normalizeAtPrefix(deColoned))),
	);
	return expandTilde(normalized);
}

function isAsciiDriveLetter(value: string): boolean {
	if (value.length !== 1) return false;
	const code = value.charCodeAt(0);
	return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function windowsDriveAliasPath(filePath: string): string | undefined {
	if (!filePath.startsWith("/")) return undefined;
	const parts = filePath.split("/");
	if (parts[0] !== "") return undefined;

	let drive: string | undefined;
	let tailStart = 2;
	if (parts.length >= 2 && isAsciiDriveLetter(parts[1] ?? "")) {
		drive = parts[1]!.toUpperCase();
	} else if (parts.length >= 3 && (parts[1] ?? "").toLowerCase() === "mnt" && isAsciiDriveLetter(parts[2] ?? "")) {
		drive = parts[2]!.toUpperCase();
		tailStart = 3;
	}
	if (!drive) return undefined;

	const tail = parts.slice(tailStart).filter(Boolean).join("\\");
	return tail ? `${drive}:\\${tail}` : `${drive}:\\`;
}

export function normalizeWindowsDriveAliasPath(filePath: string, platform: NodeJS.Platform = process.platform): string {
	if (platform !== "win32") return filePath;
	return windowsDriveAliasPath(filePath) ?? filePath;
}

export interface LineRange {
	startLine: number;
	endLine: number | undefined;
}

const LINE_RANGE_CHUNK_RE = /^L?(\d+)(?:(\.\.|[-+])L?(\d+)?)?$/i;

export function parseLineRangeChunk(sel: string): LineRange | null {
	const lineMatch = LINE_RANGE_CHUNK_RE.exec(sel.trim());
	if (!lineMatch) return null;
	const rawStart = Number.parseInt(lineMatch[1]!, 10);
	if (rawStart < 1) {
		throw new ToolError("Line selector 0 is invalid; lines are 1-indexed. Use :1.");
	}
	const sep = lineMatch[2] === ".." ? "-" : lineMatch[2];
	const rhs = lineMatch[3] ? Number.parseInt(lineMatch[3], 10) : undefined;
	let rawEnd: number | undefined;
	if (sep === "+") {
		if (rhs === undefined || rhs < 1) {
			throw new ToolError(`Invalid range ${rawStart}+${rhs ?? 0}: count must be >= 1.`);
		}
		rawEnd = rawStart + rhs - 1;
	} else if (sep === "-") {
		if (rhs !== undefined) {
			if (rhs < rawStart) {
				throw new ToolError(`Invalid range ${rawStart}-${rhs}: end must be >= start.`);
			}
			rawEnd = rhs;
		}
	}
	return { startLine: rawStart, endLine: rawEnd };
}

export function parseLineRanges(sel: string): [LineRange, ...LineRange[]] | null {
	const chunks = sel.split(",");
	const parsed: LineRange[] = [];
	for (const chunk of chunks) {
		const range = parseLineRangeChunk(chunk);
		if (!range) return null;
		parsed.push(range);
	}
	if (parsed.length === 0) return null;
	parsed.sort((a, b) => a.startLine - b.startLine);

	const merged: LineRange[] = [parsed[0]];
	for (let i = 1; i < parsed.length; i++) {
		const current = parsed[i];
		const last = merged[merged.length - 1];
		if (last.endLine === undefined) continue;
		if (current.startLine <= last.endLine + 1) {
			if (current.endLine === undefined || current.endLine > last.endLine) {
				merged[merged.length - 1] = { startLine: last.startLine, endLine: current.endLine };
			}
			continue;
		}
		merged.push(current);
	}
	return merged as [LineRange, ...LineRange[]];
}

export function selectorLineRanges(sel: string | undefined): [LineRange, ...LineRange[]] | undefined {
	if (!sel) return undefined;
	for (const chunk of sel.split(":")) {
		const lower = chunk.toLowerCase();
		if (lower === "raw" || lower === "conflicts") continue;
		const ranges = parseLineRanges(chunk);
		if (ranges) return ranges;
	}
	return undefined;
}

export function isLineInRanges(lineNumber: number, ranges: readonly LineRange[]): boolean {
	for (const range of ranges) {
		if (lineNumber < range.startLine) continue;
		if (range.endLine === undefined || lineNumber <= range.endLine) return true;
	}
	return false;
}

export const splitPathAndSel: (rawPath: string) => { path: string; sel?: string } = splitReadSelector;

export async function probeLiteralPathExists(filePath: string, cwd: string): Promise<"exists" | "missing" | "unknown"> {
	const resolved = resolveReadPath(filePath, cwd);
	try {
		await fs.promises.lstat(resolved);
		return "exists";
	} catch (err) {
		if (isMissingPath(err)) return "missing";
		return "unknown";
	}
}

export async function splitPathAndSelPreferringLiteral(
	rawPath: string,
	cwd: string,
): Promise<{ path: string; sel?: string }> {
	const strict = splitPathAndSel(rawPath);
	if (strict.sel === undefined) return strict;
	const probe = await probeLiteralPathExists(rawPath, cwd);
	return probe === "missing" ? strict : { path: rawPath };
}

export function splitInternalUrlSel(rawPath: string): { path: string; sel?: string } {
	const schemeMatch = rawPath.match(URL_SCHEME_PREFIX_RE);
	if (!schemeMatch) return { path: rawPath };
	const scheme = schemeMatch[1].toLowerCase();
	if (OPAQUE_RESOURCE_SCHEMES.has(scheme)) return { path: rawPath };
	if (!INTERNAL_SCHEMES_WITH_SELECTORS[scheme]) return { path: rawPath };

	const schemeEnd = schemeMatch[0].length;
	if (scheme === "ssh" && rawPath.indexOf("/", schemeEnd) === -1) {
		return { path: rawPath };
	}
	let path = rawPath;
	const chunks: string[] = [];
	while (true) {
		const colon = path.lastIndexOf(":");
		if (colon < schemeEnd) break;
		const tail = path.slice(colon + 1);
		if (!INTERNAL_URL_SELECTOR_PART_RE.test(tail)) break;
		chunks.unshift(tail);
		path = path.slice(0, colon);
	}
	if (chunks.length === 0) return { path: rawPath };
	return { path, sel: chunks.join(":") };
}

export function peelWriteUrlSelector(rawPath: string): string {
	const { path, sel } = splitInternalUrlSel(rawPath);
	if (sel === undefined) return rawPath;
	if (/^(?:raw|conflicts)$/i.test(sel)) return path;
	throw new ToolError(
		`write does not accept the trailing selector ":${sel}" — it writes a whole file. ` +
			`Remove ":${sel}", or if the filename truly ends with it, percent-encode the ":" as %3A.`,
	);
}

function assertNoNulByte(original: string): void {
	const index = original.indexOf("\0");
	if (index === -1) return;
	throw new Error(
		`Path contains a NUL byte at position ${index} and cannot name a file: ${JSON.stringify(original)}. ` +
			`Remove the NUL; no filesystem can store it, and a truncated path would silently target a different file.`,
	);
}

const MAX_PATH_COMPONENT_BYTES = 255;

const MAX_PATH_TOTAL_BYTES = 4096;

function assertPathLengthWithinLimits(original: string, resolved: string): void {
	const MAX_UNITS_ALWAYS_SAFE = Math.floor(MAX_PATH_COMPONENT_BYTES / 3);
	let componentStart = 0;
	let mustMeasure = resolved.length > Math.floor(MAX_PATH_TOTAL_BYTES / 3);
	if (!mustMeasure) {
		for (let i = 0; i <= resolved.length; i++) {
			const code = i < resolved.length ? resolved.charCodeAt(i) : 0x2f;
			if (code !== 0x2f && code !== 0x5c) continue;
			if (i - componentStart > MAX_UNITS_ALWAYS_SAFE) {
				mustMeasure = true;
				break;
			}
			componentStart = i + 1;
		}
	}
	if (!mustMeasure) return;

	for (const component of resolved.split(/[/\\]/)) {
		const bytes = Buffer.byteLength(component, "utf8");
		if (bytes > MAX_PATH_COMPONENT_BYTES) {
			throw new Error(
				`Path component is ${bytes} bytes, over the ${MAX_PATH_COMPONENT_BYTES}-byte filename limit, ` +
					`in ${JSON.stringify(original)}. Shorten the name ${JSON.stringify(
						`${component.slice(0, 40)}…`,
					)}; the filesystem cannot store it.`,
			);
		}
	}
	if (process.platform === "win32") return;
	const totalBytes = Buffer.byteLength(resolved, "utf8");
	if (totalBytes > MAX_PATH_TOTAL_BYTES) {
		throw new Error(
			`Path is ${totalBytes} bytes, over the ${MAX_PATH_TOTAL_BYTES}-byte total path limit, ` +
				`starting from ${JSON.stringify(original.slice(0, 60))}. Use a shorter directory or filename.`,
		);
	}
}

const WINDOWS_RESERVED_NAMES: ReadonlySet<string> = new Set([
	"con",
	"prn",
	"aux",
	"nul",
	"com1",
	"com2",
	"com3",
	"com4",
	"com5",
	"com6",
	"com7",
	"com8",
	"com9",
	"lpt1",
	"lpt2",
	"lpt3",
	"lpt4",
	"lpt5",
	"lpt6",
	"lpt7",
	"lpt8",
	"lpt9",
]);

export function assertNoWindowsReservedName(
	original: string,
	resolved: string,
	platform: NodeJS.Platform = CURRENT_PLATFORM,
): void {
	if (platform !== "win32") return;
	for (const component of resolved.split(/[/\\]/)) {
		if (!component || component === "." || component === ".." || /^[a-zA-Z]:$/.test(component)) continue;

		const trimmedTail = component.replace(/[. ]+$/, "");
		if (trimmedTail !== component) {
			throw new Error(
				`Path component ${JSON.stringify(component)} ends with a dot or space, which Windows silently ` +
					`strips, so it would open ${JSON.stringify(trimmedTail)} instead: ${JSON.stringify(original)}. ` +
					"Remove the trailing dot or space so the path names the file it appears to name.",
			);
		}

		const stem = component.includes(".") ? component.slice(0, component.indexOf(".")) : component;
		if (WINDOWS_RESERVED_NAMES.has(stem.toLowerCase())) {
			throw new Error(
				`Path component ${JSON.stringify(component)} is a reserved Windows device name ` +
					`(${stem.toUpperCase()}), not a file: ${JSON.stringify(original)}. Opening it succeeds and ` +
					"writes to the device, so no file is created. Choose a different name.",
			);
		}
	}
}

function assertNotInternalUrl(expanded: string, original: string): void {
	for (const prefix of TOP_LEVEL_INTERNAL_URL_PREFIXES) {
		if (expanded.startsWith(prefix)) {
			throw new Error(
				`Path "${original}" uses internal scheme "${prefix}" and must be resolved through the proper protocol handler, not as a filesystem path.`,
			);
		}
	}
}

export function normalizeLocalScheme(filePath: string): string {
	return filePath.replace(/^(local:)\/(?!\/)/, "$1//");
}

export function isInternalUrlPath(filePath: string): boolean {
	const normalized = normalizeLocalScheme(filePath);
	const expandedAndNormalized = normalizeLocalScheme(expandPath(normalized));
	for (const prefix of TOP_LEVEL_INTERNAL_URL_PREFIXES) {
		if (expandedAndNormalized.startsWith(prefix)) return true;
	}
	return false;
}

export function pathTargetsSsh(path: string): boolean {
	return /ssh:\/\//i.test(path);
}

export function isSshUrl(path: string): boolean {
	return /^ssh:\/\//i.test(path.trim());
}

export function isReadableUrlPath(value: string): boolean {
	return /^https?:\/\/?/i.test(value) || /^www\./i.test(value);
}

export function globSearchBase(pattern: string): string {
	const trimmed = pattern.trim();
	const meta = trimmed.search(/[*?[{]/);
	if (meta === -1) return trimmed;
	const literalPrefix = trimmed.slice(0, meta);
	const lastSlash = literalPrefix.lastIndexOf("/");
	return lastSlash === -1 ? "" : literalPrefix.slice(0, lastSlash);
}

export function resolveToCwd(filePath: string, cwd: string): string {
	assertNoNulByte(filePath);
	const normalized = normalizeLocalScheme(filePath);
	const expanded = normalizeWindowsDriveAliasPath(expandPath(normalized));
	const expandedAndNormalized = normalizeLocalScheme(expanded);

	assertNotInternalUrl(expandedAndNormalized, normalized);

	if (/^\/+$/.test(expanded)) {
		return cwd;
	}
	const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
	assertPathLengthWithinLimits(filePath, resolved);
	assertNoWindowsReservedName(filePath, resolved);
	return resolved;
}

export function isPathWithinCwd(resolvedPath: string, cwd: string): boolean {
	const relative = path.relative(path.resolve(cwd), resolvedPath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function formatPathRelativeToCwd(
	filePath: string,
	cwd: string,
	options: { trailingSlash?: boolean } = {},
): string {
	const resolvedCwd = path.resolve(cwd);
	const normalized = normalizeLocalScheme(filePath);
	if (isInternalUrlPath(normalized)) {
		return normalized;
	}
	const expanded = expandPath(normalized);
	const resolvedPath = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);
	const relative = path.relative(resolvedCwd, resolvedPath);
	const isWithinCwd = isPathWithinCwd(resolvedPath, resolvedCwd);
	let displayPath = normalizePosixPath(isWithinCwd ? relative || "." : resolvedPath);
	if (options.trailingSlash && displayPath !== "." && !displayPath.endsWith("/")) {
		displayPath += "/";
	}
	return displayPath;
}

export function resolveStoredPathCase(absolutePath: string): string {
	try {
		const stored = fs.realpathSync.native(absolutePath);
		if (stored === absolutePath) return absolutePath;
		return stored.toLowerCase() === absolutePath.toLowerCase() ? stored : absolutePath;
	} catch {
		return absolutePath;
	}
}

export function stripOuterDoubleQuotes(input: string): string {
	return input.startsWith('"') && input.endsWith('"') && input.length > 1 ? input.slice(1, -1) : input;
}
function normalizePathSeparators(input: string): string {
	if (isInternalUrlPath(input)) return input;
	if (!input.includes("\\")) return input;
	return input.replace(/\\/g, "/");
}

export function normalizePathLikeInput(input: string): string {
	return stripOuterDoubleQuotes(input.trim());
}

function parseStringEncodedPathArray(input: string): string[] | null {
	const trimmed = input.trim();
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;

	const parsed = tryParseJson(trimmed);
	if (!Array.isArray(parsed) || parsed.some(entry => typeof entry !== "string")) {
		return null;
	}
	return parsed;
}

export function toPathList(input: string | string[] | undefined): string[] {
	if (typeof input === "string") return parseStringEncodedPathArray(input) ?? [input];
	return input ?? [];
}

const GLOB_PATH_CHARS = ["*", "?", "[", "{"] as const;

export function hasGlobPathChars(filePath: string): boolean {
	return GLOB_PATH_CHARS.some(char => filePath.includes(char));
}

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

function normalizePosixPath(filePath: string): string {
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
