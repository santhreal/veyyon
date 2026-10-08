import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult } from "@veyyon/agent-core";
import { formatHashlineHeader } from "@veyyon/hashline";
import { type AstFindMatch, type AstFindResult, astGrep } from "@veyyon/natives";
import { untilAborted } from "@veyyon/utils";
import { recordFileSnapshot, recordSeenLinesFromBody } from "../../edit/file-snapshot-store";
import { artifactFooter, truncateHead } from "../../session/streaming-output";
import { resolveFileDisplayMode } from "../../utils/file-display-mode";
import { getLanguageFromPath } from "../../utils/lang-from-path";
import type { ToolSession } from "..";
import { formatResultPath } from "../core/file-recorder";
import { formatGroupedFiles } from "../core/grouped-file-output";
import { inlineBudgetFor, saveOutputArtifact } from "../core/output-artifact";
import type { OutputMeta } from "../core/output-meta";
import { toPathList } from "../core/path-utils";
import { capParseErrors, formatCodeFrameLine, formatParseErrors } from "../core/render-utils";
import { ToolError, throwIfAborted } from "../core/tool-errors";
import { toolResult } from "../core/tool-result";
import { loadUrlReader } from "../web/manifest";
import { parseReadUrlTarget } from "../web/read-url-target";
import { formatMatchLine } from "./match-line-format";
import { MATCH_LIMIT_NOTICE_PREFIX } from "./search-card-limits";
import { isImmutableSearchSourcePath, resolveToolSearchScope, type ToolScopeResolution } from "./search-scope";
import { BROAD_SEARCH_INLINE_MAX_BYTES } from "./text-search";

export interface StructureSearchInput {
	pattern: string;
	path?: string;
	skip?: number;
}

/** Bytes a metavariable value may restate before the name alone stands for it. */
export const META_VALUE_MAX_BYTES = 60;

function compareAstFindMatch(left: AstFindMatch, right: AstFindMatch): number {
	const pathCmp = left.path.localeCompare(right.path);
	if (pathCmp !== 0) return pathCmp;
	if (left.startLine !== right.startLine) return left.startLine - right.startLine;
	if (left.startColumn !== right.startColumn) return left.startColumn - right.startColumn;
	if (left.endLine !== right.endLine) return left.endLine - right.endLine;
	if (left.endColumn !== right.endColumn) return left.endColumn - right.endColumn;
	if (left.byteStart !== right.byteStart) return left.byteStart - right.byteStart;
	return left.byteEnd - right.byteEnd;
}

function retainAstFindMatch(matches: AstFindMatch[], capacity: number, candidate: AstFindMatch): void {
	if (matches.length < capacity) {
		matches.push(candidate);
		return;
	}
	let worstIndex = 0;
	for (let index = 1; index < matches.length; index++) {
		if (compareAstFindMatch(matches[index]!, matches[worstIndex]!) > 0) {
			worstIndex = index;
		}
	}
	if (compareAstFindMatch(candidate, matches[worstIndex]!) < 0) {
		matches[worstIndex] = candidate;
	}
}

interface ResolvedTarget {
	basePath: string;
	isFile: boolean;
}

/**
 * Folds per-target ast-grep results into one page. Overlapping targets (a directory plus a file
 * nested inside it) report the same match twice; the first occurrence is kept and the totals are
 * corrected for the repeat.
 */
class MultiTargetMerge {
	readonly #retained: AstFindMatch[] = [];
	readonly #parseErrors: string[] = [];
	readonly #seenMatchKeys = new Set<string>();
	readonly #seenFilesWithMatches = new Set<string>();
	readonly #capacity: number;
	readonly #commonBasePath: string;
	#totalMatches = 0;
	#filesWithMatches = 0;
	#filesSearched = 0;
	#limitReached = false;

	constructor(capacity: number, commonBasePath: string) {
		this.#capacity = capacity;
		this.#commonBasePath = commonBasePath;
	}

	absorb(target: ResolvedTarget, result: AstFindResult): void {
		this.#totalMatches += result.totalMatches;
		this.#filesWithMatches += result.filesWithMatches;
		this.#filesSearched += result.filesSearched;
		this.#limitReached = this.#limitReached || result.limitReached;
		for (const error of result.parseErrors ?? []) this.#parseErrors.push(error);
		const targetSeenFiles = new Set<string>();
		for (const match of result.matches) this.#absorbMatch(target, match, targetSeenFiles);
	}

