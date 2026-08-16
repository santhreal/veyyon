/**
 * Generic selector component for hooks.
 * Displays a list of string options with keyboard navigation.
 */
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
	applyModalReveal,
	beginModalExit,
	computeModalDims,
	consumeModalChipHover,
	hitTestModalChrome,
	MODAL_SIZING_MEDIUM,
	ModalRevealDriver,
	type ModalShellGeometry,
	type ModalShortcut,
	modalRevealEnabled,
	planModalChrome,
	renderModalShell,
	SELECT_LIST_SHORTCUTS,
	sizingForArea,
} from "./modal-shell";
import { renderSliderLines } from "./segment-track";
import { hoverBandAt } from "./selector-helpers";

/** One segment of a {@link HookSelectorSlider} — a label and an optional
 *  detail line (e.g. the resolved model name) shown beneath the track while
 *  the segment is active. Segment colors come from the track's theme palette,
 *  assigned by position. */
export interface HookSelectorSliderSegment {
	label: string;
	/** Secondary line rendered under the track when this segment is selected. */
	detail?: string;
}

/**
 * A horizontal left/right selector rendered above the option list. Unlike the
 * up/down option cursor, the slider is moved with the left/right arrows from
 * any list position, letting the caller capture an orthogonal choice (e.g. the
 * model tier to continue execution with) alongside the selected option.
 */
