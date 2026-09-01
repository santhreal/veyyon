/**
 * What the text search card shows, for any host.
 *
 * The tool half in `text-search.ts` decides what happened; this half decides what a reader is told,
 * and names no colour, glyph or component. A terminal draws it through `src/tui/draw-tool-view.ts`
 * and a second host writes its own mapping from the same value.
 *
 * The card has five shapes, which are the tool's own branches: a call still running, a failure, a
 * result described in detail, a result described only as text, and a search that matched nothing.
 * The detailed shape is the one with structure — the tool's output is grouped, blank-line separated
 * blocks of headers and matched lines, and the card keeps whole blocks rather than whole lines, so a
 * budget is spent on groups and a group that does not fit is dropped entire.
 */

import type {
	StatusRowView,
	ToolView,
	ToolViewContext,
	ToolViewRenderer,
	ViewHiddenCount,
	ViewLine,
	ViewSection,
	ViewSpan,
} from "@veyyon/view";
import { tryResolveInternalUrlSync } from "../../internal-urls/resolve-sync";
import { classifyGroupedLines, groupLineIndicesByBlank } from "../core/grouped-file-output";
import { toPathList } from "../core/path-utils";
import { formatCount, formatScopeMeta, replaceTabs, sanitizeErrorText } from "../core/render-utils";
import {
	COLLAPSED_TEXT_LIMIT,
	EXPANDED_TEXT_LIMIT,
	type TextSearchDetails,
	type TextSearchRenderArgs,
} from "./text-search";

/** What every card of this tool is titled. */
const TEXT_SEARCH_TITLE = "Search text";

/** The tool's own mark, which a settled card is titled by instead of an outcome icon. */
const TEXT_SEARCH_EMBLEM = "icon.search";

/** The line number a body row carries, which is what makes it a match rather than context. */
const CODE_FRAME_LINE_RE = /^\s*\*?(\d+)│/;

/** A body row the search itself marked as the match, rather than the lines around it. */
const MARKED_MATCH_RE = /^\s*\*\d+(?:│|[:|])/;

/** A grouped-output header, which is the row that names the file or directory under it. */
const HEADER_RE = /^#+ /;

/** The `## ` a url header wears, which the card links without it. */
const URL_HEADER_PREFIX_RE = /^#+\s+/;

/** The units a held-back count on this card is in, which the host words. */
const NOUNS = {
	match: { one: "match", many: "matches" },
	file: { one: "file", many: "files" },
	line: { one: "line", many: "lines" },
	item: { one: "item", many: "items" },
} as const;

/** The result the card reads, which is the tool's own result shape narrowed to what a card shows. */
export interface TextSearchViewResult {
	content?: Array<{ type: string; text?: string }>;
	details?: TextSearchDetails;
	isError?: boolean;
}

/**
 * One line of the tool's output, kept beside the text it came from.
 *
 * The budget counts and classifies rows by their RAW text — a header, a marked match, a blank — and
 * every one of those questions is asked after the row has already been turned into spans. Carrying
 * both means the classification never has to be read back out of a styled row.
 */
interface SearchRow {
	raw: string;
	spans: ViewLine;
}

/** The head row of every card of this tool: the pattern the model asked for is the description. */
function header(
	args: TextSearchRenderArgs | undefined,
	options: { status?: StatusRowView["status"]; emblem?: string; meta: readonly ViewLine[] },
): StatusRowView {
	return {
		kind: "statusRow",
		...(options.status === undefined ? {} : { status: options.status }),
		...(options.emblem === undefined ? {} : { emblem: options.emblem, emblemTone: "title" as const }),
		title: TEXT_SEARCH_TITLE,
		titleTone: "title",
		...(args?.input === undefined ? {} : { description: args.input }),
		meta: options.meta,
	};
}

/** What the search covered, as the head row's trailing fact. */
function scopeMeta(details: TextSearchDetails | undefined): ViewLine | undefined {
	if (details?.scopePath === undefined || details.scopePath === "") return undefined;
	return [
		{ text: "in " },
		{ text: details.scopePath, ...(details.searchPath === undefined ? {} : { file: details.searchPath }) },
	];
}

