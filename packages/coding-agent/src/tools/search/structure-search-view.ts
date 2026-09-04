/**
 * What the structure search card shows, for any host.
 *
 * The tool half in `structure-search.ts` decides what happened; this half decides what a reader is
 * told, and names no colour, glyph or component. A terminal draws it through
 * `src/modes/terminal/draw/draw-tool-view.ts` and a second host writes its own mapping from the same value.
 *
 * The card has four shapes, and they are the tool's own branches: a call still running, a failure, a
 * query that matched nothing, and a query that matched. The matched shape is the one with structure
 * — the tool's output is blank-line separated groups of a header and the matched nodes under it, and
 * a group is the unit the card keeps or drops, because half a group names a file and shows nothing
 * from it.
 */

import type {
	StatusRowView,
	ToolView,
	ToolViewContext,
	ToolViewRenderer,
	ViewHiddenCount,
	ViewLine,
	ViewSection,
} from "@veyyon/view";
import { classifyGroupedLines, groupLineIndicesByBlank } from "../core/grouped-file-output";
import { toPathList } from "../core/path-utils";
import {
	formatCount,
	formatParseErrorsCountLabel,
	formatScopeMeta,
	PARSE_ERRORS_LIMIT,
	replaceTabs,
	sanitizeErrorText,
} from "../core/render-utils";
import {
	COLLAPSED_MATCH_LIMIT,
	MATCH_LIMIT_NOTICE_PREFIX,
	type StructureSearchDetails,
	type StructureSearchRenderArgs,
} from "./structure-search";

/** What every card of this tool is titled. */
const STRUCTURE_SEARCH_TITLE = "Search structure";

/** The tool's own mark, which a settled card is titled by instead of an outcome icon. */
const STRUCTURE_SEARCH_EMBLEM = "icon.search";

/** The unit every held-back count on this card is in, which the host words. */
const MATCH_NOUN = { one: "match", many: "matches" } as const;

/** The prefix of the group the tool writes when it stopped at its match cap, which is not a match. */
const PARSE_ISSUES_PREFIX = "Parse issues:";

/** The row a meta value lands on, which reads as an aside rather than as matched source. */
const META_ROW_PREFIX = "  meta:";

/** The result the card reads, which is the tool's own result shape narrowed to what a card shows. */
export interface StructureSearchViewResult {
	content?: Array<{ type: string; text?: string }>;
	details?: StructureSearchDetails;
	isError?: boolean;
}

/** One line of the tool's output, kept beside the raw text the budget classifies it by. */
interface MatchRow {
	raw: string;
	spans: ViewLine;
}

/** The head row of every card of this tool: the pattern the model asked for is the description. */
function header(
	description: string | undefined,
	options: { status?: StatusRowView["status"]; emblem?: string; meta: readonly ViewLine[] },
): StatusRowView {
	return {
		kind: "statusRow",
		...(options.status === undefined ? {} : { status: options.status }),
		...(options.emblem === undefined ? {} : { emblem: options.emblem, emblemTone: "accent" as const }),
		title: STRUCTURE_SEARCH_TITLE,
		...(description === undefined ? {} : { description }),
		meta: options.meta,
	};
}

/** The empty answer, which is a warning mark and the words that say what was searched for nothing. */
function emptyLine(label: string): ViewLine {
	return [{ text: "", symbol: "status.warning", tone: "warning" }, { text: " " }, { text: label, tone: "muted" }];
}

/**
 * Every line of the output as the row a reader follows.
 *
 * Classification is over the whole output rather than per group, because a nested directory stack
 * only reconstructs across the blank lines that separate the groups: a group that starts at depth
 * two states its own leaf and learns the directories above it from the groups before it.
 */
