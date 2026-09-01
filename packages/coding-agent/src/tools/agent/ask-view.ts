/**
 * What the `ask` card shows, for any host.
 *
 * The tool half in `ask.ts` decides what was asked and what was answered; this half states the card
 * as a `ToolView` and names no colour, glyph or component. A question is the one card whose body is
 * somebody's own words: the question is Markdown a reader wrote, and so is the label of every choice
 * offered under it, so both are stated as Markdown the host renders rather than as text a tool
 * toned.
 */

import { replaceTabs } from "@veyyon/utils/wrap";
import type { StatusRowView, ToolView, ToolViewContext, ViewLine, ViewSection } from "@veyyon/view";
import type { AskToolDetails, QuestionResult } from "./ask";

/** One choice offered by a call, as the streamed arguments carry it. */
interface AskRenderOption {
	label: string;
	description?: string;
}

export interface AskRenderArgs {
	question?: string;
	options?: AskRenderOption[];
	multi?: boolean;
	questions?: Array<{
		id: string;
		question: string;
		options: AskRenderOption[];
		multi?: boolean;
	}>;
}

export interface AskViewResult {
	content?: Array<{ type: string; text?: string }>;
	details?: AskToolDetails;
}

/** The glyph a card's own emblem names, for a settled answer. */
const ASK_EMBLEM = "tool.ask";

/**
 * Coerce an untrusted option list (streamed or model-mangled call args) into well-formed render
 * options. Bare strings become labels; entries without a string label are dropped.
 */
function normalizeRenderOptions(raw: unknown): AskRenderOption[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: AskRenderOption[] = [];
	for (const entry of raw) {
		if (typeof entry === "string") {
			out.push({ label: entry });
			continue;
		}
		if (!entry || typeof entry !== "object") continue;
		const { label, description } = entry as Partial<AskRenderOption>;
		if (typeof label !== "string") continue;
		out.push(typeof description === "string" ? { label, description } : { label });
	}
	return out;
}

/**
 * Coerce untrusted `questions` call args into a renderable array. Models occasionally double-encode
 * the array as a JSON string — a bare string passes a truthy `.length` check but has no `.map`,
 * which used to crash the render loop. Partially streamed args can also be missing fields.
 */
function normalizeRenderQuestions(raw: unknown): NonNullable<AskRenderArgs["questions"]> | undefined {
	if (typeof raw === "string") {
		try {
			raw = JSON.parse(raw);
		} catch {
			return undefined;
		}
	}
	if (!Array.isArray(raw)) return undefined;
	const out: NonNullable<AskRenderArgs["questions"]> = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const q = entry as Partial<NonNullable<AskRenderArgs["questions"]>[number]>;
		out.push({
			id: typeof q.id === "string" ? q.id : "?",
			question: typeof q.question === "string" ? q.question : "",
			options: normalizeRenderOptions(q.options) ?? [],
			multi: q.multi === true,
		});
	}
	return out;
}

/**
 * The mark a choice carries, as a registry key.
 *
 * A single-choice question is a radio and a multi-select one is a checkbox, which is the distinction
 * a reader answers by: pick one, or pick many. The text beside each key is what a host with no glyph
 * for it draws, and it says the same thing in characters.
 */
function optionMark(multi: boolean | undefined, selected: boolean): { symbol: string; text: string } {
	if (multi) {
		return selected ? { symbol: "checkbox.checked", text: "[x]" } : { symbol: "checkbox.unchecked", text: "[ ]" };
	}
	return selected ? { symbol: "radio.selected", text: "(*)" } : { symbol: "radio.unselected", text: "( )" };
}

/** The question itself: one document, toned as the subject of the card it heads. */
function questionSection(question: string, label?: string): ViewSection {
	return {
		...(label === undefined ? {} : { label }),
		markdown: true,
		lines: [[{ text: question, tone: "accent" }]],
	};
}