/** The empty answer, which is a warning mark and the words that say which kind of empty it is. */
function emptyLine(label: string): ViewLine {
	return [{ text: "", symbol: "status.warning", tone: "warning" }, { text: " " }, { text: label, tone: "muted" }];
}

/** What the search never reached, or nothing when it reached everything it was given. */
function missingLine(details: TextSearchDetails | undefined): ViewLine | undefined {
	const missing = details?.missingPaths ?? [];
	return missing.length === 0 ? undefined : [{ text: `skipped missing: ${missing.join(", ")}`, tone: "warning" }];
}

function isMarkedMatch(raw: string): boolean {
	return MARKED_MATCH_RE.test(raw);
}

function isHeader(raw: string): boolean {
	return HEADER_RE.test(raw);
}

/**
 * The target a url-like header names, which is a path when the tool can resolve it and a URL when it
 * cannot.
 *
 * An internal address (`skill://`, `memory://`) resolves to a file a host can open directly, so the
 * span names the path; anything else stays the URL the search reported. The link is taken from the
 * header stripped of its `##` and of the trailing `(N matches)` the tool appends, because that count
 * is the card's words rather than part of the address.
 */
function urlHeaderTarget(raw: string): Pick<ViewSpan, "file" | "link"> {
	const address = raw
		.replace(URL_HEADER_PREFIX_RE, "")
		.trimEnd()
		.replace(/\s+\([^)]*\)\s*$/, "");
	const resolved = tryResolveInternalUrlSync(address);
	return resolved === undefined ? { link: address } : { file: resolved };
}

/**
 * Every line of the output as the row a reader follows.
 *
 * Classification is over the whole output rather than per group, because a nested directory stack
 * only reconstructs across the blank lines that separate the groups. A url header's resolved target
 * carries forward to the body rows under it: `classifyGroupedLines` resolves paths and knows nothing
 * about internal addresses, so the row that resolved one is the only place the rest can learn it.
 */
function searchRows(
	lines: readonly string[],
	headerBase: string | undefined,
	fileScope: string | undefined,
): SearchRow[] {
	const contexts = classifyGroupedLines(lines, headerBase, fileScope);
	let urlFile: string | undefined;
	return lines.map((line, index) => {
		const context = contexts[index]!;
		const text = replaceTabs(line);
		if (context.kind === "dir") {
			urlFile = undefined;
			return {
				raw: line,
				spans: [
					{ text, tone: "accent", ...(context.headerPath === undefined ? {} : { file: context.headerPath }) },
				],
			};
		}
		if (context.kind === "file") {
			if (context.isUrl === true) {
				const target = urlHeaderTarget(line);
				urlFile = target.file;
				return { raw: line, spans: [{ text, tone: "accent", ...target }] };
			}
			urlFile = undefined;
			// A root-level file keeps the bright accent; a nested file header is dimmed, so the eye
			// finds the directory it sits under first.
			return {
				raw: line,
				spans: [
					{
						text,
						tone: context.depth === 1 ? "accent" : "dim",
						...(context.headerPath === undefined ? {} : { file: context.headerPath }),
					},
				],
			};
		}
		const lineNumber = CODE_FRAME_LINE_RE.exec(line);
		const file = context.filePath ?? urlFile;
		return {
			raw: line,
			spans: [
				{
					text,
					tone: "output",
					...(file !== undefined && lineNumber !== null
						? { file, fileLine: Number.parseInt(lineNumber[1]!, 10) }
						: {}),
				},
			],
		};
	});
}

/**
 * A group reduced to the rows that carry the answer.
 *
 * A collapsed card shows the header and the matched lines and drops the context around them, which
 * is how a group of nine rows becomes two without the card losing which file it was in. A group that
 * is all context is kept whole instead, because dropping every row of it would leave a blank.
 */
function compactGroup(group: readonly SearchRow[]): readonly SearchRow[] {
	const compact = group.filter(row => isHeader(row.raw) || isMarkedMatch(row.raw));
	return compact.length > 0 ? compact : group;
}

/**
 * How many matches a run of rows shows.
 *
 * A search that marked its matches is counted by those marks. One that did not — a paths-only run, a
 * result that predates the marking — has no way to tell a match from a line, so every non-blank body
 * row counts as one, which is what the head row's own count already assumes.
 */