export interface HookSelectorSlider {
	/** Dim caption rendered before the slider track (e.g. "continue with"). */
	caption?: string;
	segments: HookSelectorSliderSegment[];
	/** Initially highlighted segment index. */
	index: number;
	/** Invoked with the new index whenever the slider moves. */
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
	/** Indices into the original options that cannot be selected: they render
	 *  dimmed, are skipped during navigation, and reject enter/timeout. */
	disabledIndices?: readonly number[];
	/** Render a leading radio/checkbox marker before each markable option,
	 *  matching the ask transcript. "radio" fills the marker on the cursor row
	 *  (single-choice); "checkbox" reflects {@link checkedIndices} per row
	 *  (multi-select). Options at or beyond {@link markableCount} keep the plain
	 *  cursor prefix — used for trailing control rows like "Other"/"Done". */
	selectionMarker?: "radio" | "checkbox";
	/** For `selectionMarker: "checkbox"`: original-indices currently checked. */
	checkedIndices?: readonly number[];
	/** Number of leading options (original order) that receive a selection
	 *  marker. Defaults to every option when {@link selectionMarker} is set. */
	markableCount?: number;
	/**
	 * `"card"` (default) is the standalone surface: a floating ModalShell over
	 * the transcript, with house footer chips and pointer support. `"embedded"`
	 * renders the bare title and option list for a host that already owns a
	 * card and mounts this inside its body (the session picker's delete
	 * confirmation), so the two frames never nest.
	 */
	presentation?: "card" | "embedded";
	/** Card presentation only: repaint request for hover and countdown paints. */
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

/** One row of the option list. `highlight` causes the row (and its wrapped
 *  continuations, plus trailing padding) to be painted with the theme's
 *  `selectedBg` band — the focus cue that survives themes where `accent` fg is
 *  close to the terminal foreground. `option` is the filtered option index the
 *  row belongs to, so the pointer can answer a click on any of an option's
 *  lines with that option. */
type SelectorRow = { text: string; highlight: boolean; option?: number };

/** Paint `content` with the `selectedBg` background, applied AFTER any inner
 *  ANSI styling so the band spans padding as well as content. */
function paintSelectedRow(content: string): string {
	return theme.bg("selectedBg", content);
}

/** A filtered option paired with its index into the original options array, so
 *  disabled-index lookups survive fuzzy filtering and reordering. */
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
	/** Floating card (default) versus bare rows inside a host's own card. */
	readonly #card: boolean;
	#helpText: string | undefined;
	#onRequestRender: (() => void) | undefined;
	/** Card title bar text: the title's first line, plus the countdown suffix. */
	#cardTitle: string;
	#countdownSuffix = "";
	/** List children that are option rows, and the filtered index each stands for. */
	#optionRows = new Map<Component, number>();
	/** Per-render map of 0-based body line → filtered option index. */
	#hitRows: (number | undefined)[] = [];
	/** Pointer-highlighted option (never the selected one; selection owns its row). */
	#hoveredIndex: number | null = null;
	/**
	 * The cross-fade between the option the pointer left and the one it arrived at, once a host
	 * lends this card a repaint. Absent, the band is switched.
	 */
	#hoverFade: HoverFade | undefined;
	#shellGeometry: ModalShellGeometry | null = null;
	#hoveredShortcutId: string | null = null;
	#bodyRowStart = 0;
	#reveal = new ModalRevealDriver();
	/**
	 * Fade out on the shared clock before the host drops this card. The overlay stack keeps painting
	 * it and stops routing input to it the moment this is called.
	 */
	beginOverlayExit(requestRender: () => void, done: () => void): boolean {
		return beginModalExit(this.#reveal, requestRender, done);
	}

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

		// The card's title bar carries the title's first line, so the body opens
		// on whatever the caller put under it (the session name a delete
		// confirmation is about) rather than repeating the heading.
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
					// Auto-select current option on timeout (typically the first/recommended option)
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

	/** Clamp `index` into range, then walk forward (and finally backward) to the
	 *  nearest enabled option so the cursor never lands on a disabled row. */
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

	/** Move the cursor by `delta`, skipping disabled rows, stopping at the first
	 *  enabled option reached or at the list edge. */
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

	/** Styled leading marker (`"<glyph> "`) for a markable option row, or
	 *  `undefined` when no marker applies (control rows beyond `markableCount`,
	 *  or when {@link selectionMarker} is unset) so the caller falls back to the
	 *  classic cursor prefix. Radio fills on the cursor row; checkbox reflects
	 *  the per-row checked state, with the cursor row drawn in accent. */
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

	/** Wrap an option description into indented rows, truncating to `maxRows`
	 *  with an ellipsis. Pre-wrapping (rather than emitting one long line that the
	 *  list re-wraps) lets compact mode bound how much of the highlighted option's
	 *  detail is shown, so every option label stays on screen on short terminals. */
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
		if (wrapped.length <= maxRows) return wrapped.map(row => indent + row);
		const kept = wrapped.slice(0, maxRows);
		kept[maxRows - 1] = truncateToWidth(wrapped.slice(maxRows - 1).join(" "), bodyWidth, Ellipsis.Unicode);
		return kept.map(row => indent + row);
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
		for (const line of this.#renderOptionLines(option, isSelected, false, mdTheme, descRows, renderWidth)) {
			rows += this.#renderedLineRowCount(line, renderWidth);
		}
		return rows;
	}

