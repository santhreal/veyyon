import {
	Ellipsis,
	Markdown,
	type MarkdownTheme,
	renderInlineMarkdown,
	replaceTabs,
	Text,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@veyyon/tui";
import { collapseWhitespace, isRecord } from "@veyyon/utils";
import { stripRecommendedSuffix } from "@veyyon/wire";
import type {
	ExtensionAskDialogOption,
	ExtensionAskDialogQuestion,
	ExtensionAskDialogSubmitResult,
} from "../../extensibility/extensions";
import { highlightCode } from "../theme/highlight";
import { getMarkdownTheme } from "../theme/markdown-theme";
import { activityColorToken } from "../theme/shimmer";
import { theme } from "../theme/theme-binding";
import { HOOK_EDITOR_TEXT_PAD_COLS } from "./hook-editor";
import { MODAL_SIZING_LARGE, minModalChromeRows } from "./modal-shell";

export const SUBMIT_OPTION = "Submit";

export const MIN_BODY_ROWS = 5;
export const CHROME_ROWS = minModalChromeRows(MODAL_SIZING_LARGE);
export const PREVIEW_MIN_WIDTH = 40;
export const SIDE_BY_SIDE_LIST_MIN_WIDTH = 30;
export const SIDE_BY_SIDE_GAP_WIDTH = 3;
export const MAX_HEADER_CHIP_WIDTH = 16;
export const MAX_PROMPT_TITLE_ROWS = 3;
export const PROMPT_TITLE_CHROME_COLUMNS = HOOK_EDITOR_TEXT_PAD_COLS * 2;
export const MAX_HEADER_ROWS = 4;

export function promptTitleContentWidth(): number {
	const cols = process.stdout.columns ?? 80;
	return Math.max(1, cols - PROMPT_TITLE_CHROME_COLUMNS);
}

export function boundPromptTitle(prefix: string, question: string): string {
	const width = promptTitleContentWidth();
	const flat = normalizedInlineInput(`${prefix}${question}`);
	const wrapped = wrapTextWithAnsi(flat, width);
	if (wrapped.length <= MAX_PROMPT_TITLE_ROWS) return wrapped.join("\n");
	const kept = wrapped.slice(0, MAX_PROMPT_TITLE_ROWS - 1);
	const last = truncateToWidth(wrapped[MAX_PROMPT_TITLE_ROWS - 1] ?? "", width, Ellipsis.Unicode);
	return kept.concat([last]).join("\n");
}

export interface AskDialogCallbacks {
	onSubmit(result: ExtensionAskDialogSubmitResult): void;
	onCancel(): void;
	onPrompt(title: string, prefill?: string): Promise<string | undefined>;
}

export interface AskDialogOptions {
	timeout?: number;
	onTimeout?: () => void;
	tui?: TUI;
}

export interface QuestionState {
	selectedOptions: Set<string>;
	customInput: string | undefined;
	note: string | undefined;
	noteRowKey: string | undefined;
	cursorIndex: number;
	scrollOffset: number;
	timedOut: boolean;
}

export type QuestionRowKind = "option" | "other";

export interface QuestionRow {
	kind: QuestionRowKind;
	key: string;
	label: string;
	optionIndex: number | undefined;
}

export interface RenderedList {
	lines: string[];
	scrollOffset: number;
	indicator: string;
	lineStarts?: number[];
	lineCount?: number;
}

export interface PreviewSegment {
	kind: "markdown" | "code";
	text: string;
	language: string | undefined;
}

export function questionTabLabel(question: ExtensionAskDialogQuestion, index: number): string {
	const base = question.header?.trim() || question.id || `Q${index + 1}`;
	return truncateToWidth(replaceTabs(base), MAX_HEADER_CHIP_WIDTH, Ellipsis.Unicode);
}

export function renderQuestionTitle(question: ExtensionAskDialogQuestion, width: number): string[] {
	const mdTheme = getMarkdownTheme();
	const askToken = activityColorToken("ask");
	const questionText = renderInlineMarkdown(replaceTabs(question.question), mdTheme, t => theme.fg(askToken, t));
	const wrapped = wrapTextWithAnsi(questionText, Math.max(1, width));
	if (wrapped.length <= MAX_HEADER_ROWS) return wrapped;
	return [
		...wrapped.slice(0, MAX_HEADER_ROWS - 1),
		truncateToWidth(wrapped.slice(MAX_HEADER_ROWS - 1).join(" "), Math.max(1, width), Ellipsis.Unicode),
	];
}

export function splitPreviewSegments(preview: string): PreviewSegment[] {
	const segments: PreviewSegment[] = [];
	const markdownBuffer: string[] = [];
	let fenceChar: string | undefined;
	let fenceLength = 0;
	let fenceLanguage: string | undefined;
	let codeBuffer: string[] = [];

	const flushMarkdown = (): void => {
		if (markdownBuffer.length === 0) return;
		segments.push({ kind: "markdown", text: markdownBuffer.join("\n"), language: undefined });
		markdownBuffer.length = 0;
	};
	const flushCode = (): void => {
		segments.push({ kind: "code", text: codeBuffer.join("\n"), language: fenceLanguage });
		codeBuffer = [];
		fenceChar = undefined;
		fenceLength = 0;
		fenceLanguage = undefined;
	};

	const previewLines = replaceTabs(preview).split("\n");
	for (let li = 0; li < previewLines.length; li++) {
		const line = previewLines[li]!;
		const fenceMatch = /^(\s{0,3})(`{3,}|~{3,})(.*)$/.exec(line);
		if (fenceChar !== undefined) {
			if (fenceMatch) {
				const marker = fenceMatch[2] ?? "";
				const info = fenceMatch[3]?.trim() ?? "";
				if (marker.startsWith(fenceChar) && marker.length >= fenceLength && info === "") {
					flushCode();
					continue;
				}
			}
			codeBuffer.push(line);
			continue;
		}
		if (fenceMatch) {
			flushMarkdown();
			const marker = fenceMatch[2] ?? "";
			fenceChar = marker[0];
			fenceLength = marker.length;
			fenceLanguage = fenceMatch[3]?.trim().split(/\s+/, 1)[0] || undefined;
			codeBuffer = [];
			continue;
		}
		markdownBuffer.push(line);
	}

	if (fenceChar !== undefined) {
		segments.push({ kind: "code", text: codeBuffer.join("\n"), language: fenceLanguage });
	} else {
		flushMarkdown();
	}
	return segments;
}

export function renderPreviewContent(preview: string, width: number): string[] {
	const out: string[] = [];
	const mdTheme = getMarkdownTheme();
	const accentStyle = { color: (text: string) => theme.fg("muted", text) };
	const segments = splitPreviewSegments(preview);
	for (let si = 0; si < segments.length; si++) {
		const segment = segments[si]!;
		if (segment.kind === "code") {
			const highlighted = highlightCode(segment.text, segment.language);
			const text = new Text(highlighted.join("\n"), 0, 0);
			const tr = text.render(Math.max(1, width));
			for (let li = 0; li < tr.length; li++) out.push(tr[li]!);
			continue;
		}
		const markdown = new Markdown(segment.text, 0, 0, mdTheme, accentStyle);
		const mr = markdown.render(Math.max(1, width));
		for (let li = 0; li < mr.length; li++) out.push(mr[li]!);
	}
	return out;
}

export function normalizedInlineInput(input: string): string {
	return collapseWhitespace(replaceTabs(input));
}

export function renderAnswerSummary(question: ExtensionAskDialogQuestion, state: QuestionState): string {
	const selected: string[] = [];
	for (let oi = 0; oi < question.options.length; oi++) {
		const label = question.options[oi]!.label;
		if (state.selectedOptions.has(label)) selected.push(label);
	}
	if (question.multi) {
		const answers = selected.slice();
		if (state.customInput !== undefined) answers.push(`Other: “${normalizedInlineInput(state.customInput)}”`);
		return answers.length > 0 ? answers.join(", ") : theme.fg("warning", "unanswered");
	}
	if (state.customInput !== undefined) return `“${normalizedInlineInput(state.customInput)}”`;
	if (selected.length === 0) return theme.fg("warning", "unanswered");
	return selected[0] ?? theme.fg("warning", "unanswered");
}

export function clearNote(state: QuestionState): void {
	state.note = undefined;
	state.noteRowKey = undefined;
}

export function clearNoteIfRow(state: QuestionState, rowKey: string): void {
	if (state.noteRowKey === rowKey) clearNote(state);
}

export function clearNoteUnlessRow(state: QuestionState, rowKey: string): void {
	if (state.noteRowKey !== undefined && state.noteRowKey !== rowKey) clearNote(state);
}

export function noteForSubmittedAnswer(question: ExtensionAskDialogQuestion, state: QuestionState): string | undefined {
	if (state.note === undefined || state.noteRowKey === undefined) return undefined;
	if (state.noteRowKey === "other") return state.customInput !== undefined ? state.note : undefined;
	const match = /^option:(\d+)$/.exec(state.noteRowKey);
	const optionIndex = match?.[1] === undefined ? Number.NaN : Number.parseInt(match[1], 10);
	const option = Number.isInteger(optionIndex) ? question.options[optionIndex] : undefined;
	return option && state.selectedOptions.has(option.label) ? state.note : undefined;
}

export function optionMarker(question: ExtensionAskDialogQuestion, checked: boolean): string {
	if (question.multi) return checked ? theme.checkbox.checked : theme.checkbox.unchecked;
	return checked ? theme.radio.selected : theme.radio.unselected;
}

export function renderRowLabel(
	rowItem: QuestionRow,
	question: ExtensionAskDialogQuestion,
	state: QuestionState,
	selected: boolean,
	mdTheme: MarkdownTheme,
	width: number,
): string[] {
	const isOption = rowItem.kind === "option";
	const isOther = rowItem.kind === "other";
	const checked = isOption
		? state.selectedOptions.has(stripRecommendedSuffix(rowItem.label))
		: isOther && state.customInput !== undefined;
	const color = selected ? "accent" : checked ? "toolOutput" : "text";
	const marker = `${theme.fg(checked ? "success" : "dim", optionMarker(question, checked))} `;
	const cursor = selected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
	const label = renderInlineMarkdown(rowItem.label, mdTheme, t => theme.fg(color, t));
	const noteMarker =
		state.note && state.noteRowKey === rowItem.key
			? `  ${theme.styledSymbol("tool.edit", "success")} ${theme.fg("success", "note")}`
			: "";
	const firstLine = `${cursor}${marker}${label}${noteMarker}`;
	const lines = [truncateToWidth(firstLine, width, Ellipsis.Unicode)];
	if (rowItem.kind === "option") {
		const option = question.options[rowItem.optionIndex ?? -1];
		if (option?.description?.trim()) {
			const description = renderInlineMarkdown(option.description.trim(), mdTheme, t => theme.fg("muted", t));
			const wrapped = wrapTextWithAnsi(description, Math.max(1, width - 6));
			const wrappedLines = wrapped.slice(0, 2);
			for (let li = 0; li < wrappedLines.length; li++) {
				lines.push(`      ${truncateToWidth(wrappedLines[li]!, Math.max(1, width - 6), Ellipsis.Unicode)}`);
			}
		}
	}
	if (isOther && state.customInput !== undefined) {
		const preview = collapseWhitespace(replaceTabs(state.customInput));
		lines.push(theme.fg("muted", `      ${truncateToWidth(preview, Math.max(1, width - 6), Ellipsis.Unicode)}`));
	}
	return lines;
}

export function describeAskValue(value: unknown): string {
	if (value === undefined) return "missing";
	if (typeof value === "string") return `the string ${JSON.stringify(value)}`;
	if (typeof value === "object") return value === null ? "null" : Array.isArray(value) ? "an array" : "an object";
	return `the ${typeof value} ${String(value)}`;
}

export function isAskText(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

export function assertRenderableAskQuestions(questions: readonly ExtensionAskDialogQuestion[]): void {
	if (!Array.isArray(questions) || questions.length === 0) {
		throw new Error("Ask dialog needs a non-empty array of questions.");
	}
	for (let index = 0; index < questions.length; index++) {
		const raw: unknown = questions[index];
		const at = `Ask dialog question ${index}`;
		if (!isRecord(raw)) {
			throw new Error(`${at} is ${describeAskValue(raw)}, not an object.`);
		}
		const question = raw as Partial<ExtensionAskDialogQuestion>;
		if (!isAskText(question.id)) {
			throw new Error(`${at} has no id (${describeAskValue(question.id)}); it must be a non-empty string.`);
		}
		const where = `${at} (${question.id})`;
		if (!isAskText(question.question)) {
			throw new Error(
				`${where} has no question text (${describeAskValue(question.question)}); it must be a non-empty string.`,
			);
		}
		if (question.header !== undefined && typeof question.header !== "string") {
			throw new Error(`${where} has a header that is ${describeAskValue(question.header)}, not a string.`);
		}
		if (!Array.isArray(question.options)) {
			throw new Error(`${where} has options that are ${describeAskValue(question.options)}, not an array.`);
		}
		for (let optionIndex = 0; optionIndex < question.options.length; optionIndex++) {
			const option: unknown = question.options[optionIndex];
			const optionAt = `${where} option ${optionIndex}`;
			if (!isRecord(option)) {
				throw new Error(`${optionAt} is ${describeAskValue(option)}, not an object.`);
			}
			const { label, description, preview } = option as Partial<ExtensionAskDialogOption>;
			if (!isAskText(label)) {
				throw new Error(`${optionAt} has no label (${describeAskValue(label)}); it must be a non-empty string.`);
			}
			if (description !== undefined && typeof description !== "string") {
				throw new Error(`${optionAt} has a description that is ${describeAskValue(description)}, not a string.`);
			}
			if (preview !== undefined && typeof preview !== "string") {
				throw new Error(`${optionAt} has a preview that is ${describeAskValue(preview)}, not a string.`);
			}
		}
		if (question.multi !== undefined && typeof question.multi !== "boolean") {
			throw new Error(`${where} has multi set to ${describeAskValue(question.multi)}, not a boolean.`);
		}
		if (question.recommended !== undefined && !Number.isFinite(question.recommended)) {
			throw new Error(`${where} has recommended set to ${describeAskValue(question.recommended)}, not a number.`);
		}
		if (question.preselected !== undefined && !Array.isArray(question.preselected)) {
			throw new Error(
				`${where} has preselected set to ${describeAskValue(question.preselected)}, not an array of option labels.`,
			);
		}
		for (const label of question.preselected ?? []) {
			if (typeof label !== "string") {
				throw new Error(`${where} has a preselected label that is ${describeAskValue(label)}, not a string.`);
			}
		}
	}
}
