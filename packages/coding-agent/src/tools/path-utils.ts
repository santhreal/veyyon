import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { isEnoent, isMissingPath } from "@veyyon/utils/fs-error";
import { tryParseJson } from "@veyyon/utils/json";
import { expandTilde, stripWindowsExtendedLengthPathPrefix } from "@veyyon/utils/path";
// Owners, not the `@veyyon/utils` barrel: 5 modules against 74.
import { READ_SELECTOR_RANGE_LIST_SRC, splitReadSelector } from "@veyyon/utils/read-selector";
import { trimTrailingSlashes, URL_SCHEME_PREFIX_RE } from "@veyyon/utils/url";
import { ToolError } from "./tool-errors";

// NOTHING HERE MAY IMPORT `../internal-urls`, DIRECTLY OR THROUGH A BARREL.
// This module is imported for small path helpers all over the package, and a
// single `InternalUrlRouter` import used to put it inside a 23-module cycle
// (path-utils -> internal-urls -> skill-protocol -> extensibility/skills ->
// discovery -> builtin -> path-utils), dragging `mcp`, `lsp/utils` and `config`
// in with it. A cycle is instantiated as one unit, so importing this file cost
// 51.7 MB, once per test file because the runner gives each one a fresh realm.
// The one function that needed the router now lives in `./search-scope`, which
// is downstream of this module. Keep it that way.

export { expandTilde };

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
// The line-range/`raw`/`conflicts` selector grammar and `splitPathAndSel` (the
// canonical filesystem splitter) live in @veyyon/utils (read-selector.ts), shared
// with agent-core compaction so the two can never drift.
// `READ_SELECTOR_RANGE_LIST_SRC` is the range-list fragment; LINE_RANGE_CHUNK_RE
// below is a separate CAPTURING variant used by parseLineRangeChunk, kept in sync
// with that same fragment.
// Permissive selector chunk for internal URLs — accepts well-formed selectors
// plus common malformed shapes (e.g. `:-N`) so the read tool peels the entire
// selector chain off before dispatching to a protocol handler.
const INTERNAL_URL_SELECTOR_PART_RE = new RegExp(
	String.raw`^(?:raw|conflicts|${READ_SELECTOR_RANGE_LIST_SRC}|-\d+(?:[-+]\d+)?)$`,
	"i",
);
// Schemes whose host grammar is identifier-shaped, so any trailing
// `:<selector-chunk>` is unambiguously a read-tool selector. `mcp://` is
// excluded because mcp resource URIs may legitimately contain colons. `ssh://`
// is included despite an optional `:port`; `splitInternalUrlSel` skips the peel
// for an `ssh://host:port` that has no `/path`, so the port colon is never
// mistaken for a selector (a real ssh selector trails the `/path`, e.g.
// `ssh://h/f:1-5`).
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
// Schemes whose resource URIs are server-defined and may legitimately end
// with selector-shaped tails (e.g. `:raw`, `:conflicts`, `:1-50`, `/:raw`).
// `McpProtocolHandler` resolves by exact URI match (`r.uri === uri`), so
// peeling syntactically can make valid resources unreachable. Keep these
// schemes opaque; selector support for them needs a resolver-aware path that
// tries the exact URI before interpreting any suffix as a read selector.
const OPAQUE_RESOURCE_SCHEMES: ReadonlySet<string> = new Set(["mcp"]);
const NARROW_NO_BREAK_SPACE = "\u202F";
// Read once. `process.platform` is a getter, and resolving it per call was
// measurably expensive on the hot path, so it is read once rather than as a
// default argument evaluated on every `resolveToCwd`.
const CURRENT_PLATFORM: NodeJS.Platform = process.platform;
// Every scheme the internal-URL router registers. A scheme missing here is read
// as a filesystem path: it escapes `assertNotInternalUrl`, gets its backslashes
// rewritten, and is measured against the cwd boundary as though it named a file.
// `internal-url-schemes-are-classified.test.ts` enumerates the router and fails
// when this list and the router disagree, because five schemes had drifted out of
// it (`history`, `issue`, `memory`, `pr`, `veyyon`) and nothing noticed.
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
	// macOS stores filenames in NFD (decomposed) form, try converting user input to NFD
	return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
	// macOS uses U+2019 (right single quotation mark) in screenshot names like "Capture d'écran"
	// Users typically type U+0027 (straight apostrophe)
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
		// This picks between candidate spellings of a path the user typed (shell escapes, curly
		// apostrophes). A spelling we cannot reach is not the one they meant, and the read that follows
		// the chosen spelling reports its own failure with the path.
		return false;
	}
}

