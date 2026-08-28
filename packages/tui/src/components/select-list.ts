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
	hint?: string;
	group?: string;
	filterText?: string;
}

export interface SelectListTheme {
	selectedPrefix: (text: string) => string;
	selectedText: (text: string) => string;
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
	symbols: SymbolTheme;
	hovered?: (text: string, strength: number) => string;
	matchHighlight?: (text: string) => string;
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
	overflowSearch?: boolean;
	wrapDescription?: boolean;
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
	#searchable?: ReadonlyArray<{ item: SelectItem; text: string }>;
	#filterQuery = "";
	#filterTypedByUser = false;
	#selectedIndex: number = 0;
	#hoveredIndex: number | null = null;
	#hoverFade?: HoverFade;
	#hitRows: (number | undefined)[] = [];
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

	setMaxVisible(rows: number): void {
		this.maxVisible = Math.max(1, Math.floor(rows));
	}

	setRowBudget(rows: number): void {
		const budget = Math.max(1, Math.floor(rows));
		const searchable = this.layout.overflowSearch !== false;
		const needsStatusRow = searchable && (this.items.length > budget || this.#filterQuery.length > 0);
		this.#statusRowFitsBudget = budget > 1;
		this.maxVisible = Math.max(1, needsStatusRow && budget > 1 ? budget - 1 : budget);
	}

	setFilter(filter: string): void {
		this.#setFilter(filter, true);
	}

	hasActiveFilter(): boolean {
		return this.#canClearFilter();
	}

	setSelectedIndex(index: number): void {
		this.#selectedIndex = clampLow(index, 0, this.#filteredItems.length - 1);
	}

	hitTest(line: number): number | undefined {
		return this.#hitRows[line];
	}

	setHoverIndex(index: number | null): void {
		this.#hoveredIndex = index;
		this.#hoverFade?.set(index);
	}

	setHoverMotion(options: HoverFadeOptions): void {
		this.#hoverFade?.dispose();
		this.#hoverFade = new HoverFade(options);
		if (this.#hoveredIndex !== null) this.#hoverFade.set(this.#hoveredIndex);
	}

	disposeHoverMotion(): void {
		this.#hoverFade?.dispose();
		this.#hoverFade = undefined;
		this.#hoveredIndex = null;
	}

	#hoverStrength(index: number): number {
		if (this.#hoverFade !== undefined) return this.#hoverFade.strengthAt(index);
		return index === this.#hoveredIndex ? 1 : 0;
	}

	handleWheel(delta: -1 | 1): void {
		if (this.#filteredItems.length === 0) return;
		const next = clamp(this.#selectedIndex + delta, 0, this.#filteredItems.length - 1);
		if (next === this.#selectedIndex) return;
		this.#selectedIndex = next;
		this.#notifySelectionChange();
	}

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

	invalidate(): void {}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		this.#hitRows = [];
		const showSearchStatus = this.#shouldRenderSearchStatus();

		if (this.#filteredItems.length === 0) {
			if (showSearchStatus) {
				lines.push(this.#renderStatusLine(width));
			}
			lines.push(this.theme.noMatch("  No matching items"));
			return lines;
		}

		const primaryColumnWidth = this.#getPrimaryColumnWidth();
		const wrapEnabled = this.layout.wrapDescription === true;
		const visualBudget = this.maxVisible;

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
			if (this.#headerBefore(i)) rowCounts[i] = (rowCounts[i] ?? 1) + 1;
			visualTotal += rowCounts[i];
		}

		const overflow = visualTotal > visualBudget;
		const rowWidth = Math.max(0, width - (overflow ? 1 : 0));

		const { startIndex, endIndex, visualOffset } = this.#pickWindow(rowCounts, visualBudget);

		const rows: string[] = [];
		for (let i = startIndex; i < endIndex && rows.length < visualBudget; i++) {
			const item = this.#filteredItems[i];
			if (!item) continue;
			if (this.#headerBefore(i) && rows.length < visualBudget) {
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

		if (showSearchStatus) {
			lines.push(this.#renderStatusLine(width));
		}

		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
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
		if (kb.matches(keyData, "tui.select.up")) {
			this.#selectedIndex = this.#selectedIndex === 0 ? this.#filteredItems.length - 1 : this.#selectedIndex - 1;
			this.#notifySelectionChange();
		} else if (kb.matches(keyData, "tui.select.down")) {
			this.#selectedIndex = this.#selectedIndex === this.#filteredItems.length - 1 ? 0 : this.#selectedIndex + 1;
			this.#notifySelectionChange();
		} else if (kb.matches(keyData, "tui.select.pageUp")) {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - this.maxVisible);
			this.#notifySelectionChange();
		} else if (kb.matches(keyData, "tui.select.pageDown")) {
			this.#selectedIndex = Math.min(this.#filteredItems.length - 1, this.#selectedIndex + this.maxVisible);
			this.#notifySelectionChange();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selectedItem = this.#filteredItems[this.#selectedIndex];
			if (selectedItem && this.onSelect) {
				this.onSelect(selectedItem);
			}
		}
	}

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

	#headerBefore(i: number): boolean {
		if (!this.theme.groupHeader) return false;
		const item = this.#filteredItems[i];
		if (!item?.group) return false;
		return i === 0 || this.#filteredItems[i - 1]?.group !== item.group;
	}

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
		const layout = this.#computeItemLayout(item, false, width, primaryColumnWidth);
		if (layout.kind !== "description") return 1;
		const wrapped = wrapTextWithAnsi(layout.descriptionSingleLine, layout.remainingWidth);
		return Math.max(1, wrapped.length);
	}

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
		while (lo > 0 && rowsAboveSelected + (rowCounts[lo - 1] ?? 0) <= half) {
			lo--;
			rowsAboveSelected += rowCounts[lo] ?? 0;
		}

		let hi = selected + 1;
		let used = rowsAboveSelected + (rowCounts[selected] ?? 0);
		while (hi < n && used + (rowCounts[hi] ?? 0) <= budget) {
			used += rowCounts[hi] ?? 0;
			hi++;
		}

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

	#canEditSearch(): boolean {
		return this.#statusRowFitsBudget && this.layout.overflowSearch !== false && this.items.length > this.maxVisible;
	}

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
		if (item.filterText !== undefined) return sanitizeSingleLine(item.filterText);
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
