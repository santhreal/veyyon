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
import { filterSettingItems } from "./settings-search";

export interface SettingItem {
	/** Unique identifier for this setting */
	id: string;
	/** Display label (left side) */
	label: string;
	/** Optional description shown when selected */
	description?: string;
	/** Current value to display (right side) */
	currentValue: string;
	/**
	 * Render `currentValue` as something a person reads, when the stored value is not
	 * that. Display only: preselection, cycling and write-back all keep using
	 * `currentValue`, so a labelled row still round-trips its real value.
	 */
	labelForValue?: (value: string) => string;
	/** If provided, Enter/Space cycles through these values */
	values?: string[];
	/** If provided, Enter opens this submenu. Receives current value and done callback. */
	submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
	/** True when the displayed setting differs from its default value. */
	changed?: boolean;
	/** The value comes from a layer this surface does not own; activation is disabled. */
	readOnly?: boolean;
	/** Render as a non-interactive section heading. Skipped by navigation and search. */
	heading?: boolean;
	/** The group this setting sits under, searchable at low weight so "thinking"
	 *  finds the group's rows even when no label carries the word. */
	group?: string;
	/** Words a user would call this setting that its label does not contain
	 *  ("reasoning" for effort, "clipboard" for copy). Searched at label weight,
	 *  because it IS the name as far as the person typing is concerned. */
	keywords?: readonly string[];
}

export interface SettingsListTheme {
	label: (text: string, selected: boolean, changed: boolean) => string;
	value: (text: string, selected: boolean, changed: boolean) => string;
	description: (text: string) => string;
	cursor: string;
	hint: (text: string) => string;
	/** Style for section heading rows (dimmed when outside the active section). Falls back to `hint` when omitted. */
	heading?: (text: string, dimmed: boolean) => string;
	/** Style for sidebar section names in the split layout. Falls back to label/hint. */
	section?: (text: string, active: boolean) => string;
	/**
	 * Hover band applied to the full row under the mouse pointer.
	 *
	 * `strength` is 1 for a row the pointer is resting on and a fraction while the
	 * band fades in or out (see {@link SettingsList.setHoverMotion}); a theme that
	 * paints unconditionally ignores it and keeps the switched band. Never called
	 * at strength 0.
	 */
	hovered?: (text: string, strength: number) => string;
}

/** A contiguous run of items under one heading, derived from the item list. */
interface SettingSection {
	name: string;
	firstItemIndex: number;
	lastItemIndex: number;
}

/** Optional behavior overrides for {@link SettingsList}. */
export interface SettingsListOptions {
	/**
	 * "auto" (default) renders the section sidebar layout when headings exist
	 * and the width allows; "flat" always renders inline heading rows.
	 */
	layout?: "auto" | "flat";
	/**
	 * When false, printable input is ignored (no internal type-to-filter) and
	 * the search status line is never rendered. Use when a parent component
	 * owns the query. Default true.
	 */
	typeToSearch?: boolean;
	/** Text shown when the list has no items at all. */
	emptyText?: string;
	/**
	 * Footer hint line (hint-styled, replaces the default navigation hint).
	 * An empty string removes the hint row and its leading blank entirely —
	 * use when the host renders its own footer.
	 */
	hint?: string;
	/** Fixed split-sidebar width (columns incl. indent+gap); default derives from section names. */
	sidebarWidth?: number;
	/**
	 * How selected-item descriptions paint.
	 * - `reserved` (default): always 1 blank + 3 rows (legacy panel density).
	 * - `expand`: only when the selected item id is in `expandedIds` (Grok-style).
	 * - `none`: never paint descriptions in the list.
	 */
	descriptionMode?: "reserved" | "expand" | "none";
	/** Ids whose descriptions are expanded (used when descriptionMode is `expand`). */
	expandedIds?: ReadonlySet<string>;
}

/**
 * Searchable text for a setting item, as ONE string.
 *
 * Retired from ranking: scoring a blob made a description hit indistinguishable
 * from a label hit, and it put the CURRENT VALUE and every enum value in the
 * haystack, so `high` matched whatever happened to be set to high. `settings-search.ts`
 * scores the fields separately. Kept for callers that need a single line of
 * searchable text (logging, snapshots) and deliberately excludes the value.
 */