	/** The sorted page after `skip`, at most `limit` long. */
	page(skip: number, limit: number): AstFindResult {
		this.#retained.sort(compareAstFindMatch);
		const visible = this.#retained.slice(skip);
		return {
			matches: visible.slice(0, limit),
			totalMatches: this.#totalMatches,
			filesWithMatches: this.#filesWithMatches,
			filesSearched: this.#filesSearched,
			limitReached: this.#limitReached || visible.length > limit,
			parseErrors: this.#parseErrors.length > 0 ? this.#parseErrors : undefined,
		};
	}

	#absorbMatch(target: ResolvedTarget, match: AstFindMatch, targetSeenFiles: Set<string>): void {
		const absolute = target.isFile ? target.basePath : path.resolve(target.basePath, match.path);
		const matchKey = `${absolute}\0${match.startLine}\0${match.startColumn}`;
		if (this.#seenMatchKeys.has(matchKey)) {
			this.#discountRepeat(absolute, targetSeenFiles);
			return;
		}
		this.#seenMatchKeys.add(matchKey);
		if (!this.#seenFilesWithMatches.has(absolute)) {
			this.#seenFilesWithMatches.add(absolute);
			targetSeenFiles.add(absolute);
		}
		const rebased = path.relative(this.#commonBasePath, absolute).replace(/\\/g, "/");
		retainAstFindMatch(this.#retained, this.#capacity, { ...match, path: rebased });
	}

	/** Take back what a repeated match added: one match, and its file once per target that repeats it. */
	#discountRepeat(absolute: string, targetSeenFiles: Set<string>): void {
		this.#totalMatches = Math.max(0, this.#totalMatches - 1);
		if (this.#seenFilesWithMatches.has(absolute) && !targetSeenFiles.has(absolute)) {
			this.#filesWithMatches = Math.max(0, this.#filesWithMatches - 1);
			targetSeenFiles.add(absolute);
		}
	}
}

async function runMultiTargetAstGrep(
	targets: Array<{ basePath: string; glob?: string }>,
	options: { patterns: string[]; commonBasePath: string; skip: number; limit: number; signal?: AbortSignal },
): Promise<AstFindResult> {
	throwIfAborted(options.signal, "search");
	// Resolve target kind once outside the per-match loop so file vs directory
	// path resolution is deterministic and does not rely on string suffix matching.
	const resolvedTargets = await Promise.all(
		targets.map(async (target): Promise<ResolvedTarget> => {
			const basePath = path.resolve(target.basePath);
			const isFile = await fs
				.stat(basePath)
				.then(stat => stat.isFile())
				.catch(() => false);
			return { basePath, isFile };
		}),
	);
	const capacity = options.skip + options.limit + 1;
	// Each target is an independent native scan on libuv's blocking pool, so
	// they run concurrently instead of serializing behind one another. Every
	// scan still carries the tool's own signal, so a cancellation fails each
	// of them closed just as the sequential loop did. Aggregation below walks
	// `settled` in target order, so match retention, totals and the surfaced
	// error (first failure in target order) are byte-identical to the
	// sequential version.
	const settled = await Promise.allSettled(
		targets.map(target =>
			astGrep({
				patterns: options.patterns,
				path: target.basePath,
				glob: target.glob,
				offset: 0,
				limit: capacity,
				includeMeta: true,
				signal: options.signal,
			}),
		),
	);
	const merge = new MultiTargetMerge(capacity, options.commonBasePath);
	for (const [targetIndex, outcome] of settled.entries()) {
		if (outcome.status === "rejected") throw outcome.reason;
		merge.absorb(resolvedTargets[targetIndex]!, outcome.value);
	}
	return merge.page(options.skip, options.limit);
}

export interface StructureSearchDetails {
	matchCount: number;
	fileCount: number;
	filesSearched: number;
	limitReached: boolean;
	parseErrors?: string[];
	/** Total parse error count before {@link PARSE_ERRORS_LIMIT} capping. Omitted when no errors. */
	parseErrorsTotal?: number;
	scopePath?: string;
	files?: string[];
	fileMatches?: Array<{ path: string; count: number }>;
	/** Truncation and limit record the output layer reads to append a notice and
	 * to skip re-spilling a result already written to an artifact. Structure
	 * search writes its own match-limit line and leaves this to the spill layer. */
	meta?: OutputMeta;
	/** Pre-formatted text for the user-visible TUI render. Mirrors `result.text` lines but uses
	 * a `│` gutter and `*` to mark match lines. The TUI uses this directly so it never parses model-facing text. */
	displayContent?: string;
	/** Absolute base directory used during search. Used by the renderer to resolve
	 * display-relative paths to absolute paths for OSC 8 hyperlinks. */
	searchPath?: string;
	/** Session cwd at search time. Display header/match paths are cwd-relative, so
	 * the renderer resolves them against this; `searchPath` is the scope target. */
	cwd?: string;
}

