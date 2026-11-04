/**
 * How a session file stores a search result without a second copy of its rows.
 *
 * A text or structure search returns its matches twice: the result's text holds them as the model
 * reads them (`*12:const x = 1;` under a `[a.ts#1F2E]` or `# dir/` header) and `displayContent`
 * holds the same rows as the card draws them (`*12│const x = 1;`). A paths-only search sets
 * `displayContent` to the result's text itself. `files` lists the paths `fileMatches` already
 * names, and the wrapper's `meta` is the sub-search's `meta` a second time.
 *
 * {@link searchResultCodec} drops each of these from the written line when a rebuild named by a
 * `…From` tag reproduces it exactly, and restores it when the session loads, so the entry in memory
 * is the one the tool returned.
 */
import { isDeepStrictEqual } from "node:util";
import { HL_FILE_PREFIX, HL_FILE_SUFFIX } from "@veyyon/hashline/format";
import type { ToolResultCodec } from "@veyyon/kernel/registry/tool-result-codec";
import { isRecord } from "@veyyon/utils/type-guards";
import type { BuiltinToolName } from "../core/builtin-names";
import { type CodedResultContent, firstResultText, MIN_CODED_TEXT } from "../core/output-notice";
import { formatCodeFrameLine } from "../core/render-utils";

/**
 * How a dropped `displayContent` is rebuilt from the result's text. `text` is the text itself.
 * `rows` redraws each numbered row with the card's gutter, padded to the widest line number of its
 * file, keeps `#` headers, blank lines and `  meta:` lines, drops `[path#TAG]` snapshot headers, and
 * stops at the first other line, which begins the notices after the rows. `rowsPrefix` is the first
 * `displayContentLength` characters of `rows`, which is the card body a text search keeps when its
 * card draws fewer rows than the result holds (`cardDisplayRows`).
 *
 * Persisted tags. Changing what a rebuild produces is a new tag with the old rebuild kept, or every
 * session written before the change draws a different card.
 */
export type SearchDisplayFrom = "text" | "rows" | "rowsPrefix";

/** The tag a written line carries in place of `files`: the paths of `fileMatches`, in order. */
const FILES_FROM_MATCHES = "fileMatches";

/** The tag a written line carries in place of the wrapper's `meta`: the sub-search's `meta`. */
const META_FROM_RESULT = "result";

/** The fields of a text or structure search's details that hold, or stand in for, the card text. */
export interface SearchDisplaySource {
	displayContent?: string;
	displayContentFrom?: SearchDisplayFrom;
	/** The characters of the `rowsPrefix` rebuild that are the card text. */
	displayContentLength?: number;
}

/** A model-facing row: its match marker, its line number and, after the separator, the line. */
const ROW = /^([* ])([1-9]\d*)[:|]/;
/** The row between two matches that are not adjacent. */
const ELISION = "...";
/** An ast-grep binding line, drawn as the model reads it. */
const META_LINE_PREFIX = "  meta: ";

function isSnapshotHeader(line: string): boolean {
	return line.startsWith(HL_FILE_PREFIX) && line.endsWith(HL_FILE_SUFFIX);
}

/** The `rows` rebuild: the card text of numbered search output. */
function redrawRows(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let index = 0;
	while (index < lines.length) {
		const line = lines[index]!;
		if (line === "" || line.startsWith("#")) {
			out.push(line);
			index++;
			continue;
		}
		if (isSnapshotHeader(line)) {
			index++;
			continue;
		}
		if (!ROW.test(line)) break;
		// One file's rows run until a line that is neither a row, an elision nor a binding. Its gutter
		// is as wide as its widest line number, which is how the tool pads it.
		let end = index;
		let width = 0;
		for (; end < lines.length; end++) {
			const next = lines[end]!;
			const row = ROW.exec(next);
			if (row !== null) width = Math.max(width, row[2]!.length);
			else if (next !== ELISION && !next.startsWith(META_LINE_PREFIX)) break;
		}
		for (; index < end; index++) {
			const next = lines[index]!;
			const row = ROW.exec(next);
			if (row !== null)
				out.push(formatCodeFrameLine(row[1] === "*" ? "*" : " ", row[2]!, next.slice(row[0].length), width));
			else if (next === ELISION) out.push(`${" ".repeat(width + 1)}│${ELISION}`);
			else out.push(next);
		}
	}
	while (out.length > 0 && out[out.length - 1] === "") out.pop();
	return out.join("\n");
}

