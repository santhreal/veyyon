import { Ellipsis, truncateToWidth, visibleWidth } from "@veyyon/tui";
import { clamp, clampLow, collapseWhitespace, formatCount, isCancellation, untilAborted } from "@veyyon/utils";
import { stripRecommendedSuffix, withRecommendedSuffix } from "@veyyon/wire";
import { type as arkType } from "arktype";
import type { ExtensionUISelectItem } from "../extensibility/extensions";
import { HOOK_EDITOR_TEXT_PAD_COLS } from "../modes/components/hook-editor";
import { mediumModalContentWidth } from "../modes/components/modal-shell";
import { theme } from "../modes/theme/theme";
import { ASK_OTHER_OPTION_LABEL, isReservedAskOptionLabel } from "./ask-option-labels";

export const OptionItem = arkType({
	label: arkType("string").describe("display label"),
	"description?": arkType("string").describe("optional explanatory text displayed below the label"),
	"preview?": arkType("string").describe("optional rich preview content for interactive ask dialogs"),
});

export const QuestionItem = arkType({
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

export const askSchema = arkType({
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

export interface AskOption {
	label: string;
	description?: string;
}

export function getAskOptionLabel(option: AskOption): string {
	return option.label;
}

function getSelectOptionLabel(option: ExtensionUISelectItem): string {
	return typeof option === "string" ? option : option.label;
}

function toSelectOption(option: AskOption, label = option.label): ExtensionUISelectItem {
	return option.description ? { label, description: option.description } : label;
}

export const TIMEOUT_DETECTION_TOLERANCE_MS = 1_000;

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

export interface CustomInputContext {
	selectionMarker: "radio" | "checkbox";
	checkedIndices?: readonly number[];
	markableCount: number;
}

export const MAX_CUSTOM_INPUT_OPTION_ROWS = 8;
export const MAX_CUSTOM_INPUT_TITLE_ROWS = 16;
export const MIN_CUSTOM_INPUT_CONTENT_WIDTH = 20;
export const CUSTOM_INPUT_CHROME_COLUMNS = HOOK_EDITOR_TEXT_PAD_COLS * 2;
export const CUSTOM_INPUT_DESCRIPTION_INDENT = "    ";

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

export interface CustomInputOptionGap {
	total: number;
	checked: number;
}

export interface CustomInputOptionWindow {
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

export interface CustomInputRow {
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

export interface SelectionResult {
	selectedOptions: string[];
	customInput?: string;
	note?: string;
	timedOut: boolean;
	navigation?: "back" | "forward";
	cancelled?: boolean;
}

export interface NavigationControls {
	allowBack: boolean;
	allowForward: boolean;
	progressText?: string;
}
export interface AskSingleQuestionOptions {
	recommended?: number;
	timeout?: number;
	signal?: AbortSignal;
	initialSelection?: Pick<SelectionResult, "selectedOptions" | "customInput" | "note">;
	navigation?: NavigationControls;
}

export interface UIContext {
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

export async function askSingleQuestion(
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