/** The label of one offered choice, and the note under it when the caller wrote one. */
function offeredOptionLines(options: readonly AskRenderOption[], multi: boolean | undefined): ViewLine[] {
	const lines: ViewLine[] = [];
	for (const option of options) {
		const mark = optionMark(multi, false);
		lines.push([
			{ symbol: mark.symbol, text: mark.text, tone: "dim" },
			{ text: " " },
			{ text: option.label, tone: "muted", markdown: true },
		]);
		const description = option.description?.trim();
		if (description) {
			lines.push([
				{ text: "  " },
				{ text: "↳", tone: "dim" },
				{ text: " " },
				{ text: description, tone: "dim", markdown: true },
			]);
		}
	}
	return lines;
}

/** A free-text answer, whose first row carries the mark and whose rest hangs under it. */
function customInputLines(customInput: string): ViewLine[] {
	const rows = customInput.split("\n");
	const lines: ViewLine[] = [
		[
			{ symbol: "status.success", text: "+", tone: "success" },
			{ text: " " },
			{ text: rows[0] ?? "", tone: "output" },
		],
	];
	for (let index = 1; index < rows.length; index++) {
		lines.push([{ text: "  " }, { text: rows[index] ?? "", tone: "output" }]);
	}
	return lines;
}

/** The note attached to an answer, whose continuation rows hang under the label. */
function noteLines(note: string): ViewLine[] {
	return replaceTabs(note)
		.split("\n")
		.map((line, index): ViewLine =>
			index === 0
				? [{ text: "Note:", tone: "dim" }, { text: " " }, { text: line, tone: "output" }]
				: [{ text: "      " }, { text: line, tone: "output" }],
		);
}

/**
 * The answers to one question: every offered choice with its mark filled in, then whatever the
 * reader wrote.
 *
 * A question that ended with nothing chosen is one warning row, because the offered list says
 * nothing about an answer nobody gave.
 */
function answerLines(result: {
	options?: readonly string[];
	selectedOptions?: readonly string[];
	multi?: boolean;
	customInput?: string;
	note?: string;
}): ViewLine[] {
	const selected = new Set(result.selectedOptions ?? []);
	// Prefer the full recorded option set; fall back to the selected labels when details omit the
	// options array.
	const list =
		result.options && result.options.length > 0 ? result.options : (result.selectedOptions ?? []);

	if (selected.size === 0 && result.customInput === undefined && result.note === undefined) {
		return [
			[
				{ symbol: "status.warning", text: "!", tone: "warning" },
				{ text: " " },
				{ text: "Cancelled", tone: "warning" },
			],
		];
	}

	const lines: ViewLine[] = [];
	for (const label of list) {
		const isSelected = selected.has(label);
		const mark = optionMark(result.multi, isSelected);
		lines.push([
			{ symbol: mark.symbol, text: mark.text, tone: isSelected ? "success" : "dim" },
			{ text: " " },
			{ text: label, tone: isSelected ? "output" : "muted", markdown: true },
		]);
	}
	if (result.customInput !== undefined) lines.push(...customInputLines(result.customInput));
	if (result.note !== undefined) lines.push(...noteLines(result.note));
	return lines;
}

/** What a question form states about itself beside its id: how many choices, and how many it takes. */
function questionMetaParts(multi: boolean | undefined, optionCount: number): string[] {
	const parts: string[] = [];
	if (multi) parts.push("multi");
	if (optionCount > 0) parts.push(`options:${optionCount}`);
	return parts;
}

/**
 * The sections one question of a form occupies: the question, then the choices it offers.
 *
 * A question of a FORM carries an id, which is its section's label; the single question a call asks
 * on its own has none, so its section is unlabelled and the id is stated by the caller rather than
 * defaulted here.
 */
function offeredSections(
	question: { question: string; options: readonly AskRenderOption[]; multi?: boolean },
	id?: string,
): ViewSection[] {
	const meta = questionMetaParts(question.multi, question.options.length);
	const label = id === undefined ? undefined : `[${id}]${meta.length === 0 ? "" : ` · ${meta.join(" · ")}`}`;
	const sections: ViewSection[] = [questionSection(question.question, label)];
	if (question.options.length > 0) sections.push({ lines: offeredOptionLines(question.options, question.multi) });
	return sections;
}

/** The sections one answered question occupies: the question, then what came back. */
function answeredSections(result: QuestionResult, labelled: boolean): ViewSection[] {
	return [
		questionSection(result.question, labelled ? `[${result.id}]` : undefined),
		{ lines: answerLines(result) },
	];
}