// ast-grep picks a grammar per file extension, and a prose grammar parses
// arbitrary text. Measured against this repository's CHANGELOG.md, the pattern
// `logger.warn($$$ARGS)` returned three matches averaging 2,000 characters of
// English prose, none of which contains the string `logger.warn`: the markdown
// grammar produces an inline node that swallows a whole paragraph. An unscoped
// structure search returned 8 of 40 matches from documentation files that way.
// A prose grammar cannot represent a code pattern, so a match in one is noise.
// Diff and patch files are NOT here: a hunk body carries real code lines.
// A grammar ast-grep does not yet search stays listed, because the entry is the
// policy, not the current reach of the engine.
export const PROSE_GRAMMARS: Record<string, true> = {
	asciidoc: true,
	csv: true,
	latex: true,
	log: true,
	markdown: true,
	restructuredtext: true,
	text: true,
	tsv: true,
};

/** Matches one page holds; `skip` reaches the rest. */
const DEFAULT_AST_LIMIT = 50;

interface CappedParseErrors {
	errors: string[];
	total: number;
}

interface CodeMatchGroups {
	/** Files holding a code match, in first-match order. */
	files: string[];
	matchesByFile: Map<string, AstFindMatch[]>;
	/** Matches set aside because their file parses with a prose grammar. */
	proseMatchCount: number;
	proseFiles: Set<string>;
}

interface RenderedLines {
	model: string[];
	display: string[];
}

export async function executeStructureSearch(
	session: ToolSession,
	params: StructureSearchInput,
	signal?: AbortSignal,
): Promise<AgentToolResult<StructureSearchDetails>> {
	return untilAborted(signal, async () => {
		const pattern = params.pattern.trim();
		if (pattern.length === 0) {
			throw new ToolError("Structure search input must not be empty");
		}
		const skip = pageOffset(params.skip);
		const scope = await resolveStructureScope(session, params.path, signal);
		const result = await findStructureMatches(scope, [pattern], skip, signal);
		const parseErrors = structureParseErrors(result.parseErrors);
		const groups = groupCodeMatches(result.matches, filePath =>
			formatResultPath(filePath, scope.isDirectory, scope.searchPath, session.cwd),
		);
		const proseNote = proseExclusionNote(groups);
		const baseDetails: StructureSearchDetails = {
			matchCount: result.totalMatches,
			fileCount: result.filesWithMatches,
			filesSearched: result.filesSearched,
			limitReached: result.limitReached,
			...(parseErrors.errors.length > 0
				? { parseErrors: parseErrors.errors, parseErrorsTotal: parseErrors.total }
				: {}),
			scopePath: scope.scopePath,
			searchPath: scope.searchPath,
			cwd: session.cwd,
			files: groups.files,
			fileMatches: [],
		};
		if (groups.matchesByFile.size === 0) {
			const where = scope.scopePath ?? scope.searchPath;
			return noCodeMatchResult(baseDetails, result, skip, parseErrors, proseNote, where);
		}

		const tags = await snapshotHashlineTags(session, groups.files, scope.immutableSourcePaths);
		const renderer = new FileMatchRenderer(session, groups.matchesByFile, tags);
		const output = layoutFileMatches(groups.files, scope.isDirectory, renderer, tags);
		const details: StructureSearchDetails = {
			...baseDetails,
			fileMatches: groups.files.map(filePath => ({ path: filePath, count: renderer.countOf(filePath) })),
			displayContent: output.display.join("\n"),
		};
		appendNotices(output.model, result, skip, proseNote, parseErrors);
		return toolResult(details)
			.text(await inlineOrSpill(session, output.model.join("\n")))
			.done();
	});
}

/** Floor `skip`, refusing a negative or non-finite offset. */
function pageOffset(skip: number | undefined): number {
	const offset = skip === undefined ? 0 : Math.floor(skip);
	if (!Number.isFinite(offset) || offset < 0) {
		throw new ToolError("skip must be a non-negative number");
	}
	return offset;
}