function countMatches(rows: readonly SearchRow[], marked: boolean): number {
	if (marked) return rows.reduce((count, row) => count + (isMarkedMatch(row.raw) ? 1 : 0), 0);
	return rows.reduce((count, row) => count + (!isHeader(row.raw) && row.raw.length > 0 ? 1 : 0), 0);
}

/** The rows a card shows and the count it kept back, for a body that is groups rather than lines. */
interface BudgetedBody {
	lines: ViewLine[];
	hidden?: ViewHiddenCount;
}

/**
 * The groups that fit, and what fell outside.
 *
 * The budget is in rows, and a group is taken whole or cut at the row the budget runs out on, so the
 * card never opens a group it cannot start. One row of the budget is reserved for the held-back note
 * whenever the rows outrun it, because the note is a row of the card like any other.
 *
 * What the note counts is the unit the card is about: matches for an ordinary search, files for a
 * paths-only one, and rows when the tool marked no matches at all and the head row's count cannot be
 * apportioned between what is shown and what is not.
 */
function budgetedBody(
	groups: readonly (readonly SearchRow[])[],
	maxLines: number,
	matchCount: number,
	compact: boolean,
	unit: "match" | "file" = "match",
): BudgetedBody {
	if (maxLines <= 0) return { lines: [] };
	const rendered = groups.map(group => (compact ? compactGroup(group) : group)).filter(group => group.length > 0);
	if (rendered.length === 0) return { lines: [] };

	let totalRows = 0;
	let totalMarked = 0;
	let totalFallback = 0;
	for (const group of rendered) {
		totalRows += group.length;
		totalMarked += countMatches(group, true);
		totalFallback += countMatches(group, false);
	}
	const marked = totalMarked > 0;
	const needsNote = totalRows > maxLines;
	const budget = needsNote ? Math.max(maxLines - 1, 0) : maxLines;

	const visible: (readonly SearchRow[])[] = [];
	let shownRows = 0;
	let shownMatches = 0;
	for (const group of rendered) {
		if (shownRows >= budget) break;
		const take = Math.min(group.length, budget - shownRows);
		if (take <= 0) break;
		const kept = group.slice(0, take);
		visible.push(kept);
		shownRows += kept.length;
		shownMatches += countMatches(kept, marked);
	}

	const total = marked ? totalMarked : Math.max(matchCount, totalFallback);
	const hiddenMatches = Math.max(total - shownMatches, 0);
	const hiddenRows = Math.max(totalRows - shownRows, 0);
	const lines: ViewLine[] = [];
	for (const group of visible) {
		lines.push(group[0]!.spans);
		// A group's own rows sit two columns in under the header that opened it, which is what says
		// the matched lines belong to that file and not to the card.
		for (let row = 1; row < group.length; row++) lines.push([{ text: "  " }, ...group[row]!.spans]);
	}
	if (!needsNote || (hiddenMatches === 0 && hiddenRows === 0)) return { lines };
	return {
		lines,
		hidden:
			hiddenMatches > 0
				? { count: hiddenMatches, noun: NOUNS[unit], revealable: true }
				: { count: hiddenRows, noun: NOUNS.line, revealable: true },
	};
}