	#totalOptionRows(options: HookSelectorOption[], renderWidth?: number, mdTheme?: MarkdownTheme): number {
		const themeForRows = mdTheme ?? getMarkdownTheme();
		let rows = 0;
		for (const option of options) {
			rows += this.#optionRowCount(option, renderWidth, false, themeForRows, "full");
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

		// In compact mode every option contributes only its label rows; the
		// highlighted option's description is layered on afterwards (see
		// #updateList), so the window is sized to keep as many labels visible as
		// possible rather than letting one long description swallow the budget.
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
		// Compact mode kicks in exactly when the fully-expanded list (all
		// descriptions) would overflow the row budget — the same condition that
		// enables search. There we collapse every option to its label and show
		// only the highlighted option's description, so the whole menu stays
		// visible on short terminals instead of collapsing to a single entry.
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
			// Reserve one row for the status line; give the remainder to the
			// highlighted option's description.
			selectedDescRows = Math.max(0, Math.max(1, this.#maxVisible) - labelRows - 1);
		}

		for (let i = startIndex; i < endIndex; i++) {
			const filtered = this.#filteredOptions[i];
			if (filtered === undefined) continue;
			const isSelected = i === this.#selectedIndex;
			const isDisabled = this.#isDisabled(filtered.index);
			const descMode: number | "full" = compact ? (isSelected ? selectedDescRows : 0) : "full";
			// Highlight the whole option block (label + wrapped description rows)
			// so the focus band reads as one continuous bar rather than a stripe
			// under the label alone. Disabled rows never claim focus even if the
			// index momentarily lands on one during initial coercion.
			const highlight = isSelected && !isDisabled;
			for (const text of this.#renderOptionLines(
				filtered.option,
				isSelected,
				isDisabled,
				mdTheme,
				descMode,
				renderWidth,
				filtered.index,
			)) {
				rows.push({ text, highlight, option: i });
			}
		}

		if (total === 0) {
			rows.push({ text: theme.fg("dim", "  No matching options"), highlight: false });
		}

		if (startIndex > 0 || endIndex < total || this.#shouldRenderSearchStatus(renderWidth, mdTheme)) {
			rows.push({ text: this.#renderStatusLine(total), highlight: false });
		}
		this.#listContainer.clear();
		this.#optionRows.clear();
		for (const row of rows) {
			const bgFn = row.highlight ? paintSelectedRow : undefined;
			const child = new Text(row.text, 1, 0, bgFn);
			this.#listContainer.addChild(child);
			if (row.option !== undefined) this.#optionRows.set(child, row.option);
		}
	}

	/** Countdown tick: the card shows it in the title bar, an embedded selector
	 *  in its own title row, because that is the heading each one draws. */
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

	/** Take a repaint seam and rebuild the hover fade on it. Both the constructor option and the
	 *  later setter land here, because a host that hands the callback in at construction time is
	 *  just as entitled to the fade as one that lends it afterwards. */
	#useRequestRender(callback: () => void): void {
		this.#onRequestRender = callback;
		// The band fades only once the card has a repaint to lend it: the frames between two mouse
		// reports have no input to hang off. Same ambient gate as the open unfold.
		this.#hoverFade?.dispose();
		this.#hoverFade = new HoverFade({ requestRender: callback, enabled: modalRevealEnabled() });
		if (this.#hoveredIndex !== null) this.#hoverFade.set(this.#hoveredIndex);
	}

	/** Band strength for an option row; without a fade the hovered row is at 1 and the rest at 0. */
	#hoverStrength(index: number): number {
		if (this.#hoverFade !== undefined) return this.#hoverFade.strengthAt(index);
		return index === this.#hoveredIndex ? 1 : 0;
	}

	/** Render the slider block in the style of the status line: each option is a
	 *  distinctly colored segment, the active one filled as a powerline chip
	 *  (its accent as the background, a luminance-matched label, flanked by
	 *  triangle caps) and the rest shown as plain colored labels joined by a thin
	 *  separator. Edge arrows brighten while there is room to move. When the
	 *  active segment carries a `detail` (e.g. the resolved model name) a muted
	 *  second line is appended. Returns one or two `\n`-joined lines. */
	#renderSliderLine(): string {
		const slider = this.#slider;
		if (!slider) return "";
		return renderSliderLines(slider.segments, this.#sliderIndex, slider.caption).join("\n");
	}

	/** Move the slider by `delta`, clamped to the segment range, refresh the
	 *  rendered track, and notify the caller only when the index actually moves. */
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
			// Only a card reads its own reports. Embedded, the host's card offsets
			// these rows, so a report read in this component's coordinates would
			// answer the wrong option: the host routes it through hitTestOption.
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

	/**
	 * Footer chips. A caller that passed `helpText` already wrote the keys its
	 * dialog takes — an ask question toggles where a menu selects — so those
	 * segments become the chips verbatim rather than a house row that would
	 * name the wrong key. The double-space between segments is the separator
	 * every caller writes.
	 */
	#shortcuts(): readonly ModalShortcut[] {
		if (this.#helpText !== undefined) {
			return this.#helpText
				.split(/\s{2,}/)
				.map(segment => segment.trim())
				.filter(segment => segment.length > 0)
				.map(label => {
					if (label.startsWith("enter ")) return { label, clickable: true, id: "confirm" };
					if (label.toLowerCase().startsWith("esc")) return { label, clickable: true, id: "close" };
					return { label };
				});
		}
		// Every other list surface names these keys the same way, and the labels
		// carry the live keybinding rather than a hardcoded "enter"/"esc".
		const extras: ModalShortcut[] = [];
		if (this.#slider) extras.push({ label: "←/→ tier" });
		if (this.#onExternalEditorCallback) {
			extras.push({ label: "external editor", keybindings: ["app.editor.external"] });
		}
		if (extras.length === 0) return SELECT_LIST_SHORTCUTS;
		// The close chip stays last; the surface's own keys sit in front of it.
		const shortcuts = [...SELECT_LIST_SHORTCUTS];
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
			// A click mirrors Enter: move onto the option, then take it. A
			// disabled row is inert under the pointer exactly as it is under the
			// cursor keys, rather than moving the selection onto it.
			if (index !== undefined && filtered && !this.#isDisabled(filtered.index)) {
				this.#selectedIndex = index;
				this.#updateList();
				this.#selectCurrentOption();
			}
			return true;
		}
		return true;
	}

	/**
	 * Rows this selector draws, with `#hitRows` filled in as they are produced.
	 * Assembled child by child rather than through the container so each
	 * option's LINES are known: an option row wraps, and a hit map built from
	 * child order would answer the wrong option.
	 */
	#assembleBody(contentWidth: number): string[] {
		const body: string[] = [];
		this.#hitRows = [];
		const list = this.#listContainer;
		for (const child of this.children) {
			if (child === list) {
				for (const row of list.children) {
					const option = this.#optionRows.get(row);
					for (const rendered of row.render(contentWidth)) {
						if (option === undefined) {
							body.push(rendered);
							continue;
						}
						this.#hitRows[body.length] = option;
						// The cursor row already carries the selection band; the
						// pointer band is what the OTHER rows get under the mouse.
						const strength = option === this.#selectedIndex ? 0 : this.#hoverStrength(option);
						body.push(strength > 0 ? hoverBandAt(rendered, contentWidth, strength) : rendered);
					}
				}
				continue;
			}
			for (const rendered of child.render(contentWidth)) body.push(rendered);
		}
		return body;
	}

