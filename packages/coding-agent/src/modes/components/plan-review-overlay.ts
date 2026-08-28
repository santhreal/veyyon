import {
	type Component,
	clampLow,
	Ellipsis,
	Input,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	routeSgrMouseInput,
	ScrollView,
	truncateToWidth,
	visibleWidth,
} from "@veyyon/tui";
import { getMarkdownTheme } from "../theme/markdown-theme";
import { theme } from "../theme/theme";
import {
	matchesAppExternalEditor,
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectUp,
} from "../utils/keybinding-matchers";
import type { HookSelectorSlider } from "./hook-selector";
import {
	computeModalDims,
	hitTestModalChrome,
	MODAL_SIZING_LARGE,
	type ModalShellGeometry,
	type ModalShortcut,
	minModalChromeRows,
	renderModalShell,
} from "./modal-shell";
import { fit } from "./overlay-box";
import { joinPlanSections, parsePlanSections, sectionDeletionSpan } from "./plan-toc";
import { renderSliderLines } from "./segment-track";
import { selectionBand } from "./selector-helpers";

const OVERLAY_TITLE = "Plan Review";
const MIN_BODY_ROWS = 3;
const SIDEBAR_MIN_HEADINGS = 2;
const SIDEBAR_MIN_TOTAL_WIDTH = 64;
const SIDEBAR_MIN_BODY_WIDTH = 40;
const SIDEBAR_DIVIDER_COLS = 3;
const CHROME_ROWS = minModalChromeRows(MODAL_SIZING_LARGE);

type Focus = "toc" | "body" | "actions";

interface OverlaySection {
	level: number;
	title: string;
	raw: string;
	md: Markdown;
	annotations: string[];
}

interface UndoEntry {
	text: string;
	annotations: string[][];
	deleted: string[];
}

export interface PlanReviewOverlayCallbacks {
	onPick: (label: string) => void;
	onCancel: () => void;
	onCopyPlan?: (content: string) => void | Promise<void>;
	onExternalEditor?: () => void;
	onAnnotationExternalEditor?: (draft: string, commit: (text: string | null) => void) => void;
	onPlanEdited?: (content: string) => void;
	onFeedbackChange?: (feedback: string) => void;
}

export interface PlanReviewOverlayOptions {
	promptTitle?: string;
	options: string[];
	disabledIndices?: number[];
	helpText?: string;
	initialIndex?: number;
	slider?: HookSelectorSlider;
	externalEditorLabel?: string;
	requestRender?: () => void;
}

const DEFAULT_HELP_SUFFIX = "esc cancel";

export class PlanReviewOverlay implements Component {
	#mdTheme: MarkdownTheme;
	#scrollView: ScrollView;

	#sections: OverlaySection[] = [];
	#toc: number[] = [];
	#tocBaseLevel = 1;
	#sectionOffsets: number[] = [];
	#undo: UndoEntry[] = [];
	#deleted: string[] = [];

	#options: string[];
	#disabled: Set<number>;
	#helpSuffix: string;
	#externalEditorLabel: string | undefined;
	#promptTitle: string | undefined;
	#selectedIndex: number;
	#slider: HookSelectorSlider | undefined;
	#sliderIndex: number;

	#focus: Focus = "actions";
	#tocCursor = 0;
	#sidebarShown = false;
	#pendingScrollToToc = false;

	#optionClickRows = new Map<number, number>();
	#tocClickRows = new Map<number, number>();
	#bodyClickRows = new Set<number>();
	#sidebarClickMaxCol = 0;
	#hoveredOption: number | undefined;
	#shellGeometry: ModalShellGeometry | null = null;
	#hoveredShortcutId: string | null = null;
	#bodyRowOffset = 0;

	#annotating = false;
	#input: Input;