export const textSearchToolView: Required<ToolViewRenderer<TextSearchRenderArgs, TextSearchViewResult>> = {
	/**
	 * The card while the search is running: the pattern it is running, and how the call narrowed it.
	 *
	 * `?` stands in for a pattern the model has not sent yet, because a row that named nothing would
	 * read as a search for nothing.
	 */
	renderCall(args, _context: ToolViewContext): ToolView {
		const paths = toPathList(args?.path);
		const meta: ViewLine[] = [];
		if (paths.length > 0) meta.push([{ text: formatScopeMeta(paths) }]);
		if (args?.case === false) meta.push([{ text: "case:insensitive" }]);
		if (args?.gitignore === false) meta.push([{ text: "gitignore:false" }]);
		if (args?.skip !== undefined && args.skip > 0) meta.push([{ text: `skip:${args.skip}` }]);
		return {
			kind: "statusRow",
			status: "pending",
			title: TEXT_SEARCH_TITLE,
			titleTone: "title",
			description: args?.input || "?",
			meta,
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
		if (details?.matchCount === undefined && details?.fileCount === undefined) {
			return textOnlyResult(result, context, args);
		}

		const matchCount = details.matchCount ?? 0;
		const fileCount = details.fileCount ?? 0;
		const limits = details.meta?.limits;
		const truncated = Boolean(details.truncated || details.meta?.truncation || limits?.columnTruncated);
		const missing = missingLine(details);

		if (matchCount === 0) {
			const meta: ViewLine[] = [[{ text: "0 matches" }]];
			const scope = scopeMeta(details);
			if (scope !== undefined) meta.push(scope);
			return {
				kind: "headedBlock",
				header: header(args, { status: "warning", meta }),
				lines: missing === undefined ? [emptyLine("No matches found")] : [emptyLine("No matches found"), missing],
			};
		}

		const meta: ViewLine[] = [
			[{ text: formatCount("match", matchCount) }],
			[{ text: formatCount("file", fileCount) }],
		];
		const scope = scopeMeta(details);
		if (scope !== undefined) meta.push(scope);
		if (truncated) meta.push([{ text: "truncated", tone: "warning" }]);

		const text = details.displayContent ?? result.content?.find(part => part.type === "text")?.text ?? "";
		const lines = text.split("\n");
		// Header and match paths are relative to where the search ran, so they resolve against `cwd`,
		// falling back to `searchPath` for a result that predates it; the scoped file's own path seeds
		// the body rows of a single-file search, which carry no header to learn it from.
		const rows = searchRows(lines, details.cwd ?? details.searchPath, details.searchPath);
		const groups = groupLineIndicesByBlank(lines).map(indices => indices.map(index => rows[index]!));

		// The note about what the search never reached is a row of the card, so it is taken out of the
		// budget before the groups are measured against it.
		const notes = missing === undefined ? 0 : 1;
		const budget = Math.max((context.expanded ? EXPANDED_TEXT_LIMIT : COLLAPSED_TEXT_LIMIT) - notes, 0);
		const body = budgetedBody(
			groups,
			budget,
			details.pathsOnly === true ? fileCount : matchCount,
			!context.expanded,
			details.pathsOnly === true ? "file" : "match",
		);

		const sections: ViewSection[] = [
			{ lines: body.lines, clip: true, ...(body.hidden === undefined ? {} : { hidden: body.hidden }) },
		];
		if (missing !== undefined) sections.push({ lines: [missing], clip: true });
		return {
			kind: "framedBlock",
			header: header(args, {
				...(truncated ? { status: "warning" as const } : { emblem: TEXT_SEARCH_EMBLEM }),
				meta,
			}),
			state: truncated ? "warning" : "success",
			sections,
		};
	},
};

/**
 * The card for a result the tool described as text alone.
 *
 * Reached when a search ran through a path that reports no counts, so the card has the model-facing
 * text and nothing else: each non-blank line is one row, and a card that can tell nothing else about
 * them says only how many there are.
 */
function textOnlyResult(
	result: TextSearchViewResult,
	context: ToolViewContext,
	args: TextSearchRenderArgs | undefined,
): ToolView {
	const text = result.details?.displayContent ?? result.content?.find(part => part.type === "text")?.text;
	if (text === undefined || text === "" || text === "No matches found") {
		return { kind: "textBlock", spans: emptyLine("No matches found") };
	}

	const lines = text.split("\n").filter(line => line.trim() !== "");
	const limit = context.expanded ? lines.length : COLLAPSED_TEXT_LIMIT;
	// One row of the budget goes to the note whenever there are rows it does not cover.
	const needsNote = !context.expanded && lines.length > limit;
	const shown = Math.min(lines.length, needsNote ? Math.max(limit - 1, 0) : limit);
	const held = lines.length - shown;
	return {
		kind: "framedBlock",
		header: header(args, { emblem: TEXT_SEARCH_EMBLEM, meta: [[{ text: formatCount("item", lines.length) }]] }),
		state: "success",
		sections: [
			{
				lines: lines.slice(0, shown).map(line => [{ text: replaceTabs(line), tone: "output" as const }]),
				clip: true,
				...(needsNote && held > 0 ? { hidden: { count: held, noun: NOUNS.item, revealable: true } } : {}),
			},
		],
	};
}
