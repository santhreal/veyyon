/**
 * What the ast_edit card shows, for any host.
 *
 * The tool half in `ast-edit.ts` decides which rewrites matched and what the edited text looks
 * like; this half states what the card says about them and names no colour, no glyph and no width.
 * The change groups are lines with tones and the files they came from, so a terminal draws them
 * under a rail and hyperlinks each header, and a host with an editor opens the file instead.
 */

import { collapseWhitespace } from "@veyyon/utils";
import { replaceTabs } from "@veyyon/utils/wrap";
import type {
	FramedBlockView,
	StatusRowView,
	ToolView,
	ToolViewContext,
	ToolViewRenderer,
	ViewLine,
	ViewSpan,
} from "@veyyon/view";
import { classifyGroupedLines, groupLineIndicesByBlank } from "../core/grouped-file-output";
import {
	formatCount,
	formatParseErrorsCountLabel,
	formatScopeMeta,
	PARSE_ERRORS_LIMIT,
	PREVIEW_LIMITS,
	sanitizeErrorText,
} from "../core/render-utils";
import type { AstEditToolDetails } from "./ast-edit";

/** What every card of this tool is titled. */
const AST_EDIT_TITLE = "AST Edit";

/** Rows of change a collapsed card spends before it says how many groups it kept back. */
const COLLAPSED_CHANGE_LIMIT = PREVIEW_LIMITS.COLLAPSED_LINES * 2;

/** The unit the held-back count is in, which the host words. */
const CHANGE_NOUN = { one: "change", many: "changes" } as const;

/** The arguments the card reads off the call, which are the two the model sends. */
export interface AstEditViewArgs {
	ops?: Array<{ pat?: string; out?: string }>;
	paths?: string[];
}

/** The result the card reads, which is the tool's own result shape narrowed to what a card shows. */
export interface AstEditViewResult {
	content: Array<{ type: string; text?: string }>;
	details?: AstEditToolDetails;
	isError?: boolean;
}

/**
 * One line of a pattern, for the row that heads the card.
 *
 * A pattern is source text, so it arrives with newlines and tab indentation in it; a row states one
 * line, and every host has to cut it somewhere, so the whitespace runs are one space here rather
 * than a column of tabs the host has to decide the width of.
 */
function patternPreview(pat: string | undefined): string | undefined {
	const collapsed = collapseWhitespace(pat);
	return collapsed || undefined;
}

/** How the row describes the call: the pattern when there is one, the count when there are several. */
function describeOps(ops: AstEditViewArgs["ops"], fallback: string | undefined): string | undefined {
	const count = ops?.length ?? 0;
	if (count === 1) return patternPreview(ops?.[0]?.pat);
	return count > 1 ? `${count} rewrites` : fallback;
}

/**
 * The edited text as lines a host can draw, each toned by what it is.
 *
 * The tool wrote the text as a directory tree with a code frame under each file, so the classifier
 * says which lines are headers and what file each names, and the card states that file on the span
 * rather than an escape sequence pointing at it. The frame's own `│` gutter becomes a space: a host
 * that draws the card inside a rail would otherwise nest a second vertical bar inside the first.
 */
function changeLines(details: AstEditToolDetails | undefined, text: string): ViewLine[] {
	const lines = text.split("\n");
	const contexts = classifyGroupedLines(lines, details?.cwd ?? details?.searchPath, details?.searchPath);
	return lines.map((line, index) => {
		const context = contexts[index]!;
		const display = replaceTabs(line.replace("│", " "));
		if (context.kind === "dir" || context.kind === "file") {
			const tone = context.kind === "dir" || context.depth === 1 ? "accent" : "dim";
			const span: ViewSpan = { text: display, tone };
			return [context.headerPath === undefined ? span : { ...span, file: context.headerPath }];
		}
		if (display.startsWith("+")) return [{ text: display, tone: "diffAdded" }];
		if (display.startsWith("-")) return [{ text: display, tone: "diffRemoved" }];
		return [{ text: display, tone: "output" }];
	});
}

/**
 * The change groups a card shows, and the number it held back.
 *
 * A group is one file's frame, separated from the next by a blank row, and the first is always
 * shown: a collapsed card that says "3 more changes" and shows none of them states nothing. The row
 * the host spends on the held-back note is reserved here, so a collapsed card occupies the rows it
 * did before the host started writing that note.
 */
function budgetedGroups(
	groups: ViewLine[][],
	expanded: boolean,
	budget: number,
): { lines: ViewLine[]; held: number } {
	const lines: ViewLine[] = [];
	let shown = 0;
	for (let i = 0; i < groups.length; i++) {
		const group = groups[i]!;
		const separator = shown > 0 ? 1 : 0;
		const remainingAfter = groups.length - (i + 1);
		const reserved = !expanded && remainingAfter > 0 ? 1 : 0;
		if (!expanded && shown > 0 && lines.length + separator + group.length + reserved > budget) break;
		if (separator) lines.push([]);
		lines.push(...group);
		shown++;
	}
	while (lines.length > 0 && lines[0]!.every(span => span.text.trim() === "")) lines.shift();
	return { lines, held: expanded ? 0 : groups.length - shown };
}

