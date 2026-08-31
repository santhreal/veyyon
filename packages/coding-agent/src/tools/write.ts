import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolTier,
} from "@veyyon/agent-core";
import { BARE_LITERAL_VALUE_RE, formatHashlineHeader } from "@veyyon/hashline";
import type { Component } from "@veyyon/tui";
import {
	atomicWriteFileWith,
	errorMessage,
	formatCount,
	isEnoent,
	isRecord,
	prompt,
	untilAborted,
	urlScheme,
} from "@veyyon/utils";
import { type } from "arktype";

import { allLineNumbers, canonicalSnapshotKey, getFileSnapshotStore } from "../edit/file-snapshot-store";
import { normalizeToLF } from "../edit/normalize";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { InternalUrlRouter } from "../internal-urls";
import { parseInternalUrl } from "../internal-urls/parse";
import { createLspWritethrough, type FileDiagnosticsResult, type WritethroughCallback, writethroughNoop } from "../lsp";
import { DeferredDiagnostics } from "../lsp/deferred-diagnostics";
import { getDiagnosticsLedger } from "../lsp/diagnostics-ledger";
import { highlightCode } from "../modes/theme/highlight";
import type { Theme } from "../modes/theme/theme-class";
import { toolsPrompts } from "../prompts/tools/rows";
import type { ToolSession } from "../sdk";
import { budgetedFileCommit, sessionBudgetLimits } from "../session/cpu-limit";
// Owners, not the local `../tui` barrel: it re-exports `./file-list`, and that module took
// `getLanguageFromPath` from the theme ENGINE, so three names cost 282 modules of presentation layer.
import { fileHyperlink } from "../tui/hyperlink";
import { framedBlock } from "../tui/output-block";
import { renderStatusLine } from "../tui/status-line";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import { getLanguageFromPath } from "../utils/lang-from-path";
import {
	type ArchiveMemberContent,
	archiveFormatFromPath,
	parseArchivePathCandidates,
	readArchiveEntries,
	writeArchive,
} from "../utils/zip";
import { routeWriteThroughBridge } from "./acp-bridge";
import { truncateForPrompt } from "./approval";
import { assertEditableFile } from "./auto-generated-guard";
import {
	type ConflictEntry,
	conflictRegionPresent,
	conflictRegionsEqual,
	expandContentTokens,
	getConflictHistory,
	parseConflictUri,
	spliceConflict,
} from "./conflict-detect";
import { invalidateFsScanAfterWrite } from "./fs-cache-invalidation";
import { type OutputMeta, outputMeta } from "./output-meta";
import {
	formatPathRelativeToCwd,
	isInternalUrlPath,
	pathTargetsSsh,
	peelWriteUrlSelector,
	resolveStoredPathCase,
} from "./path-utils";
import { enforcePlanModeWrite, resolvePlanPath, unwrapHashlineHeaderPath } from "./plan-mode-guard";
import {
	cachedRenderedString,
	createRenderedStringCache,
	Ellipsis,
	formatDiagnostics,
	formatErrorDetail,
	formatExpandHint,
	formatMoreItems,
	formatStatusIcon,
	getLspBatchRequest,
	type RenderedStringCache,
	replaceTabs,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "./render-utils";
import {
	deleteRowByKey,
	deleteRowByRowId,
	insertRow,
	isSqliteFile,
	parseSqlitePathCandidates,
	resolveTableRowLookup,
	updateRowByKey,
	updateRowByRowId,
} from "./sqlite-reader";
import { ToolError, toolFailure } from "./tool-errors";
import { toolResult } from "./tool-result";

const HASHLINE_HEADER_RE = /^\s*\[[^#\r\n]+#[0-9a-fA-F]{4}\]\s*$/;
const LOOSE_HASHLINE_HEADER_RE = /^\s*\[[^#\r\n]+#[^ \t\r\n]*\]\s*$/;
const HASHLINE_OP_RE =
	/^\s*(?:SWAP(?:\.BLK)?(?:\s+[1-9]\d*(?:\s*(?:\.\.|\.=|-|…|\s)\s*[1-9]\d*)?)?\s*:|DEL(?:\.BLK)?\s+[1-9]\d*(?:\s*(?:\.\.|\.=|-|…|\s)\s*[1-9]\d*)?\s*$|INS\.(?:PRE\s+[1-9]\d*|POST\s+[1-9]\d*|HEAD|TAIL|BLK\.POST\s+[1-9]\d*)\s*:|REM\s*$|MV\s+\S+)/;
const UNIFIED_DIFF_HUNK_RE = /^@@\s+[-+]?\d+(?:,\d+)?\s+[-+]?\d+(?:,\d+)?\s+@@/;
const APPLY_PATCH_MARKER_RE = /^\*\*\*\s+(?:Update File|Add File|Delete File|Move to):/;
const READ_TRUNCATION_NOTICE_RE = /^\[(?:Showing lines \d+-\d+ of \d+|\d+ more lines? in (?:file|\S+))\b.*\bUse :L?\d+/;
// The grep match marker sits at column 0 (`*42:code`) and the context marker is
// exactly one leading space with no space after the colon (` 43:code`). Neither
// tolerates arbitrary indentation: `^\s*` before the one-space form matched any
// indented numeric mapping key, so a docker-compose `  80: http` or a k8s
// manifest port was rejected as pasted search output. The `(?! )` keeps a YAML
// key, which always separates its value with a space, out of the one-space form.
const SEARCH_PREFIX_RE = /^(?:\*\d+:|[ ]\d+:(?! )|\s*>>>\s*\d+:)/;
const LINE_PREFIX_RE = /^\s*(\d+):/;
const EXECUTABLE_NOTICE = "[Notice: Made executable via chmod +x]";

const BULK_DIRECTIVE_RE = /^#?(\d+)\s*[:=]\s*(@ours|@theirs|@base|@both)$/;
/**
 * The head of a per-id directive line — `<id>:` / `<id>=` (optionally `#`-prefixed),
 * regardless of whether its value is a valid `@side` token. Used only to sharpen the
 * error message when a directive block is malformed (e.g. `15: some literal text`).
 */
const BULK_DIRECTIVE_HEAD_RE = /^#?\d+\s*[:=]/;

function truncateDirectiveLine(line: string): string {
	return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

/**
 * Parse `conflict://*` per-id directive content: every non-empty line must be
 * `<id>: @side` (also accepted: `#<id> = @side`), where `@side` is one of
 * `@ours` / `@theirs` / `@base` / `@both`.
 *
 * Returns `null` only when NO line is directive-shaped (→ uniform bulk mode).
 * Throws on duplicate ids, and — critically — on a *partial* directive block:
 * content that mixes valid `<id>: @side` lines with lines that aren't. Without
 * that guard a per-id write carrying any non-token value (a literal or
 * multi-line replacement, e.g. `15: <multi-line content>`) fell through to
 * uniform bulk mode, which pasted the raw directive text verbatim into every
 * block and still reported success. Per-id bulk is token-only; literal or
 * multi-line replacements must go through individual `conflict://<N>` writes.
 */
function parseBulkDirectives(content: string): Map<number, string> | null {
	const map = new Map<number, string>();
	const stray: string[] = [];
	let sawDirective = false;
	for (const raw of content.split("\n")) {
		const line = raw.trim();
		if (line.length === 0) continue;
		const match = line.match(BULK_DIRECTIVE_RE);
		if (!match) {
			stray.push(line);
			continue;
		}
		sawDirective = true;
		const id = Number.parseInt(match[1], 10);
		if (map.has(id)) {
			throw new ToolError(`Bulk directive lists conflict #${id} twice — each id may appear once.`);
		}
		map.set(id, match[2]);
	}
	// No directive lines at all → not a per-id block; caller uses uniform mode.
	if (!sawDirective) return null;
	if (stray.length > 0) {
		const sample = stray[0]!;
		const tokenHint = BULK_DIRECTIVE_HEAD_RE.test(sample)
			? `Per-id bulk only accepts the tokens @ours/@theirs/@base/@both — one side per id, single line. `
			: "";
		throw new ToolError(
			`Malformed \`conflict://*\` per-id block: ${stray.length} line(s) are not \`<id>: @side\` directives (first: \`${truncateDirectiveLine(sample)}\`). ` +
				tokenHint +
				`Literal or multi-line replacement content isn't supported in a per-id block — resolve those blocks with individual \`write({ path: "conflict://<N>", content })\` calls (you can issue several at once). ` +
				`For a pure pick-a-side pass, make every non-empty line \`<id>: @ours\` (or @theirs/@base/@both).`,
		);
	}
	return map;
}

const writeSchema = type({
	path: type("string").describe("file path"),
	content: type("string").describe("file content"),
});

export type WriteToolInput = typeof writeSchema.infer;

/** Details returned by the write tool for TUI rendering */
export interface WriteToolDetails {
	diagnostics?: FileDiagnosticsResult;
	meta?: OutputMeta;
	/** Set when the file was auto-chmod'd because content begins with a `#!` shebang. */
	madeExecutable?: boolean;
	/** Absolute filesystem path the write resolved to. Used by the renderer to wrap
	 * the (possibly cwd-relative) header path in an OSC 8 `file://` hyperlink. */
	resolvedPath?: string;
}

/**
 * Validate that write content is a raw file body and not a patch fragment or
 * read-output display echo.
 *
 * Replaces legacy silent prefix stripping with refusal: writing a modified
 * version of pasted patch content creates invisible file corruption, and
 * auto-stripping mangled legitimate numbered/prefixed text.
 */
function assertValidWriteContent(content: string): void {
	if (!content) return;
	const lines = content.split("\n");

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const lineNum = i + 1;
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;

		if (HASHLINE_HEADER_RE.test(line) || LOOSE_HASHLINE_HEADER_RE.test(line)) {
			throw new ToolError(
				`Cannot write content: detected hashline section header '${trimmed}' on line ${lineNum}. The write tool writes whole files and does not apply patches or strip display headers. To write the file, pass the raw file content; to apply a patch, use the edit tool.`,
			);
		}

		if (HASHLINE_OP_RE.test(line)) {
			throw new ToolError(
				`Cannot write content: detected hashline patch operation '${trimmed}' on line ${lineNum}. The write tool writes whole files and does not apply patches. To write the file, pass the complete file content; to apply a patch, use the edit tool.`,
			);
		}

		if (UNIFIED_DIFF_HUNK_RE.test(trimmed)) {
			throw new ToolError(
				`Cannot write content: detected unified diff hunk header '${trimmed}' on line ${lineNum}. The write tool writes whole files and does not apply diffs. To write the file, pass the complete file content; to apply a patch, use the edit tool.`,
			);
		}

		if (APPLY_PATCH_MARKER_RE.test(trimmed)) {
			throw new ToolError(
				`Cannot write content: detected patch marker '${trimmed}' on line ${lineNum}. The write tool writes whole files and does not apply patches. To write the file, pass the complete file content; to apply a patch, use the edit tool.`,
			);
		}

		if (READ_TRUNCATION_NOTICE_RE.test(trimmed)) {
			throw new ToolError(
				`Cannot write content: detected read tool truncation notice '${trimmed}' on line ${lineNum}. The write tool writes whole files and does not strip read display prefixes. Pass the raw file content without read tool output decorations.`,
			);
		}

		if (SEARCH_PREFIX_RE.test(line)) {
			throw new ToolError(
				`Cannot write content: detected search/read display prefix '${trimmed.slice(0, 10)}' on line ${lineNum}. The write tool writes whole files and does not strip search/read display prefixes. Pass the raw file content without line prefixes.`,
			);
		}
	}

	const nonEmptyLines = lines.map((text, idx) => ({ text, lineNum: idx + 1 })).filter(l => l.text.trim().length > 0);

	if (nonEmptyLines.length >= 2) {
		const allPrefixed = nonEmptyLines.every(l => LINE_PREFIX_RE.test(l.text));
		if (allPrefixed) {
			const isDirectiveBlock = nonEmptyLines.some(
				l => BULK_DIRECTIVE_HEAD_RE.test(l.text.trim()) && /@\w+/.test(l.text),
			);
			const isLiteralMapping = nonEmptyLines.every(l =>
				BARE_LITERAL_VALUE_RE.test(l.text.replace(LINE_PREFIX_RE, "")),
			);
			if (!isDirectiveBlock && !isLiteralMapping) {
				const first = nonEmptyLines[0]!;
				const match = first.text.match(LINE_PREFIX_RE);
				const prefix = match ? match[0] : "";
				throw new ToolError(
					`Cannot write content: detected read tool line-number prefix '${prefix}' on line ${first.lineNum}. The write tool writes whole files and does not strip line-number prefixes. Pass the raw file content without line numbers.`,
				);
			}
		}
	}
}

/**
 * Record a snapshot of the freshly-written `content` for `absolutePath`
 * so subsequent hashline edits address the new file with a current tag,
 * and return the matching `[displayPath#TAG]` header. Returns `undefined`
 * when the session is not in hashline mode so callers can no-op cheaply.
 *
 * Mirrors the post-commit snapshot recording the hashline patcher performs
 * after a successful edit: the model gets a tag without an extra `read`.
 */
function maybeWriteSnapshotHeader(session: ToolSession, absolutePath: string, content: string): string | undefined {
	if (!resolveFileDisplayMode(session).hashLines) return undefined;
	const normalized = normalizeToLF(content);
	// Every line is recorded as seen: the model authored the bytes, so the
	// patcher's unseen-anchor gate should RUN and pass rather than be skipped
	// by an empty provenance set. See allLineNumbers for why that distinction
	// matters even though the two are indistinguishable today.
	const tag = getFileSnapshotStore(session).record(
		canonicalSnapshotKey(absolutePath),
		normalized,
		allLineNumbers(normalized),
	);
	return formatHashlineHeader(formatPathRelativeToCwd(absolutePath, session.cwd), tag);
}

/**
 * Append a trailing note line to the first text block of a tool result.
 * Mutates `result` in place (the result object is owned by this call).
 */
function appendNoteToResult(result: AgentToolResult<WriteToolDetails>, note: string): void {
	const firstText = result.content.find(
		(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
	);
	if (firstText) {
		firstText.text = firstText.text.length > 0 ? `${firstText.text}\n${note}` : note;
	} else {
		result.content.push({ type: "text", text: note });
	}
}

function emitWriteProgress(
	onUpdate: AgentToolUpdateCallback<WriteToolDetails> | undefined,
	content: string,
	displayPath: string,
	resolvedPath?: string,
): void {
	onUpdate?.({
		content: [{ type: "text", text: `Writing ${content.length} bytes to ${shortenPath(displayPath)}...` }],
		details: resolvedPath ? { resolvedPath } : {},
	});
}

/**
 * If `content` begins with a `#!` shebang, ensure the file is executable.
 *
 * Mirrors `chmod a+x` (adds user/group/other execute bits to existing mode).
 * Errors are swallowed: chmod failure (e.g. Windows ACL, read-only mount)
 * MUST NOT fail an otherwise successful write. Returns whether the mode
 * actually changed so the caller can surface a note.
 */
async function maybeMarkExecutableForShebang(absolutePath: string, content: string): Promise<boolean> {
	if (!content.startsWith("#!")) return false;
	try {
		const stat = await fs.stat(absolutePath);
		const currentMode = stat.mode & 0o7777;
		const newMode = currentMode | 0o111;
		if (newMode === currentMode) return false;
		await fs.chmod(absolutePath, newMode);
		return true;
	} catch {
		return false;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Class
// ═══════════════════════════════════════════════════════════════════════════

type WriteParams = WriteToolInput;

interface ResolvedArchiveWritePath {
	absolutePath: string;
	archivePath: string;
	archiveSubPath: string;
	exists: boolean;
}

interface ResolvedSqliteWritePath {
	absolutePath: string;
	sqlitePath: string;
	table: string;
	key?: string;
	exists: boolean;
}

function isArchivePathNotFound(error: unknown): boolean {
	if (isEnoent(error)) return true;
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOTDIR";
}

function normalizeArchiveWriteSubPath(rawPath: string): string {
	const normalized = rawPath.replace(/\\/g, "/");
	if (normalized.length === 0) {
		throw new ToolError("Archive write path must target a file inside the archive");
	}
	if (normalized.endsWith("/")) {
		throw new ToolError("Archive write path must target a file, not a directory");
	}

	const parts = normalized.split("/");
	const normalizedParts: string[] = [];
	for (const part of parts) {
		if (!part || part === ".") continue;
		if (part === "..") {
			throw new ToolError("Archive path cannot contain '..'");
		}
		normalizedParts.push(part);
	}

	if (normalizedParts.length === 0) {
		throw new ToolError("Archive write path must target a file inside the archive");
	}

	return normalizedParts.join("/");
}

function parseSqliteWriteTarget(subPath: string, queryString: string): { table: string; key?: string } {
	if (queryString.trim().length > 0) {
		throw new ToolError("SQLite write paths do not support query parameters");
	}

	const normalized = subPath.replace(/^:+/, "").trim();
	if (!normalized) {
		throw new ToolError("SQLite write path must target a table");
	}

	const separatorIndex = normalized.indexOf(":");
	const table = separatorIndex === -1 ? normalized : normalized.slice(0, separatorIndex);
	const key = separatorIndex === -1 ? undefined : normalized.slice(separatorIndex + 1);
	if (!table) {
		throw new ToolError("SQLite write path must target a table");
	}
	if (key !== undefined && key.length === 0) {
		throw new ToolError("SQLite row writes require a non-empty row key");
	}

	return { table, key };
}

/**
 * Filesystem path a write call targets, for the cwd boundary (cwd-boundary.ts).
 * The hashline `[path#TAG]` wrapper is unwrapped (parity with execute) so it
 * cannot dodge the gate; ssh/internal schemes are filtered by the boundary.
 */
export function writeFilesystemTargets(args: unknown): string[] {
	const raw = (args as Partial<WriteParams>).path;
	return typeof raw === "string" ? [unwrapHashlineHeaderPath(raw)] : [];
}

/**
 * Write tool implementation.
 *
 * Creates or overwrites files with optional LSP formatting and diagnostics.
 */
export class WriteTool implements AgentTool<typeof writeSchema, WriteToolDetails> {
	readonly name = "write";
	readonly approval = (args: unknown): ToolTier => {
		const rawPath = (args as Partial<WriteParams>).path;
		if (typeof rawPath !== "string") return "write";
		// Unwrap a hashline `[path#TAG]` wrapper first (parity with execute) so a
		// wrapped `[ssh://h/x#ABCD]` can't dodge scheme detection and the tier checks below.
		const path = unwrapHashlineHeaderPath(rawPath);
		// Remote SSH writes open an outbound connection and run a remote shell —
		// gate them like the exec-tier `ssh` tool, ahead of the handler-write
		// logic. Substring match also covers selector-suffixed targets.
		if (pathTargetsSsh(path)) return "exec";
		if (!isInternalUrlPath(path)) return "write";
		// Internal URLs are usually session-local artifacts (read tier), but a
		// scheme whose handler exposes a `write` hook mutates handler-owned user
		// data (e.g. vault:// notes) and must take the write tier so always-ask
		// mode actually prompts.
		const scheme = urlScheme(path.trim());
		const handler = scheme ? InternalUrlRouter.instance().getHandler(scheme) : undefined;
		return handler?.write ? "write" : "read";
	};
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<WriteParams>;
		const targetPath = typeof params.path === "string" ? params.path : "(missing)";
		const content = typeof params.content === "string" ? params.content : "";
		return [`Path: ${truncateForPrompt(targetPath)}`, `Content:\n${truncateForPrompt(content)}`];
	};
	// The cwd boundary reads this to gate out-of-cwd writes in non-yolo modes. The
	// hashline `[path#TAG]` wrapper is unwrapped (parity with execute) so it can't
	// dodge the gate; ssh/internal schemes are filtered by the boundary. See
	// cwd-boundary.ts.
	readonly filesystemTargets = (args: unknown): string[] => writeFilesystemTargets(args);
	readonly label = "Write";
	readonly description: string;
	readonly parameters = writeSchema;
	readonly strict = true;
	readonly concurrency = "exclusive";
	readonly loadMode = "essential";

	/** Stream matchers should see the real file content, not its JSON-escaped argument encoding. */
	matcherDigest(args: unknown): string | undefined {
		const content = (args as Partial<WriteParams>).content;
		return typeof content === "string" ? content : undefined;
	}

	readonly #writethrough: WritethroughCallback;
	/**
	 * The budgeted stand-in for a bare `writethroughNoop`, for the write paths
	 * that deliberately skip LSP formatting (conflict-marker resolution, SQLite
	 * and archive members). They still put bytes on the operator's disk, so
	 * they still spend the session tree's write budget.
	 */
	readonly #plainWritethrough: WritethroughCallback;
	readonly #deferredDiagnostics: DeferredDiagnostics | undefined;

	constructor(private readonly session: ToolSession) {
		const enableLsp = (session.enableLsp ?? true) && session.settings.get("lsp.enabled");
		const enableFormat = enableLsp && session.settings.get("lsp.formatOnWrite");
		const enableDiagnostics = enableLsp && session.settings.get("lsp.diagnosticsOnWrite");
		const dedup = enableDiagnostics && session.settings.get("lsp.diagnosticsDeduplicate");
		this.#deferredDiagnostics =
			enableDiagnostics && session.queueDeferredDiagnostics ? new DeferredDiagnostics(session, dedup) : undefined;
		// The harness is deliberately never a member of its own budget group, so
		// no io.stat and no /proc/<pid>/io reading can see a byte the write tool
		// puts on disk. Wrapping the commit callback is how those bytes reach the
		// session tree's write budget, and how a write past it is refused.
		const budgetSource = {
			sessionId: () => session.getSessionId?.() ?? null,
			limits: () => sessionBudgetLimits(session.settings),
		};
		this.#writethrough = budgetedFileCommit(
			budgetSource,
			enableLsp
				? createLspWritethrough(session.cwd, {
						enableFormat,
						enableDiagnostics,
						transformDiagnostics: dedup
							? (path, result) => getDiagnosticsLedger(session).reduce(path, result)
							: undefined,
					})
				: writethroughNoop,
		);
		this.#plainWritethrough = budgetedFileCommit(budgetSource, writethroughNoop);
		this.description = prompt.render(toolsPrompts["tools/write"].text);
	}

	async #resolveArchiveWritePath(writePath: string): Promise<ResolvedArchiveWritePath | null> {
		const candidates = parseArchivePathCandidates(writePath).filter(candidate => candidate.archivePath !== writePath);
		if (candidates.length === 0) {
			return null;
		}

		const fallbackCandidate = candidates[candidates.length - 1]!;
		const fallback: ResolvedArchiveWritePath = {
			absolutePath: resolvePlanPath(this.session, fallbackCandidate.archivePath),
			archivePath: fallbackCandidate.archivePath,
			archiveSubPath: normalizeArchiveWriteSubPath(fallbackCandidate.subPath),
			exists: false,
		};

		for (const candidate of candidates) {
			const absolutePath = resolvePlanPath(this.session, candidate.archivePath);
			try {
				const stat = await Bun.file(absolutePath).stat();
				if (stat.isDirectory()) {
					continue;
				}

				return {
					absolutePath,
					archivePath: candidate.archivePath,
					archiveSubPath: normalizeArchiveWriteSubPath(candidate.subPath),
					exists: true,
				};
			} catch (error) {
				if (!isArchivePathNotFound(error)) {
					throw error;
				}
			}
		}

		return fallback;
	}

	async #writeArchiveEntry(
		content: string,
		resolvedArchivePath: ResolvedArchiveWritePath,
	): Promise<AgentToolResult<WriteToolDetails>> {
		// Resolve symlinks before the tmp+rename swap: renaming over a symlink
		// replaces the link itself with a regular file instead of writing
		// through to its target.
		const finalPath = resolvedArchivePath.exists
			? await fs.realpath(resolvedArchivePath.absolutePath).catch(() => resolvedArchivePath.absolutePath)
			: resolvedArchivePath.absolutePath;
		// A realpath swap can land on a name without an archive extension; a
		// whole-archive rewrite then defaults to an uncompressed tar, matching the
		// previous `isZip`/`isGzip`/else fallthrough.
		const format = archiveFormatFromPath(finalPath) ?? "tar";

		const entries = new Map<string, ArchiveMemberContent>();
		if (resolvedArchivePath.exists) {
			try {
				const existing = await readArchiveEntries({ bytes: await Bun.file(finalPath).bytes(), format });
				for (const [entryPath, data] of existing) {
					entries.set(entryPath, data);
				}
			} catch (error) {
				throw toolFailure(error);
			}
		}
		entries.set(resolvedArchivePath.archiveSubPath, content);

		// Whole-archive rewrite: writeArchive streams into a temp file that
		// atomicWriteFileWith renames over the original only on success, so a
		// crash/disk-full mid-write can't destroy the existing archive.
		try {
			await atomicWriteFileWith(finalPath, tmpPath => writeArchive(tmpPath, format, entries));
		} catch (error) {
			throw toolFailure(error);
		}

		invalidateFsScanAfterWrite(resolvedArchivePath.absolutePath);
		const outputPath = `${formatPathRelativeToCwd(resolvedArchivePath.absolutePath, this.session.cwd)}:${
			resolvedArchivePath.archiveSubPath
		}`;
		return {
			content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${outputPath}` }],
			details: { resolvedPath: resolvedArchivePath.absolutePath },
		};
	}

	async #resolveSqliteWritePath(writePath: string): Promise<ResolvedSqliteWritePath | null> {
		const candidates = parseSqlitePathCandidates(writePath).filter(candidate => candidate.sqlitePath !== writePath);
		if (candidates.length === 0) {
			return null;
		}

		const fallbackCandidate = candidates[candidates.length - 1]!;
		const fallbackTarget = parseSqliteWriteTarget(fallbackCandidate.subPath, fallbackCandidate.queryString);
		const fallback: ResolvedSqliteWritePath = {
			absolutePath: resolvePlanPath(this.session, fallbackCandidate.sqlitePath),
			sqlitePath: fallbackCandidate.sqlitePath,
			table: fallbackTarget.table,
			key: fallbackTarget.key,
			exists: false,
		};

		let sawExistingNonSqlite = false;
		for (const candidate of candidates) {
			const target = parseSqliteWriteTarget(candidate.subPath, candidate.queryString);
			const absolutePath = resolvePlanPath(this.session, candidate.sqlitePath);
			try {
				const stat = await Bun.file(absolutePath).stat();
				if (stat.isDirectory()) {
					continue;
				}
				if (!(await isSqliteFile(absolutePath))) {
					sawExistingNonSqlite = true;
					continue;
				}

				return {
					absolutePath,
					sqlitePath: candidate.sqlitePath,
					table: target.table,
					key: target.key,
					exists: true,
				};
			} catch (error) {
				if (!isArchivePathNotFound(error)) {
					throw error;
				}
			}
		}

		if (sawExistingNonSqlite) {
			return null;
		}

		return fallback;
	}

	async #writeSqliteRow(
		displayPath: string,
		content: string,
		resolvedSqlitePath: ResolvedSqliteWritePath,
	): Promise<AgentToolResult<WriteToolDetails>> {
		let db: Database | null = null;
		try {
			if (!resolvedSqlitePath.exists) {
				throw new ToolError(`SQLite database '${displayPath}' not found`);
			}

			db = new Database(resolvedSqlitePath.absolutePath, { create: false, strict: true });
			db.run("PRAGMA busy_timeout = 3000");

			const trimmedContent = content.trim();
			let resultText: string;
			if (trimmedContent.length === 0) {
				if (!resolvedSqlitePath.key) {
					throw new ToolError("SQLite deletes require a row key in the path");
				}

				const lookup = resolveTableRowLookup(db, resolvedSqlitePath.table);
				const deleted =
					lookup.kind === "pk"
						? deleteRowByKey(db, resolvedSqlitePath.table, lookup, resolvedSqlitePath.key)
						: deleteRowByRowId(db, resolvedSqlitePath.table, resolvedSqlitePath.key);
				resultText =
					deleted > 0
						? `Deleted row '${resolvedSqlitePath.key}' from ${resolvedSqlitePath.table}`
						: `No row deleted from ${resolvedSqlitePath.table} for key '${resolvedSqlitePath.key}'`;
			} else {
				let parsedContent: unknown;
				try {
					parsedContent = Bun.JSON5.parse(content);
				} catch (error) {
					throw new ToolError(`SQLite write content must be valid JSON5: ${errorMessage(error)}`);
				}

				if (!isRecord(parsedContent)) {
					throw new ToolError("SQLite write content must be a JSON object");
				}

				if (resolvedSqlitePath.key) {
					const lookup = resolveTableRowLookup(db, resolvedSqlitePath.table);
					const updated =
						lookup.kind === "pk"
							? updateRowByKey(db, resolvedSqlitePath.table, lookup, resolvedSqlitePath.key, parsedContent)
							: updateRowByRowId(db, resolvedSqlitePath.table, resolvedSqlitePath.key, parsedContent);
					resultText =
						updated > 0
							? `Updated row '${resolvedSqlitePath.key}' in ${resolvedSqlitePath.table}`
							: `No row updated in ${resolvedSqlitePath.table} for key '${resolvedSqlitePath.key}'`;
				} else {
					insertRow(db, resolvedSqlitePath.table, parsedContent);
					resultText = `Inserted row into ${resolvedSqlitePath.table}`;
				}
			}

			invalidateFsScanAfterWrite(resolvedSqlitePath.absolutePath);
			return toolResult<WriteToolDetails>({ resolvedPath: resolvedSqlitePath.absolutePath })
				.text(resultText)
				.sourcePath(resolvedSqlitePath.absolutePath)
				.done();
		} catch (error) {
			if (isEnoent(error)) {
				throw new ToolError(`SQLite database '${displayPath}' not found`);
			}
			if (error instanceof ToolError) {
				throw error;
			}
			throw toolFailure(error);
		} finally {
			db?.close();
		}
	}

	/**
	 * Resolve a single `conflict://<N>` write by splicing the recorded
	 * marker region in the registered file with `replacementContent`.
	 * The write deliberately bypasses the LSP writethrough: the file may
	 * still hold other unresolved marker blocks, so formatting could
	 * corrupt them and diagnostics would be marker-noise anyway.
	 *
	 * Entry ids are session-stable: they keep working even after later
	 * writes resolve other blocks in the same file. The recorded range
	 * is re-validated on disk before splicing so an out-of-band edit
	 * surfaces as a clear error instead of corrupting the file.
	 */
	async #resolveConflict(
		entry: ConflictEntry,
		replacementContent: string,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<WriteToolDetails>> {
		const absolutePath = entry.absolutePath;
		if (!(await fs.exists(absolutePath))) {
			throw new ToolError(`Conflict #${entry.id} target '${entry.displayPath}' no longer exists.`);
		}

		const expanded = expandContentTokens(replacementContent, entry);
		const originalText = await Bun.file(absolutePath).text();
		const splice = spliceConflict(originalText, entry, expanded);
		const newContent = splice.text;

		await this.#plainWritethrough(absolutePath, newContent, signal);
		invalidateFsScanAfterWrite(absolutePath);
		this.session.bumpFileMutationVersion?.(absolutePath);
		this.session.fileSnapshotStore?.invalidate(absolutePath);
		const history = this.session.conflictHistory;
		history?.invalidate(entry.id);
		if (history) {
			// Drop stale duplicate registrations of the same region: a re-read
			// after an out-of-band shift registers a fresh id at the new
			// startLine while the stale twin persists at the old one. A DISTINCT
			// conflict block that is merely byte-identical still occurs in the
			// post-splice content and must stay addressable.
			for (const other of history.entries()) {
				if (
					other.absolutePath === absolutePath &&
					conflictRegionsEqual(other, entry) &&
					!conflictRegionPresent(newContent, other)
				) {
					history.invalidate(other.id);
				}
			}
		}

		const header = maybeWriteSnapshotHeader(this.session, absolutePath, newContent);
		const range =
			entry.startLine === entry.endLine
				? `line ${entry.startLine}`
				: `lines ${entry.startLine}\u2013${entry.endLine}`;
		const summary = `Resolved conflict #${entry.id} at ${range} in ${entry.displayPath}.`;
		let resultText = header ? `${header}\n${summary}` : summary;
		const echoTrimmed = splice.trimmedLeading + splice.trimmedTrailing;
		if (echoTrimmed > 0) {
			resultText += `\nNote: dropped ${echoTrimmed} content line(s) that duplicated the code adjacent to the conflict region — writes replace only the marker block; surrounding lines stay in place.`;
		}

		return {
			content: [{ type: "text", text: resultText }],
			details: { resolvedPath: absolutePath },
		};
	}

	/**
	 * Look up a single conflict entry by id and dispatch to {@link #resolveConflict}.
	 * Throws a clear `not found` error when the id has been invalidated.
	 */
	async #resolveSingleConflictById(
		id: number,
		replacementContent: string,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<WriteToolDetails>> {
		const entry = getConflictHistory(this.session).get(id);
		if (!entry) {
			throw new ToolError(
				`Conflict #${id} not found. Conflict ids are registered when \`read\` surfaces a marker block; re-read the file to get a current id.`,
			);
		}
		return this.#resolveConflict(entry, replacementContent, signal);
	}

	/**
	 * Bulk-resolve every registered conflict via `conflict://*`.
	 *
	 * Entries are grouped by file and applied bottom-up by recorded start
	 * line so each splice keeps later anchors valid. `content` tokens are
	 * expanded *per entry*, so `content: "@ours"` keeps each block's own
	 * ours side rather than collapsing every conflict to the first
	 * block's ours.
	 *
	 * All-or-nothing semantics within a file: if any splice for a file
	 * fails (stale anchors, missing base for `@base`, etc.), that file is
	 * left untouched and the error is surfaced. Files that succeed are
	 * still written. The result text reports per-file counts so the agent
	 * can re-read the failed files and retry.
	 */
	async #resolveAllConflicts(
		replacementContent: string,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<WriteToolDetails>> {
		const history = getConflictHistory(this.session);
		const allEntries = history.entries();
		if (allEntries.length === 0) {
			throw new ToolError(
				"`conflict://*` has nothing to resolve — no conflicts are currently registered. Re-read the file(s) with conflicts first.",
			);
		}

		// Per-id directive mode: content made solely of `<id>: @side` lines
		// resolves each listed conflict with that side in one call. Ideal for
		// merge-hell files where dozens of pick-one blocks each need their own
		// winner — one call instead of one write per conflict. Parsed from the
		// PRE-strip content: hashline prefix stripping would otherwise eat the
		// `<id>: ` heads as echoed line numbers.
		const directives = parseBulkDirectives(replacementContent);
		if (directives) {
			const known = new Set(allEntries.map(entry => entry.id));
			const unknown = [...directives.keys()].filter(id => !known.has(id));
			if (unknown.length > 0) {
				throw new ToolError(
					`Bulk directive references unknown conflict id(s) ${unknown.map(id => `#${id}`).join(", ")}. Currently registered: ${allEntries.map(e => `#${e.id}`).join(", ")}.`,
				);
			}
		}
		const selectedEntries = directives ? allEntries.filter(entry => directives.has(entry.id)) : allEntries;
		const contentFor = (entry: ConflictEntry): string =>
			directives ? (directives.get(entry.id) as string) : replacementContent;

		const byFile = new Map<string, ConflictEntry[]>();
		for (const entry of selectedEntries) {
			const bucket = byFile.get(entry.absolutePath) ?? [];
			bucket.push(entry);
			byFile.set(entry.absolutePath, bucket);
		}

		const succeededFiles: { displayPath: string; count: number; header?: string }[] = [];
		const failedFiles: { displayPath: string; count: number; error: string }[] = [];
		let totalResolvedIds = 0;
		let totalEchoTrimmed = 0;

		for (const [absolutePath, fileEntries] of byFile) {
			const sample = fileEntries[0]!;
			if (!(await fs.exists(absolutePath))) {
				failedFiles.push({
					displayPath: sample.displayPath,
					count: fileEntries.length,
					error: "file no longer exists",
				});
				continue;
			}

			fileEntries.sort((a, b) => b.startLine - a.startLine);

			let text: string;
			const resolvedEntries: ConflictEntry[] = [];
			const staleEntries: ConflictEntry[] = [];
			let failure: string | undefined;
			try {
				text = await Bun.file(absolutePath).text();
			} catch (error) {
				failedFiles.push({
					displayPath: sample.displayPath,
					count: fileEntries.length,
					error: errorMessage(error),
				});
				continue;
			}
			for (const entry of fileEntries) {
				try {
					const expanded = expandContentTokens(contentFor(entry), entry);
					const splice = spliceConflict(text, entry, expanded);
					text = splice.text;
					totalEchoTrimmed += splice.trimmedLeading + splice.trimmedTrailing;
					resolvedEntries.push(entry);
				} catch (error) {
					// A locate-miss for a region an earlier entry already spliced
					// in this pass is a stale duplicate registration (re-read after
					// an out-of-band shift) — treat it as already resolved.
					if (resolvedEntries.some(done => conflictRegionsEqual(done, entry))) {
						staleEntries.push(entry);
						continue;
					}
					failure = errorMessage(error);
					break;
				}
			}
			if (failure !== undefined) {
				failedFiles.push({
					displayPath: sample.displayPath,
					count: fileEntries.length,
					error: failure,
				});
				continue;
			}

			await this.#plainWritethrough(absolutePath, text, signal);
			invalidateFsScanAfterWrite(absolutePath);
			this.session.bumpFileMutationVersion?.(absolutePath);
			this.session.fileSnapshotStore?.invalidate(absolutePath);
			for (const entry of resolvedEntries) history.invalidate(entry.id);
			for (const entry of staleEntries) history.invalidate(entry.id);
			const header = maybeWriteSnapshotHeader(this.session, absolutePath, text);
			succeededFiles.push({ displayPath: sample.displayPath, count: resolvedEntries.length, header });
			totalResolvedIds += resolvedEntries.length;
		}

		const summaryLines: string[] = [];
		const fileWord = (n: number) => (n === 1 ? "file" : "files");
		const conflictWord = (n: number) => (n === 1 ? "conflict" : "conflicts");
		if (succeededFiles.length > 0) {
			summaryLines.push(
				`Resolved ${totalResolvedIds} ${conflictWord(totalResolvedIds)} across ${succeededFiles.length} ${fileWord(succeededFiles.length)}:`,
			);
			for (const file of succeededFiles) {
				summaryLines.push(`  ${file.displayPath}: ${file.count} ${conflictWord(file.count)}`);
			}
		}
		if (directives && selectedEntries.length < allEntries.length) {
			const remaining = allEntries.filter(entry => !directives.has(entry.id)).map(entry => `#${entry.id}`);
			summaryLines.push(
				`Directive mode: ${remaining.length} unlisted ${conflictWord(remaining.length)} still registered (${remaining.join(", ")}).`,
			);
		}
		if (totalEchoTrimmed > 0) {
			summaryLines.push(
				`Note: dropped ${totalEchoTrimmed} content line(s) that duplicated code adjacent to conflict regions — writes replace only the marker block; surrounding lines stay in place.`,
			);
		}
		if (failedFiles.length > 0) {
			summaryLines.push(
				`Failed to resolve ${failedFiles.length} ${fileWord(failedFiles.length)} — registered entries left intact for retry:`,
			);
			for (const file of failedFiles) {
				summaryLines.push(`  ${file.displayPath}: ${file.count} ${conflictWord(file.count)} (${file.error})`);
			}
		}
		const headerLines = succeededFiles
			.map(file => file.header)
			.filter((header): header is string => header !== undefined);
		if (headerLines.length > 0) {
			summaryLines.push("Snapshots:");
			for (const header of headerLines) summaryLines.push(`  ${header}`);
		}
		const resultText = summaryLines.join("\n");

		if (failedFiles.length > 0 && succeededFiles.length === 0) {
			throw new ToolError(resultText);
		}
		return {
			content: [{ type: "text", text: resultText }],
			details: {},
			isError: failedFiles.length > 0 ? true : undefined,
		};
	}

	async execute(
		_toolCallId: string,
		{ path: rawPath, content }: WriteParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<WriteToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<WriteToolDetails>> {
		// Strip a hashline `[path#TAG]` wrapper up front so every downstream
		// decision (scheme routing, internal-URL handler dispatch, plan-mode
		// guard, plan path resolution, ACP bridge routing) sees the same
		// filesystem target. Without this, a model that pastes a `read`
		// header as the `path` arg would slip past `isInternalUrlPath`
		// (which fails on a leading `[`) and the bridge router would send a
		// `[local://scratch.md#ABCD]` write to the editor instead of the
		// session-local sandbox.
		// Peel a read-tool selector (`:raw`, `:1-20`, …) so the write target matches
		// what `read` resolves for the same URL; line-range/malformed selectors throw.
		const path = peelWriteUrlSelector(unwrapHashlineHeaderPath(rawPath));
		return untilAborted(signal, async () => {
			assertValidWriteContent(content);
			const internalRouter = InternalUrlRouter.instance();
			if (internalRouter.canHandle(path)) {
				const parsed = parseInternalUrl(path);
				const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
				const handler = internalRouter.getHandler(scheme);
				if (handler?.write) {
					// Handler-owned writes (vault:// notes, host URIs) mutate user
					// data outside the local sandbox — plan mode must reject them.
					enforcePlanModeWrite(this.session, path, { op: "update" });
					emitWriteProgress(onUpdate, content, path);
					await handler.write(parsed, content, { cwd: this.session.cwd, signal });
					const resultText = `Successfully wrote ${content.length} bytes to ${path}`;
					return { content: [{ type: "text", text: resultText }], details: {} };
				}
				if (scheme !== "local") {
					// Name the tool that DOES mutate this scheme, so the caller has a
					// next step instead of a dead end. memory:// is edited with the
					// memory_edit tool; other read-only schemes have no mutation tool.
					const mutationTool: Record<string, string> = { memory: "memory_edit" };
					const tool = mutationTool[scheme];
					throw new ToolError(
						tool
							? `${scheme}:// URLs are read-only for the write tool; use the ${tool} tool to change ${scheme}:// entries.`
							: `${scheme}:// URLs are read-only; there is no write path for this scheme.`,
					);
				}
				// local:// is backed by the session-local artifact sandbox and is
				// resolved by resolvePlanPath below so write/read share the same root.
			}

			const conflictUri = parseConflictUri(path);
			if (conflictUri) {
				if (conflictUri.scope) {
					throw new ToolError(
						`Conflict URI scope '/${conflictUri.scope}' is read-only — read \`conflict://${conflictUri.id}/${conflictUri.scope}\` to inspect that side. To write, drop the scope (\`conflict://${conflictUri.id}\`) and put the chosen content (or shorthand like \`@${conflictUri.scope}\`) in \`content\`.`,
					);
				}
				emitWriteProgress(onUpdate, content, path);
				const result =
					conflictUri.id === "*"
						? await this.#resolveAllConflicts(content, signal)
						: await this.#resolveSingleConflictById(conflictUri.id, content, signal);
				if (conflictUri.recoveredPrefix !== undefined) {
					appendNoteToResult(
						result,
						`Note: stripped erroneous '${conflictUri.recoveredPrefix}:' prefix from path; conflict URIs are global (use \`conflict://${conflictUri.id}\`, not \`<file>:conflict://${conflictUri.id}\`).`,
					);
				}
				return result;
			}
			const resolvedArchivePath = await this.#resolveArchiveWritePath(path);
			if (resolvedArchivePath) {
				enforcePlanModeWrite(this.session, resolvedArchivePath.archivePath, {
					op: resolvedArchivePath.exists ? "update" : "create",
				});

				emitWriteProgress(
					onUpdate,
					content,
					`${formatPathRelativeToCwd(resolvedArchivePath.absolutePath, this.session.cwd)}:${
						resolvedArchivePath.archiveSubPath
					}`,
					resolvedArchivePath.absolutePath,
				);
				return this.#writeArchiveEntry(content, resolvedArchivePath);
			}

			const resolvedSqlitePath = await this.#resolveSqliteWritePath(path);
			if (resolvedSqlitePath) {
				enforcePlanModeWrite(this.session, resolvedSqlitePath.sqlitePath, { op: "update" });

				emitWriteProgress(onUpdate, content, path, resolvedSqlitePath.absolutePath);
				return this.#writeSqliteRow(path, content, resolvedSqlitePath);
			}

			enforcePlanModeWrite(this.session, path, { op: "create" });
			const absolutePath = resolvePlanPath(this.session, path);
			const batchRequest = getLspBatchRequest(context?.toolCall);

			// Check if file exists and is auto-generated before overwriting
			const overwritingExistingFile = await fs.exists(absolutePath);
			if (overwritingExistingFile) {
				await assertEditableFile(absolutePath, path);
			}

			// On a case-insensitive filesystem the existing directory entry keeps
			// its own spelling: writing to `Foo.ts` updates `foo.ts` and does NOT
			// rename it. Report the name the filesystem actually stores, or the
			// operator greps for a filename that does not exist. No-op for a new
			// file (nothing is stored yet) and on a case-sensitive filesystem.
			const reportedPath = overwritingExistingFile ? resolveStoredPathCase(absolutePath) : absolutePath;
			const displayPath = formatPathRelativeToCwd(reportedPath, this.session.cwd);
			emitWriteProgress(onUpdate, content, displayPath, absolutePath);

			// Try ACP bridge first for editor-visible filesystem paths. Internal
			// artifacts such as local:// plans are owned by veyyon, not the editor.
			if (await routeWriteThroughBridge(this.session, path, absolutePath, content, signal)) {
				const madeExecutable = await maybeMarkExecutableForShebang(absolutePath, content);
				const header = maybeWriteSnapshotHeader(this.session, absolutePath, content);
				const writeLine = `Successfully wrote ${content.length} bytes to ${displayPath}`;
				const resultText = header ? `${header}\n${writeLine}` : writeLine;
				const fullResultText = madeExecutable ? `${resultText}\n${EXECUTABLE_NOTICE}` : resultText;
				return {
					content: [{ type: "text", text: fullResultText }],
					details: { resolvedPath: absolutePath, madeExecutable: madeExecutable || undefined },
				};
			}

			const diagnostics = await this.#writethrough(absolutePath, content, signal, undefined, batchRequest, dst =>
				this.#deferredDiagnostics?.begin(dst),
			);
			invalidateFsScanAfterWrite(absolutePath);
			if (!this.#deferredDiagnostics || batchRequest?.flush === false) {
				this.session.bumpFileMutationVersion?.(absolutePath);
			}
			const madeExecutable = await maybeMarkExecutableForShebang(absolutePath, content);

			const header = maybeWriteSnapshotHeader(this.session, absolutePath, content);
			const writeLine = `Successfully wrote ${content.length} bytes to ${displayPath}`;
			let resultText = header ? `${header}\n${writeLine}` : writeLine;
			if (madeExecutable) {
				resultText += `\n${EXECUTABLE_NOTICE}`;
			}
			if (!diagnostics) {
				return {
					content: [{ type: "text", text: resultText }],
					details: { resolvedPath: absolutePath, madeExecutable: madeExecutable || undefined },
				};
			}

			return {
				content: [{ type: "text", text: resultText }],
				details: {
					resolvedPath: absolutePath,
					diagnostics,
					madeExecutable: madeExecutable || undefined,
					meta: outputMeta()
						.diagnostics(diagnostics.summary, diagnostics.messages ?? [])
						.get(),
				},
			};
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface WriteRenderArgs {
	path?: unknown;
	file_path?: unknown;
	content?: unknown;
}

const WRITE_PREVIEW_LINES = 6;
const WRITE_STREAMING_PREVIEW_LINES = 12;

function countLines(text: string): number {
	if (!text) return 0;
	return text.split("\n").length;
}

/** Bounded newline scan: whether `text` spans more than `maxLines` lines.
 *  Runs on every live compose (the repaint predicate below), so it must not
 *  materialize the split the way `countLines` does. */
function exceedsLineCount(text: string, maxLines: number): boolean {
	if (!text) return false;
	let lines = 1;
	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
		if (++lines > maxLines) return true;
	}
	return false;
}

function writeContentOf(args: unknown): string {
	if (args == null || typeof args !== "object" || !("content" in args)) return "";
	const content = args.content;
	return typeof content === "string" ? content : "";
}

function formatLineCountSuffix(lineCount: number, uiTheme: Theme): string {
	if (lineCount <= 0) return "";
	return uiTheme.fg("dim", ` · ${formatCount("line", lineCount)}`);
}

function normalizeDisplayText(text: unknown): string {
	let displayText = "";
	if (typeof text === "string") {
		displayText = text;
	} else if (text !== undefined && text !== null) {
		displayText = String(text);
	}
	return displayText.replace(/\r/g, "");
}

/**
 * Minimum line-number gutter width for write previews. The streaming preview's
 * gutter must stay byte-stable as the line count grows: a width derived purely
 * from `String(totalLines).length` widens at the 10/100/1000-line crossings,
 * rewriting every already-rendered row — which forces the transcript's commit
 * audit to recommit the block's committed prefix (a full duplicate in native
 * scrollback). Reserving 3 digits keeps the gutter constant through 999 lines
 * and keeps the streamed rows byte-identical to the final result render.
 */
const WRITE_GUTTER_MIN_WIDTH = 3;

function formatStreamingContent(
	content: string,
	expanded: boolean,
	language: string | undefined,
	uiTheme: Theme,
	spinnerFrame?: number,
	cache?: RenderedStringCache,
): string {
	if (!content) return "";
	const bodyText = cachedRenderedString(cache, uiTheme, expanded, language ?? "", content, () => {
		const lines = normalizeDisplayText(content).split("\n");
		const totalLines = lines.length;
		// Collapsed: follow the streaming edge with a bounded tail window so the box
		// stays short enough not to strand its scrolled-off head above the viewport
		// while the block is volatile. `Ctrl+O` (expanded) lifts the cap for a
		// deliberate full view — matching the eval streaming preview.
		const startIndex = expanded ? 0 : Math.max(0, totalLines - WRITE_STREAMING_PREVIEW_LINES);
		const visibleLines = lines.slice(startIndex);
		const hidden = startIndex;
		const highlighted = highlightCode(visibleLines.join("\n"), language);
		const lineNumberWidth = Math.max(WRITE_GUTTER_MIN_WIDTH, String(totalLines).length);

		let text = "\n\n";
		if (hidden > 0) {
			text += `${uiTheme.fg("dim", `… (${formatCount("earlier line", hidden)})`)}\n`;
		}
		for (let i = 0; i < highlighted.length; i++) {
			const lineNum = startIndex + i + 1;
			const gutter = uiTheme.fg("dim", `${String(lineNum).padStart(lineNumberWidth, " ")} `);
			const body = replaceTabs(highlighted[i] ?? "");
			text += `${gutter}${body}\n`;
		}
		return text;
	});
	// The animated glyph lives on this trailing line — inside the transcript's
	// volatile-tail holdback — never in the header: an animating head row pins
	// the native-scrollback commit boundary at the top of the block, so a long
	// expanded preview could never scroll-append mid-stream.
	const spinner = spinnerFrame !== undefined ? `${formatStatusIcon("running", uiTheme, spinnerFrame)} ` : "";
	return `${bodyText}${spinner}${uiTheme.fg("dim", `… (streaming)`)}`;
}

function renderContentPreview(
	content: string,
	expanded: boolean,
	language: string | undefined,
	uiTheme: Theme,
	cache?: RenderedStringCache,
): string {
	if (!content) return "";
	return cachedRenderedString(cache, uiTheme, expanded, language ?? "", content, () => {
		const rawLines = normalizeDisplayText(content).split("\n");
		const totalLines = rawLines.length;
		const maxLines = expanded ? totalLines : Math.min(totalLines, WRITE_PREVIEW_LINES);
		const visibleLines = rawLines.slice(0, maxLines);
		const highlighted = highlightCode(visibleLines.join("\n"), language);
		const lineNumberWidth = Math.max(WRITE_GUTTER_MIN_WIDTH, String(totalLines).length);
		const hidden = totalLines - maxLines;

		let text = "\n\n";
		for (let i = 0; i < highlighted.length; i++) {
			const lineNum = i + 1;
			const gutter = uiTheme.fg("dim", `${String(lineNum).padStart(lineNumberWidth, " ")} `);
			const body = replaceTabs(highlighted[i] ?? "");
			text += `${gutter}${body}\n`;
		}
		if (!expanded && hidden > 0) {
			const hint = formatExpandHint(uiTheme, expanded, hidden > 0);
			const moreLine = `${formatMoreItems(hidden, "line")}${hint ? ` ${hint}` : ""}`;
			text += uiTheme.fg("dim", moreLine);
		}
		return text.trimEnd();
	});
}

export const writeToolRenderer = {
	renderCall(args: WriteRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		const rawPath =
			typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
		const filePath = shortenPath(rawPath);
		const lang = rawPath ? (getLanguageFromPath(rawPath) ?? "text") : "text";
		const langBadge = uiTheme.langBadge(lang);
		const pathDisplay = filePath ? uiTheme.fg("accent", filePath) : uiTheme.fg("toolOutput", "…");
		// No status icon on the head row: it's the head of the framed block, and
		// native-scrollback commits are prefix-only — an animated glyph would pin
		// the commit boundary at the top, and the pending hourglass just adds
		// noise. The liveness cue rides the trailing "(streaming)" line instead.
		const header = renderStatusLine(
			{
				title: "Write",
				description: `${langBadge}${pathDisplay}`,
			},
			uiTheme,
		);
		const content = normalizeDisplayText(args.content);
		const streamingCache = createRenderedStringCache();
		return framedBlock(uiTheme, width => {
			const body = content
				? formatStreamingContent(
						content,
						Boolean(options?.expanded),
						lang,
						uiTheme,
						options?.spinnerFrame,
						streamingCache,
					)
				: "";
			const bodyLines = body ? body.split("\n") : [];
			while (bodyLines.length > 0 && bodyLines[0].trim() === "") bodyLines.shift();
			return {
				header,
				sections: bodyLines.length > 0 ? [{ lines: bodyLines }] : [],
				state: "pending",
				borderColor: "borderMuted",
				width,
			};
		});
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: WriteToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: WriteRenderArgs,
	): Component {
		const rawPath =
			typeof args?.file_path === "string" ? args.file_path : typeof args?.path === "string" ? args.path : "";
		const filePath = shortenPath(rawPath);
		const fileContent = normalizeDisplayText(args?.content);
		const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
		const langBadge = uiTheme.langBadge(lang);
		// The header shows the cwd-relative path but links to the absolute path the
		// write resolved to (args.path may be relative, which would yield a broken
		// `file://` URI). Falls back to plain text when the result lacks a path.
		const linkTarget = result.details?.resolvedPath;
		const styledPath = filePath ? uiTheme.fg("accent", filePath) : uiTheme.fg("toolOutput", "…");
		const pathDisplay = filePath && linkTarget ? fileHyperlink(linkTarget, styledPath) : styledPath;

		if (result.isError) {
			const errorText = result.content?.find(c => c.type === "text")?.text ?? "";
			const header = renderStatusLine(
				{ icon: "error", title: "Write", description: `${langBadge}${pathDisplay}` },
				uiTheme,
			);
			return framedBlock(uiTheme, width => ({
				header,
				sections: [{ lines: formatErrorDetail(errorText, uiTheme).split("\n") }],
				state: "error",
				borderColor: "error",
				width,
			}));
		}

		const isPartial = options.isPartial === true;
		const progressText = result.content?.find(c => c.type === "text")?.text ?? "";
		const lineCount = countLines(fileContent);
		const lineSuffix = formatLineCountSuffix(lineCount, uiTheme);
		const execSuffix =
			!isPartial && result.details?.madeExecutable
				? `${uiTheme.fg("dim", " · ")}${uiTheme.fg("success", "made executable!")}`
				: "";
		const header = renderStatusLine(
			{
				icon: isPartial ? "running" : undefined,
				iconOverride: isPartial ? undefined : uiTheme.styledSymbol("tool.write", "accent"),
				spinnerFrame: options.spinnerFrame,
				title: "Write",
				description: `${langBadge}${pathDisplay}${lineSuffix}${execSuffix}`,
			},
			uiTheme,
		);
		const diagnostics = result.details?.diagnostics;

		const previewCache = createRenderedStringCache();
		return framedBlock(uiTheme, width => {
			const { expanded } = options;
			let body = renderContentPreview(fileContent, expanded, lang, uiTheme, previewCache);
			if (isPartial && progressText) {
				const safeProgressText = truncateToWidth(
					replaceTabs(progressText),
					TRUNCATE_LENGTHS.LINE,
					Ellipsis.Unicode,
				);
				body = `${uiTheme.fg("muted", safeProgressText)}${body ? `\n${body}` : ""}`;
			}
			if (!isPartial && diagnostics) {
				const diagText = formatDiagnostics(diagnostics, expanded, uiTheme, fp =>
					uiTheme.getLangIcon(getLanguageFromPath(fp)),
				);
				if (diagText.trim()) {
					const diagLines = diagText.split("\n");
					const firstNonEmpty = diagLines.findIndex(line => line.trim());
					if (firstNonEmpty >= 0) body += `\n${diagLines.slice(firstNonEmpty).join("\n")}`;
				}
			}
			const bodyLines = body.split("\n");
			while (bodyLines.length > 0 && bodyLines[0].trim() === "") bodyLines.shift();
			return {
				header,
				sections: bodyLines.length > 0 ? [{ lines: bodyLines }] : [],
				state: isPartial ? "pending" : "success",
				borderColor: "borderMuted",
				width,
			};
		});
	},
	mergeCallAndResult: true,
	// The collapsed pending preview follows the streaming edge with a tail
	// window once the content outgrows it (`… (N earlier lines)` + last rows);
	// the first partial result re-anchors the frame to the top of the file, so
	// tail rows already committed to viewport/native scrollback would survive
	// as stale content above the new frame without a full replay. Expanded and
	// short previews stay top-anchored and skip the (scrollback-wiping) reset.
	forceFirstResultViewportRepaint: (args: unknown, options: RenderResultOptions) =>
		!options.expanded && exceedsLineCount(writeContentOf(args), WRITE_STREAMING_PREVIEW_LINES),
};
