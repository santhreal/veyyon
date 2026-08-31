/**
 * What the three long-term memory tools show, for any host.
 *
 * The cards stay terse on purpose: one row, and under it the memories a call stored or the answer a
 * reflection produced, with the rest held back until the reader asks. That shape is a headed block,
 * so this module states the rows and the counts and names no colour, glyph, width or component. The
 * terminal draws them through `drawToolView`; a second host draws the same values its own way.
 */

import { truncateToWidth } from "@veyyon/utils/width";
import { replaceTabs } from "@veyyon/utils/wrap";
import type { HeadedBlockView, StatusRowView, TextBlockView, ToolViewRenderer, ViewLine } from "@veyyon/view";
import { PREVIEW_LIMITS, sanitizeErrorText } from "../core/render-utils";

/** The bullet a stored memory is marked with, resolved by the host from its own glyph table. */
const BULLET = "format.bullet";

/** The emblem a settled memory card is titled by, instead of an outcome icon. */
const MEMORY_EMBLEM = "tool.memory";

/** How wide a recalled or reflected query may print before it is cut. */
const QUERY_WIDTH = 80;

/** A tool result's text content, trimmed, or the empty string when it carries none. */
export function memoryResultText(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (result.content?.find(part => part.type === "text")?.text ?? "").trim();
}

/**
 * The row a `recall` or a `reflect` shows, which is the query it was given.
 *
 * The query is the model's own text, so it arrives with tabs in it and at any length: it is
 * de-tabbed and cut to a fixed column budget here rather than to a width, because a view is never
 * told how wide the surface is.
 */
export function memoryQueryRow(
	title: string,
	query: string | undefined,
	row: Pick<StatusRowView, "status" | "emblem" | "meta">,
): StatusRowView {
	const trimmed = replaceTabs((query ?? "").trim());
	return {
		kind: "statusRow",
		title,
		description: trimmed ? truncateToWidth(trimmed, QUERY_WIDTH) : undefined,
		...row,
	};
}

/** The memories a `retain` call is storing, in the order it stores them, blank entries dropped. */
export function retainedContents(
	args: { items?: Array<{ content?: string; context?: string }> } | undefined,
): string[] {
	return (args?.items ?? []).map(item => replaceTabs((item?.content ?? "").trim())).filter(line => line.length > 0);
}

/** The row a `retain` shows while it is still storing: the tool's title and nothing settled yet. */
export function retainPendingRow(): StatusRowView {
	return { kind: "statusRow", status: "pending", title: "Retain" };
}

/** The row a settled `retain` shows: the tool's emblem, and the count the call reported as metadata. */
export function retainRow(summary: string): StatusRowView {
	return {
		kind: "statusRow",
		emblem: MEMORY_EMBLEM,
		title: "Retain",
		...(summary ? { meta: [{ text: summary }] } : {}),
	};
}

/**
 * The `retain` card: the row, then one line per memory, then what a collapsed card held back.
 *
 * The remainder is counted in memories rather than in lines, since the card's lines ARE the items: a
 * reader told "3 more lines" would be counting the wrong thing.
 */
export function retainBlock(contents: readonly string[], header: StatusRowView, expanded: boolean): HeadedBlockView {
	const shown = expanded ? contents : contents.slice(0, PREVIEW_LIMITS.COLLAPSED_ITEMS);
	const lines: ViewLine[] = shown.map(content => [
		{ symbol: BULLET, text: "•", tone: "muted" as const },
		{ text: " " },
		{ text: content, tone: "output" as const },
	]);
	const remaining = contents.length - shown.length;
	return {
		kind: "headedBlock",
		header,
		lines,
		...(remaining > 0 ? { hidden: { count: remaining, revealable: !expanded } } : {}),
	};
}

/**
 * The `recall` card, which is the row alone until the reader opens it.
 *
 * A recall answers with every matching memory, which is a wall of text in a transcript that is
 * mostly other things, so the body is held back rather than previewed: collapsed states that there
 * is something to open, expanded shows the memories up to the body cap.
 */
export function recallBlock(header: StatusRowView, body: string, expanded: boolean): HeadedBlockView {
	if (!expanded) {
		return { kind: "headedBlock", header, lines: [], hidden: { count: 0, revealable: true } };
	}
	const lines: ViewLine[] = body
		.split("\n")
		.slice(0, PREVIEW_LIMITS.OUTPUT_EXPANDED)
		.map(line => [{ text: replaceTabs(line), tone: "muted" as const }]);
	return { kind: "headedBlock", header, lines };
}