/** The parse issues a card lists under a result that changed nothing, capped and counted. */
function parseErrorLines(parseErrors: readonly string[], total: number | undefined): ViewLine[] {
	const fullCount = total ?? parseErrors.length;
	const capped = parseErrors.slice(0, PARSE_ERRORS_LIMIT);
	const lines: ViewLine[] = capped.map(error => [{ text: `  - ${error}`, tone: "warning" as const }]);
	if (fullCount > capped.length) {
		lines.push([{ text: `  … ${fullCount - capped.length} more`, tone: "dim" }]);
	}
	return lines;
}

/** The row a settled card is headed by when the edit replaced nothing. */
function emptyHeader(details: AstEditToolDetails | undefined, args: AstEditViewArgs | undefined): StatusRowView {
	const meta: ViewLine[] = [[{ text: "0 replacements" }]];
	if (details?.scopePath) meta.push([{ text: formatScopeMeta(details.scopePath) }]);
	const searched = details?.filesSearched ?? 0;
	if (searched > 0) meta.push([{ text: `searched ${searched}` }]);
	return {
		kind: "statusRow",
		status: "warning",
		title: AST_EDIT_TITLE,
		description: describeOps(args?.ops, undefined),
		meta,
	};
}

/** The row a settled card is headed by when the edit proposed replacements. */
function resultHeader(details: AstEditToolDetails, args: AstEditViewArgs | undefined): StatusRowView {
	const meta: ViewLine[] = [
		[{ text: formatCount("replacement", details.totalReplacements) }],
		[{ text: formatCount("file", details.filesTouched) }],
	];
	if (details.scopePath) meta.push([{ text: formatScopeMeta(details.scopePath) }]);
	meta.push([{ text: `searched ${details.filesSearched}` }]);
	if (details.limitReached) meta.push([{ text: "limit reached", tone: "warning" }]);
	return {
		kind: "statusRow",
		status: details.limitReached ? "warning" : "success",
		title: AST_EDIT_TITLE,
		description: describeOps(args?.ops, undefined),
		badge: { label: "proposed", tone: "warning" },
		meta,
	};
}

/** What the card says beside the changes: that the edit stopped at a cap, and what would not parse. */
function asideLines(details: AstEditToolDetails): ViewLine[] {
	const lines: ViewLine[] = [];
	if (details.limitReached) lines.push([{ text: "limit reached; narrow path", tone: "warning" }]);
	if (details.parseErrors?.length) {
		lines.push([
			{ text: formatParseErrorsCountLabel(details.parseErrors, details.parseErrorsTotal), tone: "warning" },
		]);
	}
	return lines;
}

export const astEditToolView: Required<ToolViewRenderer<AstEditViewArgs, AstEditViewResult>> = {
	renderCall(args): StatusRowView {
		const meta: ViewLine[] = [];
		if (args.paths?.length) meta.push([{ text: formatScopeMeta(args.paths) }]);
		const rewriteCount = args.ops?.length ?? 0;
		if (rewriteCount > 1) meta.push([{ text: `${rewriteCount} rewrites` }]);
		return {
			kind: "statusRow",
			status: "pending",
			title: AST_EDIT_TITLE,
			description: describeOps(args.ops, "?"),
			...(meta.length > 0 ? { meta } : {}),
		};
	},

	renderResult(result, context: ToolViewContext, args): ToolView {
		const details = result.details;
		const text = result.content?.find(part => part.type === "text")?.text;

		if (result.isError) {
			return {
				kind: "framedBlock",
				header: { kind: "statusRow", status: "error", title: AST_EDIT_TITLE },
				state: "error",
				// The two leading spaces are the indent `formatErrorDetail` wrote. Each line carries the
				// tone of its own, where the string form coloured the block once and left every line
				// after the first uncoloured.
				sections: [
					{
						lines: sanitizeErrorText(text || "Unknown error")
							.split("\n")
							.map(line => [{ text: "  " }, { text: line, tone: "error" as const }]),
					},
				],
			};
		}

		if ((details?.totalReplacements ?? 0) === 0) {
			const header = emptyHeader(details, args);
			// The count already rides on the row, so only parse issues are worth a frame around it.
			if (!details?.parseErrors?.length) return header;
			return {
				kind: "framedBlock",
				header,
				state: "warning",
				sections: [{ lines: parseErrorLines(details.parseErrors, details.parseErrorsTotal) }],
			};
		}

		// The display text, not the model's: the two say the same thing, and only the display half
		// carries the frame gutter a reader sees rather than the hashline anchors a model edits by.
		const body = details?.displayContent ?? text ?? "";
		const lines = body.split("\n");
		const drawn = changeLines(details, body);
		const groups = groupLineIndicesByBlank(lines)
			.filter(indices => {
				const first = lines[indices[0]!]!;
				return !first.startsWith("Safety cap reached") && !first.startsWith("Parse issues:");
			})
			.map(indices => indices.map(index => drawn[index]!));
		const changes = budgetedGroups(groups, context.expanded, COLLAPSED_CHANGE_LIMIT);
		const asides = asideLines(details!);
		const card: FramedBlockView = {
			kind: "framedBlock",
			header: resultHeader(details!, args),
			state: context.partial ? "pending" : "success",
			sections: [
				...(changes.lines.length > 0 || changes.held > 0
					? [
							{
								lines: changes.lines,
								...(changes.held > 0
									? { hidden: { count: changes.held, noun: CHANGE_NOUN, revealable: true } }
									: {}),
							},
						]
					: []),
				...(asides.length > 0 ? [{ lines: asides }] : []),
			],
		};
		return card;
	},
};