/** Resolve `path`, the cwd when absent, to a search scope; a URL is materialized to a read-only local file. */
function resolveStructureScope(
	session: ToolSession,
	rawPath: string | undefined,
	signal?: AbortSignal,
): Promise<ToolScopeResolution> {
	const scopedPaths = toPathList(rawPath);
	return resolveToolSearchScope({
		rawPaths: scopedPaths.length > 0 ? scopedPaths : ["."],
		cwd: session.cwd,
		internalUrlAction: "search",
		trackImmutableSources: true,
		settings: session.settings,
		signal,
		localProtocolOptions: session.localProtocolOptions,
		skills: session.skills,
		resolveExternalUrl: async target => {
			const urlTarget = parseReadUrlTarget(target);
			if (!urlTarget) return undefined;
			const { materializeReadUrlToFile } = await loadUrlReader(session);
			const materialized = await materializeReadUrlToFile(
				session,
				{ path: urlTarget.path, raw: urlTarget.raw },
				signal,
			);
			return { sourcePath: materialized.path, immutable: true };
		},
	});
}

/** Run the patterns over one scope, or over each of several targets merged into one page. */
function findStructureMatches(
	scope: ToolScopeResolution,
	patterns: string[],
	skip: number,
	signal?: AbortSignal,
): Promise<AstFindResult> {
	if (scope.multiTargets) {
		return runMultiTargetAstGrep(scope.multiTargets, {
			patterns,
			commonBasePath: scope.searchPath,
			skip,
			limit: DEFAULT_AST_LIMIT,
			signal,
		});
	}
	return astGrep({
		patterns,
		path: scope.searchPath,
		glob: scope.globFilter,
		offset: skip,
		includeMeta: true,
		signal,
	});
}

/** Cap the parse errors, each stripped of the file prefix the native layer puts before a syntax-tree error. */
function structureParseErrors(errors: string[] | undefined): CappedParseErrors {
	const normalized = (errors ?? []).map(error => {
		const parseError = error.match(/^.+: (.+: parse error \(syntax tree contains error nodes\))$/);
		return parseError?.[1] ?? error;
	});
	return capParseErrors(normalized);
}

/** Group matches by display path, setting aside every match in a prose-grammar file. */
function groupCodeMatches(matches: AstFindMatch[], formatPath: (filePath: string) => string): CodeMatchGroups {
	const matchesByFile = new Map<string, AstFindMatch[]>();
	const proseFiles = new Set<string>();
	let proseMatchCount = 0;
	for (const match of matches) {
		const grammar = getLanguageFromPath(match.path);
		const relativePath = formatPath(match.path);
		if (grammar !== undefined && PROSE_GRAMMARS[grammar]) {
			proseMatchCount++;
			proseFiles.add(relativePath);
			continue;
		}
		const fileMatches = matchesByFile.get(relativePath);
		if (fileMatches === undefined) matchesByFile.set(relativePath, [match]);
		else fileMatches.push(match);
	}
	return { files: [...matchesByFile.keys()], matchesByFile, proseMatchCount, proseFiles };
}

/** The note counting matches set aside in documentation files; empty when there were none. */
function proseExclusionNote({ proseMatchCount: count, proseFiles: files }: CodeMatchGroups): string {
	if (count === 0) return "";
	const sample = [...files].slice(0, 3).join(", ");
	return `Excluded ${count} match${count === 1 ? "" : "es"} in ${files.size} documentation file${files.size === 1 ? "" : "s"} (${sample}): a code pattern cannot match a prose grammar.`;
}

/** The result when no code match survived: why the page is empty, then any parse issues. */
function noCodeMatchResult(
	details: StructureSearchDetails,
	result: AstFindResult,
	skip: number,
	parseErrors: CappedParseErrors,
	proseNote: string,
	where: string,
): AgentToolResult<StructureSearchDetails> {
	const parseMessage = parseErrors.errors.length
		? `\n${formatParseErrors(parseErrors.errors, parseErrors.total).join("\n")}`
		: "";
	if (skip > 0 && result.totalMatches > 0 && skip >= result.totalMatches) {
		return toolResult(details)
			.text(
				`No more results (${result.totalMatches} matches total; skip=${skip} has exhausted the result set)${parseMessage}`,
			)
			.done();
	}
	const message = noMatchMessage(result.filesSearched, where, proseNote, parseErrors.errors.length > 0);
	// Zero matches is useless even with parse issues: the follow-up
	// call has already corrected course by the time compaction runs.
	return toolResult(details).text(`${message}${parseMessage}`).useless().done();
}