/** Whether anything at all came back for a question: a choice, a written answer, or a note. */
function answered(result: {
	selectedOptions?: readonly string[];
	customInput?: string;
	note?: string;
}): boolean {
	return (
		result.customInput !== undefined ||
		result.note !== undefined ||
		(result.selectedOptions !== undefined && result.selectedOptions.length > 0)
	);
}

/** The row a card with no answer to report shows, which is the tool's own message. */
function fallbackText(result: AskViewResult): string {
	const text = result.content?.find(part => part.type === "text")?.text;
	return text ?? "";
}

/** The question a reader is looking at, or the failure that there is none. */
function callView(args: AskRenderArgs): ToolView {
	const questions = normalizeRenderQuestions(args.questions);
	if (questions && questions.length > 0) {
		return {
			kind: "framedBlock",
			header: {
				kind: "statusRow",
				title: "Ask",
				titleTone: "title",
				meta: [[{ text: `${questions.length} questions` }]],
			},
			state: "pending",
			sections: questions.flatMap(question => offeredSections(question, question.id)),
		};
	}

	if (typeof args.question !== "string" || !args.question) {
		return {
			kind: "framedBlock",
			header: { kind: "statusRow", status: "error", title: "Error: No question provided", titleTone: "error" },
			state: "error",
			sections: [],
		};
	}

	const options = normalizeRenderOptions(args.options) ?? [];
	const meta = questionMetaParts(args.multi, options.length);
	return {
		kind: "framedBlock",
		header: {
			kind: "statusRow",
			title: "Ask",
			titleTone: "title",
			...(meta.length === 0 ? {} : { meta: meta.map(entry => [{ text: entry }]) }),
		},
		state: "pending",
		sections: offeredSections({ question: args.question, options, multi: args.multi }),
	};
}

/** What came back: an answer, a redirect to chat, or the tool's own message. */
function resultView(result: AskViewResult): ToolView {
	const details = result.details;
	if (!details) {
		const fallback = fallbackText(result);
		return {
			kind: "headedBlock",
			header: { kind: "statusRow", status: "warning", title: "Ask" },
			lines: fallback ? [[{ text: fallback, tone: "dim" }]] : [],
		};
	}

	// The reader chose to talk about the question instead of answering it, so the card states the
	// questions that were open rather than an answer that was never given.
	if (details.chatRedirect) {
		const questions = details.questions ?? [];
		return {
			kind: "framedBlock",
			header: {
				kind: "statusRow",
				status: "info",
				title: "Ask",
				meta: [[{ text: "chat redirect" }]],
			},
			state: "warning",
			sections: questions.map(question => questionSection(question)),
		};
	}

	if (details.results && details.results.length > 0) {
		const results = details.results;
		const any = results.some(answered);
		return {
			kind: "framedBlock",
			header: {
				kind: "statusRow",
				status: any ? "success" : "warning",
				title: "Ask",
				meta: [[{ text: `${results.length} questions` }]],
			},
			state: any ? "success" : "warning",
			sections: results.flatMap(entry => answeredSections(entry, true)),
		};
	}

	if (!details.question) {
		const fallback = fallbackText(result);
		return { kind: "textBlock", spans: fallback ? [{ text: fallback }] : [] };
	}

	const hasSelection = answered(details);
	const header: StatusRowView = hasSelection
		? { kind: "statusRow", emblem: ASK_EMBLEM, emblemTone: "accent", title: "Ask" }
		: { kind: "statusRow", status: "warning", title: "Ask" };
	const lines = answerLines(details);
	if (details.timedOut) {
		// Distinguish auto-selection from a real answer in the transcript.
		lines.push([{ text: "auto-selected after timeout — not a user choice", tone: "dim" }]);
	}
	return {
		kind: "framedBlock",
		header,
		state: hasSelection ? "success" : "warning",
		sections: [questionSection(details.question), { lines }],
	};
}

/** The `ask` card: the question while it is open, and the answer once it is closed. */
export const askToolView = {
	renderCall: (args: AskRenderArgs, _context: ToolViewContext): ToolView => callView(args),
	renderResult: (result: AskViewResult, _context: ToolViewContext): ToolView => resultView(result),
};
