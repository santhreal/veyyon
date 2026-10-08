import * as path from "node:path";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolTier,
} from "@veyyon/agent-core";
import type { ImageContent, TextContent } from "@veyyon/ai";
import { type } from "@veyyon/ai/utils/schema/arktype";
import { lazy } from "@veyyon/utils/abortable";
import { readImageMetadata } from "@veyyon/utils/mime";
import * as prompt from "@veyyon/utils/prompt";
import { errorMessage } from "@veyyon/utils/type-guards";
import { isNotebookPath } from "../../edit/notebook";
import { CONVERTIBLE_EXTENSIONS } from "../../export/markit/convertible-extensions";
import { InternalUrlRouter, resolveLocalUrlToFile } from "../../internal-urls";
import { parseInternalUrl } from "../../internal-urls/parse";
import { toolsPrompts } from "../../prompts/tools/rows";
import type { ToolSession } from "../../sdk";
import { DEFAULT_MAX_LINES } from "../../session/streaming-output";
import { type FileDisplayMode, resolveFileDisplayMode } from "../../utils/file-display-mode";
import {
	type DelimitedPathSplitOptions,
	expandDelimitedPathEntriesSync,
	expandPath,
	isInternalUrlPath,
	isRawSelector,
	type ParsedSelector,
	parseSel,
	pathTargetsSsh,
	probeLiteralPathExists,
	splitDelimitedPathEntry,
	splitInternalUrlSel,
	splitPathAndSel,
	splitPathAndSelPreferringLiteral,
} from "../core/path-utils";
import { ToolAbortError, ToolError } from "../core/tool-errors";
import { toolResult } from "../core/tool-result";
import type { ReadUrlToolDetails } from "../web/fetch";
import { loadUrlReader } from "../web/manifest";
import { type ParsedReadUrlTarget, parseReadUrlTarget } from "../web/read-url-target";
import { parseConflictUri } from "./conflict-detect";
import { readConflictRegion, readFileConflicts } from "./read-conflicts";
import { readArchive, readSqlite } from "./read-containers";
import { readDirectory } from "./read-directory";
import {
	buildInMemoryMultiRangeResult,
	buildInMemoryTextResult,
	isMultiRange,
	selToOffsetLimit,
} from "./read-in-memory";
import { handleInternalUrl } from "./read-internal-url";
import { finishLocalRead, type LocalReadOutcome, readTextFile } from "./read-local-file";
import { loadImageContent, readConvertedDocument, readNotebook } from "./read-media";
import {
	type ResolvedReadPath,
	resolveArchiveReadPath,
	resolveSqliteReadPath,
	type SuffixMatchCache,
	statCandidateWithSuffix,
} from "./read-paths";
import { readPdfImageMember, splitPdfImageMemberReadPath } from "./read-pdf-images";
import type { ReadContext, ReadToolDetails } from "./read-types";

export { summarizeFailureReport } from "./read-summary";
export type { ReadToolDetails } from "./read-types";

const readSchema = lazy(() =>
	type({
		path: type("string").describe(
			"Local path, internal URI (e.g. memory://, skill://), or URL. Inline selectors are supported.",
		),
		"depth?": type("number.integer > 0").describe(
			"Directory listings only: recursion depth. Omitted lists the top level with per-subdirectory entry counts; 2 recurses one level.",
		),
		"limit?": type("number.integer > 0").describe(
			"Directory listings only: max entries returned; omitted entries are reported with the limit and how to see more.",
		),
	}),
);

export type ReadToolInput = typeof readSchema.value.infer;

type ReadParams = ReadToolInput;

/**
 * Filesystem path(s) a read call targets, for the cwd boundary (cwd-boundary.ts).
 * A selector suffix stays attached (it cannot introduce `../` traversal), and
 * URL/ssh/internal targets are filtered by the boundary.
 *
 * A semicolon-delimited argument reads every entry it names, so every entry is
 * measured, the way the search tools measure theirs. Measuring the joint string
 * instead resolves `a.md;/etc/passwd` to one path inside the working directory
 * that no read ever opens, and the entry outside it is never gated.
 */
export function readFilesystemTargets(args: unknown, cwd = process.cwd()): string[] {
	if (!args || typeof args !== "object" || !("path" in args)) return [];
	const rawPath = args.path;
	if (typeof rawPath !== "string") return [];
	const expanded = expandDelimitedPathEntriesSync([rawPath], cwd, { internalUrls: "split-on-semicolon" });
	return expanded.filter(entry => entry.length > 0);
}

