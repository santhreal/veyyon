import {
	type Component,
	Container,
	clampLow,
	Ellipsis,
	extractPrintableText,
	fuzzyFilter,
	HoverFade,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	padding,
	renderInlineMarkdown,
	replaceTabs,
	routeSgrMouseInput,
	type SgrMouseEvent,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@veyyon/tui";
import { getMarkdownTheme } from "../../modes/theme/markdown-theme";
import { type ThemeColor, theme } from "../../modes/theme/theme";
import {
	matchesAppExternalEditor,
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectUp,
} from "../../modes/utils/keybinding-matchers";
import { CountdownTimer } from "./countdown-timer";
import {
	computeModalDims,
	consumeModalChipHover,
	hitTestModalChrome,
	MODAL_SIZING_MEDIUM,
	type ModalShellGeometry,
	type ModalShortcut,
	planModalChrome,
	pointerMotionEnabled,
	renderModalShell,
	SELECT_LIST_SHORTCUTS,
	sizingForArea,
} from "./modal-shell";
import { renderSliderLines } from "./segment-track";
import { hoverBandAt } from "./selector-helpers";

export interface HookSelectorSliderSegment {
	label: string;
	detail?: string;
}

export interface HookSelectorSlider {
	caption?: string;
	segments: HookSelectorSliderSegment[];
	index: number;
	onChange?: (index: number) => void;
}

export interface HookSelectorOptions {
	tui?: TUI;
	timeout?: number;
	onTimeout?: () => void;
	onTimeoutStart?: () => void;
	onTimeoutReset?: () => void;
	initialIndex?: number;
	maxVisible?: number;
	onLeft?: () => void;
	onRight?: () => void;
	onExternalEditor?: () => void;
	helpText?: string;
	slider?: HookSelectorSlider;
	disabledIndices?: readonly number[];
	selectionMarker?: "radio" | "checkbox";
	checkedIndices?: readonly number[];
	markableCount?: number;
	presentation?: "card" | "embedded";
	onRequestRender?: () => void;
}

export interface HookSelectorOption {
	label: string;
	description?: string;
}

export type HookSelectorOptionInput = string | HookSelectorOption;

function normalizeHookSelectorOption(option: HookSelectorOptionInput): HookSelectorOption {
	if (typeof option === "string") return { label: option };
	if (option.description?.trim()) {
		return { label: option.label, description: option.description.trim() };
	}
	return { label: option.label };
}

type SelectorRow = { text: string; highlight: boolean; option?: number };

function paintSelectedRow(content: string): string {
	return theme.bg("selectedBg", content);
}

type FilteredOption = { option: HookSelectorOption; index: number };

export class HookSelectorComponent extends Container {
	#options: HookSelectorOption[];
	#filteredOptions: FilteredOption[];
	#searchQuery = "";
	#selectedIndex: number;
	#disabledIndices: Set<number>;
	#selectionMarker: "radio" | "checkbox" | undefined;
	#checkedIndices: Set<number>;
	#markableCount: number;
	#maxVisible: number;
	readonly #listContainer = new Container();
	#onSelectCallback: (option: string) => void;
	#onCancelCallback: () => void;
	#titleComponent: Markdown | undefined;
	#baseTitle: string;
	#countdown: CountdownTimer | undefined;
	#onLeftCallback: (() => void) | undefined;
	#onRightCallback: (() => void) | undefined;
	#onExternalEditorCallback: (() => void) | undefined;
	#onTimeoutResetCallback: (() => void) | undefined;
	#slider: HookSelectorSlider | undefined;
	#sliderIndex: number = 0;
	#sliderComponent: Text | undefined;
	#lastRenderWidth: number | undefined;
	readonly #card: boolean;
	#helpText: string | undefined;
	#onRequestRender: (() => void) | undefined;
	#cardTitle: string;
	#countdownSuffix = "";
	#optionRows = new Map<Component, number>();
	#hitRows: (number | undefined)[] = [];
	#hoveredIndex: number | null = null;
	#hoverFade: HoverFade | undefined;
	#shellGeometry: ModalShellGeometry | null = null;
	#hoveredShortcutId: string | null = null;
	#bodyRowStart = 0;

	constructor(
		title: string,
		options: HookSelectorOptionInput[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: HookSelectorOptions,
	) {
		super();

		this.#options = options.map(normalizeHookSelectorOption);
		this.#filteredOptions = this.#options.map((option, index) => ({ option, index }));
		this.#disabledIndices = new Set(
			(opts?.disabledIndices ?? []).filter(
				index => Number.isInteger(index) && index >= 0 && index < this.#options.length,
			),
		);
		this.#selectionMarker = opts?.selectionMarker;
		this.#checkedIndices = new Set(
			(opts?.checkedIndices ?? []).filter(
				index => Number.isInteger(index) && index >= 0 && index < this.#options.length,
			),
		);
		this.#markableCount = clampLow(opts?.markableCount ?? this.#options.length, 0, this.#options.length);
		this.#selectedIndex = this.#coerceSelectedIndex(opts?.initialIndex ?? 0);
		this.#maxVisible = Math.max(3, opts?.maxVisible ?? 12);
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;
		const [firstTitleLine = "", ...restTitleLines] = title.split("\n");
		this.#card = opts?.presentation !== "embedded";
		this.#helpText = opts?.helpText;
		if (opts?.onRequestRender) this.#useRequestRender(opts.onRequestRender);
		this.#baseTitle = title;
		this.#cardTitle = firstTitleLine;
		this.#onLeftCallback = opts?.onLeft;
		this.#onRightCallback = opts?.onRight;
		this.#onExternalEditorCallback = opts?.onExternalEditor;
		this.#onTimeoutResetCallback = opts?.onTimeoutReset;
		if (opts?.slider && opts.slider.segments.length > 0) {
			this.#slider = opts.slider;
			this.#sliderIndex = clampLow(opts.slider.index, 0, opts.slider.segments.length - 1);
		}

		const bodyTitle = this.#card ? restTitleLines.join("\n") : title;
		if (bodyTitle.length > 0) {
			this.#titleComponent = new Markdown(bodyTitle, 1, 0, getMarkdownTheme(), {
				color: t => theme.fg("accent", t),
			});
			this.addChild(this.#titleComponent);
			this.addChild(new Spacer(1));
		}

		if (this.#slider) {
			this.#sliderComponent = new Text(this.#renderSliderLine(), 1, 0);
			this.addChild(this.#sliderComponent);
			this.addChild(new Spacer(1));
		}

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			opts.onTimeoutStart?.();
			this.#countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				this,
				s => this.#showCountdown(s),
				() => {
					opts?.onTimeout?.();
					const selected = this.#filteredOptions[this.#selectedIndex];
					if (selected && !this.#isDisabled(selected.index)) {
						this.#onSelectCallback(selected.option.label);
					} else {
						this.#onCancelCallback();
					}
				},
			);
		}

		this.addChild(this.#listContainer);
		this.#updateList();
	}

	#isDisabled(index: number): boolean {
		return this.#disabledIndices.has(index);
	}

	#coerceSelectedIndex(index: number): number {
		if (this.#filteredOptions.length === 0) return -1;
		const maxIndex = this.#filteredOptions.length - 1;
		const clamped = clampLow(index, 0, maxIndex);
		const clampedOption = this.#filteredOptions[clamped];
		if (clampedOption && !this.#isDisabled(clampedOption.index)) return clamped;
		for (let i = clamped + 1; i <= maxIndex; i++) {
			const option = this.#filteredOptions[i];
			if (option && !this.#isDisabled(option.index)) return i;
		}
		for (let i = clamped - 1; i >= 0; i--) {
			const option = this.#filteredOptions[i];
			if (option && !this.#isDisabled(option.index)) return i;
		}
		return clamped;
	}

	#moveSelection(delta: number): void {
		if (this.#filteredOptions.length === 0) return;
		const maxIndex = this.#filteredOptions.length - 1;
		let index = this.#selectedIndex;
		while (true) {
			const next = clampLow(index + delta, 0, maxIndex);
			if (next === index) return;
			index = next;
			const option = this.#filteredOptions[index];
			if (option && !this.#isDisabled(option.index)) {
				this.#selectedIndex = index;
				this.#updateList();
				return;
			}
		}
	}

	#renderOptionLines(
		option: HookSelectorOption,
		isSelected: boolean,
		isDisabled: boolean,
		mdTheme: MarkdownTheme,
		descRows: number | "full",
		renderWidth?: number,
		index?: number,
	): string[] {
		const textColor = isDisabled ? "dim" : isSelected ? "accent" : "text";
		const prefixColor = isDisabled ? "dim" : "accent";
		const label = renderInlineMarkdown(option.label, mdTheme, t => theme.fg(textColor, t));
		const marker = index !== undefined ? this.#renderMarkerPrefix(index, isSelected, isDisabled) : undefined;
		const prefix = marker ?? (isSelected ? theme.fg(prefixColor, `${theme.nav.cursor} `) : "  ");
		const lines = [prefix + label];
		if (option.description && descRows !== 0) {
			const descriptionColor: ThemeColor = isDisabled ? "dim" : "muted";
			if (descRows === "full") {
				const description = renderInlineMarkdown(option.description, mdTheme, t => theme.fg(descriptionColor, t));
				lines.push(`    ${description}`);
			} else {
				lines.push(
					...this.#wrapDescriptionRows(option.description, descRows, descriptionColor, mdTheme, renderWidth),
				);
			}
		}
		return lines;
	}

	#renderMarkerPrefix(index: number, isSelected: boolean, isDisabled: boolean): string | undefined {
		if (this.#selectionMarker === undefined || index >= this.#markableCount) return undefined;
		if (this.#selectionMarker === "radio") {
			const glyph = isSelected ? theme.radio.selected : theme.radio.unselected;
			const color = isDisabled ? "dim" : isSelected ? "accent" : "dim";
			return theme.fg(color, `${glyph} `);
		}
		const checked = this.#checkedIndices.has(index);
		const glyph = checked ? theme.checkbox.checked : theme.checkbox.unchecked;
		const color = isDisabled ? "dim" : isSelected ? "accent" : checked ? "success" : "dim";
		return theme.fg(color, `${glyph} `);
	}

	#wrapDescriptionRows(
		description: string,
		maxRows: number,
		color: ThemeColor,
		mdTheme: MarkdownTheme,
		renderWidth = this.#lastRenderWidth,
	): string[] {
		if (maxRows <= 0) return [];
		const indent = "    ";
		const innerWidth = Math.max(1, (renderWidth ?? 80) - 2);
		const bodyWidth = Math.max(1, innerWidth - indent.length);
		const colored = renderInlineMarkdown(description, mdTheme, t => theme.fg(color, t));
		const wrapped = wrapTextWithAnsi(colored, bodyWidth);
		if (wrapped.length <= maxRows) {
			const out = new Array<string>(wrapped.length);
			for (let ri = 0; ri < wrapped.length; ri++) out[ri] = indent + wrapped[ri]!;
			return out;
		}
		const kept = wrapped.slice(0, maxRows);
		kept[maxRows - 1] = truncateToWidth(wrapped.slice(maxRows - 1).join(" "), bodyWidth, Ellipsis.Unicode);
		const out = new Array<string>(kept.length);
		for (let ri = 0; ri < kept.length; ri++) out[ri] = indent + kept[ri]!;
		return out;
	}

	#renderedLineRowCount(line: string, renderWidth: number): number {
		const normalized = replaceTabs(line);
		const wrapped = wrapTextWithAnsi(normalized, Math.max(1, renderWidth - 2));
		return Math.max(1, wrapped.length);
	}

	#optionRowCount(
		option: HookSelectorOption,
		renderWidth: number | undefined,
		isSelected: boolean,
		mdTheme: MarkdownTheme,
		descRows: number | "full",
	): number {
		if (renderWidth === undefined) return option.description && descRows !== 0 ? 2 : 1;
		let rows = 0;
		const optionLines = this.#renderOptionLines(option, isSelected, false, mdTheme, descRows, renderWidth);
		for (let li = 0; li < optionLines.length; li++) {
			rows += this.#renderedLineRowCount(optionLines[li]!, renderWidth);
		}
		return rows;
	}

	#totalOptionRows(options: HookSelectorOption[], renderWidth?: number, mdTheme?: MarkdownTheme): number {
		const themeForRows = mdTheme ?? getMarkdownTheme();
		let rows = 0;
		for (let oi = 0; oi < options.length; oi++) {
			rows += this.#optionRowCount(options[oi]!, renderWidth, false, themeForRows, "full");
		}
		return rows;
	}

	#getVisibleOptionRange(
		total: number,
		renderWidth?: number,
		mdTheme: MarkdownTheme = getMarkdownTheme(),
		compact = false,
	): { startIndex: number; endIndex: number } {
		if (total === 0) return { startIndex: 0, endIndex: 0 };

		const descMode: number | "full" = compact ? 0 : "full";
		const rowBudget = Math.max(1, this.#maxVisible);
		const selectedIndex = clampLow(this.#selectedIndex, 0, total - 1);
		let startIndex = selectedIndex;
		let endIndex = selectedIndex + 1;
		let rows = this.#optionRowCount(
			this.#filteredOptions[selectedIndex]!.option,
			renderWidth,
			true,
			mdTheme,
			descMode,
		);
		let beforeRows = 0;
		const targetBeforeRows = Math.max(0, Math.floor((rowBudget - rows) / 2));

		while (startIndex > 0) {
			const cost = this.#optionRowCount(
				this.#filteredOptions[startIndex - 1]!.option,
				renderWidth,
				false,
				mdTheme,
				descMode,
			);
			if (beforeRows + cost > targetBeforeRows || rows + cost > rowBudget) break;
			startIndex--;
			beforeRows += cost;
			rows += cost;
		}

		while (endIndex < total) {
			const cost = this.#optionRowCount(
				this.#filteredOptions[endIndex]!.option,
				renderWidth,
				false,
				mdTheme,
				descMode,
			);
			if (rows + cost > rowBudget) break;
			endIndex++;
			rows += cost;
		}

		while (startIndex > 0) {
			const cost = this.#optionRowCount(
				this.#filteredOptions[startIndex - 1]!.option,
				renderWidth,
				false,
				mdTheme,
				descMode,
			);
			if (rows + cost > rowBudget) break;
			startIndex--;
			rows += cost;
		}

		return { startIndex, endIndex };
	}

	#updateList(renderWidth = this.#lastRenderWidth): void {
		const rows: SelectorRow[] = [];
		const total = this.#filteredOptions.length;
		const mdTheme = getMarkdownTheme();
		const compact = this.#isSearchEnabled(renderWidth, mdTheme);
		const { startIndex, endIndex } = this.#getVisibleOptionRange(total, renderWidth, mdTheme, compact);

		let selectedDescRows = 0;
		if (compact && renderWidth !== undefined) {
			let labelRows = 0;
			for (let i = startIndex; i < endIndex; i++) {
				const filtered = this.#filteredOptions[i];
				if (filtered === undefined) continue;
				labelRows += this.#optionRowCount(filtered.option, renderWidth, i === this.#selectedIndex, mdTheme, 0);
			}
			selectedDescRows = Math.max(0, Math.max(1, this.#maxVisible) - labelRows - 1);
		}

		for (let i = startIndex; i < endIndex; i++) {
			const filtered = this.#filteredOptions[i];
			if (filtered === undefined) continue;
			const isSelected = i === this.#selectedIndex;
			const isDisabled = this.#isDisabled(filtered.index);
			const descMode: number | "full" = compact ? (isSelected ? selectedDescRows : 0) : "full";
			const highlight = isSelected && !isDisabled;
			const optionLines = this.#renderOptionLines(
				filtered.option,
				isSelected,
				isDisabled,
				mdTheme,
				descMode,
				renderWidth,
				filtered.index,
			);
			for (let li = 0; li < optionLines.length; li++) {
				rows.push({ text: optionLines[li]!, highlight, option: i });
			}
		}

		if (total === 0) {
			rows.push({ text: theme.fg("dim", "  No matching options"), highlight: false });
		}

		if (startIndex > 0 || endIndex < total || this.#shouldRenderSearchStatus(renderWidth, mdTheme)) {
			rows.push({ text: this.#renderStatusLine(total), highlight: false });
		}
		this.#listContainer.clear();
		for (let ri = 0; ri < rows.length; ri++) {
			const row = rows[ri]!;
			const bgFn = row.highlight ? paintSelectedRow : undefined;
			const child = new Text(row.text, 1, 0, bgFn);
			this.#listContainer.addChild(child);
			if (row.option !== undefined) this.#optionRows.set(child, row.option);
		}
	}

	#showCountdown(seconds: number): void {
		if (!this.#card) {
			this.#titleComponent?.setText(`${this.#baseTitle} (${seconds}s)`);
			return;
		}
		this.#countdownSuffix = ` (${seconds}s)`;
		this.#onRequestRender?.();
	}

	setOnRequestRender(callback: () => void): void {
		this.#useRequestRender(callback);
	}

	#useRequestRender(callback: () => void): void {
		this.#onRequestRender = callback;
		this.#hoverFade?.dispose();
		this.#hoverFade = new HoverFade({ requestRender: callback, enabled: pointerMotionEnabled() });
		if (this.#hoveredIndex !== null) this.#hoverFade.set(this.#hoveredIndex);
	}

	#hoverStrength(index: number): number {
		if (this.#hoverFade !== undefined) return this.#hoverFade.strengthAt(index);
		return index === this.#hoveredIndex ? 1 : 0;
	}

	#renderSliderLine(): string {
		const slider = this.#slider;
		if (!slider) return "";
		return renderSliderLines(slider.segments, this.#sliderIndex, slider.caption).join("\n");
	}

	#moveSlider(delta: number): void {
		const slider = this.#slider;
		if (!slider) return;
		const next = clampLow(this.#sliderIndex + delta, 0, slider.segments.length - 1);
		if (next === this.#sliderIndex) return;
		this.#sliderIndex = next;
		this.#sliderComponent?.setText(this.#renderSliderLine());
		slider.onChange?.(next);
	}

	#isSearchEnabled(renderWidth = this.#lastRenderWidth, mdTheme?: MarkdownTheme): boolean {
		return this.#totalOptionRows(this.#options, renderWidth, mdTheme) > this.#maxVisible;
	}

	#shouldRenderSearchStatus(renderWidth = this.#lastRenderWidth, mdTheme?: MarkdownTheme): boolean {
		return this.#isSearchEnabled(renderWidth, mdTheme) || this.#searchQuery.length > 0;
	}

	#renderStatusLine(total: number): string {
		const selectedCount = total === 0 ? 0 : this.#selectedIndex + 1;
		const count =
			this.#searchQuery.trim() && total !== this.#options.length
				? `${selectedCount}/${total} of ${this.#options.length}`
				: `${selectedCount}/${total}`;
		const suffix = this.#searchQuery.trim() ? `  Search: ${this.#searchQuery}` : "  Type to search";
		return theme.fg("dim", `  (${count})${suffix}`);
	}

	#setSearchQuery(query: string): void {
		this.#searchQuery = query;
		const indexedOptions = this.#options.map((option, index) => ({ option, index }));
		this.#filteredOptions = query.trim()
			? fuzzyFilter(indexedOptions, query, item => `${item.option.label} ${item.option.description ?? ""}`)
			: indexedOptions;
		this.#selectedIndex = this.#coerceSelectedIndex(0);
		this.#updateList();
	}

	#handleSearchInput(keyData: string): boolean {
		if (!this.#isSearchEnabled()) return false;

		if (matchesKey(keyData, "backspace")) {
			if (this.#searchQuery.length === 0) return false;
			const chars = [...this.#searchQuery];
			chars.pop();
			this.#setSearchQuery(chars.join(""));
			return true;
		}

		const printableText = extractPrintableText(keyData);
		if (printableText === undefined) return false;
		if (this.#searchQuery.length === 0 && printableText.trim().length === 0) return false;

		this.#setSearchQuery(this.#searchQuery + printableText);
		return true;
	}

	handleInput(keyData: string): void {
		if (keyData.startsWith("\x1b[<")) {
			if (this.#card) routeSgrMouseInput(keyData, event => this.#routeMouse(event));
			return;
		}
		if (this.#countdown) {
			this.#countdown.reset();
			this.#onTimeoutResetCallback?.();
		}

		if (matchesSelectCancel(keyData)) {
			this.#onCancelCallback();
			return;
		}

		if (this.#handleSearchInput(keyData)) {
			return;
		}

		if (matchesSelectUp(keyData) || (!this.#isSearchEnabled() && matchesKey(keyData, "k"))) {
			this.#moveSelection(-1);
		} else if (matchesSelectDown(keyData) || (!this.#isSearchEnabled() && matchesKey(keyData, "j"))) {
			this.#moveSelection(1);
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#selectCurrentOption();
		} else if (
			matchesKey(keyData, "left") ||
			(this.#slider && !this.#isSearchEnabled() && matchesKey(keyData, "h"))
		) {
			if (this.#slider) this.#moveSlider(-1);
			else this.#onLeftCallback?.();
		} else if (
			matchesKey(keyData, "right") ||
			(this.#slider && !this.#isSearchEnabled() && matchesKey(keyData, "l"))
		) {
			if (this.#slider) this.#moveSlider(1);
			else this.#onRightCallback?.();
		} else if (this.#onExternalEditorCallback && matchesAppExternalEditor(keyData)) {
			this.#onExternalEditorCallback();
		}
	}

	#selectCurrentOption(): void {
		const selected = this.#filteredOptions[this.#selectedIndex];
		if (selected && !this.#isDisabled(selected.index)) this.#onSelectCallback(selected.option.label);
	}

	#shortcuts(): readonly ModalShortcut[] {
		if (this.#helpText !== undefined) {
			const segments = this.#helpText.split(/\s{2,}/);
			const result: ModalShortcut[] = [];
			for (let si = 0; si < segments.length; si++) {
				const label = segments[si]!.trim();
				if (label.length === 0) continue;
				if (label.startsWith("enter ")) {
					result.push({ label, clickable: true, id: "confirm" });
				} else if (label.toLowerCase().startsWith("esc")) {
					result.push({ label, clickable: true, id: "close" });
				} else {
					result.push({ label });
				}
			}
			return result;
		}
		const extras: ModalShortcut[] = [];
		if (this.#slider) extras.push({ label: "←/→ tier" });
		if (this.#onExternalEditorCallback) {
			extras.push({ label: "external editor", keybindings: ["app.editor.external"] });
		}
		if (extras.length === 0) return SELECT_LIST_SHORTCUTS;
		const shortcuts = SELECT_LIST_SHORTCUTS.slice();
		shortcuts.splice(shortcuts.length - 1, 0, ...extras);
		return shortcuts;
	}

	#routeMouse(event: SgrMouseEvent): boolean {
		const chrome = hitTestModalChrome(this.#shellGeometry, event.row, event.col, {
			motion: event.motion,
			leftClick: event.leftClick,
		});
		if (
			consumeModalChipHover(chrome, this.#hoveredShortcutId, id => {
				this.#hoveredShortcutId = id;
				this.#onRequestRender?.();
			})
		) {
			return true;
		}
		if (
			chrome.kind === "close" ||
			chrome.kind === "outside" ||
			(chrome.kind === "shortcut" && chrome.id === "close")
		) {
			this.#onCancelCallback();
			return true;
		}
		if (chrome.kind === "shortcut" && chrome.id === "confirm") {
			this.#selectCurrentOption();
			return true;
		}
		if (event.wheel !== null) {
			this.#moveSelection(event.wheel < 0 ? -1 : 1);
			this.#onRequestRender?.();
			return true;
		}
		const line = event.row - this.#bodyRowStart;
		if (event.motion) {
			const index = this.#hitRows[line] ?? null;
			if (index !== this.#hoveredIndex) {
				this.#hoveredIndex = index;
				this.#hoverFade?.set(index);
				this.#onRequestRender?.();
			}
			return true;
		}
		if (event.leftClick) {
			const index = this.#hitRows[line];
			const filtered = index === undefined ? undefined : this.#filteredOptions[index];
			if (index !== undefined && filtered && !this.#isDisabled(filtered.index)) {
				this.#selectedIndex = index;
				this.#updateList();
				this.#selectCurrentOption();
			}
			return true;
		}
		return true;
	}

	#assembleBody(contentWidth: number): string[] {
		const body: string[] = [];
		this.#hitRows = [];
		const list = this.#listContainer;
		for (let ci = 0; ci < this.children.length; ci++) {
			const child = this.children[ci]!;
			if (child === list) {
				for (let ri = 0; ri < list.children.length; ri++) {
					const row = list.children[ri]!;
					const option = this.#optionRows.get(row);
					const renderedLines = row.render(contentWidth);
					for (let li = 0; li < renderedLines.length; li++) {
						const rendered = renderedLines[li]!;
						if (option === undefined) {
							body.push(rendered);
							continue;
						}
						this.#hitRows[body.length] = option;
						const strength = option === this.#selectedIndex ? 0 : this.#hoverStrength(option);
						body.push(strength > 0 ? hoverBandAt(rendered, contentWidth, strength) : rendered);
					}
				}
				continue;
			}
			const childLines = child.render(contentWidth);
			for (let li = 0; li < childLines.length; li++) body.push(childLines[li]!);
		}
		return body;
	}

	hitTestOption(line: number): number | undefined {
		return this.#hitRows[line];
	}

	setHoveredOption(index: number | null): boolean {
		if (index === this.#hoveredIndex) return false;
		this.#hoveredIndex = index;
		this.#hoverFade?.set(index);
		return true;
	}

	selectOptionAt(line: number): boolean {
		const index = this.#hitRows[line];
		const filtered = index === undefined ? undefined : this.#filteredOptions[index];
		if (index === undefined || !filtered || this.#isDisabled(filtered.index)) return false;
		this.#selectedIndex = index;
		this.#updateList();
		this.#selectCurrentOption();
		return true;
	}

	handleWheel(delta: number): void {
		this.#moveSelection(delta < 0 ? -1 : 1);
	}

	override render(width: number): readonly string[] {
		const renderWidth = Math.max(1, width);
		if (!this.#card) {
			if (this.#lastRenderWidth !== renderWidth) {
				this.#lastRenderWidth = renderWidth;
				this.#updateList(renderWidth);
			}
			return this.#assembleBody(renderWidth);
		}

		const height = process.stdout.rows || 40;
		const sizing = sizingForArea(MODAL_SIZING_MEDIUM, height);
		const dims = computeModalDims(renderWidth, height, sizing);
		if (!dims) {
			this.#shellGeometry = null;
			return new Array(height).fill(padding(renderWidth));
		}
		if (this.#lastRenderWidth !== dims.contentWidth) {
			this.#lastRenderWidth = dims.contentWidth;
			this.#updateList(dims.contentWidth);
		}

		const shortcuts = this.#shortcuts();
		const chrome = planModalChrome({
			sizing,
			modalHeight: dims.modalHeight,
			contentWidth: dims.contentWidth,
			shortcuts,
			hoveredShortcutId: this.#hoveredShortcutId,
		});

		const body = this.#assembleBody(dims.contentWidth);

		const shell = renderModalShell({
			title: truncateToWidth(this.#cardTitle + this.#countdownSuffix, dims.contentWidth, Ellipsis.Unicode),
			sizing,
			areaWidth: renderWidth,
			areaHeight: height,
			body: body.slice(0, chrome.maxBodyRows),
			preferredBodyRows: body.length,
			shortcuts,
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});
		this.#shellGeometry = shell.geometry;
		this.#bodyRowStart = shell.geometry?.bodyRowStart ?? 0;
		return shell.lines;
	}

	dispose(): void {
		this.#countdown?.dispose();
		this.#hoverFade?.dispose();
		this.#hoverFade = undefined;
		this.#hoveredIndex = null;
	}
}
