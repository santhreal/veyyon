import {
	type Component,
	clamp,
	Ellipsis,
	HoverFade,
	matchesKey,
	padding,
	routeSgrMouseInput,
	ScrollView,
	type Tab,
	TabBar,
	truncateToWidth,
	visibleWidth,
} from "@veyyon/tui";
import { clampLow, formatCount, formatMoreLines } from "@veyyon/utils";
import { withRecommendedSuffix } from "@veyyon/wire";
import type { ExtensionAskDialogQuestion, ExtensionAskDialogResultItem } from "../../extensibility/extensions";
import { ASK_OTHER_OPTION_LABEL } from "../../tools/ask-option-labels";
import { getTabBarTheme } from "../shared";
import { getMarkdownTheme } from "../theme/markdown-theme";
import { setShimmerActivity } from "../theme/shimmer";
import { theme } from "../theme/theme-binding";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../utils/keybinding-matchers";
import {
	assertRenderableAskQuestions,
	boundPromptTitle,
	CHROME_ROWS,
	clearNoteIfRow,
	clearNoteUnlessRow,
	MIN_BODY_ROWS,
	normalizedInlineInput,
	noteForSubmittedAnswer,
	PREVIEW_MIN_WIDTH,
	questionTabLabel,
	renderAnswerSummary,
	renderPreviewContent,
	renderQuestionTitle,
	renderRowLabel,
	SIDE_BY_SIDE_GAP_WIDTH,
	SIDE_BY_SIDE_LIST_MIN_WIDTH,
	SUBMIT_OPTION,
} from "./ask-dialog-helpers";
import { CountdownTimer } from "./countdown-timer";
import {
	computeModalDims,
	consumeModalChipHover,
	hitTestModalChrome,
	MODAL_SIZING_LARGE,
	type ModalShellGeometry,
	type ModalShortcut,
	pointerMotionEnabled,
	renderModalShell,
} from "./modal-shell";
import { handleTabSwitchKey, hoverBandAt, SCROLL_LIST_THEME } from "./selector-helpers";

export { boundPromptTitle };

import type {
	AskDialogCallbacks,
	AskDialogOptions,
	QuestionRow,
	QuestionState,
	RenderedList,
} from "./ask-dialog-helpers";