/**
 * What internal-URL routing decided for a read path.
 *
 * `promoted` is the `local://` case: the URL named a real file, so the read continues down the
 * ordinary filesystem path with the URL's own selector carried separately.
 */
type InternalUrlRouting =
	| { readonly kind: "handled"; readonly result: AgentToolResult<ReadToolDetails> }
	| { readonly kind: "promoted"; readonly readPath: string; readonly selector: string | undefined }
	| { readonly kind: "not-internal" };

export class ReadTool implements AgentTool<typeof readSchema.value, ReadToolDetails> {
	readonly name = "read";
	readonly approval = (args: unknown): ToolTier =>
		pathTargetsSsh(String((args as { path?: unknown }).path ?? "")) ? "exec" : "read";
	// The cwd boundary reads this to gate out-of-cwd reads in non-yolo modes. A
	// `:selector` suffix is left attached (it cannot traverse); URLs/ssh/internal
	// schemes are filtered by the boundary itself. See cwd-boundary.ts.
	readonly filesystemTargets = (args: unknown, cwd = this.session.cwd): string[] => readFilesystemTargets(args, cwd);
	readonly label = "Read";
	readonly loadMode = "essential";
	get parameters(): typeof readSchema.value {
		return readSchema.value;
	}
	readonly strict = true;

	readonly #ctx: ReadContext;
	readonly #displayMode: FileDisplayMode;

	constructor(private readonly session: ToolSession) {
		this.#displayMode = resolveFileDisplayMode(session);
		const autoResizeImages = session.settings.get("images.autoResize");
		const defaultLimit = Math.max(
			1,
			Math.min(session.settings.get("read.defaultLimit") ?? DEFAULT_MAX_LINES, DEFAULT_MAX_LINES),
		);
		const inspectImageEnabled = session.settings.get("inspect_image.enabled");
		this.#ctx = { session, defaultLimit, autoResizeImages, inspectImageEnabled };
	}

	/** Rendered on each read so the text follows the session's active tools, as bash's does. */
	get description(): string {
		return prompt.render(toolsPrompts["tools/read"].text, {
			DEFAULT_LIMIT: String(this.#ctx.defaultLimit),
			IS_HL_MODE: this.#displayMode.hashLines,
			IS_LINE_NUMBER_MODE: !this.#displayMode.hashLines && this.#displayMode.lineNumbers,
			INSPECT_IMAGE_ENABLED: this.#ctx.inspectImageEnabled,
			hasBrowser: this.session.isToolActive?.("browser") ?? this.session.settings.get("browser.enabled"),
		});
	}

	async #tryReadDelimitedPaths(
		readPath: string,
		signal?: AbortSignal,
		options: DelimitedPathSplitOptions = {},
		directory: { depth?: number; limit?: number } = {},
	): Promise<AgentToolResult<ReadToolDetails> | null> {
		const parts = await splitDelimitedPathEntry(readPath, this.session.cwd, options);
		if (!parts) return null;
		const listHasInternalUrl = parts.some(part => isInternalUrlPath(part));

		const notice = `Note: interpreted as ${parts.length} paths: ${parts.join(", ")}`;
		const notes = [notice];
		const content: Array<TextContent | ImageContent> = [];
		const displayReadTargets: string[] = [];
		let pendingText = notice;
		const flushText = () => {
			if (pendingText.length === 0) return;
			content.push({ type: "text", text: pendingText });
			pendingText = "";
		};
		const appendText = (text: string) => {
			pendingText = pendingText.length > 0 ? `${pendingText}\n\n${text}` : text;
		};

		for (const part of parts) {
			try {
				// Directory params apply per entry: every delimited part re-enters
				// execute with the same `depth`/`limit` the caller asked for.
				const result = await this.execute(
					"read-delimited-part",
					{ path: part, depth: directory.depth, limit: directory.limit },
					signal,
				);
				displayReadTargets.push(result.details?.suffixResolution?.to ?? part);
				for (const block of result.content) {
					if (block.type === "text") {
						appendText(block.text);
						continue;
					}
					flushText();
					content.push(block);
				}
			} catch (error) {
				if (error instanceof ToolAbortError || signal?.aborted) throw error;
				const message = errorMessage(error);
				// A list written as `skill://a/one.md;two.md` names one internal
				// resource and one cwd-relative path. Each entry is a complete
				// target, so state that on the entry that missed instead of
				// resolving it inside the resource the previous entry named.
				const hint =
					listHasInternalUrl && !isInternalUrlPath(part)
						? " (every entry in a semicolon-delimited list is a complete target: give this one its own scheme)"
						: "";
				const errorNote = `Could not read ${part}: ${message}${hint}`;
				notes.push(errorNote);
				displayReadTargets.push(part);
				appendText(`[${errorNote}]`);
			}
		}
		flushText();

		return toolResult<ReadToolDetails>({ notes, displayReadTargets }).content(content).done();
	}

