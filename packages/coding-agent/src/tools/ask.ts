import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import type { ToolExample } from "@veyyon/ai";
import {
	type Component,
	Ellipsis,
	Markdown,
	type MarkdownTheme,
	renderInlineMarkdown,
	replaceTabs,
	TERMINAL,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@veyyon/tui";
import { clamp, clampLow, collapseWhitespace, formatCount, isCancellation, prompt, untilAborted } from "@veyyon/utils";
import { stripRecommendedSuffix, withRecommendedSuffix } from "@veyyon/wire";
import { type as arkType } from "arktype";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { ExtensionUISelectItem } from "../extensibility/extensions";
import { HOOK_EDITOR_TEXT_PAD_COLS } from "../modes/components/hook-editor";
import { mediumModalContentWidth } from "../modes/components/modal-shell";
import { getMarkdownTheme } from "../modes/theme/markdown-theme";
import { type Theme, theme } from "../modes/theme/theme";
import { toolsPrompts } from "../prompts/tools/rows";
import { vocalizer } from "../tts/vocalizer";
import { framedBlock, renderStatusLine } from "../tui";
import type { ToolSession } from ".";
import { ASK_OTHER_OPTION_LABEL, isReservedAskOptionLabel } from "./ask-option-labels";
import { formatErrorMessage, formatMeta, formatTitle } from "./render-utils";
import { ToolAbortError } from "./tool-errors";

const OptionItem = arkType({
	label: arkType("string").describe("display label"),
	"description?": arkType("string").describe("optional explanatory text displayed below the label"),
	"preview?": arkType("string").describe("optional rich preview content for interactive ask dialogs"),
});

const QuestionItem = arkType({
	id: arkType("string").describe("question id"),
	question: arkType("string").describe("question text"),
	"header?": arkType("string").describe("optional short display chip for rich ask dialogs"),
	options: OptionItem.array().describe("available options"),
	"multi?": arkType("boolean").describe("allow multiple selections"),
	"recommended?": arkType("number").describe("recommended option index"),
}).narrow((question, ctx) => {
	const reserved = question.options.find(option => isReservedAskOptionLabel(option.label));
	return (
		reserved === undefined ||
		ctx.mustBe(`defined with option labels that do not collide with reserved runtime labels: ${reserved.label}`)
	);
});

const askSchema = arkType({
	questions: QuestionItem.array().atLeastLength(1).describe("questions to ask"),
});

export type AskToolInput = typeof askSchema.infer;

export interface QuestionResult {
	id: string;
	question: string;
	options: string[];
	multi: boolean;
	selectedOptions: string[];
	customInput?: string;
	note?: string;
	timedOut?: boolean;
}

export interface AskToolDetails {
	question?: string;
	options?: string[];
	multi?: boolean;
	selectedOptions?: string[];
	customInput?: string;
	note?: string;
	timedOut?: boolean;
	results?: QuestionResult[];
	chatRedirect?: boolean;
	questions?: string[];
}

interface AskOption {
	label: string;
	description?: string;
}

function getAskOptionLabel(option: AskOption): string {
	return option.label;
}

function getSelectOptionLabel(option: ExtensionUISelectItem): string {
	return typeof option === "string" ? option : option.label;
}

function toSelectOption(option: AskOption, label = option.label): ExtensionUISelectItem {
	return option.description ? { label, description: option.description } : label;
}

const TIMEOUT_DETECTION_TOLERANCE_MS = 1_000;

function getDoneOptionLabel(): string {
	return `${theme.status.success} Done selecting`;
}

function addRecommendedSuffix(options: AskOption[], recommendedIndex?: number): ExtensionUISelectItem[] {
	if (recommendedIndex === undefined || recommendedIndex < 0 || recommendedIndex >= options.length) {
		return options.map(option => toSelectOption(option));
	}
	return options.map((option, i) =>
		toSelectOption(option, i === recommendedIndex ? withRecommendedSuffix(option.label) : option.label),
	);
}

function getAutoSelectionOnTimeout(options: AskOption[], recommended?: number): string[] {
	if (options.length === 0) return [];
	if (typeof recommended === "number" && recommended >= 0 && recommended < options.length) {
		return [options[recommended]!.label];
	}
	return [options[0]!.label];
}

interface CustomInputContext {
	selectionMarker: "radio" | "checkbox";
	checkedIndices?: readonly number[];
	markableCount: number;
}

const MAX_CUSTOM_INPUT_OPTION_ROWS = 8;
const MAX_CUSTOM_INPUT_TITLE_ROWS = 16;
const MIN_CUSTOM_INPUT_CONTENT_WIDTH = 20;
const CUSTOM_INPUT_CHROME_COLUMNS = HOOK_EDITOR_TEXT_PAD_COLS * 2;
const CUSTOM_INPUT_DESCRIPTION_INDENT = "    ";

function customInputContentWidth(): number {
	const cols = process.stdout.columns ?? 80;
	const rows = process.stdout.rows || 40;
	const width = mediumModalContentWidth(cols, rows) ?? cols - CUSTOM_INPUT_CHROME_COLUMNS;
	return Math.max(MIN_CUSTOM_INPUT_CONTENT_WIDTH, width);
}

function clampLineToWidth(line: string, width: number): string {
	if (visibleWidth(line) <= width) return line;
	return truncateToWidth(line, width, Ellipsis.Unicode);
}

function flattenDescription(text: string): string {
	return collapseWhitespace(text);
}

function getSelectOptionDescription(option: ExtensionUISelectItem): string | undefined {
	return typeof option === "string" ? undefined : option.description;
}

interface CustomInputOptionGap {
	total: number;
	checked: number;
}

interface CustomInputOptionWindow {
	indices: number[];
	gapBefore: Map<number, CustomInputOptionGap>;
}

function pickCustomInputOptionWindow(
	total: number,
	selectedIndex: number,
	checked: ReadonlySet<number>,
): CustomInputOptionWindow {
	if (total === 0) return { indices: [], gapBefore: new Map() };
	if (total <= MAX_CUSTOM_INPUT_OPTION_ROWS) {
		return {
			indices: Array.from({ length: total }, (_, i) => i),
			gapBefore: new Map(),
		};
	}
	const keep = new Set<number>();
	const addIfRoom = (index: number) => {
		if (index >= 0 && index < total && keep.size < MAX_CUSTOM_INPUT_OPTION_ROWS) {
			keep.add(index);
		}
	};
	addIfRoom(selectedIndex);
	addIfRoom(0);
	for (const i of Array.from(checked).sort((a, b) => a - b)) {
		addIfRoom(i);
	}
	for (let i = 0; i < total && keep.size < MAX_CUSTOM_INPUT_OPTION_ROWS; i++) {
		addIfRoom(i);
	}
	const indices = Array.from(keep).sort((a, b) => a - b);
	const gapBefore = new Map<number, CustomInputOptionGap>();
	const countCheckedBetween = (startInclusive: number, endExclusive: number): number => {
		let count = 0;
		for (const i of checked) {
			if (i >= startInclusive && i < endExclusive) count++;
		}
		return count;
	};
	let prev = -1;
	for (const idx of indices) {
		if (idx > prev + 1) {
			gapBefore.set(idx, {
				total: idx - prev - 1,
				checked: countCheckedBetween(prev + 1, idx),
			});
		}
		prev = idx;
	}
	if (prev < total - 1) {
		gapBefore.set(total, {
			total: total - 1 - prev,
			checked: countCheckedBetween(prev + 1, total),
		});
	}
	return { indices, gapBefore };
}

interface CustomInputRow {
	text: string;
	priority: number;
}

function buildCustomInputRows(
	question: string,
	options: ExtensionUISelectItem[],
	context: CustomInputContext,
	contentWidth: number,
): CustomInputRow[] {
	const selectedIndex = options.findIndex(option => getSelectOptionLabel(option) === ASK_OTHER_OPTION_LABEL);
	const checked = new Set(context.checkedIndices ?? []);
	const window = pickCustomInputOptionWindow(options.length, selectedIndex, checked);
	const rows: CustomInputRow[] = [];
	rows.push({ text: clampLineToWidth(question, contentWidth), priority: -1 });
	rows.push({ text: "", priority: -1 });

	const emitGap = (gap: CustomInputOptionGap) => {
		const checkedSuffix = gap.checked > 0 ? `, ${gap.checked} checked` : "";
		rows.push({
			text: clampLineToWidth(`    … ${formatCount("more option", gap.total)}${checkedSuffix} …`, contentWidth),
			priority: 2,
		});
	};

	for (const index of window.indices) {
		const gap = window.gapBefore.get(index);
		if (gap !== undefined) emitGap(gap);
		const option = options[index]!;
		const label = getSelectOptionLabel(option);
		const isSelected = index === selectedIndex;
		const isMarkable = index < context.markableCount;
		const prefix =
			context.selectionMarker === "radio" && (isMarkable || isSelected)
				? `${isSelected ? theme.radio.selected : theme.radio.unselected} `
				: context.selectionMarker === "checkbox" && isMarkable
					? `${checked.has(index) ? theme.checkbox.checked : theme.checkbox.unchecked} `
					: isSelected
						? `${theme.nav.cursor} `
						: "  ";
		rows.push({ text: clampLineToWidth(prefix + label, contentWidth), priority: -1 });
		const description = getSelectOptionDescription(option);
		if (description) {
			const flat = flattenDescription(description);
			if (flat) {
				rows.push({
					text: clampLineToWidth(`${CUSTOM_INPUT_DESCRIPTION_INDENT}${flat}`, contentWidth),
					priority: isSelected ? 2 : checked.has(index) ? 1 : 0,
				});
			}
		}
	}

	const trailingGap = window.gapBefore.get(options.length);
	if (trailingGap !== undefined) emitGap(trailingGap);
	rows.push({ text: "", priority: -1 });
	rows.push({ text: "Enter your response:", priority: -1 });
	return rows;
}

function applyCustomInputRowBudget(rows: CustomInputRow[], budget: number): CustomInputRow[] {
	if (rows.length <= budget) return rows;
	const droppable = rows
		.map((row, index) => ({ row, index }))
		.filter(entry => entry.row.priority >= 0)
		.sort((a, b) => a.row.priority - b.row.priority || b.index - a.index);
	const removed = new Set<number>();
	for (const { index } of droppable) {
		if (rows.length - removed.size <= budget) break;
		removed.add(index);
	}
	return rows.filter((_, i) => !removed.has(i));
}

function formatCustomInputTitle(
	question: string,
	options: ExtensionUISelectItem[],
	context: CustomInputContext,
): string {
	const contentWidth = customInputContentWidth();
	const rows = buildCustomInputRows(question, options, context, contentWidth);
	return applyCustomInputRowBudget(rows, MAX_CUSTOM_INPUT_TITLE_ROWS)
		.map(row => row.text)
		.join("\n");
}

interface SelectionResult {
	selectedOptions: string[];
	customInput?: string;
	note?: string;
	timedOut: boolean;
	navigation?: "back" | "forward";
	cancelled?: boolean;
}

interface NavigationControls {
	allowBack: boolean;
	allowForward: boolean;
	progressText?: string;
}
interface AskSingleQuestionOptions {
	recommended?: number;
	timeout?: number;
	signal?: AbortSignal;
	initialSelection?: Pick<SelectionResult, "selectedOptions" | "customInput" | "note">;
	navigation?: NavigationControls;
}

interface UIContext {
	timeoutStartsOnPresentation?: boolean;
	select(
		prompt: string,
		options: ExtensionUISelectItem[],
		options_?: {
			initialIndex?: number;
			timeout?: number;
			signal?: AbortSignal;
			onTimeout?: () => void;
			onTimeoutStart?: () => void;
			onTimeoutReset?: () => void;
			onLeft?: () => void;
			onRight?: () => void;
			helpText?: string;
			selectionMarker?: "radio" | "checkbox";
			checkedIndices?: readonly number[];
			markableCount?: number;
		},
	): Promise<string | undefined>;
	editor(
		title: string,
		prefill?: string,
		dialogOptions?: { signal?: AbortSignal },
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined>;
}

async function askSingleQuestion(
	ui: UIContext,
	question: string,
	questionOptions: AskOption[],
	multi: boolean,
	options: AskSingleQuestionOptions = {},
): Promise<SelectionResult> {
	const { recommended, timeout, signal, initialSelection, navigation } = options;
	const doneLabel = getDoneOptionLabel();
	let selectedOptions = [...(initialSelection?.selectedOptions ?? [])];
	let customInput = initialSelection?.customInput;
	const note = initialSelection?.note;
	let timedOut = false;

	const selectOption = async (
		prompt: string,
		optionsToShow: ExtensionUISelectItem[],
		initialIndex?: number,
		marker?: { selectionMarker: "radio" | "checkbox"; checkedIndices?: readonly number[]; markableCount: number },
	): Promise<{ choice: string | undefined; timedOut: boolean; navigation?: "back" | "forward" }> => {
		let timeoutTriggered = false;
		const onTimeout = () => {
			timeoutTriggered = true;
		};
		let navigationAction: "back" | "forward" | undefined;
		const helpText = navigation
			? "up/down navigate  enter select  ←/→ question  esc cancel"
			: "up/down navigate  enter select  esc cancel";
		const timeoutMs = typeof timeout === "number" && timeout > 0 ? timeout : undefined;
		const timeoutController = timeoutMs === undefined ? undefined : new AbortController();
		const dialogSignal =
			signal && timeoutController
				? AbortSignal.any([signal, timeoutController.signal])
				: (timeoutController?.signal ?? signal);
		let timeoutId: NodeJS.Timeout | undefined;
		let timeoutStartedMs = Date.now();
		const armFallbackTimeout = (durationMs: number) => {
			clearTimeout(timeoutId);
			timeoutStartedMs = Date.now();
			timeoutId = setTimeout(() => {
				timeoutTriggered = true;
				timeoutController?.abort();
			}, durationMs);
		};
		const dialogOptions = {
			initialIndex,
			timeout,
			signal: dialogSignal,
			onTimeout,
			onTimeoutStart: timeoutMs === undefined ? undefined : () => armFallbackTimeout(timeoutMs),
			onTimeoutReset: timeoutMs === undefined ? undefined : () => armFallbackTimeout(timeoutMs),
			helpText,
			selectionMarker: marker?.selectionMarker,
			checkedIndices: marker?.checkedIndices,
			markableCount: marker?.markableCount,
			onLeft: navigation?.allowBack
				? () => {
						navigationAction = "back";
					}
				: undefined,
			onRight: navigation?.allowForward
				? () => {
						navigationAction = "forward";
					}
				: undefined,
		};
		try {
			const runSelect = () => {
				const selection = ui.select(prompt, optionsToShow, dialogOptions);
				if (timeoutMs !== undefined && !ui.timeoutStartsOnPresentation) {
					armFallbackTimeout(timeoutMs);
				}
				return selection;
			};
			const choice = dialogSignal ? await untilAborted(dialogSignal, runSelect) : await runSelect();
			if (!timeoutTriggered && choice === undefined && typeof timeout === "number") {
				const elapsed = Date.now() - timeoutStartedMs;
				timeoutTriggered = elapsed >= timeout && elapsed <= timeout + TIMEOUT_DETECTION_TOLERANCE_MS;
			}
			return { choice, timedOut: timeoutTriggered, navigation: navigationAction };
		} catch (error) {
			if (timeoutTriggered && isCancellation(error)) {
				return { choice: undefined, timedOut: true, navigation: navigationAction };
			}
			throw error;
		} finally {
			clearTimeout(timeoutId);
		}
	};

	const promptForCustomInput = async (
		title: string,
		optionsToShow: ExtensionUISelectItem[],
		context: CustomInputContext,
	): Promise<{ input: string | undefined }> => {
		const dialogOptions = signal ? { signal } : undefined;
		const editorTitle = formatCustomInputTitle(title, optionsToShow, context);
		const showCustomInput = () => ui.editor(editorTitle, undefined, dialogOptions, { promptStyle: true });
		const input = signal ? await untilAborted(signal, showCustomInput) : await showCustomInput();
		return { input };
	};

	const promptWithProgress = navigation?.progressText ? `${question} (${navigation.progressText})` : question;
	if (multi) {
		const selected = new Set<string>(selectedOptions);
		let cursorIndex = clamp(recommended ?? 0, 0, Math.max(questionOptions.length - 1, 0));
		const firstSelected = selectedOptions[0];
		if (firstSelected) {
			const selectedIndex = questionOptions.findIndex(option => option.label === firstSelected);
			if (selectedIndex >= 0) cursorIndex = selectedIndex;
		}
		while (true) {
			const opts: ExtensionUISelectItem[] = questionOptions.map(opt => toSelectOption(opt));

			if (!navigation?.allowForward && selected.size > 0) {
				opts.push(doneLabel);
			}
			opts.push(ASK_OTHER_OPTION_LABEL);

			const checkedIndices: number[] = [];
			for (let i = 0; i < questionOptions.length; i++) {
				if (selected.has(questionOptions[i]!.label)) checkedIndices.push(i);
			}
			const prefix = selected.size > 0 ? `(${selected.size} selected) ` : "";
			const {
				choice,
				timedOut: selectTimedOut,
				navigation: arrowNavigation,
			} = await selectOption(`${prefix}${promptWithProgress}`, opts, cursorIndex, {
				selectionMarker: "checkbox",
				checkedIndices,
				markableCount: questionOptions.length,
			});

			if (arrowNavigation) {
				return { selectedOptions: Array.from(selected), customInput, note, timedOut, navigation: arrowNavigation };
			}
			if (choice === undefined) {
				if (selectTimedOut) {
					timedOut = true;
					break;
				}
				return { selectedOptions: Array.from(selected), customInput, note, timedOut, cancelled: true };
			}
			if (choice === doneLabel) break;

			if (choice === ASK_OTHER_OPTION_LABEL) {
				if (selectTimedOut) {
					timedOut = true;
					break;
				}
				const customResult = await promptForCustomInput(`${prefix}${promptWithProgress}`, opts, {
					selectionMarker: "checkbox",
					checkedIndices,
					markableCount: questionOptions.length,
				});
				if (customResult.input === undefined) {
					continue;
				}
				customInput = customResult.input;
				break;
			}

			const selectedIdx = opts.findIndex(opt => getSelectOptionLabel(opt) === choice);
			if (selectedIdx >= 0) {
				cursorIndex = selectedIdx;
			}

			if (selected.has(choice)) {
				selected.delete(choice);
			} else {
				selected.add(choice);
			}

			if (selectTimedOut) {
				timedOut = true;
				break;
			}
		}
		selectedOptions = Array.from(selected);
	} else {
		while (true) {
			const displayOptions = addRecommendedSuffix(questionOptions, recommended);
			const optionsWithNavigation: ExtensionUISelectItem[] = displayOptions.concat([ASK_OTHER_OPTION_LABEL]);

			let initialIndex = recommended;
			const previouslySelected = selectedOptions[0];
			if (previouslySelected) {
				const selectedIndex = questionOptions.findIndex(option => option.label === previouslySelected);
				if (selectedIndex >= 0) initialIndex = selectedIndex;
			} else if (customInput !== undefined) {
				initialIndex = displayOptions.length;
			}
			if (initialIndex !== undefined) {
				const maxIndex = Math.max(optionsWithNavigation.length - 1, 0);
				initialIndex = clampLow(initialIndex, 0, maxIndex);
			}

			const {
				choice,
				timedOut: selectTimedOut,
				navigation: arrowNavigation,
			} = await selectOption(promptWithProgress, optionsWithNavigation, initialIndex, {
				selectionMarker: "radio",
				markableCount: displayOptions.length,
			});
			timedOut = selectTimedOut;

			if (arrowNavigation) {
				return { selectedOptions, customInput, note, timedOut, navigation: arrowNavigation };
			}
			if (choice === undefined) {
				if (!timedOut) {
					return { selectedOptions, customInput, note, timedOut, cancelled: true };
				}
				break;
			}
			if (choice === ASK_OTHER_OPTION_LABEL) {
				if (selectTimedOut) {
					break;
				}
				const customResult = await promptForCustomInput(promptWithProgress, optionsWithNavigation, {
					selectionMarker: "radio",
					markableCount: displayOptions.length,
				});
				if (customResult.input === undefined) {
					continue;
				}
				customInput = customResult.input;
				selectedOptions = [];
				break;
			}
			selectedOptions = [stripRecommendedSuffix(choice)];
			customInput = undefined;
			break;
		}
		if (timedOut && selectedOptions.length === 0 && customInput === undefined) {
			selectedOptions = getAutoSelectionOnTimeout(questionOptions, recommended);
		}
		if (navigation?.allowForward) {
			return { selectedOptions, customInput, note, timedOut, navigation: "forward" };
		}
	}

	if (timedOut && selectedOptions.length === 0 && customInput === undefined) {
		selectedOptions = getAutoSelectionOnTimeout(questionOptions, recommended);
	}

	return { selectedOptions, customInput, note, timedOut };
}

function formatQuestionResult(result: QuestionResult): string {
	const noteSuffix = result.note ? ` (note: ${result.note})` : "";
	if (result.customInput !== undefined) {
		return `${result.id}: "${result.customInput}"${noteSuffix}`;
	}
	if (result.selectedOptions.length > 0) {
		const suffix = `${result.timedOut ? " (auto-selected after timeout)" : ""}${noteSuffix}`;
		return result.multi
			? `${result.id}: [${result.selectedOptions.join(", ")}]${suffix}`
			: `${result.id}: ${result.selectedOptions[0]}${suffix}`;
	}
	return `${result.id}: (cancelled)${noteSuffix}`;
}

function formatSingleQuestionResponse(result: {
	selectedOptions: string[];
	customInput?: string;
	note?: string;
	timedOut?: boolean;
	multi: boolean;
}): string {
	const responseParts: string[] = [];
	if (result.selectedOptions.length > 0) {
		const selectedText = result.multi
			? `User selected: ${result.selectedOptions.join(", ")}`
			: `User selected: ${result.selectedOptions[0]}`;
		responseParts.push(result.timedOut ? `${selectedText} (auto-selected after timeout)` : selectedText);
	}
	if (result.customInput !== undefined) {
		responseParts.push(
			result.customInput.includes("\n")
				? `User provided custom input:\n${result.customInput
						.split("\n")
						.map(line => `  ${line}`)
						.join("\n")}`
				: `User provided custom input: ${result.customInput}`,
		);
	}
	if (result.note) {
		responseParts.push(
			result.note.includes("\n")
				? `User added note:\n${result.note
						.split("\n")
						.map(line => `  ${line}`)
						.join("\n")}`
				: `User added note: ${result.note}`,
		);
	}
	return responseParts.length > 0 ? responseParts.join("\n") : "User cancelled the selection";
}

type AskParams = AskToolInput;

export class AskTool implements AgentTool<typeof askSchema, AskToolDetails> {
	readonly name = "ask";
	readonly approval = "read" as const;
	readonly label = "Ask";
	readonly summary = "Ask the user a clarifying question";
	readonly description: string;
	readonly parameters = askSchema;
	readonly strict = true;

	readonly examples: readonly ToolExample<typeof askSchema.infer>[] = [
		{
			caption: "Single question",
			call: {
				questions: [
					{
						id: "auth_method",
						question: "Which authentication method should this API use?",
						options: [
							{ label: "JWT", description: "Bearer tokens for stateless API clients." },
							{ label: "OAuth2", description: "Delegated authorization with external identity providers." },
							{
								label: "Session cookies",
								description: "Browser-first authentication backed by server-side sessions.",
							},
						],
						recommended: 0,
					},
				],
			},
		},
		{
			caption: "Multiple questions",
			call: {
				questions: [
					{
						id: "storage_type",
						question: "Which storage backend?",
						options: [{ label: "SQLite" }, { label: "PostgreSQL" }],
					},
					{
						id: "auth_method",
						question: "Which auth method?",
						options: [{ label: "JWT" }, { label: "Session cookies" }],
					},
				],
			},
		},
	];
	readonly concurrency = "exclusive";
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(toolsPrompts["tools/ask"].text);
	}

	static createIf(session: ToolSession): AskTool | null {
		return session.hasUI ? new AskTool(session) : null;
	}

	#sendAskNotification(): void {
		const method = this.session.settings.get("ask.notify");
		if (method === "off") return;
		TERMINAL.sendNotification({
			title: "Veyyon",
			body: "Waiting for input",
			type: "ask",
			urgency: "normal",
			actions: "focus",
		});
	}

	async execute(
		_toolCallId: string,
		params: AskParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AskToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<AskToolDetails>> {
		if (!context?.hasUI || !context.ui) {
			context?.abort();
			throw new ToolAbortError("Ask tool requires interactive mode");
		}

		const extensionUi = context.ui;
		const ui: UIContext = {
			timeoutStartsOnPresentation: extensionUi.timeoutStartsOnPresentation,
			select: (prompt, options, dialogOptions) => extensionUi.select(prompt, options, dialogOptions),
			editor: (title, prefill, dialogOptions, editorOptions) =>
				extensionUi.editor(title, prefill, dialogOptions, editorOptions),
		};

		const planModeEnabled = this.session.getPlanModeState?.()?.enabled ?? false;
		const timeoutSeconds = this.session.settings.get("ask.timeout");
		const settingsTimeout = timeoutSeconds === 0 ? null : timeoutSeconds * 1000;
		const timeout = planModeEnabled ? null : settingsTimeout;

		if (params.questions.length === 0) {
			return {
				isError: true,
				content: [
					{
						type: "text" as const,
						text: "The ask tool was called with no questions, so nothing was shown to the user. Call it again with at least one question, or ask in your reply instead.",
					},
				],
				details: {},
			};
		}

		this.#sendAskNotification();

		if (this.session.settings.get("speech.enabled")) {
			vocalizer.speak(params.questions.map(q => q.question).join("\n"));
		}

		const richAskDialog = extensionUi.askDialog;
		if (richAskDialog) {
			try {
				const showRichDialog = () =>
					richAskDialog(
						params.questions.map(q => ({
							id: q.id,
							question: q.question,
							...(q.header?.trim() ? { header: q.header } : {}),
							options: q.options.map(option => ({
								label: option.label,
								...(option.description?.trim() ? { description: option.description.trim() } : {}),
								...(option.preview?.trim() ? { preview: option.preview } : {}),
							})),
							...(q.multi !== undefined ? { multi: q.multi } : {}),
							...(q.recommended !== undefined ? { recommended: q.recommended } : {}),
						})),
						{ timeout: timeout ?? undefined, signal },
					);
				const richResult = signal ? await untilAborted(signal, showRichDialog) : await showRichDialog();
				if (!richResult) {
					context.abort();
					throw new ToolAbortError("Ask tool was cancelled by the user");
				}
				if (richResult.kind === "chat") {
					const questionText = params.questions.map(q => q.question).join("\n");
					return {
						content: [
							{
								type: "text" as const,
								text: `User chose to chat about this instead of answering.\n\nQuestions asked:\n${questionText}`,
							},
						],
						details: { chatRedirect: true, questions: params.questions.map(q => q.question) },
					};
				}
				if (richResult.results.length !== params.questions.length) {
					throw new Error("Ask dialog returned a result count that does not match the requested questions");
				}
				const results: QuestionResult[] = [];
				for (let index = 0; index < params.questions.length; index++) {
					const question = params.questions[index];
					const result = richResult.results[index];
					if (!question || !result || result.id !== question.id) {
						throw new Error("Ask dialog returned results that do not match the requested question order");
					}
					results.push({
						id: question.id,
						question: question.question,
						options: question.options.map(option => option.label),
						multi: question.multi ?? false,
						selectedOptions: result.selectedOptions,
						customInput: result.customInput,
						note: result.note,
						timedOut: result.timedOut,
					});
				}
				if (params.questions.length === 1) {
					const result = results[0];
					if (
						!result ||
						(!result.timedOut && result.selectedOptions.length === 0 && result.customInput === undefined)
					) {
						context.abort();
						throw new ToolAbortError("Ask tool was cancelled by the user");
					}
					const details: AskToolDetails = {
						question: result.question,
						options: result.options,
						multi: result.multi,
						selectedOptions: result.selectedOptions,
						customInput: result.customInput,
						note: result.note,
						timedOut: result.timedOut,
					};
					const responseText = formatSingleQuestionResponse(result);
					return { content: [{ type: "text" as const, text: responseText }], details };
				}
				const details: AskToolDetails = { results };
				const responseText = `User answers:\n${results.map(formatQuestionResult).join("\n")}`;
				return { content: [{ type: "text" as const, text: responseText }], details };
			} catch (error) {
				if (isCancellation(error)) {
					throw new ToolAbortError("Ask input was cancelled");
				}
				throw error;
			}
		}

		const askQuestion = async (
			q: AskParams["questions"][number],
			options?: { previous?: QuestionResult; navigation?: NavigationControls },
		) => {
			const questionOptions = q.options.map(option => ({
				label: option.label,
				...(option.description?.trim() ? { description: option.description.trim() } : {}),
			}));
			const optionLabels = questionOptions.map(getAskOptionLabel);
			try {
				const { selectedOptions, customInput, note, navigation, cancelled, timedOut } = await askSingleQuestion(
					ui,
					q.question,
					questionOptions,
					q.multi ?? false,
					{
						recommended: q.recommended,
						timeout: timeout ?? undefined,
						signal,
						initialSelection: options?.previous,
						navigation: options?.navigation,
					},
				);
				return { optionLabels, selectedOptions, customInput, note, navigation, cancelled, timedOut };
			} catch (error) {
				if (isCancellation(error)) {
					throw new ToolAbortError("Ask input was cancelled");
				}
				throw error;
			}
		};

		if (params.questions.length === 1) {
			const [q] = params.questions;
			const { optionLabels, selectedOptions, customInput, note, cancelled, timedOut } = await askQuestion(q);

			if (!timedOut && (cancelled || (selectedOptions.length === 0 && customInput === undefined))) {
				context.abort();
				throw new ToolAbortError("Ask tool was cancelled by the user");
			}
			const details: AskToolDetails = {
				question: q.question,
				options: optionLabels,
				multi: q.multi ?? false,
				selectedOptions,
				customInput,
				note,
				timedOut: timedOut || undefined,
			};

			const responseText = formatSingleQuestionResponse({
				selectedOptions,
				customInput,
				note,
				timedOut: timedOut || undefined,
				multi: q.multi ?? false,
			});

			return { content: [{ type: "text" as const, text: responseText }], details };
		}

		const resultsByIndex: Array<QuestionResult | undefined> = Array.from({ length: params.questions.length });
		let questionIndex = 0;
		while (questionIndex < params.questions.length) {
			const q = params.questions[questionIndex];
			if (!q) throw new Error("Ask question index exceeded the requested question list");
			const previous = resultsByIndex[questionIndex];
			const navigation: NavigationControls = {
				allowBack: questionIndex > 0,
				allowForward: true,
				progressText: `${questionIndex + 1}/${params.questions.length}`,
			};
			const {
				optionLabels,
				selectedOptions,
				customInput,
				note,
				navigation: navAction,
				cancelled,
				timedOut,
			} = await askQuestion(q, { previous, navigation });

			if (cancelled && !timedOut) {
				context.abort();
				throw new ToolAbortError("Ask tool was cancelled by the user");
			}

			resultsByIndex[questionIndex] = {
				id: q.id,
				question: q.question,
				options: optionLabels,
				multi: q.multi ?? false,
				selectedOptions,
				customInput,
				note,
				timedOut: timedOut || undefined,
			};

			if (navAction === "back") {
				questionIndex = Math.max(0, questionIndex - 1);
				continue;
			}

			questionIndex += 1;
		}

		const results = params.questions.map((q, index) => {
			const result = resultsByIndex[index];
			if (result) return result;
			return {
				id: q.id,
				question: q.question,
				options: q.options.map(o => o.label),
				multi: q.multi ?? false,
				selectedOptions: [],
			};
		});

		const details: AskToolDetails = { results };
		const responseLines = results.map(formatQuestionResult);
		const responseText = `User answers:\n${responseLines.join("\n")}`;

		return { content: [{ type: "text" as const, text: responseText }], details };
	}
}

interface AskRenderOption {
	label: string;
	description?: string;
}

interface AskRenderArgs {
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

function renderCustomInputLines(uiTheme: Theme, customInput: string): string[] {
	const lines = customInput.split("\n");
	const out: string[] = [
		` ${uiTheme.styledSymbol("status.success", "success")} ${uiTheme.fg("toolOutput", lines[0] ?? "")}`,
	];
	for (let i = 1; i < lines.length; i++) out.push(`   ${uiTheme.fg("toolOutput", lines[i])}`);
	return out;
}

function renderNoteLines(uiTheme: Theme, note: string, width: number): string[] {
	const prefix = " Note: ";
	const continuationPrefix = "       ";
	const firstLineWidth = Math.max(1, width - visibleWidth(prefix));
	const continuationWidth = Math.max(1, width - visibleWidth(continuationPrefix));
	const noteLines = replaceTabs(note).split("\n");
	const result: string[] = new Array(noteLines.length);
	for (let li = 0; li < noteLines.length; li++) {
		const linePrefix = li === 0 ? `${uiTheme.fg("dim", " Note:")} ` : continuationPrefix;
		const maxWidth = li === 0 ? firstLineWidth : continuationWidth;
		result[li] = `${linePrefix}${uiTheme.fg("toolOutput", truncateToWidth(noteLines[li]!, maxWidth))}`;
	}
	return result;
}

function optionMarker(uiTheme: Theme, multi: boolean | undefined, selected: boolean): string {
	if (multi) return selected ? uiTheme.checkbox.checked : uiTheme.checkbox.unchecked;
	return selected ? uiTheme.radio.selected : uiTheme.radio.unselected;
}

function renderQuestionOptionLines(
	uiTheme: Theme,
	mdTheme: MarkdownTheme,
	options: AskRenderOption[],
	multi: boolean | undefined,
): string[] {
	const out: string[] = [];
	for (const opt of options) {
		const optLabel = renderInlineMarkdown(opt.label, mdTheme, t => uiTheme.fg("muted", t));
		out.push(` ${uiTheme.fg("dim", optionMarker(uiTheme, multi, false))} ${optLabel}`);
		if (opt.description?.trim()) {
			const description = renderInlineMarkdown(opt.description.trim(), mdTheme, t => uiTheme.fg("dim", t));
			out.push(`   ${uiTheme.fg("dim", "↳")} ${description}`);
		}
	}
	return out;
}

function renderAnswerOptionLines(
	uiTheme: Theme,
	mdTheme: MarkdownTheme,
	options: string[] | undefined,
	selectedOptions: string[] | undefined,
	multi: boolean | undefined,
	customInput: string | undefined,
	note: string | undefined,
	width: number,
): string[] {
	const selected = new Set(selectedOptions ?? []);
	const list = options && options.length > 0 ? options : (selectedOptions ?? []);

	if (selected.size === 0 && customInput === undefined && note === undefined) {
		return [` ${uiTheme.styledSymbol("status.warning", "warning")} ${uiTheme.fg("warning", "Cancelled")}`];
	}

	const out: string[] = [];
	for (const label of list) {
		const isSelected = selected.has(label);
		const marker = optionMarker(uiTheme, multi, isSelected);
		const markerStyled = isSelected ? uiTheme.fg("success", marker) : uiTheme.fg("dim", marker);
		const labelStyled = renderInlineMarkdown(label, mdTheme, t =>
			isSelected ? uiTheme.fg("toolOutput", t) : uiTheme.fg("muted", t),
		);
		out.push(` ${markerStyled} ${labelStyled}`);
	}
	if (customInput !== undefined) {
		const cl = renderCustomInputLines(uiTheme, customInput);
		for (let li = 0; li < cl.length; li++) out.push(cl[li]!);
	}
	if (note !== undefined) {
		const nl = renderNoteLines(uiTheme, note, width);
		for (let li = 0; li < nl.length; li++) out.push(nl[li]!);
	}
	return out;
}

export const askToolRenderer = {
	mergeCallAndResult: true,
	callIsLiveWidget: true,
	renderCall(args: AskRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const label = formatTitle("Ask", uiTheme);
		const mdTheme = getMarkdownTheme();
		const accentStyle = { color: (t: string) => uiTheme.fg("accent", t) };
		const md = (text: string, width: number) =>
			new Markdown(text, 1, 0, mdTheme, accentStyle).render(Math.max(1, width - 3 + 1));

		const questions = normalizeRenderQuestions(args.questions);
		if (questions && questions.length > 0) {
			const header = `${label} ${uiTheme.fg("muted", `${questions.length} questions`)}`;
			return framedBlock(uiTheme, width => {
				const sections: Array<{ label?: string; lines: readonly string[]; separator?: boolean }> = new Array(
					questions.length,
				);
				for (let qi = 0; qi < questions.length; qi++) {
					const q = questions[qi]!;
					const meta: string[] = [];
					if (q.multi) meta.push("multi");
					if (q.options?.length) meta.push(`options:${q.options.length}`);
					const metaStr = meta.length > 0 ? uiTheme.fg("dim", ` · ${meta.join(" · ")}`) : "";
					const mdLines = md(q.question, width);
					const lines = q.options?.length
						? mdLines.concat(renderQuestionOptionLines(uiTheme, mdTheme, q.options, q.multi))
						: mdLines;
					sections[qi] = { label: `${uiTheme.fg("dim", `[${q.id}]`)}${metaStr}`, lines };
				}
				return { header, sections, state: "pending", borderColor: "borderMuted", width };
			});
		}

		if (typeof args.question !== "string" || !args.question) {
			const errorLine = formatErrorMessage("No question provided", uiTheme);
			return framedBlock(uiTheme, width => ({
				header: errorLine,
				sections: [],
				state: "error",
				borderColor: "error",
				width,
			}));
		}

		const question = args.question;
		const meta: string[] = [];
		if (args.multi) meta.push("multi");
		const questionOptions = normalizeRenderOptions(args.options);
		if (questionOptions?.length) meta.push(`options:${questionOptions.length}`);
		const header = `${label}${formatMeta(meta, uiTheme)}`;
		const multi = args.multi;
		return framedBlock(uiTheme, width => {
			const mdLines = md(question, width);
			const bodyLines = questionOptions?.length
				? mdLines.concat(renderQuestionOptionLines(uiTheme, mdTheme, questionOptions, multi))
				: mdLines;
			return {
				header,
				sections: bodyLines.length > 0 ? [{ lines: bodyLines }] : [],
				state: "pending",
				borderColor: "borderMuted",
				width,
			};
		});
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: AskToolDetails },
		_options: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		const { details } = result;
		const mdTheme = getMarkdownTheme();
		const accentStyle = { color: (t: string) => uiTheme.fg("accent", t) };
		const md = (text: string, width: number) =>
			new Markdown(text, 1, 0, mdTheme, accentStyle).render(Math.max(1, width - 3 + 1));

		if (!details) {
			const txt = result.content[0];
			const fallback = txt?.type === "text" && txt.text ? txt.text : "";
			const header = renderStatusLine({ icon: "warning", title: "Ask" }, uiTheme);
			const body = fallback ? `\n${uiTheme.fg("dim", fallback)}` : "";
			return new Text(`${header}${body}`, 0, 0);
		}

		if (details.chatRedirect) {
			const header = renderStatusLine({ icon: "info", title: "Ask", meta: ["chat redirect"] }, uiTheme);
			const questions = details.questions ?? [];
			return framedBlock(uiTheme, width => {
				const lines: string[] = [];
				for (let qi = 0; qi < questions.length; qi++) {
					const mdLines = md(questions[qi]!, width);
					for (let li = 0; li < mdLines.length; li++) lines.push(mdLines[li]!);
				}
				return {
					header,
					sections: questions.length > 0 ? [{ lines }] : [],
					state: "warning",
					borderColor: "borderMuted",
					width,
				};
			});
		}

		if (details.results && details.results.length > 0) {
			const results = details.results;
			const hasAnySelection = results.some(
				r =>
					r.customInput !== undefined ||
					r.note !== undefined ||
					(r.selectedOptions && r.selectedOptions.length > 0),
			);
			const header = renderStatusLine(
				{
					icon: hasAnySelection ? "success" : "warning",
					title: "Ask",
					meta: [`${results.length} questions`],
				},
				uiTheme,
			);
			return framedBlock(uiTheme, width => {
				const sections: Array<{ label?: string; lines: readonly string[]; separator?: boolean }> = new Array(
					results.length,
				);
				for (let ri = 0; ri < results.length; ri++) {
					const r = results[ri]!;
					const lines = [
						...md(r.question, width),
						...renderAnswerOptionLines(
							uiTheme,
							mdTheme,
							r.options,
							r.selectedOptions,
							r.multi,
							r.customInput,
							r.note,
							width,
						),
					];
					sections[ri] = { label: uiTheme.fg("dim", `[${r.id}]`), lines };
				}
				return {
					header,
					sections,
					state: hasAnySelection ? "success" : "warning",
					borderColor: "borderMuted",
					width,
				};
			});
		}

		if (!details.question) {
			const txt = result.content[0];
			const fallback = txt?.type === "text" && txt.text ? txt.text : "";
			return new Text(fallback, 0, 0);
		}

		const question = details.question;
		const hasSelection =
			details.customInput !== undefined ||
			details.note !== undefined ||
			(details.selectedOptions && details.selectedOptions.length > 0);
		const header = renderStatusLine(
			hasSelection
				? { iconOverride: uiTheme.styledSymbol("tool.ask", "accent"), title: "Ask" }
				: { icon: "warning", title: "Ask" },
			uiTheme,
		);
		const dOptions = details.options;
		const dSelected = details.selectedOptions;
		const dMulti = details.multi;
		const dCustom = details.customInput;
		const dNote = details.note;
		const dTimedOut = details.timedOut;
		return framedBlock(uiTheme, width => {
			const bodyLines = [
				...md(question, width),
				...renderAnswerOptionLines(uiTheme, mdTheme, dOptions, dSelected, dMulti, dCustom, dNote, width),
			];
			if (dTimedOut) {
				bodyLines.push(uiTheme.fg("dim", "auto-selected after timeout — not a user choice"));
			}
			return {
				header,
				sections: bodyLines.length > 0 ? [{ lines: bodyLines }] : [],
				state: hasSelection ? "success" : "warning",
				borderColor: "borderMuted",
				width,
			};
		});
	},
};
