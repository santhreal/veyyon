import * as fs from "node:fs/promises";
import type { AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import { BARE_LITERAL_VALUE_RE, formatHashlineHeader } from "@veyyon/hashline";
import { isEnoent } from "@veyyon/utils";
import { type } from "arktype";
import { allLineNumbers, canonicalSnapshotKey, getFileSnapshotStore } from "../edit/file-snapshot-store";
import { normalizeToLF } from "../edit/normalize";
import type { FileDiagnosticsResult } from "../lsp";
import type { ToolSession } from "../sdk";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import type { OutputMeta } from "./output-meta";
import { formatPathRelativeToCwd } from "./path-utils";
import { unwrapHashlineHeaderPath } from "./plan-mode-guard";
import { shortenPath } from "./render-utils";
import { ToolError } from "./tool-errors";

export const HASHLINE_HEADER_RE = /^\s*\[[^#\r\n]+#[0-9a-fA-F]{4}\]\s*$/;
export const LOOSE_HASHLINE_HEADER_RE = /^\s*\[[^#\r\n]+#[^ \t\r\n]*\]\s*$/;
export const HASHLINE_OP_RE =
	/^\s*(?:SWAP(?:\.BLK)?(?:\s+[1-9]\d*(?:\s*(?:\.\.|\.=|-|…|\s)\s*[1-9]\d*)?)?\s*:|DEL(?:\.BLK)?\s+[1-9]\d*(?:\s*(?:\.\.|\.=|-|…|\s)\s*[1-9]\d*)?\s*$|INS\.(?:PRE\s+[1-9]\d*|POST\s+[1-9]\d*|HEAD|TAIL|BLK\.POST\s+[1-9]\d*)\s*:|REM\s*$|MV\s+\S+)/;
export const UNIFIED_DIFF_HUNK_RE = /^@@\s+[-+]?\d+(?:,\d+)?\s+[-+]?\d+(?:,\d+)?\s+@@/;
export const APPLY_PATCH_MARKER_RE = /^\*\*\*\s+(?:Update File|Add File|Delete File|Move to):/;
export const READ_TRUNCATION_NOTICE_RE =
	/^\[(?:Showing lines \d+-\d+ of \d+|\d+ more lines? in (?:file|\S+))\b.*\bUse :L?\d+/;
export const SEARCH_PREFIX_RE = /^(?:\*\d+:|[ ]\d+:(?! )|\s*>>>\s*\d+:)/;
export const LINE_PREFIX_RE = /^\s*(\d+):/;
export const EXECUTABLE_NOTICE = "[Notice: Made executable via chmod +x]";

export const BULK_DIRECTIVE_RE = /^#?(\d+)\s*[:=]\s*(@ours|@theirs|@base|@both)$/;
export const BULK_DIRECTIVE_HEAD_RE = /^#?\d+\s*[:=]/;

export function truncateDirectiveLine(line: string): string {
	return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

export function parseBulkDirectives(content: string): Map<number, string> | null {
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

export const writeSchema = type({
	path: type("string").describe("file path"),
	content: type("string").describe("file content"),
});

export type WriteToolInput = typeof writeSchema.infer;

export interface WriteToolDetails {
	diagnostics?: FileDiagnosticsResult;
	meta?: OutputMeta;
	madeExecutable?: boolean;
	resolvedPath?: string;
}

export function assertValidWriteContent(content: string): void {
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

export function maybeWriteSnapshotHeader(
	session: ToolSession,
	absolutePath: string,
	content: string,
): string | undefined {
	if (!resolveFileDisplayMode(session).hashLines) return undefined;
	const normalized = normalizeToLF(content);
	const tag = getFileSnapshotStore(session).record(
		canonicalSnapshotKey(absolutePath),
		normalized,
		allLineNumbers(normalized),
	);
	return formatHashlineHeader(formatPathRelativeToCwd(absolutePath, session.cwd), tag);
}

export function appendNoteToResult(result: AgentToolResult<WriteToolDetails>, note: string): void {
	const firstText = result.content.find(
		(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
	);
	if (firstText) {
		firstText.text = firstText.text.length > 0 ? `${firstText.text}\n${note}` : note;
	} else {
		result.content.push({ type: "text", text: note });
	}
}

export function emitWriteProgress(
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

export async function maybeMarkExecutableForShebang(absolutePath: string, content: string): Promise<boolean> {
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

export type WriteParams = WriteToolInput;

export interface ResolvedArchiveWritePath {
	absolutePath: string;
	archivePath: string;
	archiveSubPath: string;
	exists: boolean;
}

export interface ResolvedSqliteWritePath {
	absolutePath: string;
	sqlitePath: string;
	table: string;
	key?: string;
	exists: boolean;
}

export function isArchivePathNotFound(error: unknown): boolean {
	if (isEnoent(error)) return true;
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOTDIR";
}

export function normalizeArchiveWriteSubPath(rawPath: string): string {
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

export function parseSqliteWriteTarget(subPath: string, queryString: string): { table: string; key?: string } {
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

export function writeFilesystemTargets(args: unknown): string[] {
	const raw = (args as Partial<WriteParams>).path;
	return typeof raw === "string" ? [unwrapHashlineHeaderPath(raw)] : [];
}