export function getSettingItemFilterText(item: SettingItem): string {
	let text = `${item.label} ${item.id}`;
	if (item.group) text += ` ${item.group}`;
	if (item.keywords?.length) text += ` ${item.keywords.join(" ")}`;
	if (item.description) text += ` ${item.description}`;
	return sanitizeSingleLine(text);
}

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

	/** Fired when the selected item changes (navigation, filtering, or setItems). */
	onSelectionChange?: (item: SettingItem | undefined) => void;

	// Submenu state
	#submenuComponent: Component | null = null;
	#submenuItemId: string | null = null;
	// Mouse support: hover highlight and per-render hit maps (content-line
	// index → item id), rebuilt by every main-list render.
	#hoveredItemId: string | null = null;
	/**
	 * The cross-fade, once a host has lent this list a repaint
	 * ({@link setHoverMotion}). Absent, the band is switched, which is what every
	 * host had before. Keyed by setting id: a row keeps its band across a filter
	 * keystroke that moves it, and loses it when the row itself goes away.
	 */
	#hoverFade?: HoverFade<string>;
	#hitRows: (string | undefined)[] = [];
	#sidebarHitRows: (string | undefined)[] = [];
	#sidebarHitCol = 0;
	/** Column where the always-aligned value gutter starts this frame (-1 when not rendered). */
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

	/** The currently selected item, or undefined when empty or on a heading. */
	getSelectedItem(): SettingItem | undefined {
		const item = this.#filteredItems[this.#selectedIndex];
		return item && !item.heading ? item : undefined;
	}

	/** Move selection to the item with `id`. Returns false when it is not visible. */
	selectItem(id: string): boolean {
		const index = this.#filteredItems.findIndex(item => !item.heading && item.id === id);
		if (index === -1) return false;
		this.#sectionFocus = false;
		this.#selectedIndex = index;
		this.#notifySelection();
		return true;
	}

	/** True while keyboard focus is on the section headings instead of the setting rows. */
	get sectionFocused(): boolean {
		return this.#sectionFocus;
	}

	/** Whether section focus has anywhere to go: 2+ derived sections in the current view. */
	hasSectionFocusTargets(): boolean {
		return this.#sections().length >= 2;
	}

	/**
	 * Toggle keyboard focus between section headings and setting rows. While
	 * focused, Up/Down jump whole sections and Enter/Esc return to the rows.
	 * Engages only when {@link hasSectionFocusTargets}; returns the new state.
	 */
	toggleSectionFocus(): boolean {
		this.#sectionFocus = !this.#sectionFocus && this.hasSectionFocusTargets();
		return this.#sectionFocus;
	}

	/** True while an item submenu owns input. */
	hasOpenSubmenu(): boolean {
		return this.#submenuComponent !== null;
	}

	/** Label of the item whose submenu is open, for breadcrumb chrome (`Settings › Label`). */
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

	/** Resize the visible viewport (fullscreen hosts call this every render). */
	setMaxVisible(rows: number): void {
		const next = Math.max(3, Math.floor(rows));
		if (next === this.#maxVisible) return;
		this.#maxVisible = next;
		this.#clampSelectedIndex();
	}

	/** Move the selection one step for a wheel notch. */
	handleWheel(delta: -1 | 1): void {
		if (this.#submenuComponent) return;
		// Wheel is row-level interaction: it returns focus to the rows.
		this.#sectionFocus = false;
		this.#moveSelection(delta, false);
	}

	/** Move the selection one step for a wheel notch if the pointer is within the settings pane. */
	handleWheelAt(delta: -1 | 1, _line: number, col: number): boolean {
		if (this.#submenuComponent) return false;
		if (this.#sidebarHitCol > 0 && col < this.#sidebarHitCol) {
			return false;
		}
		this.handleWheel(delta);
		return true;
	}

	/** Highlight the item under the pointer (null clears). */
	setHoverItem(id: string | null): void {
		this.#hoveredItemId = id;
		this.#hoverFade?.set(id);
	}

	/**
	 * Fade the pointer band in and out instead of switching it.
	 *
	 * The frames between two mouse reports have no input to hang off, so the host
	 * lends the list its repaint. Call once after construction, and
	 * {@link disposeHoverMotion} when the host goes away. `enabled: false` is the
	 * switched band, which is what a non-truecolor terminal and
	 * `display.transitions: off` get.
	 */
	setHoverMotion(options: HoverFadeOptions): void {
		this.#hoverFade?.dispose();
		this.#hoverFade = new HoverFade<string>(options);
		if (this.#hoveredItemId !== null) this.#hoverFade.set(this.#hoveredItemId);
	}

	/**
	 * Drop the cross-fade and everything it has registered with the clock, and
	 * forget the pointer with it: a disposed list is one nothing is pointing at, so
	 * a half-faded band leaves rather than jumping to full strength.
	 */
	disposeHoverMotion(): void {
		this.#hoverFade?.dispose();
		this.#hoverFade = undefined;
		this.#hoveredItemId = null;
	}

	/**
	 * Band strength for a row id: 0 for no band through 1 for the full one. The
	 * selected row takes no band — the cursor glyph and accent are the stronger
	 * signal — but a row the pointer left keeps fading out even once the selection
	 * has moved onto it, so the suppression lives here rather than in the fade.
	 */
	#hoverStrength(id: string, isSelected: boolean): number {
		if (isSelected) return 0;
		if (this.#hoverFade !== undefined) return this.#hoverFade.strengthAt(id);
		return id === this.#hoveredItemId ? 1 : 0;
	}

	/**
	 * Resolve a pointer position against the last rendered frame. `line` is the
	 * 0-based content-line index within this component's render output, `col`
	 * the 0-based column. Sidebar rows resolve to the section's first item.
	 */
	hitTest(line: number, col: number): string | undefined {
		if (this.#submenuComponent) return undefined;
		if (this.#sidebarHitCol > 0 && col < this.#sidebarHitCol) {
			return this.#sidebarHitRows[line];
		}
		return this.#hitRows[line];
	}

	/**
	 * True when `(line, col)` lands on the always-aligned value column (past
	 * the label gutter) rather than the label — mirrors Grok's per-row value
	 * hit-rect. Hosts use this to activate on the first click there (open a
	 * submenu, cycle a value) while a click on the label only selects.
	 */
	isValueColumnHit(line: number, col: number): boolean {
		if (this.#submenuComponent || this.#valueColStart < 0) return false;
		if (this.#sidebarHitCol > 0 && col < this.#sidebarHitCol) return false;
		return col >= this.#valueColStart && this.#hitRows[line] !== undefined;
	}

	/**
	 * Like {@link hitTest}, but only rows the pointer is visually on: sidebar
	 * jump targets are excluded so hovering section names does not light up
	 * pane rows.
	 */
	hoverTest(line: number, col: number): string | undefined {
		if (this.#submenuComponent) return undefined;
		if (this.#sidebarHitCol > 0 && col < this.#sidebarHitCol) return undefined;
		return this.#hitRows[line];
	}

	/**
	 * Route a mouse event into an open submenu (coordinates are local to this
	 * list's rendered lines). Returns false when no submenu is open; submenus
	 * that do not implement {@link MouseRoutable} consume the event silently.
	 */
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

	/** Update an item's currentValue */
	updateValue(id: string, newValue: string): void {
		const item = this.#items.find(i => i.id === id);
		if (!item) return;

		item.currentValue = newValue;
		if (this.#filterQuery.trim()) {
			this.#applyFilter();
			this.#clampSelectedIndex();
		}
	}

	/**
	 * Replace the entire items array. Selection is preserved by item id when
	 * the previous selection still survives the active filter, otherwise
	 * clamped to the last filtered item (or 0 if there are no matches).
	 * An open submenu is left untouched — its lifetime is bounded by its own
	 * done callback, and `#closeSubmenu` re-resolves the restored item on exit.
	 */
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
		// Field-weighted, through the same owner the settings overlay's own search
		// uses, so the two cannot rank the same query differently.
		this.#filteredItems = this.#filterQuery.trim() ? filterSettingItems(this.#items, this.#filterQuery) : this.#items;
	}

	#firstSelectableIndex(): number {
		const index = this.#filteredItems.findIndex(item => !item.heading);
		return index >= 0 ? index : 0;
	}

	/** Move selection by one selectable item, wrapping or clamping, and skipping headings. */
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

	/** Sections derived from heading rows in the filtered list. */
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
		return sections.filter(section => section.firstItemIndex >= 0);
	}

	#activeSectionIndex(sections: SettingSection[]): number {
		for (let i = sections.length - 1; i >= 0; i--) {
			if (sections[i].firstItemIndex <= this.#selectedIndex) return i;
		}
		return 0;
	}

	/** Nearest heading row strictly before `index`, or -1 when none precedes it. */
	#lastHeadingIndexBefore(index: number): number {
		for (let i = index - 1; i >= 0; i--) {
			if (this.#filteredItems[i]?.heading) return i;
		}
		return -1;
	}

	/** Jump to the next/previous section; page through items when there are no sections. */
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
		// Landed on a heading: prefer the next selectable item, else the previous one.
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
			const chars = [...this.#filterQuery];
			chars.pop();
			this.#setFilter(chars.join(""));
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

	/**
	 * Height budget for the list frame. Expand/none description modes do not
	 * reserve the legacy blank+3 description band.
	 */
	#stableHeight(): number {
		const descMode = this.#options.descriptionMode ?? "reserved";
		const descBand = descMode === "reserved" ? 4 : 0;
		let height = this.#maxVisible + descBand;
		if (this.#options.typeToSearch !== false) height += 1;
		if (this.#options.hint !== "") height += 2;
		return height;
	}

	/** Replace list options (e.g. expanded description ids) without rebuilding the list. */
	setOptions(patch: Partial<SettingsListOptions>): void {
		this.#options = { ...this.#options, ...patch };
	}

	#padLines(lines: string[]): string[] {
		while (lines.length < this.#stableHeight()) lines.push("");
		return lines;
	}

	render(width: number): readonly string[] {
		// Hit maps describe exactly the frame being produced now.
		this.#hitRows = [];
		this.#sidebarHitRows = [];
		this.#sidebarHitCol = 0;
		this.#valueColStart = -1;
		// If submenu is active, render it instead (padded to the list's stable
		// height so opening/closing a submenu does not resize the panel).
		if (this.#submenuComponent) {
			return this.#padLines([...this.#submenuComponent.render(width)]);
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
		// While section focus owns the keyboard, the row cursor hides so the
		// section cursor is the single focus indicator.
		const isSelected = index === this.#selectedIndex && !this.#sectionFocus;
		const prefix = isSelected ? this.#theme.cursor : "  ";
		const prefixWidth = visibleWidth(prefix);
		const labelPadded = item.label + padding(Math.max(0, maxLabelWidth - visibleWidth(item.label)));
		const separator = "  ";
		const valueMaxWidth = rowWidth - prefixWidth - maxLabelWidth - visibleWidth(separator) - 2;
		// The selected boolean/enum row shows ‹ value › so the Left/Right
		// cycling gesture is discoverable, not a hidden power feature.
		const cyclable =
			isSelected && !item.readOnly && !item.submenu && item.values !== undefined && item.values.length > 0;
		// A row whose value is machine-readable (a millisecond count, a byte size) renders
		// through its own labeller so the operator reads "5 minutes" instead of "300000".
		// Mapped at render time from `currentValue` rather than stored beside it, because
		// a second field would go stale the moment a submenu selection writes the first.
		const shownValue = item.labelForValue?.(item.currentValue) ?? item.currentValue;
		const rawValue = cyclable ? `‹ ${shownValue} ›` : String(shownValue ?? "");
		const valuePlain = truncateToWidth(rawValue, valueMaxWidth, Ellipsis.Omit);
		const band = this.#theme.hovered;
		const strength = band === undefined ? 0 : this.#hoverStrength(item.id, isSelected);
		// De-emphasized rows (outside the active section) render as plain text
		// under one dim wash so inner label/value colors don't fight it.
		if (dimmed && !isSelected) {
			const text = this.#theme.hint(
				truncateToWidth(`  ${labelPadded}${separator}${valuePlain}`, Math.max(0, rowWidth)),
			);
			return strength > 0 && band !== undefined ? band(text, strength) : text;
		}
		const labelText = this.#theme.label(labelPadded, isSelected, item.changed === true);
		const valueText = this.#theme.value(valuePlain, isSelected, item.changed === true);
		const text = truncateToWidth(prefix + labelText + separator + valueText, Math.max(0, rowWidth));
		// Pointer hover paints a band behind the whole row, distinct from the
		// keyboard selection (cursor glyph + accent) which stays where it is.
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
			lines.push(...splitLines);
		} else {
			// Expand-mode description renders inline, directly under the selected
			// row inside the viewport (never detached below the padded panel), so
			// it borrows its rows from the item budget up front.
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
				for (const line of wrappedDesc.slice(0, cap)) {
					inlineDesc.push(this.#theme.description(`    ${line}`));
				}
			}
			const computeStart = (vh: number) =>
				clampLow(this.#selectedIndex - Math.floor(vh / 2), 0, this.#filteredItems.length - vh);
			let viewportHeight = clamp(this.#maxVisible - inlineDesc.length, 1, this.#filteredItems.length);
			let startIndex = computeStart(viewportHeight);
			// Sticky header: once scrolling carries the active section's heading
			// above the viewport, pin it as a leading row (borrowed from the
			// scrollable window) so the category a row belongs to is never
			// ambiguous mid-scroll.
			let stickyHeadingIndex = this.#lastHeadingIndexBefore(startIndex);
			if (stickyHeadingIndex >= 0 && viewportHeight > 1) {
				viewportHeight -= 1;
				startIndex = computeStart(viewportHeight);
				stickyHeadingIndex = this.#lastHeadingIndexBefore(startIndex);
				if (stickyHeadingIndex < 0) {
					// Recentering brought the heading itself back into view.
					viewportHeight += 1;
					startIndex = computeStart(viewportHeight);
				}
			}
			const labelWidths = this.#filteredItems.filter(item => !item.heading).map(item => visibleWidth(item.label));
			const maxLabelWidth = Math.min(30, labelWidths.length > 0 ? Math.max(...labelWidths) : 0);
			// Reserved fold/cursor gutter (2) + label column + separator (2) —
			// the always-aligned start of the value column for this frame.
			this.#valueColStart = 2 + maxLabelWidth + 2;
			const itemRowsOverflow = this.#filteredItems.length > viewportHeight;
			const itemRowWidth = Math.max(0, width - (itemRowsOverflow ? 1 : 0));
			const visibleItems = this.#filteredItems.slice(startIndex, startIndex + viewportHeight);
			// In the flat layout the active section's heading row carries the
			// section-focus cursor (the split layout shows it in the sidebar).
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
			const itemRows = visibleItems.map((item, index) =>
				this.#renderItemRow(
					item,
					startIndex + index,
					maxLabelWidth,
					itemRowWidth,
					false,
					startIndex + index === focusedHeadingIndex,
				),
			);
			// Splice the expanded description directly under the selected row;
			// rows below it shift down by the description height in the hit map.
			const selectedVisiblePos = this.#selectedIndex - startIndex;
			const descInView =
				inlineDesc.length > 0 && selectedVisiblePos >= 0 && selectedVisiblePos < visibleItems.length;
			if (descInView) {
				itemRows.splice(selectedVisiblePos + 1, 0, ...inlineDesc);
			}
			const hitOffset = stickyHeadingIndex >= 0 ? 1 : 0;
			visibleItems.forEach((item, index) => {
				const shift = descInView && index > selectedVisiblePos ? inlineDesc.length : 0;
				this.#hitRows[index + hitOffset + shift] = item.heading ? undefined : item.id;
			});
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
			lines.push(...scrollView.render(width));
			// Pad short lists to the full viewport so the panel height is constant.
			while (lines.length < this.#maxVisible) lines.push("");
		}

		// Description: reserved band (legacy) — expand mode renders inline
		// under the selected row inside the viewport above.
		if ((this.#options.descriptionMode ?? "reserved") === "reserved") {
			lines.push("");
			const selectedItem = this.#filteredItems[this.#selectedIndex];
			const descLines: string[] = [];
			if (selectedItem?.description && !selectedItem.heading) {
				const wrappedDesc = wrapTextWithAnsi(selectedItem.description, width - 4);
				for (const line of wrappedDesc.slice(0, 3)) {
					descLines.push(this.#theme.description(`  ${line}`));
				}
				if (wrappedDesc.length > 3) {
					descLines[2] = truncateToWidth(`${descLines[2]}…`, width);
				}
			}
			while (descLines.length < 3) descLines.push("");
			lines.push(...descLines);
		}

		// External-search mode: the host renders the query; skip the status row.
		if (this.#options.typeToSearch !== false) {
			lines.push(this.#renderSearchStatus(width));
		}

		// Add hint (suppressed entirely when the host owns the footer)
		if (this.#options.hint !== "") {
			lines.push("");
			const jumpHint = sections.length >= 2 ? "PgUp/PgDn to jump sections · " : "";
			const hintText = this.#options.hint ?? `Enter/Space to change · ${jumpHint}Type to search · Esc to cancel`;
			lines.push(truncateToWidth(this.#theme.hint(`  ${hintText}`), width));
		}

		return lines;
	}

	/**
	 * Split layout: section sidebar on the left, every item on the right with
	 * rows outside the active section dimmed so the section under the cursor
	 * pops. Up/Down navigation flows across section boundaries; the sidebar
	 * highlight follows the selection. Returns null when the width cannot fit
	 * both panes, falling back to the flat single-column layout.
	 */
	#renderSplitList(width: number, sections: SettingSection[]): string[] | null {
		const sectionNames = sections.map(section => section.name || "Other");
		let nameWidth = 0;
		for (const name of sectionNames) nameWidth = Math.max(nameWidth, visibleWidth(name));
		const sidebarWidth = this.#options.sidebarWidth ?? Math.min(22, nameWidth) + 4; // 2-space indent + 2-space gap
		const paneWidth = width - sidebarWidth - 2; // "│ " separator
		// Below this the value column starves (2 prefix + 30 label + 2 gap + ~25 value).
		if (paneWidth < 60) return null;

		const activeIndex = this.#activeSectionIndex(sections);
		const active = sections[activeIndex];

		const sectionStyle =
			this.#theme.section ??
			((text: string, isActive: boolean) =>
				isActive ? this.#theme.label(text, true, false) : this.#theme.hint(text));
		const sidebarRows = sectionNames.map((name, i) => {
			const label = truncateToWidth(name, sidebarWidth - 4, Ellipsis.Omit);
			// Section focus parks the cursor glyph on the active sidebar entry.
			const prefix = this.#sectionFocus && i === activeIndex ? this.#theme.cursor : "  ";
			return `${prefix}${sectionStyle(label, i === activeIndex)}${padding(sidebarWidth - visibleWidth(prefix) - visibleWidth(label))}`;
		});

		// Right pane: the whole list, continuously scrollable. The active
		// section's heading row belongs to its dim-exempt range.
		const activeStart = active.name ? active.firstItemIndex - 1 : active.firstItemIndex;
		const viewportHeight = Math.min(this.#maxVisible, this.#filteredItems.length);
		const startRow = Math.max(
			0,
			Math.min(this.#selectedIndex - Math.floor(viewportHeight / 2), this.#filteredItems.length - viewportHeight),
		);
		// Label column width spans all items so the layout stays stable across sections.
		const labelWidths = this.#filteredItems.filter(item => !item.heading).map(item => visibleWidth(item.label));
		const maxLabelWidth = Math.min(30, labelWidths.length > 0 ? Math.max(...labelWidths) : 0);
		// Sidebar + "│ " separator (2) + reserved fold/cursor gutter (2) + label
		// column + separator (2) — the always-aligned start of the value column.
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

		// Hit maps: sidebar rows resolve to each section's first item; pane rows
		// to the item they render.
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
		// If submenu is active, delegate all input to it
		// The submenu's onCancel (triggered by escape) will call done() which closes it
		if (this.#submenuComponent) {
			this.#submenuComponent.handleInput?.(data);
			return;
		}

		// Main list input handling
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
			// Confirm on a focused heading drops into its first setting.
			if (this.#sectionFocus) this.#sectionFocus = false;
			else this.#activateItem();
		}
	}

	#activateItem(): void {
		const item = this.#filteredItems[this.#selectedIndex];
		if (!item || item.heading || item.readOnly) return;

		if (item.submenu) {
			// Open submenu, passing current value so it can pre-select correctly
			this.#submenuItemId = item.id;
			this.#submenuComponent = item.submenu(item.currentValue, (selectedValue?: string) => {
				if (selectedValue !== undefined) {
					item.currentValue = selectedValue;
					this.#onChange(item.id, selectedValue);
				}
				this.#closeSubmenu();
			});
		} else if (item.values && item.values.length > 0) {
			// Cycle through values
			const currentIndex = item.values.indexOf(item.currentValue);
			const nextIndex = (currentIndex + 1) % item.values.length;
			const newValue = item.values[nextIndex];
			item.currentValue = newValue;
			this.#onChange(item.id, newValue);
		}
	}

	#closeSubmenu(): void {
		this.#submenuComponent = null;
		// Restore selection to the item that opened the submenu. Resolve by id:
		// onChange handlers may have called setItems while the submenu was open,
		// so a captured index could point at a different (or vanished) row.
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
