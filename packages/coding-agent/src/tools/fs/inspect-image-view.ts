/**
 * What the inspect_image card shows, for any host.
 *
 * The tool half in `inspect-image.ts` asks a vision model about a file; this half states what the
 * card says about the answer and names no colour, no glyph and no width. The answer is content the
 * model wrote rather than a verdict the tool reached, so the settled card is a panel of data: a host
 * states the outcome on its edge and leaves the prose on the terminal's ordinary ground.
 *
 * A card with nothing to show is a row, not an empty panel: a call still running, and a result whose
 * model returned no text, are both one line, and the model and the image's type ride on that row as
 * metadata rather than as a body the panel would have to frame.
 */

import type { FramedBlockView, StatusRowView, ToolView, ToolViewRenderer, ViewLine, ViewSection } from "@veyyon/view";
import { replaceTabs, sanitizeErrorText, shortenPath, truncateToWidth } from "../core/render-utils";
import type { InspectImageToolDetails } from "./inspect-image";

/** The arguments the card reads off an inspect_image call, which is any subset the model has sent. */
export interface InspectImageViewArgs {
	path?: string;
	question?: string;
}

/** The result the card reads, which is the tool's own result shape narrowed to what a card shows. */
export interface InspectImageViewResult {
	content: Array<{ type: string; text?: string }>;
	details?: InspectImageToolDetails;
	isError?: boolean;
}

/** The emblem a settled inspect card is titled by, instead of a success tick. */
const INSPECT_EMBLEM = "tool.inspectImage";

/** Columns the question keeps on the card, which is a budget rather than a width. */
const QUESTION_PREVIEW_WIDTH = 100;

/** Lines of the answer shown before the card says how many it held back, at each disclosure state. */
const ANSWER_LIMITS = { collapsed: 4, expanded: 16 } as const;

/** Columns one line of the answer keeps, so a model that writes a paragraph per line still lays out. */
const ANSWER_LINE_WIDTH = 120;

/** The question the card was asked, which introduces the answer under it. */
function questionLine(question: string): ViewLine {
	return [
		{ text: "Question:", tone: "dim" },
		{ text: " " },
		{ text: truncateToWidth(replaceTabs(question), QUESTION_PREVIEW_WIDTH), tone: "accent" },
	];
}

/** The question as its own line, or nothing, for a card that may have been given none. */
function questionLines(question: string): ViewLine[] {
	return question ? [questionLine(question)] : [];
}

/** The image a card is about, shortened for a reader, or the placeholder a card with no path shows. */
function describeImage(raw: string | undefined, missing: string): string {
	return typeof raw === "string" && raw !== "" ? shortenPath(raw) : missing;
}

/** What the request was answered by and what it read, which is detail the row carries rather than states. */
function requestMeta(details: InspectImageToolDetails | undefined): readonly ViewLine[] | undefined {
	const entries: ViewLine[] = [];
	if (details?.model) entries.push([{ text: details.model }]);
	if (details?.mimeType) entries.push([{ text: details.mimeType }]);
	return entries.length > 0 ? entries : undefined;
}

/** The head of the model's answer, and how much of it the card is not showing. */
function answerSection(question: string, answer: string, expanded: boolean): ViewSection {
	const answerLines = replaceTabs(answer).split("\n");
	const limit = expanded ? ANSWER_LIMITS.expanded : ANSWER_LIMITS.collapsed;
	const shown = answerLines
		.slice(0, limit)
		.map((line): ViewLine => [{ text: truncateToWidth(line, ANSWER_LINE_WIDTH), tone: "output" }]);
	const remaining = answerLines.length - shown.length;
	// A blank line after the question, so the answer reads as an answer rather than as more of it.
	const lines = question ? [questionLine(question), [], ...shown] : shown;
	return {
		lines,
		hidden:
			remaining > 0 ? { count: remaining, noun: { one: "line", many: "lines" }, revealable: !expanded } : undefined,
	};
}

/**
 * The card a failed inspection shows, which is what went wrong and the question that led to it.
 *
 * The failure text is the tool's own, shortened and cut by the shared sanitiser rather than by this
 * card, and indented two columns so it sits under the title the header already carries. The body is
 * the tool's report of what happened, so the state stays on the rail and the rows keep the
 * terminal's ground.
 */
function failureCard(question: string, pathDisplay: string, text: string): FramedBlockView {
	return {
		kind: "framedBlock",
		header: { kind: "statusRow", status: "error", title: "Inspect", description: pathDisplay },
		state: "error",
		contents: "data",
		sections: [
			{
				lines: [
					...questionLines(question),
					[{ text: "  " }, { text: sanitizeErrorText(text || "inspection failed"), tone: "error" }],
				],
			},
		],
	};
}

/**
 * How inspect_image describes its call and its result.
 *
 * The answer's text is the tool's own content block, trimmed of the trailing blank lines a model
 * ends on, since a card that framed them would frame empty rows.
 */
export const inspectImageToolView: Required<ToolViewRenderer<InspectImageViewArgs, InspectImageViewResult>> = {
	renderCall(args): ToolView {
		const header: StatusRowView = {
			kind: "statusRow",
			status: "pending",
			title: "Inspect",
			description: describeImage(args.path, "…"),
		};
		const question = typeof args.question === "string" ? args.question.trim() : "";
		if (!question) return header;
		return { kind: "headedBlock", header, lines: [questionLine(question)] };
	},

	renderResult(result, context, args): ToolView {
		const details = result.details;
		const pathDisplay = describeImage(details?.imagePath ?? args?.path, "image");
		const question = typeof args?.question === "string" ? args.question.trim() : "";
		const answer = result.content.find(block => block.type === "text")?.text?.trimEnd() ?? "";

		if (result.isError) return failureCard(question, pathDisplay, answer);

		const header: StatusRowView = {
			kind: "statusRow",
			emblem: INSPECT_EMBLEM,
			status: "success",
			title: "Inspect",
			description: pathDisplay,
			meta: requestMeta(details),
		};
		// Nothing to frame: the row already carries the model and the type, and a panel around no
		// answer is a rail beside an empty column.
		if (!answer) return header;

		return {
			kind: "framedBlock",
			header,
			state: "success",
			// The body is what the model wrote, not a verdict on it.
			contents: "data",
			sections: [answerSection(question, answer, context.expanded)],
		};
	},
};
