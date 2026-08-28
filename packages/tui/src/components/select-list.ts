import { popLoopPhase, pushLoopPhase } from "@veyyon/utils/loop-phase";
import { fuzzyFilter, matchPositions } from "../fuzzy";
import { getKeybindings } from "../keybindings";
import { extractPrintableText } from "../keys";
import { HoverFade, type HoverFadeOptions } from "../motion-hover";
import { type MouseRoutable, routeSelectListMouse, type SgrMouseEvent } from "../mouse";
import type { SymbolTheme } from "../symbols";
import type { Component } from "../tui";
import {
	clamp,
	clampLow,
	Ellipsis,
	padding,
	sanitizeSingleLine,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../utils";
import { ScrollView } from "./scroll-view";

const DEFAULT_PRIMARY_COLUMN_WIDTH = 32;
const PRIMARY_COLUMN_GAP = 2;
const MIN_DESCRIPTION_WIDTH = 10;

const DEFAULT_CURSOR_SYMBOL = ">";

export interface SelectItem {
	value: string;
	label: string;
	description?: string;
	/** Dim hint text shown inline after cursor when this item is selected */
	hint?: string;
	/** Category this item belongs to for group header rendering. */
	group?: string;
	/** Custom text to match against when filtering. */
	filterText?: string;
}

export interface SelectListTheme {
	selectedPrefix: (text: string) => string;
	selectedText: (text: string) => string;
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
	symbols: SymbolTheme;
	/** Hover band applied to the row under the mouse pointer. */
	hovered?: (text: string, strength: number) => string;
	/**
	 * Paint applied to the label characters the active filter query matched
	 * (see fuzzy `matchPositions`). Unselected rows only: the selected row's
	 * own style stays intact so nested resets can't bleach it. Omit for no
	 * hit highlighting.
	 */
	matchHighlight?: (text: string) => string;
	/**
	 * Paint for group header rows (see {@link SelectItem.group}). Receives the
	 * group name; returns the full styled header line content. Omit to render
	 * grouped lists flat (headers only exist when both the data and the theme
	 * opt in).
	 */
	groupHeader?: (text: string) => string;
}

export interface SelectListTruncatePrimaryContext {
	text: string;
	maxWidth: number;
	columnWidth: number;
	item: SelectItem;
	isSelected: boolean;
}

export interface SelectListLayoutOptions {
	minPrimaryColumnWidth?: number;
	maxPrimaryColumnWidth?: number;
	truncatePrimary?: (context: SelectListTruncatePrimaryContext) => string;
	/** Enable type-to-filter search when the item count exceeds maxVisible. Defaults to true. */
	overflowSearch?: boolean;
	/** Wrap long descriptions onto continuation rows instead of truncating. */
	wrapDescription?: boolean;
	/** Show the key legend on the status row. Defaults to true. */
	statusLegend?: boolean;
}

type SelectItemLayout =
	| {
			kind: "description";
			prefix: string;
			truncatedValue: string;
			spacing: string;
			descriptionSingleLine: string;
			descriptionStart: number;
			remainingWidth: number;
	  }
	| {
			kind: "primary";
			prefix: string;
			truncatedValue: string;
			spacing: "";
	  };

export class SelectList implements Component, MouseRoutable {
	#filteredItems: ReadonlyArray<SelectItem>;
	// Each item paired with its precomputed, sanitized filter text. Built once on
	// first filter (items are immutable), so typing a query does not re-run
	// `#getFilterText` (string concat + sanitizeSingleLine) for every item on
	// every keystroke — the dominant cost when filtering a large candidate list.
	#searchable?: ReadonlyArray<{ item: SelectItem; text: string }>;
	#filterQuery = "";
	/**
	 * True while {@link #filterQuery} is something the user typed into this list,
	 * as opposed to a query a host pushed in with {@link setFilter}. The two get
	 * different cancel-key treatment; see {@link #canClearFilter}.
	 */
	#filterTypedByUser = false;
	#selectedIndex: number = 0;
	#hoveredIndex: number | null = null;
	/**
	 * The cross-fade, once a host has offered a way to repaint between mouse
	 * reports ({@link setHoverMotion}). Absent, the band is switched: exactly the
	 * behavior every existing host has.
	 */
	#hoverFade?: HoverFade;
	/** Per-render map of 0-based output line → filtered-item index. */
	#hitRows: (number | undefined)[] = [];
	/**
	 * False when the current row budget is too small to afford the status row.
	 * Set by {@link setRowBudget}; true otherwise, so a list that was never sized
	 * against a budget behaves exactly as it did before.
	 */
	#statusRowFitsBudget = true;

	onSelect?: (item: SelectItem) => void;
	onCancel?: () => void;
	onSelectionChange?: (item: SelectItem) => void;

	constructor(
		private readonly items: ReadonlyArray<SelectItem>,
		private maxVisible: number,
		private readonly theme: SelectListTheme,
		private readonly layout: SelectListLayoutOptions = {},
	) {
		this.#filteredItems = items;
	}

	/** Resize the visible item window. */
	setMaxVisible(rows: number): void {
		this.maxVisible = Math.max(1, Math.floor(rows));
	}

	/** Size the list so its full render output fits within `rows` terminal rows. */
	setRowBudget(rows: number): void {
		const budget = Math.max(1, Math.floor(rows));
		const searchable = this.layout.overflowSearch !== false;
		// The status row appears when the items cannot all be shown, which is what
		// a budget below the item count means, or while a filter is active.
		const needsStatusRow = searchable && (this.items.length > budget || this.#filterQuery.length > 0);
		// One row cannot hold an item AND the status row. The caller asked for a
		// list, so the row goes to the list: a status row alone would show none of
		// the thing being chosen, and returning two rows would break the promise
		// this method exists to make.
		this.#statusRowFitsBudget = budget > 1;
		this.maxVisible = Math.max(1, needsStatusRow && budget > 1 ? budget - 1 : budget);
	}

	setFilter(filter: string): void {
		this.#setFilter(filter, true);
	}

	/** Whether Escape will clear a live search filter instead of closing the list. */
	hasActiveFilter(): boolean {
		return this.#canClearFilter();
	}

	setSelectedIndex(index: number): void {
		// `clampLow`, because an empty filtered list makes the high bound -1 and
		// `clamp` returns that inverted bound: a selection index of -1 indexes off
		// the front of the list. `clampLow` keeps the low bound in that case.
		this.#selectedIndex = clampLow(index, 0, this.#filteredItems.length - 1);
	}

	/** Resolve a 0-based rendered-line index to a filtered-item index. */
	hitTest(line: number): number | undefined {
		return this.#hitRows[line];
	}

	/** Band the row under the pointer (null clears). */
	setHoverIndex(index: number | null): void {
		this.#hoveredIndex = index;
		this.#hoverFade?.set(index);
	}

	/** Configure hover cross-fade motion. */
	setHoverMotion(options: HoverFadeOptions): void {
		this.#hoverFade?.dispose();
		this.#hoverFade = new HoverFade(options);
		if (this.#hoveredIndex !== null) this.#hoverFade.set(this.#hoveredIndex);
	}

	/** Dispose hover motion controllers and registered clock callbacks. */
	disposeHoverMotion(): void {
		this.#hoverFade?.dispose();
		this.#hoverFade = undefined;
		this.#hoveredIndex = null;
	}

	/** Resolved hover band strength for a filtered-item index (0 to 1). */
	#hoverStrength(index: number): number {
		if (this.#hoverFade !== undefined) return this.#hoverFade.strengthAt(index);
		return index === this.#hoveredIndex ? 1 : 0;
	}

	/** Move the selection one step for a wheel notch. */
	handleWheel(delta: -1 | 1): void {
		if (this.#filteredItems.length === 0) return;
		const next = clamp(this.#selectedIndex + delta, 0, this.#filteredItems.length - 1);
		if (next === this.#selectedIndex) return;
		this.#selectedIndex = next;
		this.#notifySelectionChange();
	}

	/** Mouse click: select the item under the pointer and confirm it. */
	clickItem(index: number): void {
		const item = this.#filteredItems[index];
		if (!item) return;
		if (index !== this.#selectedIndex) {
			this.#selectedIndex = index;
			this.#notifySelectionChange();
		}
		this.onSelect?.(item);
	}

	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		routeSelectListMouse(this, event, line);
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		this.#hitRows = [];
		const showSearchStatus = this.#shouldRenderSearchStatus();

		// If no items match filter, show message
		if (this.#filteredItems.length === 0) {
			if (showSearchStatus) {
				lines.push(this.#renderStatusLine(width));
			}
			lines.push(this.theme.noMatch("  No matching items"));
			return lines;
		}

		const primaryColumnWidth = this.#getPrimaryColumnWidth();
		const wrapEnabled = this.layout.wrapDescription === true;
		// `maxVisible` is the picker's visual row budget. For non-wrap layouts
		// every item is one row, so the budget matches the original item count.
		const visualBudget = this.maxVisible;

		// Compute per-item visual row counts at the conservative width (i.e.
		// assume the scrollbar column might be reserved). For non-wrap layouts
		// every count is 1, so visualTotal == #filteredItems and overflow falls
		// back to the original `N > maxVisible` predicate exactly.
		const conservativeRowWidth = Math.max(0, width - 1);
		const rowCounts = new Array<number>(this.#filteredItems.length);
		let visualTotal = 0;
		for (let i = 0; i < this.#filteredItems.length; i++) {
			const item = this.#filteredItems[i];
			if (!item) {
				rowCounts[i] = 0;
				continue;
			}
			rowCounts[i] = wrapEnabled ? this.#computeItemRowCount(item, conservativeRowWidth, primaryColumnWidth) : 1;
			// A group header rides on its group's first surviving item, so the
			// window/scroll math counts it as part of that item's rows.
			if (this.#headerBefore(i)) rowCounts[i] = (rowCounts[i] ?? 1) + 1;
			visualTotal += rowCounts[i];
		}

		const overflow = visualTotal > visualBudget;
		const rowWidth = Math.max(0, width - (overflow ? 1 : 0));

		// Pick a window centered on the selected item that fits in visualBudget
		// rows. Falls through to the original item-count window when every row
		// count is 1.
		const { startIndex, endIndex, visualOffset } = this.#pickWindow(rowCounts, visualBudget);

		// Render visible items. Cap rows at the budget so a single item that
		// wraps to more than `visualBudget` rows (pathological — e.g. a 5-row
		// description with maxVisible=3) still keeps the popup bounded; the
		// scrollbar carries the offscreen rows.
		const rows: string[] = [];
		for (let i = startIndex; i < endIndex && rows.length < visualBudget; i++) {
			const item = this.#filteredItems[i];
			if (!item) continue;
			if (this.#headerBefore(i) && rows.length < visualBudget) {
				// Header rows are chrome: not selectable, not hoverable — the
				// hitRows slot stays undefined so mouse routing skips them.
				rows.push(this.theme.groupHeader!(item.group!));
			}
			const band = this.theme.hovered;
			const strength = this.#hoverStrength(i);
			const itemRows = this.#renderItem(item, i === this.#selectedIndex, rowWidth, primaryColumnWidth);
			for (let ri = 0; ri < itemRows.length; ri++) {
				if (rows.length >= visualBudget) break;
				this.#hitRows[rows.length] = i;
				rows.push(band !== undefined && strength > 0 ? band(itemRows[ri]!, strength) : itemRows[ri]!);
			}
		}

		const sv = new ScrollView(rows, {
			height: rows.length,
			scrollbar: "auto",
			totalRows: visualTotal,
			theme: { track: t => this.theme.scrollInfo(t), thumb: t => this.theme.selectedPrefix(t) },
		});
		sv.setScrollOffset(visualOffset);
		const svLines = sv.render(width);
		for (let li = 0; li < svLines.length; li++) lines.push(svLines[li]!);

		// Add search status when relevant (scrollbar now indicates overflow)
		if (showSearchStatus) {
			lines.push(this.#renderStatusLine(width));
		}

		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// Cancel-key ladder: clear non-empty search query first, close on second cancel.
		if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.#canClearFilter()) {
				this.#setFilter("", true);
				return;
			}
			if (this.onCancel) {
				this.onCancel();
			}
			return;
		}

		if (this.#handleSearchInput(keyData)) {
			return;
		}

		if (this.#filteredItems.length === 0) return;
		// Up arrow - wrap to bottom when at top
		if (kb.matches(keyData, "tui.select.up")) {
			this.#selectedIndex = this.#selectedIndex === 0 ? this.#filteredItems.length - 1 : this.#selectedIndex - 1;
			this.#notifySelectionChange();
		}
		// Down arrow - wrap to top when at bottom
		else if (kb.matches(keyData, "tui.select.down")) {
			this.#selectedIndex = this.#selectedIndex === this.#filteredItems.length - 1 ? 0 : this.#selectedIndex + 1;
			this.#notifySelectionChange();
		}
		// PageUp - jump up by one visible page
		else if (kb.matches(keyData, "tui.select.pageUp")) {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - this.maxVisible);
			this.#notifySelectionChange();
		}
		// PageDown - jump down by one visible page
		else if (kb.matches(keyData, "tui.select.pageDown")) {
			this.#selectedIndex = Math.min(this.#filteredItems.length - 1, this.#selectedIndex + this.maxVisible);
			this.#notifySelectionChange();
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selectedItem = this.#filteredItems[this.#selectedIndex];
			if (selectedItem && this.onSelect) {
				this.onSelect(selectedItem);
			}
		}
	}

	/** Paint selected row with cursor prefix and body styling. */
	#paintSelectedRow(prefix: string, body: string): string {
		return this.theme.selectedPrefix(prefix) + this.theme.selectedText(body);
	}

	#renderItem(item: SelectItem, isSelected: boolean, width: number, primaryColumnWidth: number): string[] {
		const layout = this.#computeItemLayout(item, isSelected, width, primaryColumnWidth);
		const { prefix, truncatedValue, spacing } = layout;

		if (layout.kind === "description") {
			const { descriptionSingleLine, descriptionStart, remainingWidth } = layout;
			if (this.layout.wrapDescription) {
				const wrapped = wrapTextWithAnsi(descriptionSingleLine, remainingWidth);
				if (wrapped.length === 0) wrapped.push("");
				const indent = padding(descriptionStart);
				const first = wrapped[0] ?? "";
				if (isSelected) {
					const rows = [this.#paintSelectedRow(prefix, `${truncatedValue}${spacing}${first}`)];
					for (let i = 1; i < wrapped.length; i++) {
						rows.push(this.theme.selectedText(`${indent}${wrapped[i]}`));
					}
					return rows;
				}
				const rows = [prefix + truncatedValue + this.theme.description(spacing + first)];
				for (let i = 1; i < wrapped.length; i++) {
					rows.push(this.theme.description(`${indent}${wrapped[i]}`));
				}
				return rows;
			}

			// Truncate description with ellipsis when exceeding available width.
			const truncatedDesc = truncateToWidth(descriptionSingleLine, remainingWidth, Ellipsis.Unicode);
			if (isSelected) {
				return [this.#paintSelectedRow(prefix, `${truncatedValue}${spacing}${truncatedDesc}`)];
			}
			return [
				prefix + this.#paintHits(truncatedValue, item.label) + this.theme.description(spacing + truncatedDesc),
			];
		}

		if (isSelected) {
			return [this.#paintSelectedRow(prefix, truncatedValue)];
		}
		return [prefix + this.#paintHits(truncatedValue, item.label)];
	}

	/**
	 * Whether a group header renders above filtered item `i`: the theme must
	 * provide the paint, the item must carry a group, and it must start a new
	 * run (first item, or a different group than the previous survivor).
	 */
	#headerBefore(i: number): boolean {
		if (!this.theme.groupHeader) return false;
		const item = this.#filteredItems[i];
		if (!item?.group) return false;
		return i === 0 || this.#filteredItems[i - 1]?.group !== item.group;
	}

	/**
	 * Paint the filter query's hit characters inside a truncated label. The
	 * label is plain text at this point (styling wraps rows later), so index
	 * math is safe; positions past the truncation point simply drop.
	 */
	#paintHits(truncatedValue: string, label: string): string {
		const paint = this.theme.matchHighlight;
		if (!paint || this.#filterQuery.length === 0) return truncatedValue;
		const positions = matchPositions(this.#filterQuery, label);
		if (positions.length === 0) return truncatedValue;
		const hitSet = new Set(positions);
		let out = "";
		for (let i = 0; i < truncatedValue.length; i++) {
			out += hitSet.has(i) ? paint(truncatedValue[i]!) : truncatedValue[i];
		}
		return out;
	}

	#computeItemRowCount(item: SelectItem, width: number, primaryColumnWidth: number): number {
		// Selection style does not change row count; pass isSelected=false to
		// keep the cheap path uniform for items outside the visible window.
		const layout = this.#computeItemLayout(item, false, width, primaryColumnWidth);
		if (layout.kind !== "description") return 1;
		const wrapped = wrapTextWithAnsi(layout.descriptionSingleLine, layout.remainingWidth);
		return Math.max(1, wrapped.length);
	}

	/** Pick a contiguous window of items fitting within the row budget. */
	#pickWindow(
		rowCounts: ReadonlyArray<number>,
		budget: number,
	): { startIndex: number; endIndex: number; visualOffset: number } {
		const n = rowCounts.length;
		const selected = clamp(this.#selectedIndex, 0, n - 1);
		if (n === 0) return { startIndex: 0, endIndex: 0, visualOffset: 0 };

		const half = Math.floor(budget / 2);
		let lo = selected;
		let rowsAboveSelected = 0;
		// Step 1: expand upward up to `half` rows above the selection so it
		// lands near the visual middle, matching the prior centering.
		while (lo > 0 && rowsAboveSelected + (rowCounts[lo - 1] ?? 0) <= half) {
			lo--;
			rowsAboveSelected += rowCounts[lo] ?? 0;
		}

		// Step 2: expand downward until the budget is filled. The selected
		// item's own rows are always counted; if it alone exceeds `budget`
		// the surplus is clipped at render time and the scrollbar carries it.
		let hi = selected + 1;
		let used = rowsAboveSelected + (rowCounts[selected] ?? 0);
		while (hi < n && used + (rowCounts[hi] ?? 0) <= budget) {
			used += rowCounts[hi] ?? 0;
			hi++;
		}

		// Step 3: if room remains (selection sat near the bottom), keep
		// expanding upward.
		while (lo > 0 && used + (rowCounts[lo - 1] ?? 0) <= budget) {
			lo--;
			used += rowCounts[lo] ?? 0;
		}

		let visualOffset = 0;
		for (let i = 0; i < lo; i++) visualOffset += rowCounts[i] ?? 0;
		return { startIndex: lo, endIndex: hi, visualOffset };
	}

	#computeItemLayout(
		item: SelectItem,
		isSelected: boolean,
		width: number,
		primaryColumnWidth: number,
	): SelectItemLayout {
		const cursor = this.theme.symbols?.cursor ?? DEFAULT_CURSOR_SYMBOL;
		const prefix = isSelected ? `${cursor} ` : padding(visibleWidth(cursor) + 1);
		const prefixWidth = visibleWidth(prefix);
		const descriptionSingleLine = item.description ? sanitizeSingleLine(item.description) : undefined;

		if (descriptionSingleLine && width > 40) {
			const effectivePrimaryColumnWidth = clamp(primaryColumnWidth, 1, width - prefixWidth - 4);
			const maxPrimaryWidth = Math.max(1, effectivePrimaryColumnWidth - PRIMARY_COLUMN_GAP);
			const truncatedValue = this.#truncatePrimary(item, isSelected, maxPrimaryWidth, effectivePrimaryColumnWidth);
			const truncatedValueWidth = visibleWidth(truncatedValue);
			const spacing = padding(Math.max(1, effectivePrimaryColumnWidth - truncatedValueWidth));
			const descriptionStart = prefixWidth + truncatedValueWidth + spacing.length;
			const remainingWidth = width - descriptionStart - 2; // -2 for safety

			if (remainingWidth > MIN_DESCRIPTION_WIDTH) {
				return {
					kind: "description",
					prefix,
					truncatedValue,
					spacing,
					descriptionSingleLine,
					descriptionStart,
					remainingWidth,
				};
			}
		}

		const fallbackMax = width - prefixWidth - 2;
		const truncatedValue = this.#truncatePrimary(item, isSelected, fallbackMax, fallbackMax);
		return {
			kind: "primary",
			prefix,
			truncatedValue,
			spacing: "",
		};
	}

	#getPrimaryColumnWidth(): number {
		const { min, max } = this.#getPrimaryColumnBounds();
		let widestPrimary = 0;
		for (let ii = 0; ii < this.#filteredItems.length; ii++) {
			widestPrimary = Math.max(
				widestPrimary,
				visibleWidth(this.#getDisplayValue(this.#filteredItems[ii]!)) + PRIMARY_COLUMN_GAP,
			);
		}

		return clamp(widestPrimary, min, max);
	}

	#getPrimaryColumnBounds(): { min: number; max: number } {
		const rawMin =
			this.layout.minPrimaryColumnWidth ?? this.layout.maxPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;
		const rawMax =
			this.layout.maxPrimaryColumnWidth ?? this.layout.minPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;

		return {
			min: clamp(rawMin, 1, rawMax),
			max: Math.max(1, Math.max(rawMin, rawMax)),
		};
	}

	#truncatePrimary(item: SelectItem, isSelected: boolean, maxWidth: number, columnWidth: number): string {
		const displayValue = this.#getDisplayValue(item);
		const truncatedValue = this.layout.truncatePrimary
			? this.layout.truncatePrimary({
					text: displayValue,
					maxWidth,
					columnWidth,
					item,
					isSelected,
				})
			: truncateToWidth(displayValue, maxWidth, Ellipsis.Omit);

		return truncateToWidth(truncatedValue, maxWidth, Ellipsis.Omit);
	}

	#getDisplayValue(item: SelectItem): string {
		return sanitizeSingleLine(item.label || item.value);
	}

	#renderStatusLine(width: number): string {
		const query = sanitizeSingleLine(this.#filterQuery);
		// The key legend rides the existing status row (no extra chrome row):
		// a picker without it read as a bare list with no visible affordances.
		// Dense one-space separator dialect; dropped first under truncation so
		// the live search text always survives.
		// "esc clear" while a query is live: the cancel ladder clears the search
		// first, so advertising "close" there would lie about what esc does next.
		const legend =
			this.layout.statusLegend === false
				? ""
				: query
					? " · ↑↓ move · ↵ select · esc clear"
					: " · ↑↓ move · ↵ select · esc close";
		const statusText = (query ? `  Search: ${query}` : "  Type to search") + legend;
		return this.theme.scrollInfo(truncateToWidth(statusText, Math.max(1, width - 2), Ellipsis.Omit));
	}

	#shouldRenderSearchStatus(): boolean {
		return (
			this.#statusRowFitsBudget &&
			this.layout.overflowSearch !== false &&
			(this.items.length > this.maxVisible || this.#filterQuery.length > 0)
		);
	}

	/** Whether type-to-search is currently active and permitted by row budget. */
	#canEditSearch(): boolean {
		return this.#statusRowFitsBudget && this.layout.overflowSearch !== false && this.items.length > this.maxVisible;
	}

	/** Whether cancel key clears the active query rather than closing the list. */
	#canClearFilter(): boolean {
		return this.#filterQuery.length > 0 && (this.#filterTypedByUser || this.#canEditSearch());
	}

	#handleSearchInput(keyData: string): boolean {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.editor.deleteCharBackward")) {
			if (!this.#canClearFilter()) return false;
			const len = this.#filterQuery.length;
			const cut = len > 0 && (this.#filterQuery.charCodeAt(len - 1) & 0xfc00) === 0xdc00 ? 2 : 1;
			this.#setFilter(this.#filterQuery.slice(0, len - cut), true, true);
			return true;
		}

		if (!this.#canEditSearch()) return false;

		const printableText = extractPrintableText(keyData);
		if (printableText === undefined) return false;
		if (this.#filterQuery.length === 0 && printableText.trim().length === 0) return false;

		this.#setFilter(this.#filterQuery + printableText, true, true);
		return true;
	}

	#setFilter(filter: string, notify: boolean, typedByUser = false): void {
		this.#filterQuery = filter;
		this.#filterTypedByUser = filter.length > 0 && typedByUser;
		if (filter.trim()) {
			// Breadcrumb the fuzzy match so the loop watchdog can attribute a
			// large-list filter stall instead of logging it as "unknown".
			pushLoopPhase("ui.select-filter");
			try {
				if (!this.#searchable) {
					const searchable = new Array<{ item: SelectItem; text: string }>(this.items.length);
					for (let ii = 0; ii < this.items.length; ii++)
						searchable[ii] = { item: this.items[ii]!, text: this.#getFilterText(this.items[ii]!) };
					this.#searchable = searchable;
				}
				const filtered = fuzzyFilter(this.#searchable, filter, entry => entry.text);
				const filteredItems: SelectItem[] = new Array(filtered.length);
				for (let fi = 0; fi < filtered.length; fi++) filteredItems[fi] = filtered[fi]!.item;
				this.#filteredItems = filteredItems;
			} finally {
				popLoopPhase();
			}
		} else {
			this.#filteredItems = this.items;
		}
		this.#selectedIndex = 0;
		if (notify) {
			this.#notifySelectionChange();
		}
	}

	#getFilterText(item: SelectItem): string {
		// An explicit filter text replaces the row's visible text outright rather
		// than adding to it: the point is to EXCLUDE what the row also shows.
		if (item.filterText !== undefined) return sanitizeSingleLine(item.filterText);
		// Concatenate distinct label and value for fuzzy search.
		let text = item.value === item.label ? item.label : `${item.label} ${item.value}`;
		if (item.description) {
			text += ` ${item.description}`;
		}
		if (item.hint) {
			text += ` ${item.hint}`;
		}
		return sanitizeSingleLine(text);
	}

	#notifySelectionChange(): void {
		const selectedItem = this.#filteredItems[this.#selectedIndex];
		if (selectedItem && this.onSelectionChange) {
			this.onSelectionChange(selectedItem);
		}
	}

	getSelectedItem(): SelectItem | null {
		const item = this.#filteredItems[this.#selectedIndex];
		return item || null;
	}
}