	constructor(
		planContent: string,
		options: PlanReviewOverlayOptions,
		private readonly callbacks: PlanReviewOverlayCallbacks,
	) {
		this.#mdTheme = getMarkdownTheme();
		this.#scrollView = new ScrollView([], {
			height: MIN_BODY_ROWS,
			scrollbar: "auto",
			ellipsis: Ellipsis.Omit,
			theme: { track: t => theme.fg("dim", t), thumb: t => theme.fg("accent", t) },
		});
		this.#options = options.options;
		this.#disabled = new Set(
			(options.disabledIndices ?? []).filter(i => Number.isInteger(i) && i >= 0 && i < this.#options.length),
		);
		this.#helpSuffix = options.helpText ?? DEFAULT_HELP_SUFFIX;
		this.#externalEditorLabel = options.externalEditorLabel;
		this.#promptTitle = options.promptTitle;
		this.#selectedIndex = this.#coerceIndex(options.initialIndex ?? 0);
		if (options.slider && options.slider.segments.length > 0) {
			this.#slider = options.slider;
			this.#sliderIndex = clampLow(options.slider.index, 0, options.slider.segments.length - 1);
		} else {
			this.#sliderIndex = 0;
		}
		this.#input = new Input();
		this.#input.setUseTerminalCursor(false);
		this.#input.onSubmit = value => this.#submitAnnotation(value);
		this.#input.onEscape = () => this.#exitAnnotate();
		this.#setSections(planContent);
	}

	invalidate(): void {
		for (let si = 0; si < this.#sections.length; si++) this.#sections[si]!.md.invalidate();
	}

	setPlanContent(planContent: string): void {
		this.#setSections(planContent);
		this.#scrollView.scrollToTop();
		this.#tocCursor = 0;
		this.#deleted = [];
		this.#undo = [];
		this.#recomputeFeedback();
	}

	#setSections(planContent: string): void {
		this.#sections = parsePlanSections(planContent).map(section => ({
			level: section.level,
			title: section.title,
			raw: section.raw,
			md: new Markdown(section.raw, 1, 0, this.#mdTheme),
			annotations: [] as string[],
		}));
		this.#rebuildToc();
		this.#tocCursor = Math.min(this.#tocCursor, Math.max(0, this.#toc.length - 1));
	}

	#rebuildToc(): void {
		const headings: number[] = [];
		for (let i = 0; i < this.#sections.length; i++) {
			if (this.#sections[i]!.level >= 1) headings.push(i);
		}
		let minLevel = Number.POSITIVE_INFINITY;
		for (let hi = 0; hi < headings.length; hi++) {
			const level = this.#sections[headings[hi]!]!.level;
			if (level < minLevel) minLevel = level;
		}
		const topLevel: number[] = [];
		for (let hi = 0; hi < headings.length; hi++) {
			if (this.#sections[headings[hi]!]!.level === minLevel) topLevel.push(headings[hi]!);
		}
		const titleIndex = topLevel.length === 1 && headings[0] === topLevel[0] ? topLevel[0]! : -1;
		const toc: number[] = [];
		for (let hi = 0; hi < headings.length; hi++) {
			if (headings[hi] !== titleIndex) toc.push(headings[hi]!);
		}
		this.#toc = toc;
		let tocBaseLevel = Number.POSITIVE_INFINITY;
		for (let ti = 0; ti < toc.length; ti++) {
			const level = this.#sections[toc[ti]!]!.level;
			if (level < tocBaseLevel) tocBaseLevel = level;
		}
		this.#tocBaseLevel = toc.length > 0 ? tocBaseLevel : 1;
	}

	#coerceIndex(index: number): number {
		const max = this.#options.length - 1;
		if (max < 0) return -1;
		const clamped = clampLow(index, 0, max);
		if (!this.#disabled.has(clamped)) return clamped;
		for (let i = clamped + 1; i <= max; i++) if (!this.#disabled.has(i)) return i;
		for (let i = clamped - 1; i >= 0; i--) if (!this.#disabled.has(i)) return i;
		return clamped;
	}

	#firstEnabledIndex(): number {
		for (let i = 0; i < this.#options.length; i++) if (!this.#disabled.has(i)) return i;
		return -1;
	}

	#moveSelection(delta: number): void {
		const max = this.#options.length - 1;
		if (max < 0) return;
		let index = this.#selectedIndex;
		while (true) {
			const next = clampLow(index + delta, 0, max);
			if (next === index) return;
			index = next;
			if (!this.#disabled.has(index)) {
				this.#selectedIndex = index;
				return;
			}
		}
	}

	#moveSlider(delta: number): void {
		const slider = this.#slider;
		if (!slider) return;
		const next = clampLow(this.#sliderIndex + delta, 0, slider.segments.length - 1);
		if (next === this.#sliderIndex) return;
		this.#sliderIndex = next;
		slider.onChange?.(next);
	}

	#confirmSelection(): void {
		const index = this.#selectedIndex;
		if (index >= 0 && index < this.#options.length && !this.#disabled.has(index)) {
			this.callbacks.onPick(this.#options[index]!);
		}
	}

	handleInput(keyData: string): void {
		if (keyData.startsWith("\x1b[<") && this.#handleMouse(keyData)) return;
		if (this.#annotating) {
			if (this.callbacks.onAnnotationExternalEditor && matchesAppExternalEditor(keyData)) {
				this.callbacks.onAnnotationExternalEditor(this.#input.getValue(), text => {
					if (text !== null) this.#submitAnnotation(text);
				});
				return;
			}
			this.#input.handleInput(keyData);
			return;
		}
		if (matchesSelectCancel(keyData)) {
			this.callbacks.onCancel();
			return;
		}
		if (this.callbacks.onExternalEditor && matchesAppExternalEditor(keyData)) {
			this.callbacks.onExternalEditor();
			return;
		}
		if (this.callbacks.onCopyPlan && keyData === "c") {
			void this.callbacks.onCopyPlan(joinPlanSections(this.#sections));
			return;
		}
		if (matchesKey(keyData, "tab") || keyData === "\t") {
			this.#cycleRegion(1);
			return;
		}
		if (matchesKey(keyData, "shift+tab") || keyData === "\x1b[Z") {
			this.#cycleRegion(-1);
			return;
		}
		switch (this.#focus) {
			case "actions":
				this.#handleActions(keyData);
				return;
			case "body":
				this.#handleBody(keyData);
				return;
			case "toc":
				this.#handleToc(keyData);
				return;
		}
	}

	#handleMouse(data: string): boolean {
		return routeSgrMouseInput(data, event => {
			const chrome = hitTestModalChrome(this.#shellGeometry, event.row, event.col, {
				motion: event.motion,
				leftClick: event.leftClick,
			});
			if (chrome.kind === "hover-shortcut") {
				this.#hoveredShortcutId = chrome.id;
				if (chrome.id !== null) {
					this.#setHoveredOption(undefined);
					return true;
				}
			} else if (
				chrome.kind === "close" ||
				chrome.kind === "outside" ||
				(chrome.kind === "shortcut" && chrome.id === "close")
			) {
				this.callbacks.onCancel();
				return true;
			} else if (chrome.kind === "shortcut" && chrome.id === "confirm") {
				if (this.#annotating) this.#submitAnnotation(this.#input.getValue());
				else this.#confirmSelection();
				return true;
			}

			if (event.wheel !== null) {
				this.#scrollView.scroll(event.wheel * 3);
				return true;
			}
			if (event.release) return true;

			const bodyRow = event.row - this.#bodyRowOffset;
			if (event.motion) {
				this.#setHoveredOption(this.#optionClickRows.get(bodyRow));
				return true;
			}
			if (!event.leftClick) return true;
			const optionIndex = this.#optionClickRows.get(bodyRow);
			if (optionIndex !== undefined) {
				if (!this.#disabled.has(optionIndex)) {
					this.#focus = "actions";
					this.#selectedIndex = optionIndex;
					this.#confirmSelection();
				}
				return true;
			}
			const tocPos = this.#tocClickRows.get(bodyRow);
			if (tocPos !== undefined && event.col < this.#sidebarClickMaxCol) {
				this.#focus = "toc";
				this.#tocCursor = tocPos;
				this.#scrubBodyToToc();
				return true;
			}
			if (this.#bodyClickRows.has(bodyRow)) {
				this.#setFocus("body");
			}
			return true;
		});
	}

	#setHoveredOption(index: number | undefined): void {
		this.#hoveredOption = index !== undefined && !this.#disabled.has(index) ? index : undefined;
	}

	#cycleRegion(direction: number): void {
		const regions: Focus[] = this.#sidebarShown ? ["toc", "body", "actions"] : ["body", "actions"];
		const current = regions.indexOf(this.#focus);
		const base = current < 0 ? regions.length - 1 : current;
		this.#setFocus(regions[(base + direction + regions.length) % regions.length]!);
	}

	#setFocus(focus: Focus): void {
		this.#focus = focus;
		if (focus === "toc") this.#tocCursor = this.#deriveTocCursorFromScroll();
	}

	#handleActions(data: string): void {
		const isLeft = matchesKey(data, "left") || (this.#slider !== undefined && matchesKey(data, "h"));
		const isRight = matchesKey(data, "right") || (this.#slider !== undefined && matchesKey(data, "l"));
		if (isLeft) {
			this.#moveSlider(-1);
			return;
		}
		if (isRight) {
			this.#moveSlider(1);
			return;
		}
		if (matchesSelectUp(data) || matchesKey(data, "k")) {
			if (this.#selectedIndex === this.#firstEnabledIndex()) this.#setFocus("body");
			else this.#moveSelection(-1);
			return;
		}
		if (matchesSelectDown(data) || matchesKey(data, "j")) {
			this.#moveSelection(1);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#confirmSelection();
			return;
		}
		this.#handleBodyScroll(data);
	}

	#handleBody(data: string): void {
		if (matchesKey(data, "left") || matchesKey(data, "h")) {
			if (this.#sidebarShown) this.#setFocus("toc");
			return;
		}
		if (
			matchesKey(data, "right") ||
			matchesKey(data, "l") ||
			matchesKey(data, "enter") ||
			matchesKey(data, "return") ||
			data === "\n"
		) {
			this.#setFocus("actions");
			return;
		}
		if (matchesSelectUp(data) || matchesKey(data, "k")) {
			if (this.#scrollView.getScrollOffset() <= 0 && this.#sidebarShown) this.#setFocus("toc");
			else this.#scrollView.scroll(-1);
			return;
		}
		if (matchesSelectDown(data) || matchesKey(data, "j")) {
			if (this.#scrollView.getScrollOffset() >= this.#scrollView.getMaxScrollOffset()) this.#setFocus("actions");
			else this.#scrollView.scroll(1);
			return;
		}
		this.#handleBodyScroll(data);
	}

	#handleBodyScroll(data: string): void {
		if (this.#scrollView.handleScrollKey(data)) return;
		if (data === "g") this.#scrollView.scrollToTop();
		else if (data === "G") this.#scrollView.scrollToBottom();
	}

	#handleToc(data: string): void {
		if (matchesSelectUp(data) || matchesKey(data, "k")) {
			this.#moveTocCursor(-1);
			return;
		}
		if (matchesSelectDown(data) || matchesKey(data, "j")) {
			if (this.#tocCursor >= this.#toc.length - 1) this.#setFocus("actions");
			else this.#moveTocCursor(1);
			return;
		}
		if (
			matchesKey(data, "right") ||
			matchesKey(data, "l") ||
			matchesKey(data, "enter") ||
			matchesKey(data, "return") ||
			data === "\n"
		) {
			this.#setFocus("body");
			return;
		}
		if (data === "d" || matchesKey(data, "delete")) {
			this.#deleteSelectedSection();
			return;
		}
		if (data === "a") {
			this.#startAnnotate();
			return;
		}
		if (data === "u") {
			this.#undoLast();
			return;
		}
	}

	#moveTocCursor(delta: number): void {
		if (this.#toc.length === 0) return;
		const next = clampLow(this.#tocCursor + delta, 0, this.#toc.length - 1);
		if (next === this.#tocCursor) return;
		this.#tocCursor = next;
		this.#scrubBodyToToc();
	}

	#scrubBodyToToc(): void {
		const sectionIndex = this.#toc[this.#tocCursor];
		if (sectionIndex === undefined) return;
		const offset = this.#sectionOffsets[sectionIndex];
		if (offset !== undefined) this.#scrollView.setScrollOffset(offset);
	}

	#deriveTocCursorFromScroll(): number {
		if (this.#toc.length === 0) return 0;
		const scrollOffset = this.#scrollView.getScrollOffset();
		let current = 0;
		for (let i = 0; i < this.#sections.length; i++) {
			if ((this.#sectionOffsets[i] ?? 0) <= scrollOffset) current = i;
			else break;
		}
		let pos = 0;
		for (let p = 0; p < this.#toc.length; p++) {
			if (this.#toc[p]! <= current) pos = p;
			else break;
		}
		return pos;
	}

	#pushUndo(): void {
		this.#undo.push({
			text: joinPlanSections(this.#sections),
			annotations: this.#sections.map(section => section.annotations.slice()),
			deleted: Array.from(this.#deleted),
		});
	}

	#deleteSelectedSection(): void {
		const sectionIndex = this.#toc[this.#tocCursor];
		if (sectionIndex === undefined) return;
		const span = sectionDeletionSpan(this.#sections, sectionIndex);
		if (span.length === 0) return;
		this.#pushUndo();
		for (let si = 0; si < span.length; si++) {
			const section = this.#sections[span[si]!]!;
			if (section.level >= 1 && section.title) this.#deleted.push(section.title);
		}
		for (let i = span.length - 1; i >= 0; i--) this.#sections.splice(span[i]!, 1);
		this.#rebuildToc();
		this.#tocCursor = Math.min(this.#tocCursor, Math.max(0, this.#toc.length - 1));
		this.#pendingScrollToToc = true;
		this.callbacks.onPlanEdited?.(joinPlanSections(this.#sections));
		this.#recomputeFeedback();
	}

	#undoLast(): void {
		const entry = this.#undo.pop();
		if (!entry) return;
		this.#setSections(entry.text);
		for (let i = 0; i < this.#sections.length; i++) {
			this.#sections[i]!.annotations = entry.annotations[i] ? entry.annotations[i]!.slice() : [];
		}
		this.#deleted = Array.from(entry.deleted);
		this.#tocCursor = Math.min(this.#tocCursor, Math.max(0, this.#toc.length - 1));
		this.#pendingScrollToToc = true;
		this.callbacks.onPlanEdited?.(joinPlanSections(this.#sections));
		this.#recomputeFeedback();
	}

	#startAnnotate(): void {
		if (this.#toc[this.#tocCursor] === undefined) return;
		this.#annotating = true;
		this.#input.setValue("");
	}

	#submitAnnotation(value: string): void {
		this.#annotating = false;
		const note = value.trim();
		const sectionIndex = this.#toc[this.#tocCursor];
		if (note && sectionIndex !== undefined) {
			this.#pushUndo();
			this.#sections[sectionIndex]!.annotations.push(note);
			this.#recomputeFeedback();
		}
		this.#input.setValue("");
	}

	#exitAnnotate(): void {
		this.#annotating = false;
		this.#input.setValue("");
	}

	#recomputeFeedback(): void {
		const annotated: OverlaySection[] = [];
		for (let si = 0; si < this.#sections.length; si++) {
			const section = this.#sections[si]!;
			if (section.level >= 1 && section.annotations.length > 0) annotated.push(section);
		}
		if (annotated.length === 0 && this.#deleted.length === 0) {
			this.callbacks.onFeedbackChange?.("");
			return;
		}
		let feedback = "Refinement feedback on the plan:\n";
		if (this.#deleted.length > 0) {
			feedback += "\nRemove these sections:\n";
			for (let di = 0; di < this.#deleted.length; di++) feedback += `- ${this.#deleted[di]!}\n`;
		}
		for (let si = 0; si < annotated.length; si++) {
			const section = annotated[si]!;
			feedback += `\n## ${section.title}\n`;
			for (let ni = 0; ni < section.annotations.length; ni++) {
				feedback += this.#formatAnnotationFeedback(section.annotations[ni]!);
			}
		}
		this.callbacks.onFeedbackChange?.(feedback);
	}

	#formatAnnotationFeedback(note: string): string {
		if (!note.includes("\n")) return `- ${note}\n`;
		const fence = this.#markdownFenceFor(note);
		return `${fence}md\n${note}\n${fence}\n`;
	}

	#markdownFenceFor(text: string): string {
		let fence = "```";
		while (text.includes(fence)) fence += "`";
		return fence;
	}

	#renderSliderLines(): string[] {
		const slider = this.#slider;
		if (!slider) return [];
		return renderSliderLines(slider.segments, this.#sliderIndex, slider.caption);
	}

	#renderOptionLines(): string[] {
		const active = this.#focus === "actions";
		const result: string[] = new Array(this.#options.length);
		for (let i = 0; i < this.#options.length; i++) {
			const label = this.#options[i]!;
			const selected = i === this.#selectedIndex;
			const isDisabled = this.#disabled.has(i);
			const hovered = !isDisabled && i === this.#hoveredOption;
			const cursor = selected ? theme.fg(active ? "accent" : "dim", `${theme.nav.cursor} `) : "  ";
			let text = isDisabled
				? theme.fg("dim", label)
				: selected && active
					? theme.bold(theme.fg("accent", label))
					: theme.fg("text", label);
			if (hovered) text = theme.bg("selectedBg", ` ${text} `);
			result[i] = cursor + text;
		}
		return result;
	}

	#buildShortcuts(): ModalShortcut[] {
		if (this.#annotating) {
			const chips: ModalShortcut[] = [{ label: "enter save", clickable: true, id: "confirm" }];
			if (this.#externalEditorLabel) chips.push({ label: `${this.#externalEditorLabel} editor` });
			chips.push({ label: "esc cancel", clickable: true, id: "close" });
			return chips;
		}
		const chips: ModalShortcut[] = [];
		switch (this.#focus) {
			case "actions":
				chips.push({ label: "up/down select" }, { label: "enter confirm", clickable: true, id: "confirm" });
				if (this.#slider) chips.push({ label: "left/right model" });
				break;
			case "toc":
				chips.push({ label: "up/down section" }, { label: "enter open" });
				chips.push({ label: "a annotate" }, { label: "d delete" }, { label: "u undo" });
				break;
			case "body":
				chips.push(
					{ label: "up/down scroll" },
					{ label: "shift faster" },
					{ label: "pgup/pgdn" },
					{ label: "g/G ends" },
				);
				break;
		}
		if (this.callbacks.onCopyPlan) chips.push({ label: "c copy" });
		chips.push({ label: "tab regions" });
		if (this.#externalEditorLabel && this.#focus !== "toc")
			chips.push({ label: `${this.#externalEditorLabel} editor` });
		chips.push({ label: this.#helpSuffix, clickable: true, id: "close" });
		return chips;
	}

	#buildBody(bodyContentWidth: number): string[] {
		const lines: string[] = [];
		const offsets: number[] = new Array(this.#sections.length);
		for (let i = 0; i < this.#sections.length; i++) {
			const section = this.#sections[i]!;
			offsets[i] = lines.length;
			const rendered = section.md.render(bodyContentWidth);
			if (section.level >= 1 && section.annotations.length > 0 && rendered.length > 0) {
				lines.push(rendered[0]!);
				for (let ni = 0; ni < section.annotations.length; ni++) {
					const noteLines = section.annotations[ni]!.split(/\r?\n/);
					for (let j = 0; j < noteLines.length; j++) {
						const prefix =
							j === 0
								? `${theme.fg("warning", "▎ ")}${theme.fg("dim", "note: ")}`
								: `${theme.fg("warning", "▎ ")}${theme.fg("dim", "      ")}`;
						lines.push(`${prefix}${theme.fg("accent", noteLines[j] ?? "")}`);
					}
				}
				for (let k = 1; k < rendered.length; k++) lines.push(rendered[k]!);
			} else {
				for (let li = 0; li < rendered.length; li++) lines.push(rendered[li]!);
			}
		}
		this.#sectionOffsets = offsets;
		return lines;
	}

	#sidebarWidthFor(width: number): number {
		return clampLow(Math.round(width * 0.24), 18, 30);
	}

	#sidebarBodyWidth(contentWidth: number, sidebarWidth: number): number {
		return Math.max(1, contentWidth - sidebarWidth - SIDEBAR_DIVIDER_COLS);
	}

	#sidebarVisible(contentWidth: number): boolean {
		if (this.#toc.length < SIDEBAR_MIN_HEADINGS) return false;
		if (contentWidth < SIDEBAR_MIN_TOTAL_WIDTH) return false;
		return this.#sidebarBodyWidth(contentWidth, this.#sidebarWidthFor(contentWidth)) >= SIDEBAR_MIN_BODY_WIDTH;
	}

	#renderSidebarLines(
		regionRows: number,
		sidebarWidth: number,
	): { lines: string[]; posForRow: (number | undefined)[] } {
		const lines: string[] = [];
		const posForRow: (number | undefined)[] = [];
		const slots = Math.max(0, regionRows);
		const total = this.#toc.length;
		let start = 0;
		if (total > slots) {
			start = clampLow(this.#tocCursor - Math.floor(slots / 2), 0, total - slots);
		}
		for (let r = 0; r < slots; r++) {
			const p = start + r;
			lines.push(p < total ? this.#renderTocEntry(p, sidebarWidth) : "");
			posForRow.push(p < total ? p : undefined);
		}
		return { lines, posForRow };
	}

	#renderTocEntry(p: number, width: number): string {
		const section = this.#sections[this.#toc[p]!]!;
		const highlighted = p === this.#tocCursor;
		const selected = highlighted && this.#focus === "toc";
		const glow = highlighted && this.#focus !== "toc";
		const indent = " ".repeat(Math.max(0, section.level - this.#tocBaseLevel));
		const ann = section.annotations.length > 0 ? " ✎" : "";
		const avail = Math.max(0, width - 1 - indent.length - visibleWidth(ann));
		const title = truncateToWidth(section.title || "(untitled)", avail, Ellipsis.Unicode);
		const body = indent + title + ann;
		const gutter = selected ? theme.nav.cursor : glow ? "▎" : " ";
		const line = gutter + body;
		if (selected) return selectionBand(theme.bold(line), width);
		if (glow) return theme.fg("accent", line);
		return theme.fg("muted", line);
	}

	#renderAnnotateLines(contentWidth: number): string[] {
		if (!this.#annotating) return [];
		const section = this.#sections[this.#toc[this.#tocCursor]!];
		const title = section?.title ?? "";
		const caption = `${theme.fg("dim", "Annotate")} ${theme.fg("accent", `‹${title}›`)}`;
		return [caption, this.#input.render(contentWidth)[0] ?? ""];
	}

	#renderRegionRule(contentWidth: number): string {
		return theme.fg("borderAccent", theme.boxSharp.horizontal.repeat(Math.max(0, contentWidth)));
	}

	#composeSplitLine(sidebar: string, body: string, sidebarWidth: number, bodyWidth: number): string {
		const divider = theme.fg("borderAccent", theme.boxSharp.vertical);
		return `${fit(sidebar, sidebarWidth)} ${divider} ${fit(body, bodyWidth)}`;
	}

	render(width: number): readonly string[] {
		const termHeight = Math.max(14, process.stdout.rows || 40);
		const sizing = MODAL_SIZING_LARGE;
		const dims = computeModalDims(width, termHeight, sizing);
		const contentWidth = dims?.contentWidth ?? Math.max(1, width - 4);

		const sidebarShown = this.#sidebarVisible(contentWidth);
		this.#sidebarShown = sidebarShown;
		const sidebarWidth = sidebarShown ? this.#sidebarWidthFor(contentWidth) : 0;
		const bodyContentWidth = sidebarShown ? this.#sidebarBodyWidth(contentWidth, sidebarWidth) : contentWidth;

		const sliderLines = this.#renderSliderLines();
		const optionLines = this.#renderOptionLines();
		const promptLines = this.#promptTitle ? [theme.bold(theme.fg("accent", this.#promptTitle))] : [];
		const annotateLines = this.#renderAnnotateLines(contentWidth);

		const belowRegionRows = 1 + promptLines.length + sliderLines.length + optionLines.length + annotateLines.length;
		const regionRows = Math.max(MIN_BODY_ROWS, (dims?.modalHeight ?? termHeight) - CHROME_ROWS - belowRegionRows);

		const bodyLines = this.#buildBody(bodyContentWidth);
		this.#scrollView.setLines(bodyLines);
		this.#scrollView.setHeight(regionRows);
		if (this.#pendingScrollToToc) {
			this.#pendingScrollToToc = false;
			this.#scrubBodyToToc();
		}
		if (this.#focus !== "toc") this.#tocCursor = this.#deriveTocCursorFromScroll();
		const body = this.#scrollView.render(bodyContentWidth);

		this.#optionClickRows.clear();
		this.#tocClickRows.clear();
		this.#bodyClickRows.clear();

		const content: string[] = [];
		if (sidebarShown) {
			const { lines: sidebar, posForRow } = this.#renderSidebarLines(regionRows, sidebarWidth);
			for (let i = 0; i < regionRows; i++) {
				const pos = posForRow[i];
				if (pos !== undefined) this.#tocClickRows.set(content.length, pos);
				this.#bodyClickRows.add(content.length);
				content.push(this.#composeSplitLine(sidebar[i] ?? "", body[i] ?? "", sidebarWidth, bodyContentWidth));
			}
		} else {
			for (let bi = 0; bi < body.length; bi++) {
				this.#bodyClickRows.add(content.length);
				content.push(body[bi]!);
			}
		}
		content.push(this.#renderRegionRule(contentWidth));
		for (let li = 0; li < promptLines.length; li++) content.push(promptLines[li]!);
		for (let li = 0; li < sliderLines.length; li++) content.push(sliderLines[li]!);
		for (let i = 0; i < optionLines.length; i++) {
			this.#optionClickRows.set(content.length, i);
			content.push(optionLines[i]!);
		}
		for (let li = 0; li < annotateLines.length; li++) content.push(annotateLines[li]!);

		const shell = renderModalShell({
			title: OVERLAY_TITLE,
			sizing,
			areaWidth: width,
			areaHeight: termHeight,
			body: content,
			shortcuts: this.#buildShortcuts(),
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});
		this.#shellGeometry = shell.geometry;
		this.#bodyRowOffset = shell.geometry?.bodyRowStart ?? 0;
		this.#sidebarClickMaxCol = sidebarShown ? (shell.geometry?.leftPad ?? 0) + 2 + sidebarWidth + 1 : 0;
		return shell.lines;
	}
}