/** The `reflect` card: the row, then the answer, cut to the preview the disclosure state allows. */
export function reflectBlock(header: StatusRowView, answer: string, expanded: boolean): HeadedBlockView {
	const answerLines = answer.split("\n").filter(line => line.trim().length > 0);
	const limit = expanded ? PREVIEW_LIMITS.OUTPUT_EXPANDED : PREVIEW_LIMITS.OUTPUT_COLLAPSED;
	const shown = answerLines.slice(0, limit);
	const remaining = answerLines.length - shown.length;
	return {
		kind: "headedBlock",
		header,
		lines: shown.map(line => [{ text: replaceTabs(line), tone: "output" as const }]),
		...(remaining > 0
			? { hidden: { count: remaining, noun: { one: "line", many: "lines" }, revealable: !expanded } }
			: {}),
	};
}

/**
 * The card a failed memory call shows, which is the failure the tool reported.
 *
 * A failure is one line and carries no body, so it is a text block rather than a headed one: there
 * is nothing under the row to hold back. The mark is a symbol key, so the host draws the error glyph
 * it has rather than the one this module would have to name.
 */
export function memoryFailure(
	result: { content?: Array<{ type: string; text?: string }> },
	fallback: string,
): TextBlockView {
	return {
		kind: "textBlock",
		spans: [
			{ symbol: "status.error", text: "", tone: "error" },
			{ text: " " },
			{ text: `Error: ${sanitizeErrorText(memoryResultText(result) || fallback)}`, tone: "error" },
		],
	};
}

/** What a memory card reads off a call, which is partial while the arguments are still streaming. */
export interface RetainViewArgs {
	items?: Array<{ content?: string; context?: string }>;
}

/** What the two reading memory tools show of a call: the query, when it has arrived. */
export interface MemoryQueryViewArgs {
	query?: string;
}

/**
 * The half of a tool result a memory card reads.
 *
 * Text and the failure flag, and nothing else: a memory card states its count from the sentence the
 * tool wrote, so declaring `details` here would bind every memory tool's result type to a member no
 * card reads.
 */
export interface MemoryViewResult {
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
}

/** How many memories a settled `recall` found, read off the sentence the tool wrote. */
function recalledCount(text: string): number {
	const match = text.match(/^Found (\d+) relevant/);
	return match ? Number(match[1]) : 0;
}

export const retainToolView: Required<ToolViewRenderer<RetainViewArgs, MemoryViewResult>> = {
	renderCall: (args, context) => retainBlock(retainedContents(args), retainPendingRow(), context.expanded),
	renderResult: (result, context, args) => {
		if (result.isError) return memoryFailure(result, "Retain failed");
		// The tool's own "N memories stored." sentence, without the full stop, so it reads as the
		// trailing detail of a row rather than as a sentence someone left in a table cell.
		const summary = memoryResultText(result).replace(/\.$/, "");
		return retainBlock(retainedContents(args), retainRow(summary), context.expanded);
	},
};

export const recallToolView: Required<ToolViewRenderer<MemoryQueryViewArgs, MemoryViewResult>> = {
	renderCall: (args, _context) => memoryQueryRow("Recall", args?.query, { status: "pending" }),
	renderResult: (result, context, args) => {
		if (result.isError) return memoryFailure(result, "Recall failed");
		const text = memoryResultText(result);
		const found = recalledCount(text);
		const meta = [{ text: found > 0 ? `${found} found` : "no matches" }];
		if (found === 0) return memoryQueryRow("Recall", args?.query, { status: "warning", meta });
		const header = memoryQueryRow("Recall", args?.query, { status: "success", emblem: MEMORY_EMBLEM, meta });
		return recallBlock(header, text.replace(/^[^\n]*\n+/, ""), context.expanded);
	},
};

export const reflectToolView: Required<ToolViewRenderer<MemoryQueryViewArgs, MemoryViewResult>> = {
	renderCall: (args, _context) => memoryQueryRow("Reflect", args?.query, { status: "pending" }),
	renderResult: (result, context, args) => {
		if (result.isError) return memoryFailure(result, "Reflect failed");
		const header = memoryQueryRow("Reflect", args?.query, { status: "success", emblem: MEMORY_EMBLEM });
		return reflectBlock(header, memoryResultText(result), context.expanded);
	},
};