/**
 * Why a search found nothing. A bare "No matches found" hid WHY it was empty. The most common
 * cause of a surprising zero is that the structure matcher selects files by language, so a
 * mismatch (or a path with no files of that language) searches ZERO files and still says "no
 * matches" — a silent recall hole. The file-search count makes a zero-file search read as a
 * scoping problem, not proven absence.
 */
function noMatchMessage(searched: number, where: string, proseNote: string, hasParseErrors: boolean): string {
	const searchedFiles = `${searched} file${searched === 1 ? "" : "s"}`;
	if (proseNote) {
		return `No code matches (searched ${searchedFiles}). ${proseNote} Scope \`path\` to the language the pattern is written for.`;
	}
	if (hasParseErrors) {
		return "No matches found. Parse issues mean the query may be mis-scoped; narrow `path` before concluding absence.";
	}
	if (searched === 0) {
		return `No matches found because NO FILES were searched (0 files under ${where}). Structure search selects files by language, so this usually means the path has no files of the target language, the path is wrong, or the language was not detected. Verify the path and language before concluding the pattern does not match.`;
	}
	return `No matches found (searched ${searchedFiles}). If you expected matches, check the pattern syntax for this language and that the path covers the intended files.`;
}

/**
 * Snapshot each editable file under hashline display so its match lines carry anchors. A
 * read-only source, an over-cap file and an unreadable file get no tag and print plain lines.
 */
async function snapshotHashlineTags(
	session: ToolSession,
	files: string[],
	immutableSourcePaths: ReadonlySet<string>,
): Promise<Map<string, string>> {
	const tags = new Map<string, string>();
	if (!resolveFileDisplayMode(session).hashLines) return tags;
	for (const relativePath of files) {
		const absolutePath = path.resolve(session.cwd, relativePath);
		if (isImmutableSearchSourcePath(absolutePath, immutableSourcePaths)) continue;
		// Whole-file content tag: any anchor validates while the file is unchanged.
		const tag = await recordFileSnapshot(session, absolutePath);
		if (tag) tags.set(relativePath, tag);
	}
	return tags;
}

/**
 * Renders one file's matches as model lines and display lines, counting each file's matches and
 * recording the lines a tagged file showed the model so a later edit can anchor on them.
 */
class FileMatchRenderer {
	readonly #counts = new Map<string, number>();
	readonly #session: ToolSession;
	readonly #matchesByFile: Map<string, AstFindMatch[]>;
	readonly #tags: Map<string, string>;

	constructor(session: ToolSession, matchesByFile: Map<string, AstFindMatch[]>, tags: Map<string, string>) {
		this.#session = session;
		this.#matchesByFile = matchesByFile;
		this.#tags = tags;
	}

	countOf(relativePath: string): number {
		return this.#counts.get(relativePath) ?? 0;
	}

	render(relativePath: string): RenderedLines {
		const rendered: RenderedLines = { model: [], display: [] };
		const fileMatches = this.#matchesByFile.get(relativePath) ?? [];
		const tag = this.#tags.get(relativePath);
		const lineOptions = { useHashLines: tag !== undefined };
		const matchLines = fileMatches.map(match => match.text.split("\n"));
		let width = 0;
		for (const [index, match] of fileMatches.entries()) {
			width = Math.max(width, String(match.startLine + matchLines[index]!.length - 1).length);
		}
		for (const [index, match] of fileMatches.entries()) {
			appendMatchLines(rendered, match, matchLines[index]!, width, lineOptions);
		}
		this.#counts.set(relativePath, (this.#counts.get(relativePath) ?? 0) + fileMatches.length);
		if (tag !== undefined) {
			const absoluteFilePath = path.resolve(this.#session.cwd, relativePath);
			recordSeenLinesFromBody(this.#session, absoluteFilePath, tag, rendered.model.join("\n"));
		}
		return rendered;
	}
}

/** Append one match's source lines, the first marked as the match, and its bindings line. */
function appendMatchLines(
	rendered: RenderedLines,
	match: AstFindMatch,
	lines: string[],
	width: number,
	lineOptions: { useHashLines: boolean },
): void {
	for (const [index, line] of lines.entries()) {
		const lineNumber = match.startLine + index;
		const isMatch = index === 0;
		rendered.model.push(formatMatchLine(lineNumber, line, isMatch, lineOptions));
		rendered.display.push(formatCodeFrameLine(isMatch ? "*" : " ", lineNumber, line, width));
	}
	const metaLine = match.metaVariables === undefined ? undefined : formatMetaLine(match.metaVariables);
	if (metaLine !== undefined) {
		rendered.model.push(metaLine);
		rendered.display.push(metaLine);
	}
}

/**
 * The `  meta:` line listing a match's bindings, sorted by name; undefined when it has none.
 *
 * An ast-grep binding is a source range inside the match printed just above, so its value
 * restates bytes already delivered. A multi-node capture is joined onto one line, which makes
 * `$$$BODY` a second copy of the whole body; a single-node capture spanning lines arrives with its
 * newlines and entered the body carrying no line number at all, so no hashline anchor covered it.
 * Over five patterns of this repository the bindings cost 8,414 tokens against 9,052 tokens of
 * match text. A value stays while it is short enough to be a convenience; past that the name
 * alone says the capture bound and the lines above hold it.
 */
function formatMetaLine(metaVariables: Record<string, string>): string | undefined {
	const parts = Object.entries(metaVariables)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) =>
			value.includes("\n") || Buffer.byteLength(value, "utf-8") > META_VALUE_MAX_BYTES
				? `${key}=…`
				: `${key}=${value}`,
		);
	return parts.length > 0 ? `  meta: ${parts.join(", ")}` : undefined;
}

