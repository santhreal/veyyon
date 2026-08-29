import { getKeybindings } from "../keybindings";
import { extractPrintableText, isLoneLineFeed } from "../keys";
import { HoverFade, type HoverFadeOptions } from "../motion-hover";
import type { MouseRoutable, SgrMouseEvent } from "../mouse";
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
import type { SettingItem, SettingSection, SettingsListOptions, SettingsListTheme } from "./settings-list-helpers";
import { filterSettingItems } from "./settings-search";

export * from "./settings-list-helpers";
export type { SettingItem, SettingsListTheme };

export class SettingsList implements Component {
	#items: SettingItem[];
	#filteredItems: SettingItem[];
	#theme: SettingsListTheme;
	#selectedIndex = 0;
	#maxVisible: number;
	#onChange: (id: string, newValue: string) => void;
	#onCancel: () => void;
	#options: SettingsListOptions;
	#filterQuery = "";
	#sectionFocus = false;
	#lastNotifiedSelectionId: string | undefined;

	onSelectionChange?: (item: SettingItem | undefined) => void;

	#submenuComponent: Component | null = null;
	#submenuItemId: string | null = null;
	#hoveredItemId: string | null = null;
	#hoverFade?: HoverFade<string>;
	#hitRows: (string | undefined)[] = [];
	#sidebarHitRows: (string | undefined)[] = [];
	#sidebarHitCol = 0;
	#valueColStart = -1;
	constructor(
		items: SettingItem[],
		maxVisible: number,
		theme: SettingsListTheme,
		onChange: (id: string, newValue: string) => void,
		onCancel: () => void,
		options: SettingsListOptions = {},
	) {
		this.#items = items;
		this.#filteredItems = items;
		this.#maxVisible = maxVisible;
		this.#theme = theme;
		this.#onChange = onChange;
		this.#onCancel = onCancel;
		this.#options = options;
		this.#selectedIndex = this.#firstSelectableIndex();
		this.#lastNotifiedSelectionId = this.getSelectedItem()?.id;
	}

	getSelectedItem(): SettingItem | undefined {
		const item = this.#filteredItems[this.#selectedIndex];
		return item && !item.heading ? item : undefined;
	}

	selectItem(id: string): boolean {
		const index = this.#filteredItems.findIndex(item => !item.heading && item.id === id);
		if (index === -1) return false;
		this.#sectionFocus = false;
		this.#selectedIndex = index;
		this.#notifySelection();
		return true;
	}

	activateSelected(): void {
		this.#activateItem();
	}

	get sectionFocused(): boolean {
		return this.#sectionFocus;
	}

	hasSectionFocusTargets(): boolean {
		return this.#sections().length >= 2;
	}

	toggleSectionFocus(): boolean {
		this.#sectionFocus = !this.#sectionFocus && this.hasSectionFocusTargets();
		return this.#sectionFocus;
	}

	hasOpenSubmenu(): boolean {
		return this.#submenuComponent !== null;
	}