export class AskDialogComponent implements Component {
	#states: QuestionState[];
	#activeTabIndex = 0;
	#submitScrollOffset = 0;
	#hoveredRowIndex: number | null = null;
	#hoveredTabId: string | null = null;
	#hoverFade: HoverFade | undefined;
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
		setShimmerActivity("ask");
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
		this.#countdown?.dispose();
		this.#hoverFade?.dispose();
		this.#hoverFade = undefined;
		this.#hoveredRowIndex = null;
		setShimmerActivity("idle");
	}

	setOnRequestRender(callback: () => void): void {
		this.#onRequestRenderExternal = callback;
		this.#hoverFade?.dispose();
		this.#hoverFade = new HoverFade({ requestRender: callback, enabled: pointerMotionEnabled() });
		if (this.#hoveredRowIndex !== null) this.#hoverFade.set(this.#hoveredRowIndex);
	}

	handleInput(keyData: string): void {
		if (keyData.startsWith("\x1b[<")) {
			this.#handleMouse(keyData);
			return;
		}
		if (this.#closed || this.#promptActive) return;
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
		const bodyRows = Math.max(MIN_BODY_ROWS, (dims?.modalHeight ?? termHeight) - headerLines.length - CHROME_ROWS);
		const bodyLines = this.#isSubmitTab()
			? this.#renderSubmitBody(contentWidth, bodyRows)
			: this.#renderQuestionBody(contentWidth, bodyRows);

		const shell = renderModalShell({
			title: this.#titleText(),
			sizing,
			areaWidth: width,
			areaHeight: termHeight,
			body: headerLines.concat(bodyLines.lines),
			shortcuts: this.#buildShortcuts(bodyLines.indicator),
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});
		this.#shellGeometry = shell.geometry;
		this.#listPointerMap =
			bodyLines.lineStarts !== undefined && bodyLines.lineCount !== undefined
				? {
						frameStart: (shell.geometry?.bodyRowStart ?? 0) + headerLines.length,
						lineStarts: bodyLines.lineStarts,
						lineCount: bodyLines.lineCount,
						scrollOffset: bodyLines.scrollOffset,
					}
				: null;
		return shell.lines;
	}

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
			const geometry = this.#shellGeometry;
			const tabBar = this.#tabBar;
			const hoveredTab =
				tabBar && geometry && event.row >= geometry.bodyRowStart
					? tabBar.tabAt(event.row - geometry.bodyRowStart, event.col - (geometry.leftPad + 2))
					: undefined;
			const hoveredTabId = hoveredTab && !hoveredTab.muted ? hoveredTab.id : null;
			if (hoveredTabId !== this.#hoveredTabId) {
				this.#hoveredTabId = hoveredTabId;
				tabBar?.setHoverTab(hoveredTabId);
				this.#requestRender();
			}
			if (event.leftClick && hoveredTab && !hoveredTab.muted) {
				this.#selectTabId(hoveredTab.id);
				this.#requestRender();
				return true;
			}
			const map = this.#listPointerMap;
			const local = map ? event.row - map.frameStart + map.scrollOffset : -1;
			let rowIndex: number | null = null;
			if (map && local >= 0 && local < map.lineCount) {
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
					this.#hoverFade?.set(rowIndex);
					this.#requestRender();
				}
				return true;
			}
			if (event.leftClick && rowIndex !== null) {
				const active = this.#activeQuestionState();
				if (active) {
					active.state.cursorIndex = rowIndex;
					this.#hoveredRowIndex = null;
					this.#hoverFade?.set(null);
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
			const questionTabs: Tab[] = new Array<Tab>(this.questions.length + 1);
			for (let qi = 0; qi < this.questions.length; qi++) {
				questionTabs[qi] = { id: String(qi), label: questionTabLabel(this.questions[qi]!, qi) };
			}
			questionTabs[this.questions.length] = { id: "submit", label: "Submit" };
			const tabs: Tab[] = questionTabs;
			this.#tabBar = new TabBar("", tabs, getTabBarTheme(), this.#activeTabIndex);
			this.#tabBar.showHint = false;
			if (this.#hoveredTabId !== null) this.#tabBar.setHoverTab(this.#hoveredTabId);
			const tbLines = this.#tabBar.render(width);
			for (let li = 0; li < tbLines.length; li++) lines.push(tbLines[li]!);
		}
		if (this.#isSubmitTab()) {
			lines.push(theme.bold(theme.fg("accent", "Review answers")));
			return lines;
		}
		const questionIndex = this.#currentQuestionIndex();
		const question = this.questions[questionIndex];
		if (!question) return lines;
		const rl = renderQuestionTitle(question, width);
		for (let li = 0; li < rl.length; li++) lines.push(rl[li]!);
		return lines;
	}

	#questionRows(question: ExtensionAskDialogQuestion): QuestionRow[] {
		const rows: QuestionRow[] = new Array<QuestionRow>(question.options.length + 1);
		for (let oi = 0; oi < question.options.length; oi++) {
			rows[oi] = {
				kind: "option",
				key: `option:${oi}`,
				label: this.#optionLabel(question, question.options[oi]!.label, oi),
				optionIndex: oi,
			};
		}
		rows[question.options.length] = {
			kind: "other",
			key: "other",
			label: ASK_OTHER_OPTION_LABEL,
			optionIndex: undefined,
		};
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

	#selectTabId(id: string): void {
		const index = id === "submit" ? this.#submitTabIndex() : Number.parseInt(id, 10);
		if (!Number.isInteger(index) || index < 0 || index > this.#submitTabIndex()) return;
		if (index === this.#activeTabIndex) return;
		this.#activeTabIndex = index;
		this.#submitScrollOffset = 0;
		this.#hoveredRowIndex = null;
		this.#hoverFade?.set(null);
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
		const lines = list.lines.concat([theme.fg("borderAccent", "─".repeat(Math.max(1, width)))], previewLines);
		while (lines.length < maxRows) lines.push("");
		return { lines: lines.slice(0, maxRows), scrollOffset: list.scrollOffset, indicator: list.indicator };
	}

	#hoverStrength(index: number): number {
		if (this.#hoverFade !== undefined) return this.#hoverFade.strengthAt(index);
		return index === this.#hoveredRowIndex ? 1 : 0;
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
			const rl = renderRowLabel(rowItem, question, state, index === state.cursorIndex, mdTheme, width);
			for (let li = 0; li < rl.length; li++) allLines.push(rl[li]!);
		}
		for (let index = 0; index < rowItems.length; index++) {
			const strength = this.#hoverStrength(index);
			if (strength <= 0) continue;
			const from = lineStartByRow[index] ?? allLines.length;
			const to = lineStartByRow[index + 1] ?? allLines.length;
			for (let line = from; line < to; line++) {
				allLines[line] = hoverBandAt(allLines[line]!, width, strength);
			}
		}
		const cursorStart = lineStartByRow[state.cursorIndex] ?? 0;
		state.scrollOffset = this.#scrollOffsetForCursor(state.scrollOffset, cursorStart, rows, allLines.length);
		const scrollView = new ScrollView(allLines, {
			height: rows,
			scrollbar: "auto",
			theme: SCROLL_LIST_THEME,
		});
		scrollView.setScrollOffset(state.scrollOffset);
		const lines = scrollView.render(width).slice();
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
		const lines = content.slice(0, visibleCount);
		lines.push(theme.fg("dim", `… ${formatMoreLines(hidden)}`));
		return lines;
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
			theme: SCROLL_LIST_THEME,
		});
		scrollView.setScrollOffset(this.#submitScrollOffset);
		const lines = scrollView.render(width).slice();
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
			const selectedOptions: string[] = [];
			const allOptionLabels = new Array<string>(question.options.length);
			for (let oi = 0; oi < question.options.length; oi++) {
				const label = question.options[oi]!.label;
				allOptionLabels[oi] = label;
				if (state.selectedOptions.has(label)) selectedOptions.push(label);
			}
			results.push({
				id: question.id,
				question: question.question,
				options: allOptionLabels,
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