/** Lay rendered files out as a directory tree, or as one block per file headed by its hashline tag. */
function layoutFileMatches(
	files: string[],
	isDirectory: boolean,
	renderer: FileMatchRenderer,
	tags: Map<string, string>,
): RenderedLines {
	if (isDirectory) {
		return formatGroupedFiles(files, relativePath => {
			const rendered = renderer.render(relativePath);
			const tag = tags.get(relativePath);
			return {
				modelLines: rendered.model,
				displayLines: rendered.display,
				headerSuffix: tag ? `#${tag}` : "",
				skip: rendered.model.length === 0,
			};
		});
	}
	const output: RenderedLines = { model: [], display: [] };
	for (const relativePath of files) {
		const rendered = renderer.render(relativePath);
		if (rendered.model.length === 0) continue;
		if (output.model.length > 0) {
			output.model.push("");
			output.display.push("");
		}
		const tag = tags.get(relativePath);
		if (tag) output.model.push(formatHashlineHeader(relativePath, tag));
		output.model.push(...rendered.model);
		output.display.push(...rendered.display);
	}
	return output;
}

/** Append the page-limit notice, the prose exclusion note and the parse issues, each after a blank line. */
function appendNotices(
	lines: string[],
	result: AstFindResult,
	skip: number,
	proseNote: string,
	parseErrors: CappedParseErrors,
): void {
	if (result.limitReached) {
		// `limit` is a files-only field of the search tool, so advice to raise it
		// costs a rejected call and a round trip. `skip` is what structure search
		// accepts, and the offset is over the unfiltered page the native layer
		// returned, not over the matches left after the prose-grammar exclusion.
		const nextSkip = skip + result.matches.length;
		lines.push(
			"",
			`${MATCH_LIMIT_NOTICE_PREFIX}: ${result.totalMatches} found, ${result.matches.length} returned. Use skip=${nextSkip} for the next page, or narrow path or input.`,
		);
	}
	if (proseNote) lines.push("", proseNote);
	if (parseErrors.errors.length) lines.push("", ...formatParseErrors(parseErrors.errors, parseErrors.total));
}

/** Head-truncate to the inline budget; a truncated output is saved whole to an artifact named in a footer. */
async function inlineOrSpill(session: ToolSession, rawOutput: string): Promise<string> {
	const headTruncation = truncateHead(rawOutput, {
		maxBytes: inlineBudgetFor(session, BROAD_SEARCH_INLINE_MAX_BYTES),
		maxLines: Number.MAX_SAFE_INTEGER,
	});
	if (!headTruncation.truncated) return headTruncation.content;
	const spillArtifactId = await saveOutputArtifact(session, "search-structure", rawOutput);
	if (!spillArtifactId) return headTruncation.content;
	const separator = headTruncation.content.endsWith("\n") ? "" : "\n";
	return `${headTruncation.content}${separator}${artifactFooter(spillArtifactId)}`;
}

// =============================================================================
// TUI Renderer
// =============================================================================

export interface StructureSearchRenderArgs {
	input: string;
	path?: string;
	skip?: number;
}