	getOpenSubmenuLabel(): string | undefined {
		if (this.#submenuItemId === null) return undefined;
		return this.#items.find(item => item.id === this.#submenuItemId)?.label;
	}

	#notifySelection(): void {
		const item = this.getSelectedItem();
		if (item?.id === this.#lastNotifiedSelectionId) return;
		this.#lastNotifiedSelectionId = item?.id;
		this.onSelectionChange?.(item);
	}

	setMaxVisible(rows: number): void {
		const next = Math.max(3, Math.floor(rows));
		if (next === this.#maxVisible) return;
		this.#maxVisible = next;
		this.#clampSelectedIndex();
	}

	handleWheel(delta: -1 | 1): void {
		if (this.#submenuComponent) return;
		this.#sectionFocus = false;
		this.#moveSelection(delta, false);
	}

	handleWheelAt(delta: -1 | 1, _line: number, col: number): boolean {
		if (this.#submenuComponent) return false;
		if (this.#sidebarHitCol > 0 && col < this.#sidebarHitCol) {
			return false;
		}
		this.handleWheel(delta);
		return true;
	}

	setHoverItem(id: string | null): void {
		this.#hoveredItemId = id;
		this.#hoverFade?.set(id);
	}

	setHoverMotion(options: HoverFadeOptions): void {
		this.#hoverFade?.dispose();
		this.#hoverFade = new HoverFade<string>(options);
		if (this.#hoveredItemId !== null) this.#hoverFade.set(this.#hoveredItemId);
	}

	disposeHoverMotion(): void {
		this.#hoverFade?.dispose();
		this.#hoverFade = undefined;
		this.#hoveredItemId = null;
	}

	#hoverStrength(id: string, isSelected: boolean): number {
		if (isSelected) return 0;
		if (this.#hoverFade !== undefined) return this.#hoverFade.strengthAt(id);
		return id === this.#hoveredItemId ? 1 : 0;
	}

	hitTest(line: number, col: number): string | undefined {
		if (this.#submenuComponent) return undefined;
		if (this.#sidebarHitCol > 0 && col < this.#sidebarHitCol) {
			return this.#sidebarHitRows[line];
		}
		return this.#hitRows[line];
	}

	isValueColumnHit(line: number, col: number): boolean {
		if (this.#submenuComponent || this.#valueColStart < 0) return false;
		if (this.#sidebarHitCol > 0 && col < this.#sidebarHitCol) return false;
		return col >= this.#valueColStart && this.#hitRows[line] !== undefined;
	}

	hoverTest(line: number, col: number): string | undefined {
		if (this.#submenuComponent) return undefined;
		if (this.#sidebarHitCol > 0 && col < this.#sidebarHitCol) return undefined;
		return this.#hitRows[line];
	}

	routeSubmenuMouse(event: SgrMouseEvent, line: number, col: number): boolean {
		if (!this.#submenuComponent) return false;
		(this.#submenuComponent as Component & Partial<MouseRoutable>).routeMouse?.(event, line, col);
		return true;
	}

	getSearchQuery(): string {
		return this.#filterQuery;
	}

	clearSearch(): void {
		if (this.#filterQuery.length === 0) return;
		this.#setFilter("");
	}

	updateValue(id: string, newValue: string): void {
		const item = this.#items.find(i => i.id === id);
		if (!item) return;

		item.currentValue = newValue;
		if (this.#filterQuery.trim()) {
			this.#applyFilter();
			this.#clampSelectedIndex();
		}
	}

	setItems(items: SettingItem[]): void {
		const selectedId = this.#filteredItems[this.#selectedIndex]?.id;
		this.#items = items;
		this.#applyFilter();
		if (this.#sectionFocus && !this.hasSectionFocusTargets()) this.#sectionFocus = false;

		const nextIndex = selectedId ? this.#filteredItems.findIndex(item => item.id === selectedId) : -1;
		if (nextIndex >= 0) {
			this.#selectedIndex = nextIndex;
		} else {
			this.#clampSelectedIndex();
		}
		this.#notifySelection();
	}

	#setFilter(filter: string): void {
		this.#filterQuery = filter;
		if (filter.trim()) this.#sectionFocus = false;
		this.#applyFilter();
		this.#selectedIndex = this.#firstSelectableIndex();
		this.#notifySelection();
	}

	#applyFilter(): void {
		this.#filteredItems = this.#filterQuery.trim() ? filterSettingItems(this.#items, this.#filterQuery) : this.#items;
	}

	#firstSelectableIndex(): number {
		const index = this.#filteredItems.findIndex(item => !item.heading);
		return index >= 0 ? index : 0;
	}

	#moveSelection(delta: -1 | 1, wrap = true): void {
		const len = this.#filteredItems.length;
		if (len === 0) return;
		let index = this.#selectedIndex;
		for (let step = 0; step < len * 2; step++) {
			const next = index + delta;
			if (next < 0 || next >= len) {
				if (wrap) {
					index = (next + len) % len;
				} else {
					return;
				}
			} else {
				index = next;
			}
			if (!this.#filteredItems[index]?.heading) {
				this.#selectedIndex = index;
				this.#notifySelection();
				return;
			}
		}
	}

	#sections(): SettingSection[] {
		const sections: SettingSection[] = [];
		let current: SettingSection | null = null;
		for (let i = 0; i < this.#filteredItems.length; i++) {
			const item = this.#filteredItems[i];
			if (item.heading) {
				current = { name: item.label, firstItemIndex: -1, lastItemIndex: -1 };
				sections.push(current);
				continue;
			}
			if (!current) {
				current = { name: "", firstItemIndex: i, lastItemIndex: i };
				sections.push(current);
			}
			if (current.firstItemIndex < 0) current.firstItemIndex = i;
			current.lastItemIndex = i;
		}
		let w = 0;
		for (let si = 0; si < sections.length; si++) {
			if (sections[si]!.firstItemIndex >= 0) sections[w++] = sections[si]!;
		}
		sections.length = w;
		return sections;
	}

	#activeSectionIndex(sections: SettingSection[]): number {
		for (let i = sections.length - 1; i >= 0; i--) {
			if (sections[i].firstItemIndex <= this.#selectedIndex) return i;
		}
		return 0;
	}

	#lastHeadingIndexBefore(index: number): number {
		for (let i = index - 1; i >= 0; i--) {
			if (this.#filteredItems[i]?.heading) return i;
		}
		return -1;
	}

	#jumpSection(delta: -1 | 1): void {
		const sections = this.#sections();
		if (sections.length < 2) {
			const len = this.#filteredItems.length;
			if (len === 0) return;
			this.#selectedIndex = clamp(this.#selectedIndex + delta * this.#maxVisible, 0, len - 1);
			this.#clampSelectedIndex();
		} else {
			const next = (this.#activeSectionIndex(sections) + delta + sections.length) % sections.length;
			this.#selectedIndex = sections[next].firstItemIndex;
		}
		this.#notifySelection();
	}

	#clampSelectedIndex(): void {
		if (this.#filteredItems.length === 0) {
			this.#selectedIndex = 0;
			return;
		}
		this.#selectedIndex = clamp(this.#selectedIndex, 0, this.#filteredItems.length - 1);
		if (!this.#filteredItems[this.#selectedIndex]?.heading) return;
		for (let i = this.#selectedIndex + 1; i < this.#filteredItems.length; i++) {
			if (!this.#filteredItems[i].heading) {
				this.#selectedIndex = i;
				return;
			}
		}
		for (let i = this.#selectedIndex - 1; i >= 0; i--) {
			if (!this.#filteredItems[i].heading) {
				this.#selectedIndex = i;
				return;
			}
		}
	}

	#renderSearchStatus(width: number): string {
		const query = sanitizeSingleLine(this.#filterQuery);
		const statusText = query ? `  Search: ${query}` : "  Type to search";
		return this.#theme.hint(truncateToWidth(statusText, width, Ellipsis.Omit));
	}

	#shouldRenderSearchStatus(): boolean {
		if (this.#options.typeToSearch === false) return false;
		return this.#items.length > this.#maxVisible || this.#filterQuery.length > 0;
	}

	#handleSearchInput(data: string): boolean {
		if (this.#options.typeToSearch === false) return false;
		if (this.#items.length === 0) return false;

		const kb = getKeybindings();
		if (kb.matches(data, "tui.editor.deleteCharBackward")) {
			if (this.#filterQuery.length === 0) return false;
			const len = this.#filterQuery.length;
			const cut = len > 0 && (this.#filterQuery.charCodeAt(len - 1) & 0xfc00) === 0xdc00 ? 2 : 1;
			this.#setFilter(this.#filterQuery.slice(0, len - cut));
			return true;
		}

		const printableText = extractPrintableText(data);
		if (printableText === undefined) return false;
		if (this.#filterQuery.length === 0 && printableText.trim().length === 0) return false;

		this.#setFilter(this.#filterQuery + printableText);
		return true;
	}

	invalidate(): void {
		this.#submenuComponent?.invalidate?.();
	}

	#stableHeight(): number {
		const descMode = this.#options.descriptionMode ?? "reserved";
		const descBand = descMode === "reserved" ? 4 : 0;
		let height = this.#maxVisible + descBand;
		if (this.#options.typeToSearch !== false) height += 1;
		if (this.#options.hint !== "") height += 2;
		return height;
	}

	setOptions(patch: Partial<SettingsListOptions>): void {
		this.#options = { ...this.#options, ...patch };
	}

	#padLines(lines: string[]): string[] {
		while (lines.length < this.#stableHeight()) lines.push("");
		return lines;
	}

	render(width: number): readonly string[] {
		this.#hitRows = [];
		this.#sidebarHitRows = [];
		this.#sidebarHitCol = 0;
		this.#valueColStart = -1;
		if (this.#submenuComponent) {
			return this.#padLines(this.#submenuComponent.render(width).slice());
		}

		return this.#padLines(this.#renderMainList(width));
	}

	#renderItemRow(
		item: SettingItem,
		index: number,
		maxLabelWidth: number,
		rowWidth: number,
		dimmed = false,
		headingCursor = false,
	): string {
		if (item.heading) {
			const headingStyle = this.#theme.heading ?? ((text: string) => this.#theme.hint(text));
			const prefix = headingCursor ? this.#theme.cursor : "  ";
			return truncateToWidth(`${prefix}${headingStyle(item.label, dimmed)}`, Math.max(0, rowWidth));
		}
		const isSelected = index === this.#selectedIndex && !this.#sectionFocus;
		const prefix = isSelected ? this.#theme.cursor : "  ";
		const prefixWidth = visibleWidth(prefix);
		const labelPadded = item.label + padding(Math.max(0, maxLabelWidth - visibleWidth(item.label)));
		const separator = "  ";
		const valueMaxWidth = rowWidth - prefixWidth - maxLabelWidth - visibleWidth(separator) - 2;
		const cyclable =
			isSelected && !item.readOnly && !item.submenu && item.values !== undefined && item.values.length > 0;
		const shownValue = item.labelForValue?.(item.currentValue) ?? item.currentValue;
		const rawValue = cyclable ? `‹ ${shownValue} ›` : String(shownValue ?? "");
		const valuePlain = truncateToWidth(rawValue, valueMaxWidth, Ellipsis.Omit);
		const band = this.#theme.hovered;
		const strength = band === undefined ? 0 : this.#hoverStrength(item.id, isSelected);
		if (dimmed && !isSelected) {
			const text = this.#theme.hint(
				truncateToWidth(`  ${labelPadded}${separator}${valuePlain}`, Math.max(0, rowWidth)),
			);
			return strength > 0 && band !== undefined ? band(text, strength) : text;
		}
		const labelText = this.#theme.label(labelPadded, isSelected, item.changed === true);
		const valueText = this.#theme.value(valuePlain, isSelected, item.changed === true);
		const text = truncateToWidth(prefix + labelText + separator + valueText, Math.max(0, rowWidth));
		if (strength > 0 && band !== undefined) {
			return band(text, strength);
		}
		return text;
	}

	#renderMainList(width: number): string[] {
		const lines: string[] = [];

		if (this.#items.length === 0) {
			lines.push(this.#theme.hint(`  ${this.#options.emptyText ?? "No settings available"}`));
			return lines;
		}

		if (this.#filteredItems.length === 0) {
			if (this.#shouldRenderSearchStatus()) {
				lines.push(this.#renderSearchStatus(width));
			}
			lines.push(this.#theme.hint("  No matching settings"));
			lines.push("");
			lines.push(truncateToWidth(this.#theme.hint("  Backspace to edit search · Esc to cancel"), width));
			return lines;
		}

		const sections = this.#sections();
		const splitLines =
			this.#options.layout !== "flat" && !this.#filterQuery.trim() && sections.length >= 2
				? this.#renderSplitList(width, sections)
				: null;
		if (splitLines) {
			for (let li = 0; li < splitLines.length; li++) lines.push(splitLines[li]!);
		} else {
			const descMode = this.#options.descriptionMode ?? "reserved";
			const selectedForDesc = this.#filteredItems[this.#selectedIndex];
			const inlineDesc: string[] = [];
			if (
				descMode === "expand" &&
				selectedForDesc?.description &&
				!selectedForDesc.heading &&
				this.#options.expandedIds?.has(selectedForDesc.id)
			) {
				const wrappedDesc = wrapTextWithAnsi(selectedForDesc.description, Math.max(1, width - 4));
				const cap = Math.min(8, Math.max(1, this.#maxVisible - 4));
				const descLines = wrappedDesc.slice(0, cap);
				for (let di = 0; di < descLines.length; di++) {
					inlineDesc.push(this.#theme.description(`    ${descLines[di]!}`));
				}
			}
			const computeStart = (vh: number) =>
				clampLow(this.#selectedIndex - Math.floor(vh / 2), 0, this.#filteredItems.length - vh);
			let viewportHeight = clamp(this.#maxVisible - inlineDesc.length, 1, this.#filteredItems.length);
			let startIndex = computeStart(viewportHeight);
			let stickyHeadingIndex = this.#lastHeadingIndexBefore(startIndex);
			if (stickyHeadingIndex >= 0 && viewportHeight > 1) {
				viewportHeight -= 1;
				startIndex = computeStart(viewportHeight);
				stickyHeadingIndex = this.#lastHeadingIndexBefore(startIndex);
				if (stickyHeadingIndex < 0) {
					viewportHeight += 1;
					startIndex = computeStart(viewportHeight);
				}
			}
			let maxLabelWidth = 0;
			for (let fi = 0; fi < this.#filteredItems.length; fi++) {
				const item = this.#filteredItems[fi]!;
				if (item.heading) continue;
				const lw = visibleWidth(item.label);
				if (lw > maxLabelWidth) maxLabelWidth = lw;
			}
			maxLabelWidth = Math.min(30, maxLabelWidth);
			this.#valueColStart = 2 + maxLabelWidth + 2;
			const itemRowsOverflow = this.#filteredItems.length > viewportHeight;
			const itemRowWidth = Math.max(0, width - (itemRowsOverflow ? 1 : 0));
			const visibleItems = this.#filteredItems.slice(startIndex, startIndex + viewportHeight);
			const active = sections[this.#activeSectionIndex(sections)];
			const focusedHeadingIndex = this.#sectionFocus && active?.name ? active.firstItemIndex - 1 : -1;
			if (stickyHeadingIndex >= 0) {
				const stickyItem = this.#filteredItems[stickyHeadingIndex]!;
				lines.push(
					this.#renderItemRow(
						stickyItem,
						stickyHeadingIndex,
						maxLabelWidth,
						itemRowWidth,
						false,
						stickyHeadingIndex === focusedHeadingIndex,
					),
				);
				this.#hitRows[0] = undefined;
			}
			const itemRows = new Array<string>(visibleItems.length);
			for (let ii = 0; ii < visibleItems.length; ii++) {
				itemRows[ii] = this.#renderItemRow(
					visibleItems[ii]!,
					startIndex + ii,
					maxLabelWidth,
					itemRowWidth,
					false,
					startIndex + ii === focusedHeadingIndex,
				);
			}
			const selectedVisiblePos = this.#selectedIndex - startIndex;
			const descInView =
				inlineDesc.length > 0 && selectedVisiblePos >= 0 && selectedVisiblePos < visibleItems.length;
			if (descInView) {
				itemRows.splice(selectedVisiblePos + 1, 0, ...inlineDesc);
			}
			const hitOffset = stickyHeadingIndex >= 0 ? 1 : 0;
			for (let index = 0; index < visibleItems.length; index++) {
				const item = visibleItems[index]!;
				const shift = descInView && index > selectedVisiblePos ? inlineDesc.length : 0;
				this.#hitRows[index + hitOffset + shift] = item.heading ? undefined : item.id;
			}
			const scrollView = new ScrollView(itemRows, {
				height: viewportHeight + (descInView ? inlineDesc.length : 0),
				scrollbar: "auto",
				totalRows: this.#filteredItems.length,
				theme: {
					track: text => this.#theme.hint(text),
					thumb: text => this.#theme.label(text, true, false),
				},
			});
			scrollView.setScrollOffset(startIndex);
			const scrollLines = scrollView.render(width);
			for (let li = 0; li < scrollLines.length; li++) lines.push(scrollLines[li]!);
			while (lines.length < this.#maxVisible) lines.push("");
		}

		if ((this.#options.descriptionMode ?? "reserved") === "reserved") {
			lines.push("");
			const selectedItem = this.#filteredItems[this.#selectedIndex];
			const descLines: string[] = [];
			if (selectedItem?.description && !selectedItem.heading) {
				const wrappedDesc = wrapTextWithAnsi(selectedItem.description, width - 4);
				const splitDescLines = wrappedDesc.slice(0, 3);
				for (let di = 0; di < splitDescLines.length; di++) {
					descLines.push(this.#theme.description(`  ${splitDescLines[di]!}`));
				}
				if (wrappedDesc.length > 3) {
					descLines[2] = truncateToWidth(`${descLines[2]}…`, width);
				}
			}
			while (descLines.length < 3) descLines.push("");
			for (let li = 0; li < descLines.length; li++) lines.push(descLines[li]!);
		}

		if (this.#options.typeToSearch !== false) {
			lines.push(this.#renderSearchStatus(width));
		}

		if (this.#options.hint !== "") {
			lines.push("");
			const jumpHint = sections.length >= 2 ? "PgUp/PgDn to jump sections · " : "";
			const hintText = this.#options.hint ?? `Enter/Space to change · ${jumpHint}Type to search · Esc to cancel`;
			lines.push(truncateToWidth(this.#theme.hint(`  ${hintText}`), width));
		}

		return lines;
	}

	#renderSplitList(width: number, sections: SettingSection[]): string[] | null {
		let nameWidth = 0;
		const sectionNames = new Array<string>(sections.length);
		for (let si = 0; si < sections.length; si++) {
			sectionNames[si] = sections[si]!.name || "Other";
			nameWidth = Math.max(nameWidth, visibleWidth(sectionNames[si]!));
		}
		const sidebarWidth = this.#options.sidebarWidth ?? Math.min(22, nameWidth) + 4; // 2-space indent + 2-space gap
		const paneWidth = width - sidebarWidth - 2; // "│ " separator
		if (paneWidth < 60) return null;

		const activeIndex = this.#activeSectionIndex(sections);
		const active = sections[activeIndex];

		const sectionStyle =
			this.#theme.section ??
			((text: string, isActive: boolean) =>
				isActive ? this.#theme.label(text, true, false) : this.#theme.hint(text));
		const sidebarRows = new Array<string>(sectionNames.length);
		for (let si = 0; si < sectionNames.length; si++) {
			const label = truncateToWidth(sectionNames[si]!, sidebarWidth - 4, Ellipsis.Omit);
			const prefix = this.#sectionFocus && si === activeIndex ? this.#theme.cursor : "  ";
			sidebarRows[si] =
				`${prefix}${sectionStyle(label, si === activeIndex)}${padding(sidebarWidth - visibleWidth(prefix) - visibleWidth(label))}`;
		}

		const activeStart = active.name ? active.firstItemIndex - 1 : active.firstItemIndex;
		const viewportHeight = Math.min(this.#maxVisible, this.#filteredItems.length);
		const startRow = Math.max(
			0,
			Math.min(this.#selectedIndex - Math.floor(viewportHeight / 2), this.#filteredItems.length - viewportHeight),
		);
		let maxLabelWidth = 0;
		for (let fi = 0; fi < this.#filteredItems.length; fi++) {
			const item = this.#filteredItems[fi]!;
			if (item.heading) continue;
			const lw = visibleWidth(item.label);
			if (lw > maxLabelWidth) maxLabelWidth = lw;
		}
		maxLabelWidth = Math.min(30, maxLabelWidth);
		this.#valueColStart = sidebarWidth + 2 + 2 + maxLabelWidth + 2;
		const overflow = this.#filteredItems.length > viewportHeight;
		const rowWidth = Math.max(0, paneWidth - (overflow ? 1 : 0));
		const itemRows: string[] = [];
		for (let r = 0; r < viewportHeight; r++) {
			const index = startRow + r;
			const item = this.#filteredItems[index];
			if (!item) break;
			const dimmed = index < activeStart || index > active.lastItemIndex;
			itemRows.push(this.#renderItemRow(item, index, maxLabelWidth, rowWidth, dimmed));
		}
		const scrollView = new ScrollView(itemRows, {
			height: viewportHeight,
			scrollbar: "auto",
			totalRows: this.#filteredItems.length,
			theme: {
				track: text => this.#theme.hint(text),
				thumb: text => this.#theme.label(text, true, false),
			},
		});
		scrollView.setScrollOffset(startRow);
		const paneRows = scrollView.render(paneWidth);

		this.#sidebarHitCol = sidebarWidth;
		for (let i = 0; i < sectionNames.length; i++) {
			this.#sidebarHitRows[i] = this.#filteredItems[sections[i].firstItemIndex]?.id;
		}
		for (let r = 0; r < viewportHeight; r++) {
			const item = this.#filteredItems[startRow + r];
			if (item && !item.heading) this.#hitRows[r] = item.id;
		}

		const separator = this.#theme.hint("│ ");
		const lines: string[] = [];
		const height = Math.max(this.#maxVisible, sidebarRows.length);
		for (let i = 0; i < height; i++) {
			const left = sidebarRows[i] ?? padding(sidebarWidth);
			lines.push(truncateToWidth(left + separator + (paneRows[i] ?? ""), width));
		}
		return lines;
	}

	handleInput(data: string): void {
		if (this.#submenuComponent) {
			this.#submenuComponent.handleInput?.(data);
			return;
		}

		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.#filterQuery.length > 0) {
				this.clearSearch();
				return;
			}
			if (this.#sectionFocus) {
				this.#sectionFocus = false;
				return;
			}
			this.#onCancel();
			return;
		}

		if (this.#handleSearchInput(data)) {
			return;
		}

		if (this.#filteredItems.length === 0) return;

		if (kb.matches(data, "tui.select.up")) {
			if (this.#sectionFocus) this.#jumpSection(-1);
			else this.#moveSelection(-1);
		} else if (kb.matches(data, "tui.select.down")) {
			if (this.#sectionFocus) this.#jumpSection(1);
			else this.#moveSelection(1);
		} else if (kb.matches(data, "tui.select.pageDown")) {
			this.#jumpSection(1);
		} else if (kb.matches(data, "tui.select.pageUp")) {
			this.#jumpSection(-1);
		} else if (kb.matches(data, "tui.select.confirm") || data === " " || isLoneLineFeed(data)) {
			if (this.#sectionFocus) this.#sectionFocus = false;
			else this.#activateItem();
		}
	}

	#activateItem(): void {
		const item = this.#filteredItems[this.#selectedIndex];
		if (!item || item.heading || item.readOnly) return;

		if (item.submenu) {
			this.#submenuItemId = item.id;
			this.#submenuComponent = item.submenu(item.currentValue, (selectedValue?: string) => {
				if (selectedValue !== undefined) {
					item.currentValue = selectedValue;
					this.#onChange(item.id, selectedValue);
				}
				this.#closeSubmenu();
			});
		} else if (item.values && item.values.length > 0) {
			const currentIndex = item.values.indexOf(item.currentValue);
			const nextIndex = (currentIndex + 1) % item.values.length;
			const newValue = item.values[nextIndex];
			item.currentValue = newValue;
			this.#onChange(item.id, newValue);
		}
	}

	#closeSubmenu(): void {
		this.#submenuComponent = null;
		if (this.#submenuItemId !== null) {
			const index = this.#filteredItems.findIndex(item => !item.heading && item.id === this.#submenuItemId);
			this.#submenuItemId = null;
			if (index >= 0) {
				this.#selectedIndex = index;
			} else {
				this.#clampSelectedIndex();
			}
			this.#notifySelection();
		}
	}
}