function rebuildDisplay(from: unknown, length: unknown, content: CodedResultContent): string | undefined {
	const text = firstResultText(content);
	if (text === undefined) return undefined;
	if (from === "text") return text;
	if (from === "rows") return redrawRows(text);
	if (from === "rowsPrefix" && typeof length === "number") return redrawRows(text).slice(0, length);
	return undefined;
}

/** The fields that rebuild `display` from `content` in its place, or undefined when none reproduces it. */
function displaySource(display: string, content: CodedResultContent): SearchDisplaySource | undefined {
	if (display.length < MIN_CODED_TEXT) return undefined;
	const text = firstResultText(content);
	if (text === undefined) return undefined;
	if (text === display) return { displayContentFrom: "text" };
	const rows = redrawRows(text);
	if (rows === display) return { displayContentFrom: "rows" };
	return rows.startsWith(display)
		? { displayContentFrom: "rowsPrefix", displayContentLength: display.length }
		: undefined;
}

/** True when `files` is `fileMatches`' paths in order and long enough to be worth a tag. */
function filesAreMatchPaths(files: unknown, fileMatches: unknown): boolean {
	if (!Array.isArray(files) || !Array.isArray(fileMatches) || files.length !== fileMatches.length) return false;
	let length = 0;
	for (let index = 0; index < files.length; index++) {
		const file: unknown = files[index];
		const match: unknown = fileMatches[index];
		if (typeof file !== "string" || !isRecord(match) || match.path !== file) return false;
		length += file.length;
	}
	return length >= MIN_CODED_TEXT;
}

/** A sub-search's details without what its content and `fileMatches` rebuild, else `result` itself. */
function slimResult(result: Record<string, unknown>, content: CodedResultContent): Record<string, unknown> {
	let slimmed = result;
	const display = result.displayContent;
	const source = typeof display === "string" ? displaySource(display, content) : undefined;
	if (source !== undefined) {
		const { displayContent: _dropped, ...kept } = slimmed;
		slimmed = { ...kept, ...source };
	}
	if (filesAreMatchPaths(result.files, result.fileMatches)) {
		const { files: _dropped, ...kept } = slimmed;
		slimmed = { ...kept, filesFrom: FILES_FROM_MATCHES };
	}
	return slimmed;
}

function restoreResult(result: Record<string, unknown>, content: CodedResultContent): void {
	if (result.displayContent === undefined && result.displayContentFrom !== undefined) {
		const display = rebuildDisplay(result.displayContentFrom, result.displayContentLength, content);
		if (display !== undefined) {
			result.displayContent = display;
			delete result.displayContentFrom;
			delete result.displayContentLength;
		}
	}
	if (result.filesFrom === FILES_FROM_MATCHES && result.files === undefined && Array.isArray(result.fileMatches)) {
		const files: string[] = [];
		for (const match of result.fileMatches) {
			if (!isRecord(match) || typeof match.path !== "string") return;
			files.push(match.path);
		}
		result.files = files;
		delete result.filesFrom;
	}
}

/** How a `search` result is written to a session file and read back. */
export const searchResultCodec: ToolResultCodec = {
	toolName: "search" satisfies BuiltinToolName,
	slim(details, content) {
		if (!isRecord(details) || !isRecord(details.result)) return details;
		const result = slimResult(details.result, content);
		const metaIsResults =
			isRecord(details.meta) &&
			Object.keys(details.meta).length > 0 &&
			isDeepStrictEqual(details.meta, details.result.meta);
		if (!metaIsResults) return result === details.result ? details : { ...details, result };
		const { meta: _dropped, ...kept } = details;
		return { ...kept, result, metaFrom: META_FROM_RESULT };
	},
	restore(details, content) {
		if (!isRecord(details) || !isRecord(details.result)) return;
		restoreResult(details.result, content);
		if (details.metaFrom === META_FROM_RESULT && details.meta === undefined) {
			details.meta = details.result.meta;
			delete details.metaFrom;
		}
	},
};

/**
 * The card text of a text or structure search. A session loaded with the codec registered holds it
 * whole; a transcript read without that restore holds the written form, which is rebuilt here from
 * the result's text. Undefined when the details hold neither.
 */
export function resolveSearchDisplay(
	details: SearchDisplaySource | undefined,
	content: CodedResultContent,
): string | undefined {
	if (details === undefined) return undefined;
	if (details.displayContent !== undefined) return details.displayContent;
	return details.displayContentFrom === undefined
		? undefined
		: rebuildDisplay(details.displayContentFrom, details.displayContentLength, content);
}
