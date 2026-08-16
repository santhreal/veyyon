import {
	type Component,
	clamp,
	Ellipsis,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	padding,
	renderInlineMarkdown,
	replaceTabs,
	routeSgrMouseInput,
	ScrollView,
	type Tab,
	TabBar,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@veyyon/tui";
import { clampLow, collapseWhitespace, formatCount, formatMoreLines, isRecord } from "@veyyon/utils";
import { stripRecommendedSuffix, withRecommendedSuffix } from "@veyyon/wire";
import type {
	ExtensionAskDialogOption,
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResultItem,
	ExtensionAskDialogSubmitResult,
} from "../../extensibility/extensions";
import { ASK_OTHER_OPTION_LABEL } from "../../tools/ask-option-labels";
import { getTabBarTheme } from "../shared";
import { highlightCode } from "../theme/highlight";
import { getMarkdownTheme } from "../theme/markdown-theme";
import { activityColorToken, setShimmerActivity } from "../theme/shimmer";
import { theme } from "../theme/theme-binding";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import { CountdownTimer } from "./countdown-timer";
import { HOOK_EDITOR_TEXT_PAD_COLS } from "./hook-editor";
import {
	applyModalReveal,
	beginModalExit,
	computeModalDims,
	consumeModalChipHover,
	hitTestModalChrome,
	MODAL_SIZING_LARGE,
	ModalRevealDriver,
	type ModalShellGeometry,
	type ModalShortcut,
	minModalChromeRows,
	renderModalShell,
} from "./modal-shell";
import { handleTabSwitchKey, selectionBand } from "./selector-helpers";

const SUBMIT_OPTION = "Submit";

/**
 * Minimum rows kept for the question/submit body on a short terminal.
 *
 * Higher than the plan overlay's floor, and deliberately so: this body carries
 * the question text and its options together, whereas the plan overlay's floor
 * covers only a scroll region that has its prompt, slider, and options laid out
 * beneath it. (The doc here used to say "plan-body rows", copied from that
 * overlay, which made the two look like one number that disagreed with itself.)
 */
const MIN_BODY_ROWS = 5;
/** Rows ModalShell reserves outside the body budget, so the body/list layout
 *  decision (side-by-side preview vs stacked) is made against a realistic budget
 *  without duplicating the whole layout pass. Taken from the shell rather than
 *  restated: this was `3 + footerLines + vPad`, three unnamed rows that happened
 *  to agree with the shell and would not have failed if the shell grew one. */
const CHROME_ROWS = minModalChromeRows(MODAL_SIZING_LARGE);
const PREVIEW_MIN_WIDTH = 40;
const SIDE_BY_SIDE_LIST_MIN_WIDTH = 30;
const SIDE_BY_SIDE_GAP_WIDTH = 3;
const MAX_HEADER_CHIP_WIDTH = 16;
/** Maximum number of title lines shown in the prompt editor overlay, so a
 *  long or multi-line question cannot push the input row off-screen. Mirrors
 *  the bounded-title pattern from the legacy ask path without its option-window
 *  coupling. */
const MAX_PROMPT_TITLE_ROWS = 3;
/**
 * Columns consumed by the chrome the bounded title is rendered inside.
 *
 * The title goes to `onPrompt`, which mounts a `HookEditorComponent` in the
 * full-width editor container, so the only chrome around the title row is that
 * component's own horizontal padding. Taken from there rather than restated,
 * because the same value was independently hardcoded to 4 here and in
 * `tools/ask.ts`, both described as border plus padding. `DynamicBorder`, the
 * only border in that component, renders one full-width horizontal rule and
 * consumes zero columns, so both copies wrapped the title two columns narrower
 * than the space it had.
 */
const PROMPT_TITLE_CHROME_COLUMNS = HOOK_EDITOR_TEXT_PAD_COLS * 2;
/** Maximum number of wrapped lines for an in-body question header, so a long
 *  or multi-line question cannot push the option list off-screen. Mirrors the
 *  row-cap pattern used by boundPromptTitle for the prompt editor overlay. */
const MAX_HEADER_ROWS = 4;

function promptTitleContentWidth(): number {
	const cols = process.stdout.columns ?? 80;
	return Math.max(1, cols - PROMPT_TITLE_CHROME_COLUMNS);
}

/** Bound a prompt editor title to a fixed row/width budget so long or
 *  multi-line questions stay usable inside the small prompt overlay. */
export function boundPromptTitle(prefix: string, question: string): string {
	const width = promptTitleContentWidth();
	const flat = normalizedInlineInput(`${prefix}${question}`);
	const wrapped = wrapTextWithAnsi(flat, width);
	if (wrapped.length <= MAX_PROMPT_TITLE_ROWS) return wrapped.join("\n");
	const kept = wrapped.slice(0, MAX_PROMPT_TITLE_ROWS - 1);
	const last = truncateToWidth(wrapped[MAX_PROMPT_TITLE_ROWS - 1] ?? "", width, Ellipsis.Unicode);
	return [...kept, last].join("\n");
}

interface AskDialogCallbacks {
	onSubmit(result: ExtensionAskDialogSubmitResult): void;
	onCancel(): void;
	onPrompt(title: string, prefill?: string): Promise<string | undefined>;
}

interface AskDialogOptions {
	timeout?: number;
	onTimeout?: () => void;
	tui?: TUI;
	/** Play the open unfold (TOUCH-5). Show site decides via modalRevealEnabled(). */
	reveal?: boolean;
}

interface QuestionState {
	selectedOptions: Set<string>;
	customInput: string | undefined;
	note: string | undefined;
	noteRowKey: string | undefined;
	cursorIndex: number;
	scrollOffset: number;
	timedOut: boolean;
}

type QuestionRowKind = "option" | "other";

interface QuestionRow {
	kind: QuestionRowKind;
	key: string;
	label: string;
	optionIndex: number | undefined;
}

interface RenderedList {
	lines: string[];
	scrollOffset: number;
	indicator: string;
	/** Question lists only: per-row start line within the unclipped list, and the
	 *  total unclipped line count, so pointer rows map back to option rows. */
	lineStarts?: number[];
	lineCount?: number;
}

interface PreviewSegment {
	kind: "markdown" | "code";
	text: string;
	language: string | undefined;
}

function questionTabLabel(question: ExtensionAskDialogQuestion, index: number): string {
	const base = question.header?.trim() || question.id || `Q${index + 1}`;
	return truncateToWidth(replaceTabs(base), MAX_HEADER_CHIP_WIDTH, Ellipsis.Unicode);
}

function renderQuestionTitle(question: ExtensionAskDialogQuestion, width: number): string[] {
	const mdTheme = getMarkdownTheme();
	// The agent is asking, so the question itself carries the living `ask` hue:
	// the same theme token the `await` breath paints, sourced from ONE place so a
	// rebrand owns it. This is the visible "your turn" — the prompt reads green.
	const askToken = activityColorToken("ask");
	const questionText = renderInlineMarkdown(replaceTabs(question.question), mdTheme, t => theme.fg(askToken, t));
	const wrapped = wrapTextWithAnsi(questionText, Math.max(1, width));
	if (wrapped.length <= MAX_HEADER_ROWS) return wrapped;
	return [
		...wrapped.slice(0, MAX_HEADER_ROWS - 1),
		truncateToWidth(wrapped.slice(MAX_HEADER_ROWS - 1).join(" "), Math.max(1, width), Ellipsis.Unicode),
	];
}

function splitPreviewSegments(preview: string): PreviewSegment[] {
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

	for (const line of replaceTabs(preview).split("\n")) {
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

function renderPreviewContent(preview: string, width: number): string[] {
	const out: string[] = [];
	const mdTheme = getMarkdownTheme();
	const accentStyle = { color: (text: string) => theme.fg("muted", text) };
	for (const segment of splitPreviewSegments(preview)) {
		if (segment.kind === "code") {
			const highlighted = highlightCode(segment.text, segment.language);
			const text = new Text(highlighted.join("\n"), 0, 0);
			out.push(...text.render(Math.max(1, width)));
			continue;
		}
		const markdown = new Markdown(segment.text, 0, 0, mdTheme, accentStyle);
		out.push(...markdown.render(Math.max(1, width)));
	}
	return out;
}

function normalizedInlineInput(input: string): string {
	return collapseWhitespace(replaceTabs(input));
}

function renderAnswerSummary(question: ExtensionAskDialogQuestion, state: QuestionState): string {
	const selected = question.options.map(option => option.label).filter(label => state.selectedOptions.has(label));
	if (question.multi) {
		const answers = [...selected];
		if (state.customInput !== undefined) answers.push(`Other: “${normalizedInlineInput(state.customInput)}”`);
		return answers.length > 0 ? answers.join(", ") : theme.fg("warning", "unanswered");
	}
	if (state.customInput !== undefined) return `“${normalizedInlineInput(state.customInput)}”`;
	if (selected.length === 0) return theme.fg("warning", "unanswered");
	return selected[0] ?? theme.fg("warning", "unanswered");
}

function clearNote(state: QuestionState): void {
	state.note = undefined;
	state.noteRowKey = undefined;
}

function clearNoteIfRow(state: QuestionState, rowKey: string): void {
	if (state.noteRowKey === rowKey) clearNote(state);
}

function clearNoteUnlessRow(state: QuestionState, rowKey: string): void {
	if (state.noteRowKey !== undefined && state.noteRowKey !== rowKey) clearNote(state);
}

function noteForSubmittedAnswer(question: ExtensionAskDialogQuestion, state: QuestionState): string | undefined {
	if (state.note === undefined || state.noteRowKey === undefined) return undefined;
	if (state.noteRowKey === "other") return state.customInput !== undefined ? state.note : undefined;
	const match = /^option:(\d+)$/.exec(state.noteRowKey);
	const optionIndex = match?.[1] === undefined ? Number.NaN : Number.parseInt(match[1], 10);
	const option = Number.isInteger(optionIndex) ? question.options[optionIndex] : undefined;
	return option && state.selectedOptions.has(option.label) ? state.note : undefined;
}

function optionMarker(question: ExtensionAskDialogQuestion, checked: boolean): string {
	if (question.multi) return checked ? theme.checkbox.checked : theme.checkbox.unchecked;
	return checked ? theme.radio.selected : theme.radio.unselected;
}

function renderRowLabel(
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
	// "✎ note" marker (glyph + word), matching the plan-review annotation mark.
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
			for (const line of wrapped.slice(0, 2)) {
				lines.push(`      ${truncateToWidth(line, Math.max(1, width - 6), Ellipsis.Unicode)}`);
			}
		}
	}
	if (isOther && state.customInput !== undefined) {
		const preview = collapseWhitespace(replaceTabs(state.customInput));
		lines.push(theme.fg("muted", `      ${truncateToWidth(preview, Math.max(1, width - 6), Ellipsis.Unicode)}`));
	}
	return lines;
}

function describeAskValue(value: unknown): string {
	if (value === undefined) return "missing";
	if (typeof value === "string") return `the string ${JSON.stringify(value)}`;
	if (typeof value === "object") return value === null ? "null" : Array.isArray(value) ? "an array" : "an object";
	return `the ${typeof value} ${String(value)}`;
}

function isAskText(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * Refuse a question this dialog cannot render, naming the field and the question
 * that carried it.
 *
 * The rendered fields are read with no fallback — `replaceTabs(question.question)`,
 * `question.options.length` — because the declared type makes them mandatory. That
 * holds for every in-tree caller and for nobody else: `ExtensionUI.askDialog` is a
 * published extension API, and the collab and RPC paths hand over JSON that was
 * decoded rather than type-checked. A question with no `question` field reached the
 * header renderer and took the process down with `undefined is not an object
 * (evaluating 'text.replaceAll')` — an uncaught exception thrown from inside a
 * render pass, so there was no tool error and no notice, just a dead session and
 * every live subagent with it.
 *
 * The precondition is therefore checked once, where the dialog is built, and a
 * violation is an ordinary rejection: `#presentDialog` catches a throwing
 * presenter, releases the modal surface, and the caller — a tool call, an
 * extension command — is handed an error naming what to fix. Refusing beats
 * substituting a placeholder, because a dialog reading "undefined" asks a question
 * nobody wrote and records an answer to it.
 */
function assertRenderableAskQuestions(questions: readonly ExtensionAskDialogQuestion[]): void {
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

export class AskDialogComponent implements Component {
	#states: QuestionState[];
	#activeTabIndex = 0;
	#submitScrollOffset = 0;
	/** Pointer-highlighted option row on the active question tab (null clears). */
	#hoveredRowIndex: number | null = null;
	/** Last render's option-list geometry for pointer hit-testing. */
	#listPointerMap: {
		frameStart: number;
		lineStarts: number[];
		lineCount: number;
		scrollOffset: number;
	} | null = null;
	#remainingSeconds: number | undefined;
	#countdown: CountdownTimer | undefined;
	#promptActive = false;
	#timeoutExpired = false;
	#closed = false;
	#tabBar: TabBar | undefined;
	#shellGeometry: ModalShellGeometry | null = null;
	#hoveredShortcutId: string | null = null;
	#onRequestRenderExternal: (() => void) | undefined;
	#reveal = new ModalRevealDriver();
	/**
	 * Fade out on the shared clock before the host drops this card. The overlay stack keeps painting
	 * it and stops routing input to it the moment this is called.
	 */
	beginOverlayExit(requestRender: () => void, done: () => void): boolean {
		return beginModalExit(this.#reveal, requestRender, done);
	}

	constructor(
		private readonly questions: ExtensionAskDialogQuestion[],
		private readonly callbacks: AskDialogCallbacks,
		private readonly options: AskDialogOptions = {},
	) {
		assertRenderableAskQuestions(questions);
		this.#states = questions.map(question => {
			const recommended = Number.isInteger(question.recommended) ? question.recommended : 0;
			const maxIndex = Math.max(0, question.options.length - 1);
			const preselected = question.multi
				? (question.preselected ?? []).filter(label => question.options.some(option => option.label === label))
				: [];
			return {
				selectedOptions: new Set<string>(preselected),
				customInput: undefined,
				note: undefined,
				noteRowKey: undefined,
				cursorIndex: clamp(recommended ?? 0, 0, maxIndex),
				scrollOffset: 0,
				timedOut: false,
			};
		});
		// The dialog appearing IS the agent yielding the turn: flip the living
		// status to `ask` so any concurrent shimmer surface reads the green
		// "your turn" breath. `dispose()` returns it to rest.
		setShimmerActivity("ask");
		if (options.reveal) {
			this.#reveal.start(() => this.#onRequestRenderExternal?.());
		}
		if (options.timeout && options.timeout > 0) {
			this.#countdown = new CountdownTimer(
				options.timeout,
				options.tui,
				this,
				seconds => {
					this.#remainingSeconds = seconds;
				},
				() => this.#handleTimeout(),
			);
		}
	}

	invalidate(): void {
		this.#tabBar?.invalidate();
	}

	dispose(): void {
		this.#closed = true;
		this.#reveal.stop();
		this.#countdown?.dispose();
		// The user answered (or it timed out): drop the `ask` breath back to rest.
		// The next agent turn's `agent_start` flips it to `thinking`.
		setShimmerActivity("idle");
	}

	setOnRequestRender(callback: () => void): void {
		this.#onRequestRenderExternal = callback;
	}

	handleInput(keyData: string): void {
		if (keyData.startsWith("\x1b[<")) {
			this.#handleMouse(keyData);
			return;
		}
		if (this.#closed || this.#promptActive) return;
		// Reset the inactivity countdown on any key that reaches past the
		// closed/prompt guards, matching HookSelector/HookInput semantics.
		this.#countdown?.reset();
		if (matchesSelectCancel(keyData)) {
			this.#finishCancel();
			return;
		}
		if (this.#hasSubmitTab() && handleTabSwitchKey(keyData, direction => this.#switchTab(direction))) {
			this.#requestRender();
			return;
		}
		if (this.#isSubmitTab()) {
			this.#handleSubmitTabInput(keyData);
			return;
		}
		this.#handleQuestionInput(keyData);
	}

	render(width: number): readonly string[] {
		const termHeight = Math.max(14, process.stdout.rows || 40);
		const sizing = MODAL_SIZING_LARGE;
		const dims = computeModalDims(width, termHeight, sizing);
		const contentWidth = dims?.contentWidth ?? Math.max(1, width - 4);
		const headerLines = this.#renderHeader(contentWidth);
		// ModalShell's own chrome (top/close bar, footer divider, bottom border,
		// vertical padding, footer band) reserves CHROME_ROWS outside the body;
		// the header rows are part of the body we hand it, so subtract those too.
		const bodyRows = Math.max(MIN_BODY_ROWS, (dims?.modalHeight ?? termHeight) - headerLines.length - CHROME_ROWS);
		const bodyLines = this.#isSubmitTab()
			? this.#renderSubmitBody(contentWidth, bodyRows)
			: this.#renderQuestionBody(contentWidth, bodyRows);

		const shell = renderModalShell({
			title: this.#titleText(),
			sizing,
			areaWidth: width,
			areaHeight: termHeight,
			body: [...headerLines, ...bodyLines.lines],
			shortcuts: this.#buildShortcuts(bodyLines.indicator),
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});
		this.#shellGeometry = shell.geometry;
		// Pointer map for the option list: frame row of the list's first rendered
		// line plus the unclipped row starts from this render. Null on the submit
		// tab, whose body is a scrollable summary with no selectable rows.
		this.#listPointerMap =
			bodyLines.lineStarts !== undefined && bodyLines.lineCount !== undefined
				? {
						frameStart: (shell.geometry?.bodyRowStart ?? 0) + headerLines.length,
						lineStarts: bodyLines.lineStarts,
						lineCount: bodyLines.lineCount,
						scrollOffset: bodyLines.scrollOffset,
					}
				: null;
		return applyModalReveal(shell, width, this.#reveal.value);
	}

	/** Footer chips for the active tab (browse vs submit review), mirroring
	 *  the old dynamic hint text as clickable/inert ModalShortcut entries. */
	#buildShortcuts(indicator: string): ModalShortcut[] {
		const chips: ModalShortcut[] = [];
		if (this.#isSubmitTab()) {
			chips.push({ label: "enter submit", clickable: true, id: "confirm" });
			chips.push({ label: "up/down scroll" });
		} else {
			const question = this.questions[this.#currentQuestionIndex()];
			if (question?.multi) {
				chips.push({ label: "space toggle" });
				chips.push({ label: "enter toggle" });
			} else {
				chips.push({ label: "enter select", clickable: true, id: "confirm" });
			}
			chips.push({ label: "n note" });
		}
		if (this.#hasSubmitTab()) chips.push({ label: "tab tabs" });
		if (indicator) chips.push({ label: `${indicator} scroll` });
		chips.push({ label: "esc cancel", clickable: true, id: "close" });
		return chips;
	}

	#handleMouse(data: string): void {
		routeSgrMouseInput(data, event => {
			const chrome = hitTestModalChrome(this.#shellGeometry, event.row, event.col, {
				motion: event.motion,
				leftClick: event.leftClick,
			});
			if (
				consumeModalChipHover(chrome, this.#hoveredShortcutId, id => {
					this.#hoveredShortcutId = id;
					this.#requestRender();
				})
			) {
				return true;
			}
			if (this.#closed || this.#promptActive) return true;
			if (
				chrome.kind === "close" ||
				chrome.kind === "outside" ||
				(chrome.kind === "shortcut" && chrome.id === "close")
			) {
				this.#finishCancel();
				return true;
			}
			if (chrome.kind === "shortcut" && chrome.id === "confirm") {
				if (this.#isSubmitTab()) this.#handleSubmitTabInput("\n");
				else this.#handleQuestionInput("\n");
				return true;
			}
			if (event.wheel !== null) {
				if (this.#isSubmitTab()) {
					this.#submitScrollOffset = Math.max(0, this.#submitScrollOffset + event.wheel);
				} else {
					const active = this.#activeQuestionState();
					if (active) {
						const rowCount = this.#questionRows(active.question).length;
						active.state.cursorIndex = clamp(
							active.state.cursorIndex + event.wheel,
							0,
							Math.max(0, rowCount - 1),
						);
					}
				}
				this.#requestRender();
				return true;
			}
			const map = this.#listPointerMap;
			const local = map ? event.row - map.frameStart + map.scrollOffset : -1;
			let rowIndex: number | null = null;
			if (map && local >= 0 && local < map.lineCount) {
				// Largest row start at or below the line: the row the pointer is over.
				for (let index = map.lineStarts.length - 1; index >= 0; index--) {
					if ((map.lineStarts[index] ?? 0) <= local) {
						rowIndex = index;
						break;
					}
				}
			}
			if (event.motion) {
				if (rowIndex !== this.#hoveredRowIndex) {
					this.#hoveredRowIndex = rowIndex;
					this.#requestRender();
				}
				return true;
			}
			if (event.leftClick && rowIndex !== null) {
				// Click mirrors the cursor + Enter: an option answers (single) or
				// toggles (multi), the Other row opens the inline input.
				const active = this.#activeQuestionState();
				if (active) {
					active.state.cursorIndex = rowIndex;
					this.#hoveredRowIndex = null;
					this.#handleQuestionInput("\n");
				}
				return true;
			}
			return true;
		});
	}

	#titleText(): string {
		return this.#remainingSeconds === undefined ? "Ask" : `Ask (${this.#remainingSeconds}s)`;
	}

	#hasSubmitTab(): boolean {
		// Multi questions confirm on the Submit tab (Enter toggles, never
		// submits), so any multi question forces the tab even when there is
		// only one question.
		return this.questions.length > 1 || this.questions.some(question => question.multi);
	}

	#submitTabIndex(): number {
		return this.questions.length;
	}

	#isSubmitTab(): boolean {
		return this.#hasSubmitTab() && this.#activeTabIndex === this.#submitTabIndex();
	}

	#currentQuestionIndex(): number {
		return clamp(this.#activeTabIndex, 0, Math.max(0, this.questions.length - 1));
	}

	#requestRender(): void {
		this.options.tui?.requestRender();
		this.#onRequestRenderExternal?.();
	}

	#renderHeader(width: number): string[] {
		const lines: string[] = [];
		if (this.#hasSubmitTab()) {
			const tabs: Tab[] = [
				...this.questions.map((question, index) => ({
					id: String(index),
					label: questionTabLabel(question, index),
				})),
				{ id: "submit", label: "Submit" },
			];
			this.#tabBar = new TabBar("", tabs, getTabBarTheme(), this.#activeTabIndex);
			this.#tabBar.showHint = false;
			lines.push(...this.#tabBar.render(width));
		}
		if (this.#isSubmitTab()) {
			lines.push(theme.bold(theme.fg("accent", "Review answers")));
			return lines;
		}
		const questionIndex = this.#currentQuestionIndex();
		const question = this.questions[questionIndex];
		if (!question) return lines;
		lines.push(...renderQuestionTitle(question, width));
		return lines;
	}

	#questionRows(question: ExtensionAskDialogQuestion): QuestionRow[] {
		const rows: QuestionRow[] = question.options.map((option, index) => ({
			kind: "option",
			key: `option:${index}`,
			label: this.#optionLabel(question, option.label, index),
			optionIndex: index,
		}));
		rows.push({ kind: "other", key: "other", label: ASK_OTHER_OPTION_LABEL, optionIndex: undefined });
		return rows;
	}

	#optionLabel(question: ExtensionAskDialogQuestion, label: string, index: number): string {
		return question.recommended === index ? withRecommendedSuffix(label) : label;
	}

	#activeQuestionState(): { question: ExtensionAskDialogQuestion; state: QuestionState } | undefined {
		const question = this.questions[this.#currentQuestionIndex()];
		const state = this.#states[this.#currentQuestionIndex()];
		if (!question || !state) return undefined;
		return { question, state };
	}

	#handleQuestionInput(keyData: string): void {
		const active = this.#activeQuestionState();
		if (!active) return;
		const { question, state } = active;
		const rows = this.#questionRows(question);
		if (matchesSelectUp(keyData)) {
			state.cursorIndex = clamp(state.cursorIndex - 1, 0, Math.max(0, rows.length - 1));
			this.#requestRender();
			return;
		}
		if (matchesSelectDown(keyData)) {
			state.cursorIndex = clamp(state.cursorIndex + 1, 0, Math.max(0, rows.length - 1));
			this.#requestRender();
			return;
		}
		const rowItem = rows[state.cursorIndex];
		if (!rowItem) return;
		if (keyData === "n" || keyData === "N") {
			if (rowItem.kind === "option" || rowItem.kind === "other") {
				void this.#promptForNote(question, state, rowItem);
			}
			return;
		}
		const isEnter = matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n";
		const isSpace = matchesKey(keyData, "space") || keyData === " ";
		if (!isEnter && !isSpace) return;
		if (rowItem.kind === "other") {
			void this.#promptForCustomInput(question, state, rowItem);
			return;
		}
		const option = question.options[rowItem.optionIndex ?? -1];
		if (!option) return;
		if (question.multi) {
			// Multi is toggle-only: Enter and Space both toggle, and the
			// answer is confirmed from the Submit tab.
			if (state.selectedOptions.has(option.label)) {
				state.selectedOptions.delete(option.label);
				clearNoteIfRow(state, rowItem.key);
			} else {
				state.selectedOptions.add(option.label);
			}
			this.#requestRender();
			return;
		}
		state.selectedOptions = new Set([option.label]);
		state.customInput = undefined;
		clearNoteUnlessRow(state, rowItem.key);
		this.#advanceAfterQuestion();
	}

	#handleSubmitTabInput(keyData: string): void {
		if (matchesSelectUp(keyData)) {
			this.#submitScrollOffset = Math.max(0, this.#submitScrollOffset - 1);
			this.#requestRender();
			return;
		}
		if (matchesSelectDown(keyData)) {
			// Clamped against the rendered line count in #renderSubmitBody.
			this.#submitScrollOffset += 1;
			this.#requestRender();
			return;
		}
		const isEnter = matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n";
		if (isEnter) this.#finishSubmit();
	}

	#switchTab(direction: 1 | -1): void {
		const tabCount = this.questions.length + 1;
		this.#activeTabIndex = (this.#activeTabIndex + direction + tabCount) % tabCount;
		this.#submitScrollOffset = 0;
		this.#hoveredRowIndex = null;
	}

	#advanceAfterQuestion(): void {
		const current = this.#currentQuestionIndex();
		if (this.questions.length === 1) {
			this.#finishSubmit();
			return;
		}
		this.#activeTabIndex = current + 1 < this.questions.length ? current + 1 : this.#submitTabIndex();
		this.#submitScrollOffset = 0;
		this.#requestRender();
	}

	async #promptForCustomInput(
		question: ExtensionAskDialogQuestion,
		state: QuestionState,
		rowItem: QuestionRow,
	): Promise<void> {
		this.#promptActive = true;
		try {
			const input = await this.callbacks.onPrompt(
				boundPromptTitle("Custom answer: ", question.question),
				state.customInput,
			);
			if (input === undefined || this.#closed) return;
			if (input.trim() === "") {
				// Submitting an empty value unselects the custom answer.
				state.customInput = undefined;
				clearNoteIfRow(state, rowItem.key);
				return;
			}
			state.customInput = input;
			if (!question.multi) {
				state.selectedOptions.clear();
				clearNoteUnlessRow(state, rowItem.key);
				this.#advanceAfterQuestion();
			}
		} finally {
			this.#promptActive = false;
			this.#runDeferredTimeout();
			this.#requestRender();
		}
	}

	async #promptForNote(
		question: ExtensionAskDialogQuestion,
		state: QuestionState,
		rowItem: QuestionRow,
	): Promise<void> {
		this.#promptActive = true;
		try {
			const input = await this.callbacks.onPrompt(
				boundPromptTitle(`Note for ${rowItem.label}: `, question.question),
				state.noteRowKey === rowItem.key ? state.note : undefined,
			);
			if (input === undefined || this.#closed) return;
			state.note = input;
			state.noteRowKey = rowItem.key;
		} finally {
			this.#promptActive = false;
			this.#runDeferredTimeout();
			this.#requestRender();
		}
	}

	#renderQuestionBody(width: number, maxRows: number): RenderedList {
		const active = this.#activeQuestionState();
		if (!active) return { lines: [], scrollOffset: 0, indicator: "" };
		const { question, state } = active;
		const rowItems = this.#questionRows(question);
		state.cursorIndex = clamp(state.cursorIndex, 0, Math.max(0, rowItems.length - 1));
		const selectedRow = rowItems[state.cursorIndex];
		const preview =
			selectedRow?.kind === "option" ? question.options[selectedRow.optionIndex ?? -1]?.preview : undefined;
		// The preview pane exists only while the highlighted option carries a
		// preview; otherwise the list takes the full dialog width.
		if (!preview?.trim()) return this.#renderQuestionList(question, state, rowItems, width, maxRows);
		const sideBySide = width >= SIDE_BY_SIDE_LIST_MIN_WIDTH + PREVIEW_MIN_WIDTH + SIDE_BY_SIDE_GAP_WIDTH;
		if (sideBySide) {
			const previewWidth = Math.max(PREVIEW_MIN_WIDTH, Math.floor(width * 0.45));
			const listWidth = Math.max(1, width - previewWidth - SIDE_BY_SIDE_GAP_WIDTH);
			const list = this.#renderQuestionList(question, state, rowItems, listWidth, maxRows);
			const previewLines = this.#renderPreviewPane(preview, previewWidth, maxRows);
			const lines: string[] = [];
			for (let index = 0; index < maxRows; index++) {
				const left = truncateToWidth(list.lines[index] ?? "", listWidth, Ellipsis.Unicode);
				const right = truncateToWidth(previewLines[index] ?? "", previewWidth, Ellipsis.Unicode);
				const gap = padding(Math.max(1, listWidth - visibleWidth(left)) + 1);
				lines.push(`${left}${gap}${theme.fg("borderAccent", "│")} ${right}`);
			}
			return { lines, scrollOffset: list.scrollOffset, indicator: list.indicator };
		}
		const previewLines = this.#renderPreviewPane(preview, width, clampLow(Math.floor(maxRows * 0.4), 3, 8));
		const listRows = Math.max(3, maxRows - previewLines.length - 1);
		const list = this.#renderQuestionList(question, state, rowItems, width, listRows);
		const lines = [...list.lines, theme.fg("borderAccent", "─".repeat(Math.max(1, width))), ...previewLines];
		while (lines.length < maxRows) lines.push("");
		return { lines: lines.slice(0, maxRows), scrollOffset: list.scrollOffset, indicator: list.indicator };
	}

	#renderQuestionList(
		question: ExtensionAskDialogQuestion,
		state: QuestionState,
		rowItems: QuestionRow[],
		width: number,
		rows: number,
	): RenderedList {
		const mdTheme = getMarkdownTheme();
		const allLines: string[] = [];
		const lineStartByRow: number[] = [];
		for (let index = 0; index < rowItems.length; index++) {
			lineStartByRow.push(allLines.length);
			const rowItem = rowItems[index];
			if (!rowItem) continue;
			allLines.push(...renderRowLabel(rowItem, question, state, index === state.cursorIndex, mdTheme, width));
		}
		// Pointer hover bands the whole row (label + description lines); the
		// cursor row keeps its own accent styling and never double-bands.
		const hovered = this.#hoveredRowIndex;
		if (hovered !== null && hovered < rowItems.length && hovered !== state.cursorIndex) {
			const from = lineStartByRow[hovered] ?? allLines.length;
			const to = lineStartByRow[hovered + 1] ?? allLines.length;
			for (let line = from; line < to; line++) {
				allLines[line] = selectionBand(allLines[line]!, width);
			}
		}
		const cursorStart = lineStartByRow[state.cursorIndex] ?? 0;
		state.scrollOffset = this.#scrollOffsetForCursor(state.scrollOffset, cursorStart, rows, allLines.length);
		const scrollView = new ScrollView(allLines, {
			height: rows,
			scrollbar: "auto",
			theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
		});
		scrollView.setScrollOffset(state.scrollOffset);
		const lines = [...scrollView.render(width)];
		while (lines.length < rows) lines.push("");
		return {
			lines: lines.slice(0, rows),
			scrollOffset: state.scrollOffset,
			indicator: this.#clipIndicator(state.scrollOffset, rows, allLines.length),
			lineStarts: lineStartByRow,
			lineCount: allLines.length,
		};
	}

	#renderPreviewPane(preview: string, width: number, maxRows: number): string[] {
		const bodyWidth = Math.max(1, width - 2);
		const content = renderPreviewContent(preview, bodyWidth);
		if (content.length <= maxRows) return content;
		const visibleCount = Math.max(1, maxRows - 1);
		const hidden = content.length - visibleCount;
		return [...content.slice(0, visibleCount), theme.fg("dim", `… ${formatMoreLines(hidden)}`)];
	}

	#renderSubmitBody(width: number, rows: number): RenderedList {
		const allLines: string[] = [];
		const unanswered = this.#unansweredCount();
		if (unanswered > 0) {
			allLines.push(theme.fg("warning", `${formatCount("unanswered question", unanswered)}; Enter still submits.`));
			allLines.push("");
		}
		for (let index = 0; index < this.questions.length; index++) {
			const question = this.questions[index];
			const state = this.#states[index];
			if (!question || !state) continue;
			const label = questionTabLabel(question, index);
			const answer = renderAnswerSummary(question, state);
			allLines.push(`${theme.fg("dim", `${index + 1}. ${label}:`)} ${answer}`);
			const submittedNote = noteForSubmittedAnswer(question, state);
			if (submittedNote?.trim()) {
				const note = normalizedInlineInput(submittedNote);
				allLines.push(
					theme.fg("muted", `   Note: ${truncateToWidth(note, Math.max(1, width - 9), Ellipsis.Unicode)}`),
				);
			}
		}
		allLines.push("");
		allLines.push(theme.fg("accent", `${theme.nav.cursor} ${SUBMIT_OPTION}`));
		this.#submitScrollOffset = clamp(this.#submitScrollOffset, 0, Math.max(0, allLines.length - rows));
		const scrollView = new ScrollView(allLines, {
			height: rows,
			scrollbar: "auto",
			theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
		});
		scrollView.setScrollOffset(this.#submitScrollOffset);
		const rendered = scrollView.render(width);
		const lines = [...rendered];
		while (lines.length < rows) lines.push("");
		return {
			lines: lines.slice(0, rows),
			scrollOffset: this.#submitScrollOffset,
			indicator: this.#clipIndicator(this.#submitScrollOffset, rows, allLines.length),
		};
	}

	#scrollOffsetForCursor(currentOffset: number, cursorLine: number, rows: number, totalRows: number): number {
		if (totalRows <= rows) return 0;
		let nextOffset = clamp(currentOffset, 0, Math.max(0, totalRows - rows));
		if (cursorLine < nextOffset) nextOffset = cursorLine;
		if (cursorLine >= nextOffset + rows) nextOffset = cursorLine - rows + 1;
		return clamp(nextOffset, 0, Math.max(0, totalRows - rows));
	}

	#clipIndicator(offset: number, rows: number, totalRows: number): string {
		const above = offset > 0;
		const below = offset + rows < totalRows;
		if (above && below) return "↕";
		if (above) return "↑";
		if (below) return "↓";
		return "";
	}

	#unansweredCount(): number {
		let count = 0;
		for (let index = 0; index < this.questions.length; index++) {
			const question = this.questions[index];
			const state = this.#states[index];
			if (!question || !state) continue;
			if (state.selectedOptions.size === 0 && state.customInput === undefined) count += 1;
		}
		return count;
	}

	#handleTimeout(): void {
		if (this.#closed) return;
		if (this.#promptActive) {
			this.#timeoutExpired = true;
			return;
		}
		this.options.onTimeout?.();
		for (let index = 0; index < this.questions.length; index++) {
			const question = this.questions[index];
			const state = this.#states[index];
			if (!question || !state) continue;
			if (state.selectedOptions.size === 0 && state.customInput === undefined) {
				const noteMatch = /^option:(\d+)$/.exec(state.noteRowKey ?? "");
				const notedIndex = noteMatch ? Number.parseInt(noteMatch[1], 10) : Number.NaN;
				const fallbackIndex =
					Number.isInteger(notedIndex) && question.options[notedIndex]
						? notedIndex
						: clamp(question.recommended ?? 0, 0, Math.max(0, question.options.length - 1));
				const fallback = question.options[fallbackIndex];
				if (fallback) state.selectedOptions.add(fallback.label);
				state.timedOut = true;
			}
		}
		this.#finishSubmit();
	}

	#runDeferredTimeout(): void {
		if (!this.#timeoutExpired) return;
		this.#timeoutExpired = false;
		this.#handleTimeout();
	}

	#finishSubmit(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#countdown?.dispose();
		this.callbacks.onSubmit({ kind: "submit", results: this.#buildResults() });
	}

	#finishCancel(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#countdown?.dispose();
		this.callbacks.onCancel();
	}

	#buildResults(): ExtensionAskDialogResultItem[] {
		const results: ExtensionAskDialogResultItem[] = [];
		for (let index = 0; index < this.questions.length; index++) {
			const question = this.questions[index];
			const state = this.#states[index];
			if (!question || !state) continue;
			const selectedOptions = question.options
				.map(option => option.label)
				.filter(label => state.selectedOptions.has(label));
			results.push({
				id: question.id,
				question: question.question,
				options: question.options.map(option => option.label),
				multi: question.multi ?? false,
				selectedOptions,
				customInput: state.customInput,
				note: noteForSubmittedAnswer(question, state),
				timedOut: state.timedOut || undefined,
			});
		}
		return results;
	}
}
