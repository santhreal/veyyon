/**
 * What the edit card shows, for any host.
 *
 * The tool half applies the change and reports it as a diff; this half states what the card says
 * about it and names no colour, no glyph and no width. The change is a diff section: the rows, which
 * side of the edit each is on and the file they belong to, so a terminal marks and colours them
 * while a host with an editor may draw two panes. A delete or a bare rename carries no rows at all
 * and is one status row, which is what it was before.
 *
 * Every mode reaches the same card: a replace, a JSON patch, a hashline payload and an apply-patch
 * envelope differ in how the change is described to the tool and not in what the reader is told
 * happened.
 */

import { HL_FILE_PREFIX, HL_FILE_SUFFIX, HL_MOVE_KEYWORD, HL_REM_KEYWORD } from "@veyyon/hashline";
import { errorMessage, sanitizeText } from "@veyyon/utils";
import { replaceTabs } from "@veyyon/utils/wrap";
import type {
	FramedBlockView,
	StatusRowView,
	ToolView,
	ToolViewContext,
	ToolViewRenderer,
	ViewDiffSide,
	ViewLine,
	ViewSection,
} from "@veyyon/view";
import { diagnosticsSection } from "../tools/core/diagnostics";
import {
	getDiffStats,
	LINE_NOUN,
	PREVIEW_LIMITS,
	shortenEmbeddedPaths,
	shortenPath,
	truncateDiffByHunk,
} from "../tools/core/render-utils";
import type { EditMode } from "../utils/edit-mode";
import { getLanguageFromPath } from "../utils/lang-from-path";
import type { EditToolDetails, EditToolPerFileResult } from "./details";
import type { DiffError, DiffResult } from "./diff";
import { type ApplyPatchEntry, expandApplyPatchToEntries, expandApplyPatchToPreviewEntries } from "./modes/apply-patch";
import type { Operation } from "./modes/patch";
import type { PerFileDiffPreview } from "./streaming";

/** Rows of a change the collapsed call card shows before the host cuts the front off. */
const EDIT_STREAMING_PREVIEW_LINES = 12;

/**
 * Rows an expanded streaming preview leaves free out of the host's window.
 *
 * The settled card is drawn where the preview was, and a preview that spent the whole window pushes
 * its own mutating rows past the scrollback boundary before the change has finished arriving.
 */
const EDIT_STREAMING_HEADROOM = 4;

/** Lines of replacement text a call card shows before it says how many it kept back. */
const CALL_TEXT_PREVIEW_LINES = 6;

/** What the card is titled for each operation. */
function operationTitle(op: Operation | undefined): string {
	return op === "create" ? "Create" : op === "delete" ? "Delete" : "Edit";
}

/**
 * One entry of an `edits` array, as much of it as a card reads.
 *
 * The index signature is what each mode's own entry fields arrive as: a replace entry carries
 * `old_text` and `new_text`, a patch entry a `diff`, and no card reads either.
 */
type EditEntry = {
	path?: unknown;
	rename?: unknown;
	move?: unknown;
	op?: Operation;
	[field: string]: unknown;
};

/** The arguments the card reads off the call, across every edit mode. */
export interface EditViewArgs {
	path?: unknown;
	file_path?: unknown;
	oldText?: string;
	newText?: string;
	patch?: string;
	input?: string;
	_input?: string;
	all?: boolean;
	op?: Operation;
	rename?: unknown;
	diff?: string;
	/** The change computed for the call before the tool ran, when the arguments carry none. */
	previewDiff?: string;
	__partialJson?: string;
	edits?: EditEntry[];
	/** The mode the caller resolved, so the card dispatches without sniffing the payload's shape. */
	editMode?: EditMode;
	/** Per-file changes computed while an edit spanning several files streams. */
	previewFiles?: PerFileDiffPreview[];
	/** The change computed for the call, or why it could not be, when the tool has not answered yet. */
	preview?: DiffResult | DiffError;
}

/** The result the card reads, which is the tool's own result shape narrowed to what a card shows. */
export interface EditViewResult {
	content: Array<{ type: string; text?: string }>;
	details?: EditToolDetails;
	isError?: boolean;
}