	/**
	 * Embedded presentation: the option index drawn on `line` (0-based within
	 * this selector's own rows), or undefined for a heading, gap or the status
	 * row. The host owns the card and therefore owns the pointer; this is how
	 * it asks which option a click landed on.
	 */
	hitTestOption(line: number): number | undefined {
		return this.#hitRows[line];
	}

	/** Embedded presentation: hover `index` (or clear it with null). Returns
	 *  true when the paint changed. */
	setHoveredOption(index: number | null): boolean {
		if (index === this.#hoveredIndex) return false;
		this.#hoveredIndex = index;
		this.#hoverFade?.set(index);
		return true;
	}

	/** Embedded presentation: take the option on `line`, exactly as Enter
	 *  would. A gap, heading or disabled row is inert. */
	selectOptionAt(line: number): boolean {
		const index = this.#hitRows[line];
		const filtered = index === undefined ? undefined : this.#filteredOptions[index];
		if (index === undefined || !filtered || this.#isDisabled(filtered.index)) return false;
		this.#selectedIndex = index;
		this.#updateList();
		this.#selectCurrentOption();
		return true;
	}

	/** Embedded presentation: a wheel notch steps the cursor like an arrow. */
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
			return Array.from({ length: height }, () => padding(renderWidth));
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
		return applyModalReveal(shell, renderWidth, this.#reveal.value);
	}

	dispose(): void {
		this.#countdown?.dispose();
		this.#hoverFade?.dispose();
		this.#hoverFade = undefined;
		this.#hoveredIndex = null;
	}
}