function matchRows(lines: readonly string[], details: StructureSearchDetails | undefined): MatchRow[] {
	const contexts = classifyGroupedLines(lines, details?.cwd ?? details?.searchPath, details?.searchPath);
	return lines.map((line, index) => {
		const context = contexts[index]!;
		const text = replaceTabs(line);
		if (context.kind === "dir") {
			return {
				raw: line,
				spans: [
					{ text, tone: "accent", ...(context.headerPath === undefined ? {} : { file: context.headerPath }) },
				],
			};
		}
		if (context.kind === "file") {
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
		// A meta row is what the match CARRIES rather than the source it matched, so it reads as an
		// aside instead of as another line of code.
		return { raw: line, spans: [{ text, tone: line.startsWith(META_ROW_PREFIX) ? "dim" : "output" }] };
	});
}

/**
 * The groups the card is about, which are the matches and neither of the notices around them.
 *
 * The tool writes its match-limit line and its parse-issue list into the same output as the matches,
 * separated by the same blank line, so both arrive as groups. The card states each of them in its own
 * words instead, and a group that is one of them is not a match to be counted or budgeted.
 */
function matchGroups(lines: readonly string[], rows: readonly MatchRow[]): (readonly MatchRow[])[] {
	return groupLineIndicesByBlank(lines)
		.filter(indices => {
			const first = lines[indices[0]!]!;
			return !first.startsWith(MATCH_LIMIT_NOTICE_PREFIX) && !first.startsWith(PARSE_ISSUES_PREFIX);
		})
		.map(indices => indices.map(index => rows[index]!));
}

/** The rows a card shows and the count it kept back, for a body that is groups rather than lines. */
interface BudgetedBody {
	lines: ViewLine[];
	hidden?: ViewHiddenCount;
}

/**
 * The groups that fit, and how many fell outside.
 *
 * A group is taken WHOLE or not at all: it is a header and the nodes matched under it, so a group cut
 * at the row the budget runs out on would name a file and show part of what was found in it. One row
 * of the budget is reserved for the held-back note whenever a group follows, because the note is a row
 * of the card like any other. Reserving it up front is what makes the note always fit, so a card that
 * held anything back always says so — including a card whose first group is wider than the whole
 * budget, which is the note alone.
 */
function budgetedBody(groups: readonly (readonly MatchRow[])[], maxLines: number): BudgetedBody {
	if (groups.length === 0 || maxLines <= 0) return { lines: [] };

	let fitting = groups.length;
	let fittedRows = 0;
	for (let index = 0; index < groups.length; index++) {
		const rows = groups[index]!.length;
		const reserved = index + 1 < groups.length ? 1 : 0;
		if (fittedRows + rows + reserved > maxLines) {
			fitting = index;
			break;
		}
		fittedRows += rows;
		fitting = index + 1;
	}

	const lines: ViewLine[] = [];
	for (const group of groups.slice(0, fitting)) {
		lines.push(group[0]!.spans);
		// A group's own rows sit two columns in under the header that opened it, which is what says
		// the matched nodes belong to that file and not to the card.
		for (let row = 1; row < group.length; row++) lines.push([{ text: "  " }, ...group[row]!.spans]);
	}

	const remaining = groups.length - fitting;
	return remaining > 0 ? { lines, hidden: { count: remaining, noun: MATCH_NOUN, revealable: true } } : { lines };
}

/**
 * The rows that follow the matches: why the search stopped, and what it could not parse.
 *
 * Their own section rather than more lines of the first one, so the count the card kept back stays
 * with the groups it was taken from instead of landing under a warning about something else.
 */
function noteSection(details: StructureSearchDetails | undefined): ViewSection | undefined {
	const lines: ViewLine[] = [];
	if (details?.limitReached === true) {
		lines.push([{ text: "limit reached; page with skip or narrow path", tone: "warning" }]);
	}
	const parseErrors = details?.parseErrors ?? [];
	if (parseErrors.length > 0) {
		lines.push([{ text: formatParseErrorsCountLabel(parseErrors, details?.parseErrorsTotal), tone: "warning" }]);
	}
	return lines.length === 0 ? undefined : { lines, clip: true };
}

/**
 * What the query could not be parsed against, listed under the empty answer.
 *
 * Only an empty result lists them: a card with matches has rows to show and states the count instead,
 * because a query that matched somewhere is not mis-scoped for the files it could not parse.
 */
function parseErrorLines(details: StructureSearchDetails | undefined): ViewLine[] {
	const parseErrors = details?.parseErrors ?? [];
	if (parseErrors.length === 0) return [];
	const total = details?.parseErrorsTotal ?? parseErrors.length;
	const shown = parseErrors.slice(0, PARSE_ERRORS_LIMIT);
	const lines: ViewLine[] = [
		[{ text: "Query may be mis-scoped; narrow `path` before concluding absence", tone: "warning" }],
	];
	// The indent is a span of its own rather than part of the toned text, so a host that paints tone as
	// a colour run opens it at the first character of the sentence.
	for (const error of shown) lines.push([{ text: "  " }, { text: `- ${error}`, tone: "warning" }]);
	if (total > shown.length) lines.push([{ text: "  " }, { text: `… ${total - shown.length} more`, tone: "dim" }]);
	return lines;
}

export const structureSearchToolView: Required<ToolViewRenderer<StructureSearchRenderArgs, StructureSearchViewResult>> =
	{
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
			if (args?.skip !== undefined && args.skip > 0) meta.push([{ text: `skip:${args.skip}` }]);
			return {
				kind: "statusRow",
				status: "pending",
				title: STRUCTURE_SEARCH_TITLE,
				description: args?.input || "?",
				meta,
			};
		},

		renderResult(result, context: ToolViewContext, args): ToolView {
			const details = result.details;

			if (result.isError === true) {
				const text = result.content?.find(part => part.type === "text")?.text;
				return {
					kind: "textBlock",
					spans: [
						{ text: "", symbol: "status.error", tone: "error" },
						{ text: " " },
						{
							text: `Error: ${sanitizeErrorText(text === undefined || text === "" ? "Unknown error" : text)}`,
							tone: "error",
						},
					],
				};
			}

			const matchCount = details?.matchCount ?? 0;
			const filesSearched = details?.filesSearched ?? 0;
			const limitReached = details?.limitReached ?? false;

			if (matchCount === 0) {
				const meta: ViewLine[] = [[{ text: "0 matches" }]];
				if (details?.scopePath !== undefined && details.scopePath !== "") {
					meta.push([{ text: `in ${details.scopePath}` }]);
				}
				if (filesSearched > 0) meta.push([{ text: `searched ${filesSearched}` }]);
				return {
					kind: "headedBlock",
					header: header(args?.input, { status: "warning", meta }),
					lines: [emptyLine("No matches found"), ...parseErrorLines(details)],
				};
			}

			const meta: ViewLine[] = [
				[{ text: formatCount("match", matchCount) }],
				[{ text: formatCount("file", details?.fileCount ?? 0) }],
			];
			if (details?.scopePath !== undefined && details.scopePath !== "") {
				meta.push([{ text: `in ${details.scopePath}` }]);
			}
			meta.push([{ text: `searched ${filesSearched}` }]);
			if (limitReached) meta.push([{ text: "limit reached", tone: "warning" }]);

			const text = details?.displayContent ?? result.content?.find(part => part.type === "text")?.text ?? "";
			const lines = text.split("\n");
			const groups = matchGroups(lines, matchRows(lines, details));
			const notes = noteSection(details);

			// The notes are rows of the card, so they are taken out of the budget before the groups are
			// measured against it: a group that only fits once the warning is dropped does not fit.
			const budget = Math.max(
				(context.expanded ? Number.POSITIVE_INFINITY : COLLAPSED_MATCH_LIMIT) - (notes?.lines.length ?? 0),
				0,
			);
			const body = budgetedBody(groups, budget);
			const rows: ViewSection = {
				lines: body.lines,
				clip: true,
				...(body.hidden === undefined ? {} : { hidden: body.hidden }),
			};

			return {
				kind: "framedBlock",
				header: header(args?.input, {
					...(limitReached ? { status: "warning" as const } : { emblem: STRUCTURE_SEARCH_EMBLEM }),
					meta,
				}),
				state: limitReached ? "warning" : "success",
				sections: notes === undefined ? [rows] : [rows, notes],
			};
		},
	};