/** A path off an edit entry, which is a path only when the model sent a string. */
function entryPath(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** How many distinct files an `edits` array touches. */
function countEditFiles(edits: EditEntry[]): number {
	return new Set(edits.map(edit => entryPath(edit.path)).filter(Boolean)).size;
}

/**
 * The path out of a streamed argument buffer, so the card names the file before the JSON closes.
 *
 * The fragment is decoded as the JSON string it is part of rather than unescaped by hand: a chunk
 * boundary lands inside an escape often enough that a hand-rolled reader mangles a surrogate pair,
 * and a trailing half-escape is dropped so the parse sees a well-formed string.
 */
function partialJsonString(partialJson: string | undefined, key: string): string | undefined {
	if (!partialJson) return undefined;
	const pattern = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`, "u");
	const match = pattern.exec(partialJson);
	if (!match) return undefined;
	let text = match[1].replace(/\\u[0-9a-fA-F]{0,3}$/, "");
	const trailingBackslashes = text.match(/\\+$/)?.[0].length ?? 0;
	if (trailingBackslashes % 2 === 1) text = text.slice(0, -1);
	try {
		return JSON.parse(`"${text}"`) as string;
	} catch {
		return text;
	}
}

/** One file a hashline payload names, with whatever file-level op it carries. */
interface HashlineEntry {
	path: string;
	op?: Operation;
	rename?: string;
	/** A SWAP/DEL/INS line-editing op precedes the file op, which keeps a move framed. */
	hasLineEdits?: boolean;
}

/** A path a hashline header names, with the tag and any quoting taken back off it. */
function hashlineHeaderPath(rawPath: string): string {
	const trimmed = rawPath.trim();
	const hashStart = /#[0-9a-fA-F]{4}$/u.exec(trimmed)?.index;
	const withoutHash = hashStart === undefined ? trimmed : trimmed.slice(0, hashStart);
	if (withoutHash.length < 2) return withoutHash;
	const first = withoutHash[0];
	const last = withoutHash[withoutHash.length - 1];
	if ((first === '"' || first === "'") && first === last) return withoutHash.slice(1, -1);
	return withoutHash;
}

/** The file a hashline section header names, or nothing when the line is not one. */
function hashlineHeader(line: string): string | null {
	const trimmed = line.trimEnd();
	if (!trimmed.startsWith(HL_FILE_PREFIX)) return null;
	// Tolerant while the closing bracket is still arriving; the parser enforces the final shape.
	const bodyEnd = trimmed.endsWith(HL_FILE_SUFFIX) ? trimmed.length - HL_FILE_SUFFIX.length : trimmed.length;
	const previewPath = hashlineHeaderPath(trimmed.slice(HL_FILE_PREFIX.length, bodyEnd).trim());
	return previewPath.length > 0 ? previewPath : null;
}

// Line-editing op headers (SWAP/DEL/INS family), distinct from the file-level REM/MV ops. Body rows
// are always `+TEXT`, so this matches real headers alone.
const HL_LINE_OP_HEADER = /^(?:SWAP|DEL|INS)\b/;

/**
 * A hashline payload, however much of it has arrived, as the files it names and the file-level ops
 * each carries, so a delete or a move is labelled before the payload finishes streaming.
 */
function hashlineEntries(input: string): HashlineEntry[] {
	const stripped = input.startsWith("\uFEFF") ? input.slice(1) : input;
	const entries: HashlineEntry[] = [];
	let current: HashlineEntry | undefined;
	for (const rawLine of stripped.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		const headerPath = hashlineHeader(line);
		if (headerPath) {
			current = { path: headerPath };
			entries.push(current);
			continue;
		}
		if (!current) continue;
		const trimmed = line.trim();
		if (trimmed === HL_REM_KEYWORD) current.op = "delete";
		else if (trimmed.startsWith(`${HL_MOVE_KEYWORD} `))
			current.rename = hashlineHeaderPath(trimmed.slice(HL_MOVE_KEYWORD.length + 1));
		else if (HL_LINE_OP_HEADER.test(trimmed)) current.hasLineEdits = true;
	}
	return entries;
}

/** The hashline payload's files, for a call in hashline mode alone. */
function hashlineSummary(args: EditViewArgs): HashlineEntry[] | undefined {
	const input = args.input ?? args._input;
	if (args.editMode !== "hashline" || typeof input !== "string") return undefined;
	return hashlineEntries(input);
}

const MISSING_APPLY_PATCH_END_ERROR = "The last line of the patch must be '*** End Patch'";

/** The envelope's files, or why the envelope could not be read, for a call in apply-patch mode. */
function applyPatchSummary(
	args: EditViewArgs,
	partial: boolean,
): { entries: ApplyPatchEntry[]; error?: string } | undefined {
	if (args.editMode !== undefined && args.editMode !== "apply_patch") return undefined;
	if (typeof args.input !== "string") return undefined;
	try {
		return { entries: expandApplyPatchToEntries({ input: args.input }) };
	} catch (err) {
		const error = errorMessage(err);
		// A payload still arriving has no closing marker yet, which is not an error the reader has
		// anything to do about: the entries parsed so far are what the card shows.
		if (partial && error === MISSING_APPLY_PATCH_END_ERROR) {
			return { entries: expandApplyPatchToPreviewEntries({ input: args.input }) };
		}
		return { entries: [], error };
	}
}

/** A change row in the canonical form the tool writes: a marker, a line number and the text. */
const CANONICAL_DIFF_ROW = /^([+-\s])(\s*\d+)\|(.*)$/;

/** The older form of the same row, whose number is separated by a space and may be absent. */
const LEGACY_DIFF_ROW = /^([+-\s])(?:(\s*\d+)\s)?(.*)$/;

/** Which side of the change a marker column states. */
function sideOfMarker(marker: string): ViewDiffSide {
	return marker === "+" ? "added" : marker === "-" ? "removed" : "context";
}

/** A change as the lines, sides and numbers a diff section states. */
function diffRows(diff: string): { lines: ViewLine[]; sides: ViewDiffSide[]; numbers: (number | null)[] } {
	const lines: ViewLine[] = [];
	const sides: ViewDiffSide[] = [];
	const numbers: (number | null)[] = [];
	for (const row of sanitizeText(diff).split("\n")) {
		const trimmed = row.trim();
		// A blank row and the markers older transcripts wrote both mean the rows around them are not
		// next to each other in the file, which is one thing to say however it was written.
		if (trimmed.length === 0 || trimmed === "..." || trimmed === "…") {
			lines.push([{ text: "" }]);
			sides.push("gap");
			numbers.push(null);
			continue;
		}
		const canonical = CANONICAL_DIFF_ROW.exec(row);
		const parsed = canonical ?? LEGACY_DIFF_ROW.exec(row);
		if (!parsed) {
			lines.push([{ text: row }]);
			sides.push("context");
			numbers.push(null);
			continue;
		}
		const number = parsed[2]?.trim();
		lines.push([{ text: parsed[3] ?? "" }]);
		sides.push(sideOfMarker(parsed[1] ?? " "));
		numbers.push(number ? Number.parseInt(number, 10) : null);
	}
	return { lines, sides, numbers };
}

/**
 * A change as one section of the card.
 *
 * A collapsed settled card is cut to the hunks and lines a preview is worth and says how many lines
 * it dropped; a card still arriving states the whole change and asks the host for a window onto its
 * end, because the rows a reader wants while an edit streams are the newest ones and how many fit is
 * the host's answer.
 */
function diffSection(
	diff: string,
	path: string,
	options: { expanded: boolean; label?: string; streaming?: boolean; tailMax?: number },
): ViewSection | undefined {
	if (!diff) return undefined;
	const trimmed =
		options.streaming || options.expanded
			? { text: diff, hiddenLines: 0 }
			: truncateDiffByHunk(diff, PREVIEW_LIMITS.DIFF_COLLAPSED_HUNKS, PREVIEW_LIMITS.DIFF_COLLAPSED_LINES);
	const { lines, sides, numbers } = diffRows(trimmed.text);
	// A change computed before the edit landed has no numbers of its own, and a gutter of blanks in
	// front of every row is a column that states nothing.
	const numbered = numbers.some(number => number !== null);
	return {
		...(options.label === undefined ? {} : { label: options.label }),
		lines,
		diff: { sides, ...(numbered ? { lineNumbers: numbers } : {}), ...(path ? { path } : {}) },
		...(trimmed.hiddenLines > 0 ? { hidden: { count: trimmed.hiddenLines, noun: LINE_NOUN, revealable: true } } : {}),
		...(options.streaming
			? {
					tail: options.expanded
						? { viewport: true, reserve: EDIT_STREAMING_HEADROOM }
						: { max: options.tailMax ?? EDIT_STREAMING_PREVIEW_LINES, viewport: true },
				}
			: {}),
	};
}

/**
 * Replacement text a call carries with no change computed for it yet, as the lines the card shows.
 *
 * The text is the model's, not the file's, so it is stated as the tool's own words rather than as a
 * change: nothing is known yet about which of these lines is an addition.
 */
function textPreviewSection(text: string, expanded: boolean): ViewSection | undefined {
	const lines = sanitizeText(text).split("\n");
	if (lines.length === 0) return undefined;
	const kept = expanded ? lines : lines.slice(0, CALL_TEXT_PREVIEW_LINES);
	const held = lines.length - kept.length;
	return {
		lines: kept.map(line => [{ text: replaceTabs(line), tone: "output" as const }]),
		...(held > 0 ? { hidden: { count: held, noun: LINE_NOUN, revealable: true } } : {}),
	};
}

/**
 * The failure as the card states it, with every path in it shortened.
 *
 * A patch failure quotes the lines it could not match, so the text is a file's own content and the
 * absolute paths in it are the operator's directory layout. Word by word, since a path may sit
 * inside brackets or end a sentence.
 */
function errorSection(
	errorText: string,
	rawPath: string,
	linkPath: string | undefined,
	expanded: boolean,
): ViewSection {
	let sanitized = errorText;
	for (const candidate of [rawPath, linkPath]) {
		if (candidate) sanitized = sanitized.replaceAll(candidate, shortenPath(candidate));
	}
	sanitized = shortenEmbeddedPaths(sanitized);
	const lines = sanitized.split("\n");
	const kept = expanded ? lines : lines.slice(0, PREVIEW_LIMITS.DIFF_COLLAPSED_LINES);
	const held = lines.length - kept.length;
	return {
		lines: kept.map(line => [{ text: replaceTabs(line), tone: "error" as const }]),
		...(held > 0 ? { hidden: { count: held, noun: LINE_NOUN, revealable: true } } : {}),
	};
}

/** How many lines a change adds and removes, as the trailing detail of the row that heads the card. */
function statsMeta(diff: string | undefined): ViewLine[] {
	if (!diff) return [];
	const { added, removed } = getDiffStats(diff);
	const meta: ViewLine[] = [];
	if (added > 0) meta.push([{ text: `+${added}`, tone: "diffAdded" }]);
	if (removed > 0) meta.push([{ text: `-${removed}`, tone: "diffRemoved" }]);
	return meta;
}

/**
 * The row that heads every edit card: the operation, the file it is to and what it did to it.
 *
 * The file is the subject of the row, so it is the description rather than a fact beside it, and a
 * rename states both halves in one description because the two are one move. The link is the file a
 * reader opens afterwards, which for a rename is where it ended up.
 */
function header(options: {
	op?: Operation;
	title?: string;
	rawPath: string;
	rename?: string;
	linkPath?: string;
	firstChangedLine?: number;
	status?: StatusRowView["status"];
	emblem?: string;
	meta?: ViewLine[];
}): StatusRowView {
	// A call whose path has not arrived yet says so with an ellipsis, which names no file and is
	// therefore drawn as the row's own words rather than in the colour a path carries.
	const shown = options.rawPath ? shortenPath(options.rawPath) : "…";
	const description = options.rename === undefined ? shown : `${shown} → ${shortenPath(options.rename)}`;
	const target = options.rename ?? options.linkPath ?? options.rawPath;
	return {
		kind: "statusRow",
		title: options.title ?? operationTitle(options.op),
		...(options.status === undefined ? {} : { status: options.status }),
		...(options.emblem === undefined ? {} : { emblem: options.emblem }),
		description,
		// The path is the subject of the row, and an edit states its counts after it, so the row keeps
		// both by shortening the path rather than losing whichever fact sits past the last column.
		descriptionFits: true,
		...(options.rawPath ? { descriptionTone: "accent" as const } : {}),
		...(target ? { descriptionFile: target } : {}),
		...(options.firstChangedLine === undefined ? {} : { descriptionFileLine: options.firstChangedLine }),
		...(options.rawPath ? { language: getLanguageFromPath(options.rawPath) ?? "" } : {}),
		...(options.meta === undefined || options.meta.length === 0 ? {} : { meta: options.meta }),
	};
}

/**
 * A delete or a bare rename as the one row it is.
 *
 * Neither carries a change to show, so a framed card around them would be a frame around nothing.
 * The settled row is titled by the tool's own mark and the one still running by its status.
 */
function inlineRow(options: {
	op?: Operation;
	rename?: string;
	rawPath: string;
	linkPath?: string;
	pending: boolean;
}): StatusRowView {
	const isDelete = options.op === "delete";
	return header({
		op: options.op,
		title: isDelete ? "Delete" : "Move",
		rawPath: options.rawPath,
		rename: options.rename,
		linkPath: options.linkPath,
		...(options.pending ? { status: "pending" } : { emblem: isDelete ? "tool.delete" : "tool.move" }),
	});
}

/** Whether a call carries anything worth framing, which keeps a move with edits in a card. */
function hasCallPayload(args: EditViewArgs): boolean {
	const multi = args.previewFiles;
	if (multi && multi.length > 1 && multi.some(preview => preview.diff || preview.error)) return true;
	if (args.previewDiff || args.diff || args.newText || args.patch) return true;
	return Array.isArray(args.edits) && args.edits.length > 0;
}

/** The sections a call card shows for whatever change has been computed for it so far. */
function callSections(args: EditViewArgs, rawPath: string, expanded: boolean): ViewSection[] {
	const multi = args.previewFiles;
	if (multi && multi.length > 1 && multi.some(preview => preview.diff || preview.error)) {
		const sections: ViewSection[] = [];
		// One window over the whole card, split between the files in it. A window per file multiplies
		// the bound by the number of files, and a streaming preview that outgrows the viewport scrolls
		// its own mutating rows into committed scrollback.
		const shown = multi.filter(preview => preview.diff || preview.error).length;
		const tailMax = Math.max(2, Math.floor(EDIT_STREAMING_PREVIEW_LINES / Math.max(1, shown)));
		for (const preview of multi) {
			if (preview.error) {
				sections.push({ label: shortenPath(preview.path), lines: [[{ text: preview.error, tone: "error" }]] });
				continue;
			}
			const section = diffSection(preview.diff ?? "", preview.path, {
				expanded,
				streaming: true,
				tailMax,
				label: shortenPath(preview.path),
			});
			if (section) sections.push(section);
		}
		return sections;
	}
	if (args.previewDiff) {
		const section = diffSection(args.previewDiff, rawPath, { expanded, streaming: true });
		return section ? [section] : [];
	}
	if (args.diff && args.op) {
		const section = diffSection(args.diff, rawPath, { expanded, streaming: true });
		return section ? [section] : [];
	}
	const text = args.diff ?? args.newText ?? args.patch;
	if (text) {
		const section = textPreviewSection(text, expanded);
		return section ? [section] : [];
	}
	return [];
}

/** The card one file's result draws, which a multi-file result draws one of per file. */
function resultSections(
	details: EditToolDetails | EditToolPerFileResult | undefined,
	options: {
		isError: boolean;
		errorText: string;
		rawPath: string;
		linkPath?: string;
		op?: Operation;
		rename?: string;
		expanded: boolean;
		preview?: DiffResult | DiffError;
	},
): ViewSection[] {
	const sections: ViewSection[] = [];
	if (options.isError) {
		if (options.errorText)
			sections.push(errorSection(options.errorText, options.rawPath, options.linkPath, options.expanded));
	} else if (details?.diff) {
		const section = diffSection(details.diff, options.rawPath, { expanded: options.expanded });
		if (section) sections.push(section);
	} else if (details) {
		// A settled result with no change to show is a delete, a bare rename or a genuine no-op. The
		// row that heads the card already names the first two; only the third needs saying, or an
		// empty card reads as an edit that stalled.
		if (options.op !== "delete" && options.op !== "create" && !options.rename) {
			const shown = options.linkPath
				? shortenPath(options.linkPath)
				: options.rawPath
					? shortenPath(options.rawPath)
					: "";
			sections.push({ lines: [[{ text: `No changes were made${shown ? ` to ${shown}` : ""}.`, tone: "dim" }]] });
		}
	} else if (options.preview) {
		if ("error" in options.preview) {
			sections.push(errorSection(options.preview.error, options.rawPath, options.linkPath, options.expanded));
		} else if (options.preview.diff) {
			const section = diffSection(options.preview.diff, options.rawPath, { expanded: options.expanded });
			if (section) sections.push(section);
		}
	}
	const diagnostics = details?.diagnostics;
	if (diagnostics) {
		const section = diagnosticsSection(diagnostics, options.expanded);
		if (section) sections.push(section);
	}
	return sections;
}

/** What one file's result says, as the card a single-file edit is and a section of a multi-file one. */
function singleFileResult(
	result: {
		content?: Array<{ type: string; text?: string }>;
		details?: EditToolDetails | EditToolPerFileResult;
		isError?: boolean;
	},
	context: ToolViewContext,
	args: EditViewArgs | undefined,
): ToolView {
	const details = result.details;
	const isError = result.isError ?? (details && "isError" in details ? details.isError === true : false);
	const edits = Array.isArray(args?.edits) ? args.edits : undefined;
	const firstEdit = edits?.[0];
	const firstHashline = hashlineSummary(args ?? {})?.[0];
	const moveSource =
		details && "sourcePath" in details && typeof details.sourcePath === "string" ? details.sourcePath : undefined;
	const detailPath = details && "path" in details && typeof details.path === "string" ? details.path : undefined;
	const rawPath =
		moveSource ??
		(typeof args?.file_path === "string"
			? args.file_path
			: typeof args?.path === "string"
				? args.path
				: (entryPath(firstEdit?.path) ?? detailPath ?? firstHashline?.path ?? ""));
	const op = args?.op ?? firstEdit?.op ?? details?.op;
	const rename =
		(typeof args?.rename === "string" ? args.rename : undefined) ??
		entryPath(firstEdit?.rename) ??
		entryPath(firstEdit?.move) ??
		(details && "move" in details && typeof details.move === "string" ? details.move : undefined);
	const displayErrorText = isError && details && "displayErrorText" in details ? details.displayErrorText : undefined;
	const errorText = isError
		? displayErrorText ||
			(details && "errorText" in details ? (details.errorText ?? "") : "") ||
			(result.content?.find(part => part.type === "text")?.text ?? "")
		: "";
	const linkPath = details && "path" in details ? details.path : undefined;

	// A delete or a move that changed nothing inside the file has no rows to frame.
	if (!isError && !details?.diff && !details?.diagnostics && (op === "delete" || rename)) {
		return inlineRow({ op, rename, rawPath, linkPath, pending: false });
	}

	// A settled result is authoritative: what it reports is what happened. The change computed while
	// the call streamed is a call-phase artifact -- in a batch it describes only the first file -- so
	// it is read only while no result exists.
	const preview = details ? undefined : args?.preview;
	const previewDiff = preview && !("error" in preview) ? preview.diff : undefined;
	const firstChangedLine =
		(preview && "firstChangedLine" in preview ? preview.firstChangedLine : undefined) ||
		(details && !isError ? details.firstChangedLine : undefined);

	const card: FramedBlockView = {
		kind: "framedBlock",
		gutter: true,
		header: header({
			op,
			rawPath,
			rename,
			linkPath,
			firstChangedLine,
			...(isError ? { status: "error" } : context.partial ? { status: "pending" } : { emblem: "tool.edit" }),
			meta: statsMeta(isError ? undefined : (details?.diff ?? previewDiff)),
		}),
		state: isError ? "error" : context.partial === true ? "pending" : "success",
		sections: resultSections(details, {
			isError,
			errorText,
			rawPath,
			linkPath,
			op,
			rename,
			expanded: context.expanded,
			preview,
		}),
	};
	return card;
}

export const editToolView: Required<ToolViewRenderer<EditViewArgs, EditViewResult>> = {
	/**
	 * The card while the change is still arriving.
	 *
	 * No status icon on the row that heads it: the block reports `running`, which the host says on a
	 * trailing row of its own, and an animated glyph in a head row pins a native-scrollback commit
	 * boundary at the top of the block so a long preview could never scroll-append mid-stream.
	 */
	renderCall(args, context: ToolViewContext): ToolView {
		const hashline = hashlineSummary(args);
		const applyPatch = applyPatchSummary(args, context.partial === true);
		const firstApplyPatch = applyPatch?.entries[0];
		const firstHashline = hashline?.[0];
		const firstEdit = Array.isArray(args.edits) && args.edits.length > 0 ? args.edits[0] : undefined;
		const rawPath =
			typeof args.file_path === "string"
				? args.file_path
				: typeof args.path === "string"
					? args.path
					: (entryPath(firstEdit?.path) ??
						partialJsonString(args.__partialJson, "path") ??
						firstHashline?.path ??
						firstApplyPatch?.path ??
						"");
		const rename =
			(typeof args.rename === "string" ? args.rename : undefined) ??
			entryPath(firstEdit?.rename) ??
			entryPath(firstEdit?.move) ??
			firstApplyPatch?.rename ??
			firstHashline?.rename;
		const op = args.op ?? firstEdit?.op ?? firstApplyPatch?.op ?? firstHashline?.op;
		const fileCount = Array.isArray(args.edits)
			? countEditFiles(args.edits)
			: (hashline?.length ?? applyPatch?.entries.length ?? 0);

		const payload = hasCallPayload(args) || firstHashline?.hasLineEdits === true;
		if (fileCount <= 1 && !applyPatch?.error && (op === "delete" || (rename !== undefined && !payload))) {
			return inlineRow({ op, rename, rawPath, pending: true });
		}

		const sections = callSections(args, rawPath, context.expanded);
		if (applyPatch?.error) {
			sections.push({ lines: [[{ text: replaceTabs(applyPatch.error), tone: "error" }]] });
		}
		return {
			kind: "framedBlock",
			gutter: true,
			header: header({
				op,
				rawPath,
				rename,
				meta: fileCount > 1 ? [[{ text: `+${fileCount - 1} more`, tone: "dim" }]] : [],
			}),
			state: applyPatch?.error ? "error" : "running",
			sections,
		};
	},

	/**
	 * The card once the tool has answered.
	 *
	 * An edit spanning several files is ONE card whose sections are the files, where the terminal
	 * used to stack a framed card per file with a blank row between them: a card is what a tool call
	 * produced, and a call that edited four files produced one.
	 */
	renderResult(result, context: ToolViewContext, args): ToolView {
		const edits = Array.isArray(args?.edits) ? args.edits : undefined;
		const perFileResults = result.details?.perFileResults;
		const totalFiles = edits ? countEditFiles(edits) : 0;
		if (!perFileResults || (perFileResults.length <= 1 && totalFiles <= 1)) {
			return singleFileResult(result, context, args);
		}

		const sections: ViewSection[] = [];
		let added = 0;
		let removed = 0;
		let failed = false;
		for (const file of perFileResults) {
			const label = shortenPath(file.path);
			if (file.isError) {
				failed = true;
				const text = file.displayErrorText || file.errorText || "";
				sections.push({ label, ...errorSection(text, file.path, file.path, context.expanded) });
				continue;
			}
			const stats = getDiffStats(file.diff ?? "");
			added += stats.added;
			removed += stats.removed;
			const section = diffSection(file.diff ?? "", file.path, { expanded: context.expanded, label });
			sections.push(section ?? { label, lines: [[{ text: "No changes were made.", tone: "dim" }]] });
			if (file.diagnostics) {
				const diagnostics = diagnosticsSection(file.diagnostics, context.expanded);
				if (diagnostics) sections.push(diagnostics);
			}
		}
		const remaining = Math.max(0, totalFiles - perFileResults.length);
		if (remaining > 0) {
			sections.push({
				lines: [[{ text: `${remaining} more file${remaining > 1 ? "s" : ""} pending…`, tone: "dim" }]],
			});
		}

		const meta: ViewLine[] = [[{ text: `${perFileResults.length} file${perFileResults.length === 1 ? "" : "s"}` }]];
		if (added > 0) meta.push([{ text: `+${added}`, tone: "diffAdded" }]);
		if (removed > 0) meta.push([{ text: `-${removed}`, tone: "diffRemoved" }]);
		return {
			kind: "framedBlock",
			gutter: true,
			header: {
				kind: "statusRow",
				title: "Edit",
				...(failed ? { status: "error" } : remaining > 0 ? { status: "running" } : { emblem: "tool.edit" }),
				meta,
			},
			state: failed ? "error" : remaining > 0 ? "pending" : "success",
			sections,
		};
	},
};
