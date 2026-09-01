/**
 * What the file search card shows, for any host.
 *
 * The tool half in `file-search.ts` decides what happened; this half decides what a reader is told,
 * and names no colour, glyph or component. A terminal draws it through `src/tui/draw-tool-view.ts`
 * and a second host writes its own mapping from the same value.
 *
 * The card has five shapes, and they are the tool's own branches rather than presentation choices: a
 * call still running, a failure, a result the tool described in detail, a result it described only as
 * text, and a result that found nothing. The last of those is not an empty version of the fourth —
 * a scan that timed out mid-walk found nothing YET, which is a warning rather than an answer.
 */

import * as path from "node:path";
import { formatCount } from "@veyyon/utils/format";
import type {
	FramedBlockView,
	StatusRowView,
	ToolView,
	ToolViewContext,
	ToolViewRenderer,
	ViewHiddenCount,
	ViewLine,
	ViewSection,
} from "@veyyon/view";
import { getLanguageFromPath } from "../../utils/lang-from-path";
import { formatFullOutputReference } from "../core/output-meta";
import { sanitizeErrorText } from "../core/render-utils";
import { COLLAPSED_LIST_LIMIT, type FileSearchDetails, type FileSearchRenderArgs } from "./file-search";

/** What every card of this tool is titled. */
const FILE_SEARCH_TITLE = "Search files";

/** The tool's own mark, which a settled card is titled by instead of an outcome icon. */
const FILE_SEARCH_EMBLEM = "icon.search";

/** The unit every held-back count on this card is in, which the host words. */
const FILE_NOUN = { one: "file", many: "files" } as const;

/** The result the card reads, which is the tool's own result shape narrowed to what a card shows. */
export interface FileSearchViewResult {
	content?: Array<{ type: string; text?: string }>;
	details?: FileSearchDetails;
	isError?: boolean;
}

/** The head row of every result card: the pattern the model asked for is the description. */
function header(
	args: FileSearchRenderArgs | undefined,
	options: { status?: StatusRowView["status"]; emblem?: string; meta: readonly ViewLine[] },
): StatusRowView {
	return {
		kind: "statusRow",
		...(options.status === undefined ? {} : { status: options.status }),
		...(options.emblem === undefined ? {} : { emblem: options.emblem, emblemTone: "title" as const }),
		title: FILE_SEARCH_TITLE,
		titleTone: "title",
		...(args?.input === undefined ? {} : { description: args.input }),
		meta: options.meta,
	};
}

/**
 * One found path as the row a reader follows.
 *
 * A directory is outdented and marked with the host's folder glyph; a file sits two columns in,
 * badged with its language and linked to the absolute path the tool resolved. The trailing slash is
 * what says which of the two it is, because that is what the search itself reports.
 */
function fileRow(entry: string, cwd: string | undefined): ViewLine {
	if (entry.endsWith("/")) {
		return [{ text: "", symbol: "icon.folder", tone: "accent" }, { text: " " }, { text: entry, tone: "accent" }];
	}
	const absolute = cwd === undefined ? undefined : path.resolve(cwd, entry);
	return [
		{ text: "  " },
		{
			text: entry,
			tone: "output",
			// Stated even when the path names no language the tool knows, which is a file whose
			// language it could not tell rather than a row that names no file.
			language: getLanguageFromPath(entry) ?? "",
			...(absolute === undefined ? {} : { file: absolute }),
		},
	];
}

/** What the card kept back, or nothing when the reader already has every row. */
function heldBack(total: number, shown: number): ViewHiddenCount | undefined {
	const count = total - shown;
	return count > 0 ? { count, noun: FILE_NOUN, revealable: true } : undefined;
}

/**
 * Why the search stopped short, in the order the tool learned it.
 *
 * One reason for the result cap: `resultLimitReached` and `limits.resultLimit` carry the same number,
 * and stating both read as `limit 200 results, limit 200 results`.
 */
function truncationReasons(details: FileSearchDetails | undefined): string[] {
	const truncation = details?.truncation ?? details?.meta?.truncation;
	const reasons: string[] = [];
	const resultLimit = details?.resultLimitReached ?? details?.meta?.limits?.resultLimit?.reached;
	if (resultLimit) reasons.push(`limit ${resultLimit} results`);
	if (truncation) reasons.push(truncation.truncatedBy === "lines" ? "line limit" : "size limit");
	const artifactId = truncation && "artifactId" in truncation ? truncation.artifactId : undefined;
	if (artifactId) reasons.push(formatFullOutputReference(artifactId));
	return reasons;
}

/**
 * The notes that follow the rows: what the scan cut, and what it never reached.
 *
 * Their own section rather than more lines of the first one, so the count the card kept back stays
 * with the rows it was taken from instead of landing under a warning about something else.
 */
function noteSection(details: FileSearchDetails | undefined, truncated: boolean): ViewSection | undefined {
	const lines: ViewLine[] = [];
	const reasons = truncated ? truncationReasons(details) : [];
	if (reasons.length > 0) lines.push([{ text: `truncated: ${reasons.join(", ")}`, tone: "warning" }]);
	const missingPaths = details?.missingPaths ?? [];
	if (missingPaths.length > 0) {
		lines.push([{ text: `skipped missing: ${missingPaths.join(", ")}`, tone: "warning" }]);
	}
	return lines.length === 0 ? undefined : { lines, clip: true };
}