	/**
	 * One internal URL, or a semicolon-delimited list of them.
	 *
	 * An internal resource cannot be probed on disk the way a file can, so the
	 * literal URL is resolved first and the list only after it fails: a resource
	 * whose own name contains a semicolon still resolves, and
	 * `skill://a/one.md;two.md` fans out into one read per entry.
	 */
	async #readInternalUrlOrList(
		rawPath: string,
		urlPath: string,
		parsedSel: ParsedSelector,
		signal?: AbortSignal,
		directory: { depth?: number; limit?: number } = {},
	): Promise<AgentToolResult<ReadToolDetails>> {
		try {
			return await handleInternalUrl(this.#ctx, urlPath, parsedSel, signal);
		} catch (error) {
			if (error instanceof ToolAbortError || signal?.aborted) throw error;
			const delimited = await this.#tryReadDelimitedPaths(
				rawPath,
				signal,
				{
					internalUrls: "split-on-semicolon",
				},
				directory,
			);
			if (delimited) return delimited;
			throw error;
		}
	}

	/**
	 * Route an internal URL: `agent://`, `artifact://`, `memory://`, `skill://`, `rule://`,
	 * `local://`, `mcp://`, `veyyon://`, `issue://` and `pr://`.
	 *
	 * A `local://` URL naming a real file is promoted to that filesystem path, keeping its selector
	 * separate so a sibling literal file cannot shadow the URL's selector semantics during
	 * filesystem routing. Every other scheme is served here.
	 */
	async #routeInternalUrl(readPath: string, params: ReadParams, signal?: AbortSignal): Promise<InternalUrlRouting> {
		if (!InternalUrlRouter.instance().canHandle(readPath)) return { kind: "not-internal" };
		// The internal-URL-aware splitter peels a malformed selector off the URL so parseSel reports
		// it, rather than the handler receiving a path it cannot make sense of.
		const internalTarget = splitInternalUrlSel(readPath);
		const parsed = parseSel(internalTarget.sel);
		if (internalTarget.sel !== undefined && parsed.kind === "none") {
			throw new ToolError(
				`Invalid selector ':${internalTarget.sel}' on '${internalTarget.path}'. Use :N, :N-M, :N+K, :N- (open-ended), a comma-separated list of ranges, :raw, or a range combined with raw (e.g. :raw:50-100).`,
			);
		}
		const urlMeta = parseInternalUrl(internalTarget.path);
		const serve = async (): Promise<InternalUrlRouting> => ({
			kind: "handled",
			result: await this.#readInternalUrlOrList(readPath, internalTarget.path, parsed, signal, {
				depth: params.depth,
				limit: params.limit,
			}),
		});
		if (urlMeta.protocol.replace(/:$/, "").toLowerCase() !== "local") return serve();
		const localFile = await resolveLocalUrlToFile(urlMeta, {
			cwd: this.session.cwd,
			settings: this.session.settings,
			signal,
			localProtocolOptions: this.session.localProtocolOptions,
			skills: this.session.skills,
		});
		if (!localFile) return serve();
		return { kind: "promoted", readPath: localFile.path, selector: internalTarget.sel };
	}

	/**
	 * Read a URL target, honouring a line selector when one is attached.
	 *
	 * A multi-range or offset/limit selector is served through the URL cache so the fetch happens
	 * once and every range reads the same body; a bare URL goes straight to the fetch path.
	 */
	async #readUrlTarget(target: ParsedReadUrlTarget, signal?: AbortSignal): Promise<AgentToolResult<ReadToolDetails>> {
		const { executeReadUrl, loadReadUrlCacheEntry } = await loadUrlReader(this.session);
		const raw = target.raw;
		const cacheKey = { path: target.path, raw };
		const cacheOptions = { ensureArtifact: true, preferCached: true } as const;
		const inMemoryOptions = (details: ReadUrlToolDetails) => ({
			details: { ...details },
			sourceUrl: details.finalUrl,
			entityLabel: "URL output",
			raw,
			immutable: true,
		});

		const ranges = target.ranges;
		if (ranges !== undefined && ranges.length > 1) {
			const cached = await loadReadUrlCacheEntry(this.session, cacheKey, signal, cacheOptions);
			return buildInMemoryMultiRangeResult(this.session, cached.output, ranges, inMemoryOptions(cached.details));
		}
		if (target.offset !== undefined || target.limit !== undefined) {
			const cached = await loadReadUrlCacheEntry(this.session, cacheKey, signal, cacheOptions);
			return buildInMemoryTextResult(
				this.session,
				cached.output,
				target.offset,
				target.limit,
				inMemoryOptions(cached.details),
			);
		}
		return executeReadUrl(this.session, cacheKey, signal);
	}

	async execute(
		_toolCallId: string,
		params: ReadParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ReadToolDetails>,
		_toolContext?: AgentToolContext,
	): Promise<AgentToolResult<ReadToolDetails>> {
		const readPath = params.path.startsWith("file://") ? expandPath(params.path) : params.path;
		const conflictUri = parseConflictUri(readPath);
		if (conflictUri) {
			if (conflictUri.id === "*") {
				throw new ToolError(
					"Reading `conflict://*` is not supported — wildcards are write-only. Use the `<path>:conflicts` read selector for the full list of conflicts in a file, or read `conflict://<N>` to inspect a single block.",
				);
			}
			return readConflictRegion(this.session, conflictUri.id, conflictUri.scope);
		}

		const parsedUrlTarget = parseReadUrlTarget(readPath);
		if (parsedUrlTarget) {
			return this.#readUrlTarget(parsedUrlTarget, signal);
		}

		const routed = await this.#routeInternalUrl(readPath, params, signal);
		if (routed.kind === "handled") return routed.result;
		if (routed.kind === "promoted") return this.#readFilesystemPath(routed.readPath, routed.selector, params, signal);
		return this.#readFilesystemPath(readPath, undefined, params, signal);
	}

	/**
	 * Read a filesystem path: an archive member, a SQLite table, a PDF image, a directory or a file.
	 *
	 * `promotedSelector` is the selector of a `local://` URL that named a real file. It stays apart
	 * from the path so it cannot be mistaken for part of the resolved path.
	 */
	async #readFilesystemPath(
		readPath: string,
		promotedSelector: string | undefined,
		params: ReadParams,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<ReadToolDetails>> {
		// One suffix-glob memo per read call — archive, sqlite, and plain-path
		// resolution share misses instead of re-globbing the workspace.
		const suffixCache: SuffixMatchCache = new Map();

		// Prefer a literal filesystem match over selector interpretation so real
		// POSIX filenames containing selector-looking suffixes win over structured
		// archive / sqlite / pdf-image dispatch.
		const target =
			promotedSelector === undefined
				? await splitPathAndSelPreferringLiteral(readPath, this.session.cwd)
				: { path: readPath, sel: promotedSelector };
		const rawPathIsLiteral =
			promotedSelector !== undefined
				? readPath.includes(":") && (await probeLiteralPathExists(readPath, this.session.cwd)) !== "missing"
				: target.sel === undefined && splitPathAndSel(readPath).sel !== undefined;
		if (!rawPathIsLiteral) {
			const member = await this.#readContainerMember(readPath, promotedSelector, suffixCache, signal);
			if (member) return member;
		}

		const parsed = parseSel(target.sel);
		const resolved = await statCandidateWithSuffix(this.session.cwd, target.path, suffixCache, signal, {
			throwNonMissing: true,
		});
		if (!resolved) {
			const delimitedResult = await this.#tryReadDelimitedPaths(
				readPath,
				signal,
				{},
				{
					depth: params.depth,
					limit: params.limit,
				},
			);
			if (delimitedResult) return delimitedResult;
			throw new ToolError(`Path '${target.path}' not found`);
		}
		if (resolved.stat.isDirectory()) {
			return this.#readResolvedDirectory(resolved, parsed, params);
		}
		if (parsed.kind === "conflicts") {
			return readFileConflicts(this.session, resolved.absolutePath, resolved.suffixResolution, signal);
		}
		const outcome = await this.#readFileContent(readPath, target.path, resolved, parsed, signal);
		return outcome.kind === "result" ? outcome.result : finishLocalRead(outcome.read, resolved.suffixResolution);
	}

	/** Read a member of an archive, a SQLite database or a PDF's extracted images, when the path names one. */
	async #readContainerMember(
		readPath: string,
		promotedSelector: string | undefined,
		suffixCache: SuffixMatchCache,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<ReadToolDetails> | undefined> {
		const archivePath = await resolveArchiveReadPath(this.session.cwd, readPath, suffixCache, signal);
		if (archivePath) {
			const archiveSubPath =
				promotedSelector === undefined
					? splitPathAndSel(archivePath.archiveSubPath)
					: { path: archivePath.archiveSubPath, sel: promotedSelector };
			const archiveParsed = parseSel(archiveSubPath.sel);
			return readArchive(
				this.session,
				readPath,
				archiveParsed,
				{ ...archivePath, archiveSubPath: archiveSubPath.path },
				signal,
			);
		}

		const sqlitePath = await resolveSqliteReadPath(this.session.cwd, readPath, suffixCache, signal);
		if (sqlitePath) {
			return readSqlite(this.session, sqlitePath, signal);
		}

		const pdfImageMemberPath = splitPdfImageMemberReadPath(readPath);
		if (!pdfImageMemberPath) return undefined;
		const resolved = await statCandidateWithSuffix(
			this.session.cwd,
			pdfImageMemberPath.pdfPath,
			suffixCache,
			signal,
			{
				throwNonMissing: true,
			},
		);
		if (!resolved) throw new ToolError(`Path '${pdfImageMemberPath.pdfPath}' not found`);
		if (resolved.stat.isDirectory()) {
			throw new ToolError(`Path '${pdfImageMemberPath.pdfPath}' is a directory, not a PDF file`);
		}
		return readPdfImageMember(
			this.#ctx,
			resolved.absolutePath,
			pdfImageMemberPath.pdfPath,
			pdfImageMemberPath.member,
			resolved.suffixResolution,
			signal,
		);
	}

	async #readResolvedDirectory(
		resolved: ResolvedReadPath,
		parsed: ParsedSelector,
		params: ReadParams,
	): Promise<AgentToolResult<ReadToolDetails>> {
		if (isMultiRange(parsed)) {
			throw new ToolError("Multi-range line selectors are not supported for directory listings.");
		}
		const { offset, limit } = selToOffsetLimit(parsed);
		// Directory listings are deterministic and fast; never abort them mid-scan
		// (an interrupt would otherwise surface a misleading "Operation aborted").
		const dirResult = await readDirectory(this.session, resolved.absolutePath, offset, limit, {
			depth: params.depth,
			entryLimit: params.limit,
		});
		if (resolved.suffixResolution) {
			dirResult.details ??= {};
			dirResult.details.suffixResolution = resolved.suffixResolution;
		}
		return dirResult;
	}

	/** Read a resolved file by its type: an image, a notebook, a convertible document or text. */
	async #readFileContent(
		readPath: string,
		localReadPath: string,
		resolved: ResolvedReadPath,
		parsed: ParsedSelector,
		signal: AbortSignal | undefined,
	): Promise<LocalReadOutcome> {
		const { absolutePath, stat } = resolved;
		const imageMetadata = await readImageMetadata(absolutePath);
		const mimeType = imageMetadata?.mimeType;
		if (mimeType) {
			const image = await loadImageContent(this.#ctx, {
				readPath,
				absolutePath,
				mimeType,
				imageMetadata,
				fileSize: stat.size,
			});
			return { kind: "content", read: { ...image, columnTruncated: 0 } };
		}
		if (isNotebookPath(absolutePath) && !isRawSelector(parsed)) {
			return { kind: "result", result: await readNotebook(this.session, absolutePath, localReadPath, parsed) };
		}
		const ext = path.extname(absolutePath).toLowerCase();
		if (CONVERTIBLE_EXTENSIONS.has(ext)) {
			const converted = await readConvertedDocument(this.session, absolutePath, localReadPath, ext, parsed, signal);
			if (converted.kind === "result") return converted;
			return {
				kind: "content",
				read: {
					content: converted.content,
					details: { contentUnavailable: { reason: "conversion-failed" } },
					columnTruncated: 0,
				},
			};
		}
		return readTextFile(this.#ctx, resolved, localReadPath, ext, parsed, signal);
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

export interface ReadRenderArgs {
	path?: unknown;
	file_path?: unknown;
	/** Directory listings only: recursion depth. */
	depth?: number;
	/** Directory listings only: the entry cap. Not a line count. */
	limit?: number;
	raw?: boolean;
}