function normalizeAtPrefix(filePath: string): string {
	if (!filePath.startsWith("@")) return filePath;

	const withoutAt = filePath.slice(1);

	// We only treat a leading "@" as a shorthand for a small set of well-known
	// syntaxes. This avoids mangling literal paths like "@my-file.txt".
	if (
		withoutAt.startsWith("/") ||
		withoutAt === "~" ||
		withoutAt.startsWith("~/") ||
		// Windows absolute paths (drive letters / UNC / root-relative)
		path.win32.isAbsolute(withoutAt) ||
		// Internal URL shorthands
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
	// Some models intermittently prefix an otherwise-valid path with a stray
	// `:` (e.g. `:/abs/path`, `:../rel`). No real path starts with `:` and it
	// never begins a selector against an absolute/relative path, so strip it
	// before resolution — mirroring the `@`-prefix normalization above and the
	// implicit stripping `write` already tolerates (issue #5508).
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

/**
 * Inclusive line range describing one selector segment (e.g. `50-100`,
 * `301-`, or `50+10`). `endLine` is `undefined` for open-ended ranges.
 */
export interface LineRange {
	startLine: number;
	endLine: number | undefined;
}

const LINE_RANGE_CHUNK_RE = /^L?(\d+)(?:(\.\.|[-+])L?(\d+)?)?$/i;

/** Parse a single `N`, `N-M`, `N-`, `N+K`, or `..`-aliased (`N..M`, `N..`) chunk. Throws via {@link ToolError} on invalid bounds. */
export function parseLineRangeChunk(sel: string): LineRange | null {
	// Tolerate surrounding whitespace so a spaced multi-range list like
	// `1-3, 5-7` parses. Without this the `" 5-7"` chunk fails the anchored
	// regex, `parseLineRanges` returns null, and `read` silently widens the
	// selector to the whole file instead of the requested lines.
	const lineMatch = LINE_RANGE_CHUNK_RE.exec(sel.trim());
	if (!lineMatch) return null;
	const rawStart = Number.parseInt(lineMatch[1]!, 10);
	if (rawStart < 1) {
		throw new ToolError("Line selector 0 is invalid; lines are 1-indexed. Use :1.");
	}
	// `..` is a forgiving alias for `-` (e.g. `2724..2727` == `2724-2727`).
	const sep = lineMatch[2] === ".." ? "-" : lineMatch[2];
	const rhs = lineMatch[3] ? Number.parseInt(lineMatch[3], 10) : undefined;
	let rawEnd: number | undefined;
	if (sep === "+") {
		if (rhs === undefined || rhs < 1) {
			throw new ToolError(`Invalid range ${rawStart}+${rhs ?? 0}: count must be >= 1.`);
		}
		rawEnd = rawStart + rhs - 1;
	} else if (sep === "-") {
		// `301-` is shorthand for "from 301 onward" — equivalent to bare `301`.
		if (rhs !== undefined) {
			if (rhs < rawStart) {
				throw new ToolError(`Invalid range ${rawStart}-${rhs}: end must be >= start.`);
			}
			rawEnd = rhs;
		}
	}
	return { startLine: rawStart, endLine: rawEnd };
}

/**
 * Parse a comma-separated list of line ranges (e.g. `5-16,960-973`). Returns
 * the ranges in ascending order with overlapping/adjacent ranges merged so
 * downstream consumers can stream the file in a single forward pass per range.
 */
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
		// Open-ended (endLine undefined) means "to EOF" — any later range is absorbed.
		if (last.endLine === undefined) continue;
		// Merge when current starts within (or immediately after) the last range.
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

/**
 * Extract line ranges from a read selector, ignoring display modes (`raw`, `conflicts`).
 * Returns parsed ranges, or `undefined` for unfiltered whole-resource searches.
 */
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

/** Return `true` when `lineNumber` (1-indexed) falls in any of the supplied ranges. */
export function isLineInRanges(lineNumber: number, ranges: readonly LineRange[]): boolean {
	for (const range of ranges) {
		if (lineNumber < range.startLine) continue;
		if (range.endLine === undefined || lineNumber <= range.endLine) return true;
	}
	return false;
}

/**
 * Split a read-tool path into its base path and trailing selector.
 * Delegates to {@link splitReadSelector} in `@veyyon/utils` for consistent grammar.
 */
export const splitPathAndSel: (rawPath: string) => { path: string; sel?: string } = splitReadSelector;

/**
 * Probe whether `filePath` exists literally using `lstat` to preserve paths
 * matching selector grammar (e.g. `test:1-2`). Ambiguous errors return `"unknown"`.
 */
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

/**
 * Split a path and selector, preferring a literal file when it exists on disk.
 * Falls back to strict selector splitting only on definitive `ENOENT`/`ENOTDIR`.
 */
export async function splitPathAndSelPreferringLiteral(
	rawPath: string,
	cwd: string,
): Promise<{ path: string; sel?: string }> {
	const strict = splitPathAndSel(rawPath);
	if (strict.sel === undefined) return strict;
	const probe = await probeLiteralPathExists(rawPath, cwd);
	return probe === "missing" ? strict : { path: rawPath };
}

/**
 * Split internal URLs (`scheme://...`) into URL target and trailing read selector.
 * Iteratively peels selector chunks so protocol handlers receive clean URLs.
 * Skips schemes where resource URIs legitimately contain colons (`mcp://`).
 */

export function splitInternalUrlSel(rawPath: string): { path: string; sel?: string } {
	const schemeMatch = rawPath.match(URL_SCHEME_PREFIX_RE);
	if (!schemeMatch) return { path: rawPath };
	const scheme = schemeMatch[1].toLowerCase();
	// Opaque schemes (mcp://, etc.) carry server-defined resource URIs that may
	// legitimately end in selector-shaped tails. Forward verbatim — see
	// OPAQUE_RESOURCE_SCHEMES.
	if (OPAQUE_RESOURCE_SCHEMES.has(scheme)) return { path: rawPath };
	if (!INTERNAL_SCHEMES_WITH_SELECTORS[scheme]) return { path: rawPath };

	const schemeEnd = schemeMatch[0].length;
	// ssh:// authority carries an optional `:port`; with no `/path` after the
	// authority, a trailing `:NNNN` is the port, not a read selector
	// (e.g. ssh://host:2222). Other schemes' authority-trailing selectors
	// (artifact://5:1-50) still peel, so this guard is ssh-specific.
	if (scheme === "ssh" && rawPath.indexOf("/", schemeEnd) === -1) {
		return { path: rawPath };
	}
	let path = rawPath;
	const chunks: string[] = [];
	while (true) {
		const colon = path.lastIndexOf(":");
		// Stop before crossing into the scheme separator `://`.
		if (colon < schemeEnd) break;
		const tail = path.slice(colon + 1);
		if (!INTERNAL_URL_SELECTOR_PART_RE.test(tail)) break;
		chunks.unshift(tail);
		path = path.slice(0, colon);
	}
	if (chunks.length === 0) return { path: rawPath };
	return { path, sel: chunks.join(":") };
}

/**
 * Strip display mode selectors (`raw`/`conflicts`) from internal-URL write targets.
 * Throws if a partial range selector is supplied since `write` requires a whole file.
 */
export function peelWriteUrlSelector(rawPath: string): string {
	const { path, sel } = splitInternalUrlSel(rawPath);
	if (sel === undefined) return rawPath;
	// Case-insensitive to match read's selector grammar (parseSel + the /i regexes above).
	if (/^(?:raw|conflicts)$/i.test(sel)) return path;
	throw new ToolError(
		`write does not accept the trailing selector ":${sel}" — it writes a whole file. ` +
			`Remove ":${sel}", or if the filename truly ends with it, percent-encode the ":" as %3A.`,
	);
}

/**
 * Reject paths containing NUL bytes before syscalls to prevent path truncation
 * and misleading argument type errors.
 */
function assertNoNulByte(original: string): void {
	const index = original.indexOf("\0");
	if (index === -1) return;
	throw new Error(
		`Path contains a NUL byte at position ${index} and cannot name a file: ${JSON.stringify(original)}. ` +
			`Remove the NUL; no filesystem can store it, and a truncated path would silently target a different file.`,
	);
}

/** Maximum allowed filename component length in bytes (`NAME_MAX` = 255). */
const MAX_PATH_COMPONENT_BYTES = 255;

/** Maximum allowed whole-path length in bytes (`PATH_MAX` = 4096). */
const MAX_PATH_TOTAL_BYTES = 4096;

/**
 * Reject paths exceeding component (255B) or total (4096B) byte limits with
 * descriptive error messages before syscall execution.
 */
function assertPathLengthWithinLimits(original: string, resolved: string): void {
	// FAST PATH, and the reason this function is shaped the way it is. The exact
	// check below splits the path and measures every component, which allocates an
	// array plus a `Buffer.byteLength` call per component. On `resolveToCwd`, which
	// every tool path goes through, that measured 312ns -> 688ns: a 2x
	// pessimization of the hot path to catch an input almost nobody sends.
	// (Timings are min-of-5 runs of 200k calls; single samples on this box swing
	// by ~30%, so a one-shot measurement here is not trustworthy.)
	//
	// UTF-8 never uses more than 3 bytes per UTF-16 code unit (a BMP character is
	// at most 3 bytes in one unit; a surrogate pair is 4 bytes across two, so 2
	// per unit). So a component of at most 85 code units cannot reach 256 bytes,
	// and a path of at most 1365 cannot reach 4097. When both hold, the exact
	// check cannot fail and is skipped entirely: one allocation-free scan.
	const MAX_UNITS_ALWAYS_SAFE = Math.floor(MAX_PATH_COMPONENT_BYTES / 3);
	let componentStart = 0;
	let mustMeasure = resolved.length > Math.floor(MAX_PATH_TOTAL_BYTES / 3);
	if (!mustMeasure) {
		for (let i = 0; i <= resolved.length; i++) {
			// Treat end-of-string as a separator so the final component is measured.
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
	// Windows with an extended-length prefix reaches 32767, so a POSIX ceiling
	// applied there would refuse paths that work.
	if (process.platform === "win32") return;
	const totalBytes = Buffer.byteLength(resolved, "utf8");
	if (totalBytes > MAX_PATH_TOTAL_BYTES) {
		throw new Error(
			`Path is ${totalBytes} bytes, over the ${MAX_PATH_TOTAL_BYTES}-byte total path limit, ` +
				`starting from ${JSON.stringify(original.slice(0, 60))}. Use a shorter directory or filename.`,
		);
	}
}

/**
 * Win32 device names. Reserved in EVERY directory, not just the drive root, and
 * reserved with any extension too: `CON`, `CON.txt` and `con.log` all name the
 * console device rather than a file.
 */
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

/**
 * Reject Windows device names (`CON`, `NUL`, etc.) and paths with trailing dots
 * or spaces that Win32 silently strips or aliases.
 */
export function assertNoWindowsReservedName(
	original: string,
	resolved: string,
	platform: NodeJS.Platform = CURRENT_PLATFORM,
): void {
	if (platform !== "win32") return;
	for (const component of resolved.split(/[/\\]/)) {
		// `.` and `..` are navigation, not names ending in a dot, and a drive
		// letter is never a filename. Measuring any of them against these rules
		// would refuse ordinary relative paths.
		if (!component || component === "." || component === ".." || /^[a-zA-Z]:$/.test(component)) continue;

		const trimmedTail = component.replace(/[. ]+$/, "");
		if (trimmedTail !== component) {
			throw new Error(
				`Path component ${JSON.stringify(component)} ends with a dot or space, which Windows silently ` +
					`strips, so it would open ${JSON.stringify(trimmedTail)} instead: ${JSON.stringify(original)}. ` +
					"Remove the trailing dot or space so the path names the file it appears to name.",
			);
		}

		// The reservation applies to the stem, so `CON.txt` is still the console.
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

/**
 * True when a path argument contains `ssh://` anywhere. Used for fail-closed
 * pre-expansion approval checks on un-flattened delimited paths.
 */
export function pathTargetsSsh(path: string): boolean {
	return /ssh:\/\//i.test(path);
}

/**
 * True when a path is specifically an `ssh://` URL (anchored scheme match).
 * Unlike {@link pathTargetsSsh} (substring, for the pre-expansion approval
 * scan), this is the exact per-entry check used to reject `ssh://` *before* a
 * side-effecting `InternalUrlRouter.resolve` in tools that need a local file.
 */
export function isSshUrl(path: string): boolean {
	return /^ssh:\/\//i.test(path.trim());
}

/**
 * True when the read tool's URL parser (`parseReadUrlTarget` in fetch.ts) would
 * recognize this path as a readable external URL: a strict `http(s)://`, a
 * collapsed `http(s):/host` (Node path normalization folds `//` → `/`), or a
 * scheme-less `www.` spelling. Keep in sync with `parseReadUrlTarget`.
 */
export function isReadableUrlPath(value: string): boolean {
	return /^https?:\/\/?/i.test(value) || /^www\./i.test(value);
}

/**
 * Return the leading literal base directory of a glob pattern containing no
 * metacharacters (`*?[{`). Used by search tools to enforce cwd boundaries.
 */
export function globSearchBase(pattern: string): string {
	const trimmed = pattern.trim();
	const meta = trimmed.search(/[*?[{]/);
	if (meta === -1) return trimmed;
	const literalPrefix = trimmed.slice(0, meta);
	const lastSlash = literalPrefix.lastIndexOf("/");
	return lastSlash === -1 ? "" : literalPrefix.slice(0, lastSlash);
}

/**
 * Resolve a path relative to cwd, handling `~` expansion and absolute paths.
 * Treats a bare root `/` as a workspace-root alias.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
	assertNoNulByte(filePath);
	const normalized = normalizeLocalScheme(filePath);
	const expanded = normalizeWindowsDriveAliasPath(expandPath(normalized));
	const expandedAndNormalized = normalizeLocalScheme(expanded);

	assertNotInternalUrl(expandedAndNormalized, normalized);

	if (/^\/+$/.test(expanded)) {
		return cwd;
	}
	// Length is checked on the RESOLVED path, because that is the string the
	// syscall receives: a short relative path under a deep cwd can exceed the
	// total limit while looking fine on its own.
	const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
	assertPathLengthWithinLimits(filePath, resolved);
	assertNoWindowsReservedName(filePath, resolved);
	return resolved;
}

/**
 * True when `resolvedPath` is inside or equal to `cwd`.
 * Pure containment check on already-resolved absolute paths.
 */
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

/**
 * Resolve the true on-disk casing of `absolutePath` via `realpathSync.native`
 * on case-insensitive filesystems. Returns unchanged if non-existent or a symlink.
 */
export function resolveStoredPathCase(absolutePath: string): string {
	try {
		const stored = fs.realpathSync.native(absolutePath);
		if (stored === absolutePath) return absolutePath;
		// Case-only difference, i.e. the same path spelled differently. Anything
		// else is a real redirection (symlink, `..`) and is left alone.
		return stored.toLowerCase() === absolutePath.toLowerCase() ? stored : absolutePath;
	} catch {
		return absolutePath;
	}
}

/**
 * Strip matching surrounding double quotes from a path string.
 * Leaves single quotes untouched as they are valid POSIX filename characters.
 */
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

/**
 * Parse a JSON-encoded array of path strings (e.g. `'["a.ts","b.ts"]'`).
 * Returns `null` when the input is not a bracketed JSON string array, so the
 * caller can fall back to treating the input as a single literal path.
 */
function parseStringEncodedPathArray(input: string): string[] | null {
	const trimmed = input.trim();
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;

	const parsed = tryParseJson(trimmed);
	if (!Array.isArray(parsed) || parsed.some(entry => typeof entry !== "string")) {
		return null;
	}
	return parsed;
}

/**
 * Normalize a path argument that may arrive as a single string, a JSON-encoded
 * string array (`'["a.ts"]'`), or an actual array into a flat `string[]`.
 * Delimited single strings (`"a.ts b.ts"`) are left for
 * {@link expandDelimitedPathEntries} to split.
 */
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

function isDelimitedPathSeparator(ch: string, mode: DelimitedPathSplitMode): boolean {
	if (mode === "comma") return ch === ",";
	if (mode === "semicolon") return ch === ";";
	if (mode === "whitespace") return TOP_LEVEL_WHITESPACE_RE.test(ch);
	return ch === "," || ch === ";" || TOP_LEVEL_WHITESPACE_RE.test(ch);
}

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
		if (braceDepth !== 0 || !isDelimitedPathSeparator(ch, mode)) continue;
		parts.push(entry.slice(start, i));
		start = i + 1;
	}
	parts.push(entry.slice(start));
	return parts;
}

async function delimitedPathPartResolves(entry: string, cwd: string, splitter: PathEntrySplitter): Promise<boolean> {
	if (isInternalUrlPath(entry)) return true;
	const peeled = splitPathAndSel(entry).path;
	const { basePath } = splitter(peeled);
	const absoluteBasePath = resolveToCwd(basePath, cwd);
	try {
		await fs.promises.stat(absoluteBasePath);
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

/**
 * Resolution threshold for path splitting: `"none"` (unconditional semicolon),
 * `"some"` (comma recovery), or `"all"` (whitespace heuristic).
 */
type DelimitedResolveRequirement = "all" | "some" | "none";

async function tryDelimitedPathSplit(
	entry: string,
	cwd: string,
	splitter: PathEntrySplitter,
	mode: DelimitedPathSplitMode,
	requirement: DelimitedResolveRequirement,
): Promise<string[] | null> {
	const rawParts = splitTopLevelDelimitedPath(entry, mode);
	if (rawParts.length < 2) return null;

	const parts = rawParts.map(normalizePathLikeInput).filter(part => part.length > 0);
	if (parts.length === 0) return null;
	if (parts.length < 2 && rawParts.length === parts.length) return null;

	if (requirement !== "none") {
		const resolved = await Promise.all(parts.map(part => delimitedPathPartResolves(part, cwd, splitter)));
		const valid = requirement === "all" ? resolved.every(Boolean) : resolved.some(Boolean);
		if (!valid) return null;
	}
	return parts;
}

/** How one path-like entry is allowed to fan out into several targets. */
export interface DelimitedPathSplitOptions {
	splitter?: PathEntrySplitter;
	/**
	 * Handling for internal URLs (`skill://`, etc.): `"keep"` leaves them whole,
	 * `"split-on-semicolon"` splits only on `;` for multi-target tools.
	 */
	internalUrls?: "keep" | "split-on-semicolon";
}

/**
 * Split one path-like entry whose multiple targets were flattened into one
 * string. Existing paths are kept intact, so real filenames containing spaces,
 * commas, or semicolons win over delimiter recovery.
 */
export async function splitDelimitedPathEntry(
	entry: string,
	cwd: string,
	options: DelimitedPathSplitOptions = {},
): Promise<string[] | null> {
	const normalizedEntry = normalizePathLikeInput(entry);
	if (!hasTopLevelPathDelimiter(normalizedEntry)) return null;
	if (isInternalUrlPath(normalizedEntry)) {
		if (options.internalUrls !== "split-on-semicolon") return null;
		return tryDelimitedPathSplit(normalizedEntry, cwd, options.splitter ?? parseSearchPath, "semicolon", "none");
	}
	// A real POSIX file may contain the delimiter and a selector-shaped tail
	// (`a;b:1-2`, `a b:1-2`). Preserve the raw entry whenever the full literal
	// resolves — or is only ambiguous — so downstream literal-preferring
	// splitters see it before delimiter expansion peels or splits (issue #4618
	// reviewer feedback: delimited expansion ran before the literal check).
	if ((await probeLiteralPathExists(normalizedEntry, cwd)) !== "missing") return null;
	const splitter = options.splitter ?? parseSearchPath;
	const peeledEntry = splitPathAndSel(normalizedEntry).path;
	if (!hasGlobPathChars(peeledEntry) && (await delimitedPathPartResolves(normalizedEntry, cwd, splitter))) {
		return null;
	}

	return (
		(await tryDelimitedPathSplit(normalizedEntry, cwd, splitter, "semicolon", "none")) ??
		(await tryDelimitedPathSplit(normalizedEntry, cwd, splitter, "comma", "some")) ??
		(await tryDelimitedPathSplit(normalizedEntry, cwd, splitter, "whitespace", "all")) ??
		(await tryDelimitedPathSplit(normalizedEntry, cwd, splitter, "mixed", "all"))
	);
}

/** Expand delimited entries in-place while preserving unsplit entries. */
export async function expandDelimitedPathEntries(
	entries: readonly string[],
	cwd: string,
	options: DelimitedPathSplitOptions = {},
): Promise<string[]> {
	const expanded: string[] = [];
	for (const entry of entries) {
		const normalizedEntry = normalizePathLikeInput(entry);
		const split = await splitDelimitedPathEntry(normalizedEntry, cwd, options);
		if (split) expanded.push(...split);
		else expanded.push(normalizedEntry);
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

/**
 * Parse search path preferring literal interpretation when a path with glob
 * characters exists on disk (e.g. Next.js `[id]` routes).
 */
export async function parseSearchPathPreferringLiteral(filePath: string, cwd: string): Promise<ParsedSearchPath> {
	if (!hasGlobPathChars(filePath) || isInternalUrlPath(filePath)) return parseSearchPath(filePath);
	try {
		await fs.promises.stat(resolveToCwd(filePath, cwd));
		return { basePath: normalizePathSeparators(filePath) };
	} catch {
		return parseSearchPath(filePath);
	}
}

// Parse a find pattern into a base directory path and a glob pattern.
// Examples:
//   src/app/**/\*.tsx -> { basePath: "src/app", globPattern: "**/*.tsx", hasGlob: true }
//   src/app/\*.tsx -> { basePath: "src/app", globPattern: "*.tsx", hasGlob: true }
//   \*.ts -> { basePath: ".", globPattern: "**/*.ts", hasGlob: true }
//   **/\*.json -> { basePath: ".", globPattern: "**/*.json", hasGlob: true }
//   /abs/path/**/\*.ts -> { basePath: "/abs/path", globPattern: "**/*.ts", hasGlob: true }
//   src/app -> { basePath: "src/app", globPattern: "**/*", hasGlob: false }
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
	const uniquePatterns = [...new Set(patterns.map(pattern => normalizePosixPath(pattern).trim()).filter(Boolean))];
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
	// A single walk rooted at the common ancestor is only safe when that
	// ancestor is itself one of the requested scopes (e.g. `.` + `src/foo.ts`):
	// the walk then covers exactly what the caller asked for. When the common
	// ancestor is an unrequested parent (`.` + `~/.gitconfig` → `$HOME`, or
	// disjoint trees → `/`), a collapsed walk traverses every unrelated sibling
	// under it — fan out into per-item targets so each scan stays bounded to a
	// requested path.
	const commonIsRequestedScope = parsedItems.some(item => item.absoluteBasePath === commonBasePath);
	// Walkers prune `.git` unconditionally and honor gitignore, so a plain-file
	// item folded into a directory walk's glob union (`.` + `.git/config`) can
	// silently never match. Callers that dedupe overlapping results opt in via
	// `fanOutFileItems` to get explicit file targets, which bypass the walker.
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
	return resolveSearchPathItems([...new Set(pathItems)], cwd, suffixGlob, fanOutFileItems);
}

async function resolveFindPatternItems(
	patternItems: string[],
	cwd: string,
): Promise<ResolvedMultiFindPattern | undefined> {
	if (patternItems.length <= 1) {
		return undefined;
	}

	// Each path becomes its own walk root. Collapsing to a shared common ancestor
	// (and filtering with a brace-union glob) would force the walker to traverse
	// and stat every unrelated sibling under that ancestor — two paths under
	// $HOME would scan all of $HOME. The find tool fans these targets out in
	// parallel instead, so every scan stays bounded to exactly one requested path.
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
	return resolveFindPatternItems([...new Set(patternItems)], cwd);
}

/**
 * Partitioned paths/globs split by base directory existence, allowing multi-path
 * tools to process existing targets while reporting missing ones.
 */
export interface PartitionedPaths {
	/** Raw input strings whose resolved base path exists. */
	valid: string[];
	/** Raw input strings whose resolved base path is missing (ENOENT). */
	missing: string[];
}

/**
 * Stat base paths concurrently, returning entries partitioned by existence.
 * Swallows only `ENOENT` so permission and I/O errors propagate.
 */
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
		// Try macOS AM/PM variant (narrow no-break space before AM/PM)
		const amPmVariant = tryMacOSScreenshotPath(baseCandidate);
		if (amPmVariant !== baseCandidate && fileExists(amPmVariant)) {
			return amPmVariant;
		}

		// Try NFD variant (macOS stores filenames in NFD form)
		const nfdVariant = tryNFDVariant(baseCandidate);
		if (nfdVariant !== baseCandidate && fileExists(nfdVariant)) {
			return nfdVariant;
		}

		// Try curly quote variant (macOS uses U+2019 in screenshot names)
		const curlyVariant = tryCurlyQuoteVariant(baseCandidate);
		if (curlyVariant !== baseCandidate && fileExists(curlyVariant)) {
			return curlyVariant;
		}

		// Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
		const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
		if (nfdCurlyVariant !== baseCandidate && fileExists(nfdCurlyVariant)) {
			return nfdCurlyVariant;
		}
	}

	return resolved;
}