/** The empty answer, which is a warning mark and the words that say which kind of empty it is. */
function emptyLine(label: string): ViewLine {
	return [{ text: "", symbol: "status.warning", tone: "warning" }, { text: " " }, { text: label, tone: "muted" }];
}

export const fileSearchToolView: Required<ToolViewRenderer<FileSearchRenderArgs, FileSearchViewResult>> = {
	/**
	 * The card while the search is running: the pattern it is running, and the cap if the call set one.
	 *
	 * `*` stands in for a pattern the model has not sent yet, because a row that named nothing would
	 * read as a search over nothing rather than as one over everything.
	 */
	renderCall(args, _context: ToolViewContext): ToolView {
		return {
			kind: "statusRow",
			status: "pending",
			title: FILE_SEARCH_TITLE,
			titleTone: "title",
			description: args?.input || "*",
			meta: args?.limit === undefined ? [] : [[{ text: `limit:${args.limit}` }]],
		};
	},

	renderResult(result, context: ToolViewContext, args): ToolView {
		const details = result.details;

		if (result.isError === true || details?.error !== undefined) {
			const text = details?.error ?? result.content?.find(part => part.type === "text")?.text;
			return {
				kind: "textBlock",
				spans: [
					{ text: "", symbol: "status.error", tone: "error" },
					{ text: " " },
					{ text: `Error: ${sanitizeErrorText(text)}`, tone: "error" },
				],
			};
		}

		// A result the tool described in detail carries a count; one that did not is a block of text
		// the card can only list, and the two are told apart by the count rather than by the text.
		if (details?.fileCount === undefined) return textOnlyResult(result, context, args);

		const truncation = details.truncation ?? details.meta?.truncation;
		const truncated = Boolean(
			details.truncated || truncation || details.resultLimitReached || details.meta?.limits?.resultLimit,
		);

		if (details.fileCount === 0) {
			// `truncated` on an empty result means the scan timed out mid-walk, so the card says the
			// answer is incomplete rather than that there is none.
			const label = truncated ? "No matches before timeout (scan incomplete)" : "No files found";
			const missingPaths = details.missingPaths ?? [];
			return {
				kind: "headedBlock",
				header: header(args, {
					status: "warning",
					meta: truncated
						? [[{ text: "0 files" }], [{ text: "timed out", tone: "warning" }]]
						: [[{ text: "0 files" }]],
				}),
				lines:
					missingPaths.length === 0
						? [emptyLine(label)]
						: [emptyLine(label), [{ text: `skipped missing: ${missingPaths.join(", ")}`, tone: "warning" }]],
			};
		}

		const files = details.files ?? [];
		const shown = context.expanded ? files.length : Math.min(files.length, COLLAPSED_LIST_LIMIT);
		const hidden = context.expanded ? undefined : heldBack(files.length, shown);
		const rows: ViewSection = {
			lines: files.slice(0, shown).map(entry => fileRow(entry, details.cwd)),
			clip: true,
			...(hidden === undefined ? {} : { hidden }),
		};
		const notes = noteSection(details, truncated);

		const meta: ViewLine[] = [[{ text: formatCount("file", details.fileCount) }]];
		if (details.scopePath !== undefined && details.scopePath !== "") {
			meta.push([{ text: `in ${details.scopePath}` }]);
		}
		if (truncated) meta.push([{ text: "truncated", tone: "warning" }]);

		const card: FramedBlockView = {
			kind: "framedBlock",
			header: header(args, {
				...(truncated ? { status: "warning" } : { emblem: FILE_SEARCH_EMBLEM }),
				meta,
			}),
			state: truncated ? "warning" : "success",
			sections: notes === undefined ? [rows] : [rows, notes],
		};
		return card;
	},
};

/**
 * The card for a result the tool described as text alone.
 *
 * Reached when a search ran through operations that report no per-file detail, so the card has the
 * model-facing text and nothing else: each non-blank line is one found path, and a card that can
 * tell nothing else about them says only that.
 */
function textOnlyResult(
	result: FileSearchViewResult,
	context: ToolViewContext,
	args: FileSearchRenderArgs | undefined,
): ToolView {
	const text = result.content?.find(part => part.type === "text")?.text;
	if (
		text === undefined ||
		text.includes("No files matching") ||
		text.includes("No files found") ||
		text.trim() === ""
	) {
		return { kind: "textBlock", spans: emptyLine("No files found") };
	}

	const lines = text.split("\n").filter(line => line.trim() !== "");
	const shown = context.expanded ? lines.length : Math.min(lines.length, COLLAPSED_LIST_LIMIT);
	const hidden = context.expanded ? undefined : heldBack(lines.length, shown);
	return {
		kind: "framedBlock",
		header: header(args, { emblem: FILE_SEARCH_EMBLEM, meta: [[{ text: formatCount("file", lines.length) }]] }),
		state: "success",
		sections: [
			{
				lines: lines.slice(0, shown).map(line => [{ text: "  " }, { text: line, tone: "accent" as const }]),
				clip: true,
				...(hidden === undefined ? {} : { hidden }),
			},
		],
	};
}
