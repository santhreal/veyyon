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
import { SCROLLBAR_RESERVE_COLS, ScrollView } from "./scroll-view";
import { filterSettingItems } from "./settings-search";

/**
 * ROW GEOMETRY.
 *
 * A settings row used to be `cursor + label.padEnd(widestLabel) + "  " + value`,
 * which put every value at one column and let each one end wherever its text ran
 * out. `on`, `8`, `claude-sonnet-4-5-20250929` and `~/.veyyon/profiles/work` all
 * started together and finished apart, so the column a reader scans — the one
 * holding what each setting is set TO — had no edge to scan down. The value
 * column is right-flushed here instead, and the block is as wide as its own
 * content rather than as wide as the pane, so the values share a right edge that
 * sits beside the labels instead of out at the terminal's margin.
 *
 * A group used to be a heading row at the same indent as its members, so a group
 * had a name and no extent. Its rows indent past it, which is what makes the
 * group read as a block.
 *
 * A row's KIND used to be invisible: a row that opens a submenu, a row that
 * cycles through values and a row that only reports a value were the same shape,
 * and the `‹ value ›` cycling frame appeared only on the row already under the
 * cursor. A drill-down row now carries its affordance in a reserved trailing
 * cell, so which rows go somewhere is legible from the shape of the column
 * without moving the cursor onto them.
 */

/** Columns the cursor glyph occupies, reserved on every row so nothing shifts. */
const CURSOR_COLS = 2;
/** Columns a group's rows indent past their heading, giving the group extent. */
const GROUP_INSET_COLS = 2;
/** Columns between the label column and the value column. */
const VALUE_GAP_COLS = 2;
/** Widest label column; a longer label is cut rather than pushing values out. */
const LABEL_MAX_COLS = 30;
/** Columns the value column keeps before the label column spends any of them. */
const MIN_VALUE_COLS = 8;
/** Columns the drill-down affordance occupies: one of gap, one of glyph. */
const AFFORDANCE_COLS = 2;
/** The cycling frame `‹ v ›` adds this much, reserved so the edge cannot move. */
const CYCLE_FRAME_COLS = 4;
/** Rows the footnote band always occupies: one blank, two of prose. */
const FOOTNOTE_ROWS = 3;
/** Item rows a frame keeps before it will spend any on the footnote band. */
const MIN_ITEM_ROWS = 4;
/** Fallback drill-down glyph for a host that names none. */
const DRILL_IN_GLYPH = "›";

/**
 * Where one frame's rows put their parts. Derived once per frame from every
 * filtered item rather than from the window in view, so scrolling never moves a
 * column sideways.
 */
interface RowGeometry {
	/** Columns before a group member's label: the cursor gutter plus the inset. */
	indent: number;
	/** Columns before a heading's label: the cursor gutter alone. */
	headingIndent: number;
	/** The label column, padded to this width. */
	labelWidth: number;
	/** The value column. A value is right-flushed inside it. */
	valueWidth: number;
	/** First column of the value column, for the pointer. */
	valueCol: number;
	/** True when a row in this list drills down, so every row reserves the cell. */
	affordance: boolean;
}

/**
 * What a set of items asks one row to be, measured with no width in hand:
 * the columns each part wants before anything is squeezed.
 */
interface RowDemand {
	/** Columns before a group member's label: the cursor gutter plus the inset. */
	indent: number;
	/** The widest label, capped at {@link LABEL_MAX_COLS}. */
	labelWidth: number;
	/** The widest displayed value, including a cycling row's frame. */
	valueWidth: number;
	/** Columns the trailing drill-down cell takes, or 0 when no row drills down. */
	trailing: number;
	/** True when a row in this set drills down, so every row reserves the cell. */
	affordance: boolean;
}

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
	/**
	 * The search field on the status row, given the live query. Omit and the list
	 * writes `Search: <query>` / `Type to search`; a product with one field
	 * grammar supplies it here so this row is not a second definition of it.
	 */
	searchField?: (query: string) => string;
	/**
	 * The row shown when the list is empty or the query matched nothing, given
	 * the sentence with its indent. Omit and the list paints it with
	 * {@link SettingsListTheme.hint}; a product whose surfaces share one empty
	 * row supplies it here so this row is not a second weight of it.
	 */
	emptyRow?: (text: string) => string;
	/**
	 * The glyph a drill-down row carries in its trailing cell, from the host's
	 * own symbol preset. Omitted and the list uses `›`, which is the shape every
	 * preset spells this with.
	 */
	drillIn?: string;
}

/** A contiguous run of items under one heading, derived from the item list. */
interface SettingSection {
	name: string;
	firstItemIndex: number;
	lastItemIndex: number;
}

/**
 * Where the selected row's description goes.
 *
 * `reserved` (the default) is a band below the frame, `footnote` a fixed band at
 * the foot of the rows inside the pane, `none` shows no description at all.
 */
export type SettingsDescriptionMode = "footnote" | "reserved" | "none";

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
	 * How the selected item's description paints.
	 * - `reserved` (default): a band below the whole frame — 1 blank + 3 rows,
	 *   outside the pane, so a sidebar rule stops above it. It adds to the
	 *   frame's height rather than borrowing from the rows.
	 * - `footnote`: a fixed band at the foot of the list, inside the pane, always
	 *   the same height. The row stream never reflows, so moving the cursor moves
	 *   the cursor and nothing else, and a two-pane layout gets a description at
	 *   all. Ask for it in a card that owns its own height.
	 * - `none`: never paint descriptions in the list.
	 *
	 * The default stays `reserved` because a host that asks for nothing must keep
	 * getting what it had: the footnote band borrows from the item viewport, and
	 * a one-row list (a plugin's Enabled toggle) has nothing to lend, so making
	 * it the default silently deleted the description from every list that had
	 * never heard of the option.
	 */
	descriptionMode?: SettingsDescriptionMode;
	/**
	 * When true the `footnote` band takes as many rows as the selected row's
	 * description needs instead of the two it is worth at rest, so prose longer
	 * than the band can be read in full.
	 *
	 * The band's height changes only when a host sets this, never when the cursor
	 * moves, which is the property the band exists for: a reader who pressed
	 * nothing sees nothing move.
	 */
	descriptionExpanded?: boolean;
}

/**
 * True when a row's value steps through a list of values.
 *
 * ONE predicate, because the two that existed disagreed: the renderer drew the
 * `‹ value ›` frame whenever a row carried any values at all, so a row with a
 * single value advertised a step that could only ever return the value it
 * already had.
 */
function cyclesValue(item: SettingItem): boolean {
	return (
		item.heading !== true && item.readOnly !== true && item.submenu === undefined && (item.values?.length ?? 0) > 1
	);
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

	/** Open the selected row's submenu or cycle its values, same as Enter. */
	activateSelected(): void {
		this.#activateItem();
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
		const field = this.#theme.searchField?.(query);
		// A supplied field carries its own colour; wrapping it in the hint paint
		// would end at the field's own reset.
		if (field !== undefined) return truncateToWidth(`  ${field}`, width, Ellipsis.Omit);
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
	 * Height budget for the list frame. The footnote band borrows its rows from
	 * the item viewport rather than adding to the frame, so a list that shows a
	 * description is exactly as tall as one that does not; only the legacy
	 * `reserved` band sits outside the frame and adds to it.
	 */
	#stableHeight(): number {
		const descBand = this.#descriptionMode() === "reserved" ? 4 : 0;
		let height = this.#maxVisible + descBand;
		if (this.#options.typeToSearch !== false) height += 1;
		if (this.#options.hint !== "") height += 2;
		return height;
	}

	#descriptionMode(): SettingsDescriptionMode {
		return this.#options.descriptionMode ?? "reserved";
	}

	/**
	 * The columns this frame's rows share, measured over every filtered item so a
	 * scroll, a cursor move or a submenu round trip cannot shift a column
	 * sideways. `rowWidth` is the space the rows have.
	 *
	 * A NARROW PANE CUTS THE NAME, NOT THE STATE. The label column used to take
	 * its full measured width and leave the value whatever remained, which in the
	 * split card's 36-column pane was four cells: every row on the Appearance tab
	 * read `tita`, `Unic`, `Defa`, `Disa`. A cut name is still the name, and its
	 * group and its neighbours say the rest; a value cut to four cells is not a
	 * shorter value, it is a different one. So the value keeps
	 * {@link MIN_VALUE_COLS} before the label spends anything, and either column
	 * carries a mark where it was cut.
	 */
	#geometry(rowWidth: number): RowGeometry {
		const demand = this.#rowDemand(this.#filteredItems);
		const { indent, trailing } = demand;
		let { labelWidth, valueWidth } = demand;
		const fixed = indent + VALUE_GAP_COLS + trailing;
		const room = clampLow(rowWidth - fixed, 0, rowWidth);
		const floor = Math.min(valueWidth, MIN_VALUE_COLS, room);
		valueWidth = clamp(room - labelWidth, floor, valueWidth);
		labelWidth = clampLow(room - valueWidth, 0, labelWidth);
		// THE VALUE COLUMN ENDS AT THE ROW'S EDGE, not at the end of a block sized
		// to the widest value. Sized to its content the values huddled wherever the
		// longest one happened to reach, with the rest of the row empty beyond them:
		// the row had two right edges and neither was its own. Labels read down the
		// left, values up the right, and the space between them is what is left.
		const valueCol = Math.max(indent + labelWidth + VALUE_GAP_COLS, rowWidth - trailing - valueWidth);
		return {
			indent,
			headingIndent: CURSOR_COLS,
			labelWidth,
			valueWidth,
			valueCol,
			affordance: demand.affordance,
		};
	}

	/**
	 * What one row of `items` asks for, before any width is applied. One
	 * measurement for both readers: the frame's own columns and the width a host
	 * needs to hand the rows so nothing is cut, which would otherwise be two
	 * formulas that agree until one of them is edited.
	 */
	#rowDemand(items: readonly SettingItem[]): RowDemand {
		const glyph = this.#theme.drillIn ?? DRILL_IN_GLYPH;
		let labelWidth = 0;
		let valueWidth = 0;
		let affordance = false;
		let grouped = false;
		for (const item of items) {
			if (item.heading) {
				grouped = true;
				continue;
			}
			labelWidth = Math.max(labelWidth, visibleWidth(item.label));
			const shown = item.labelForValue?.(item.currentValue) ?? item.currentValue;
			// The cycling frame is reserved for every row that can cycle, not only
			// the one under the cursor: measured on the selected row alone, the
			// column's right edge would step four cells left and back as the cursor
			// passed over each enum row.
			const frame = cyclesValue(item) ? CYCLE_FRAME_COLS : 0;
			valueWidth = Math.max(valueWidth, visibleWidth(String(shown ?? "")) + frame);
			if (item.submenu) affordance = true;
		}
		return {
			indent: CURSOR_COLS + (grouped ? GROUP_INSET_COLS : 0),
			labelWidth: Math.min(labelWidth, LABEL_MAX_COLS),
			valueWidth,
			trailing: affordance ? AFFORDANCE_COLS + visibleWidth(glyph) - 1 : 0,
			affordance,
		};
	}

	/**
	 * The pane width at which this list cuts nothing: every label whole, every
	 * value whole, the cursor gutter, the group inset, the trailing affordance
	 * and the scrollbar the view reserves, all paid for.
	 *
	 * A HOST THAT SPLITS ITS CARD HAS TO ASK WHAT THE ROWS COST. The settings
	 * card sized its category sidebar from its own name lengths and handed the
	 * rows the remainder, which at 70 columns was a 31-column pane for rows that
	 * wanted 35: every Appearance label came out cut (`Terminal Hyper…`) while
	 * the sidebar sat at its full width beside them. The reserve is counted here
	 * rather than by the caller, for the same reason the rows ask the view for
	 * their width instead of guessing it.
	 *
	 * Measured over every item rather than the filtered view, so typing a search
	 * cannot move the split it decides.
	 */
	naturalPaneWidth(): number {
		const demand = this.#rowDemand(this.#items);
		const row = demand.indent + demand.labelWidth + VALUE_GAP_COLS + demand.valueWidth + demand.trailing;
		return row + SCROLLBAR_RESERVE_COLS;
	}

	/**
	 * The rows this list needs to show everything it holds: every item, and the
	 * description band that states what the selected one does.
	 *
	 * A HOST'S OWN DECORATION IS PAID FOR OUT OF SPARE ROWS. The settings card
	 * spends three rows on a live status-line preview; with the pane widened
	 * those three rows came out of the list, and the Appearance tab's last two
	 * rows — the ones a reader had just expanded a fold to see — fell off the
	 * end of the card. So the host asks what the rows want before it spends a
	 * row on anything of its own.
	 *
	 * The blank rows between groups are not counted: they are the cheapest thing
	 * on the list and the first thing it gives up, so a host that can afford a
	 * preview is not talked out of it by air.
	 */
	naturalRowCount(): number {
		return this.#physicalRowsNeeded(false) + (this.#descriptionMode() === "footnote" ? FOOTNOTE_ROWS : 0);
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
		geo: RowGeometry,
		rowWidth: number,
		dimmed = false,
		headingCursor = false,
	): string {
		// A heading sits at the cursor gutter and its members inset past it, so the
		// group's left edge is the heading's own and the block below it is visibly
		// inside the group rather than beside it.
		if (item.heading) {
			const headingStyle = this.#theme.heading ?? ((text: string) => this.#theme.hint(text));
			const prefix = headingCursor ? this.#theme.cursor : padding(geo.headingIndent);
			const gutter = padding(Math.max(0, geo.headingIndent - visibleWidth(prefix)));
			return truncateToWidth(`${prefix}${gutter}${headingStyle(item.label, dimmed)}`, Math.max(0, rowWidth));
		}
		// While section focus owns the keyboard, the row cursor hides so the
		// section cursor is the single focus indicator.
		const isSelected = index === this.#selectedIndex && !this.#sectionFocus;
		const cursor = isSelected ? this.#theme.cursor : padding(CURSOR_COLS);
		const prefix = cursor + padding(Math.max(0, geo.indent - visibleWidth(cursor)));
		// A cut name is marked. Unmarked, `Terminal Hyperlinks` arrives as
		// `Terminal Hyperlink`, which reads as a setting that is not there.
		const labelPadded = truncateToWidth(item.label, geo.labelWidth, Ellipsis.Unicode).padEnd(geo.labelWidth);
		// The selected row wears `‹ value ›` when activating it cycles the value, so
		// a row that changes in place is distinguishable from one that only reports.
		const cyclable = isSelected && cyclesValue(item);
		// A row whose value is machine-readable (a millisecond count, a byte size) renders
		// through its own labeller so the operator reads "5 minutes" instead of "300000".
		// Mapped at render time from `currentValue` rather than stored beside it, because
		// a second field would go stale the moment a submenu selection writes the first.
		const shownValue = item.labelForValue?.(item.currentValue) ?? item.currentValue;
		const rawValue = cyclable ? `‹ ${shownValue} ›` : String(shownValue ?? "");
		// The value column's right edge is the row's, and inside it the value reads
		// from the left: these are words, not figures, so a shared LEFT edge is what
		// makes the states scan as a column — `titanium` and `auto` start in the
		// same place instead of hanging off one ragged right edge.
		//
		// Marked where it is cut, for the same reason as the label and more
		// urgently: `Disa` is not a shorter `Disabled`, it is a value the product
		// never had.
		const cut = truncateToWidth(rawValue, geo.valueWidth, Ellipsis.Unicode);
		// The slack sits OUTSIDE the value's paint: a theme that fills a background
		// would otherwise wash the empty column between the value and the row's
		// trailing cell, as wide as the widest value in the list rather than as
		// wide as this row's own.
		const slack = padding(Math.max(0, geo.valueWidth - visibleWidth(cut)));
		// The trailing cell states the row's KIND: a row that opens something
		// carries the glyph, and a row that does not leaves the cell empty rather
		// than closing the gap, so the column stays a column.
		const trailing = geo.affordance ? ` ${item.submenu ? (this.#theme.drillIn ?? DRILL_IN_GLYPH) : " "}` : "";
		const band = this.#theme.hovered;
		const strength = band === undefined ? 0 : this.#hoverStrength(item.id, isSelected);
		// De-emphasized rows (outside the active section) render as plain text
		// under one dim wash so inner label/value colors don't fight it.
		// The label's own column is fixed and the value's edge is the row's, so the
		// space between them is the row's slack rather than a constant.
		const gap = padding(Math.max(VALUE_GAP_COLS, geo.valueCol - geo.indent - geo.labelWidth));
		if (dimmed && !isSelected) {
			const plain = `${padding(geo.indent)}${labelPadded}${gap}${cut}${slack}${trailing}`;
			const text = this.#theme.hint(truncateToWidth(plain, Math.max(0, rowWidth)));
			return strength > 0 && band !== undefined ? band(text, strength) : text;
		}
		const labelText = this.#theme.label(labelPadded, isSelected, item.changed === true);
		const valueText = this.#theme.value(cut, isSelected, item.changed === true);
		const painted = prefix + labelText + gap + valueText + slack + this.#theme.hint(trailing);
		const text = truncateToWidth(painted, Math.max(0, rowWidth));
		// Pointer hover paints a band behind the whole row, distinct from the
		// keyboard selection (cursor glyph + accent) which stays where it is.
		if (strength > 0 && band !== undefined) {
			return band(text, strength);
		}
		return text;
	}

	/**
	 * The footnote band: a block at the foot of the rows describing whatever the
	 * cursor is on, {@link FOOTNOTE_ROWS} tall at rest.
	 *
	 * A height that does not follow the cursor is the whole point. The band this
	 * replaces was spliced INTO the row stream under the selected row and took its
	 * rows out of the viewport, so one press of Down re-centred the window and
	 * moved every row on screen — the content a reader was looking at moved
	 * because the cursor moved. Here the rows above never learn that the band
	 * changed.
	 *
	 * Two rows of prose is a summary, and some descriptions say more than that: a
	 * setting shadowed by a runtime override explains which layer it is coming
	 * from and why the row is read-only. So a host may grow the band with
	 * `descriptionExpanded`, and the rows move once, for a key the reader pressed.
	 */
	#footnoteBand(width: number): string[] {
		if (!this.#footnoteFits()) return [];
		const rows: string[] = [""];
		const item = this.#filteredItems[this.#selectedIndex];
		const prose = item && !item.heading ? item.description : undefined;
		const budget = this.#bandProseBudget();
		if (prose) {
			const wrapped = wrapTextWithAnsi(prose, Math.max(1, width - CURSOR_COLS - 2));
			for (const line of wrapped.slice(0, budget)) {
				rows.push(this.#theme.description(`${padding(CURSOR_COLS)}${line}`));
			}
			if (wrapped.length > budget && rows.length > 1) {
				rows[rows.length - 1] = truncateToWidth(`${rows[rows.length - 1]}…`, width);
			}
		}
		while (rows.length < FOOTNOTE_ROWS) rows.push("");
		return rows;
	}

	/**
	 * Prose rows the band may spend. At rest it is the band's own height, and
	 * expanded it is everything left once the item rows keep {@link MIN_ITEM_ROWS}
	 * — a description never takes the list.
	 */
	#bandProseBudget(): number {
		const resting = FOOTNOTE_ROWS - 1;
		if (this.#options.descriptionExpanded !== true) return resting;
		return clampLow(this.#maxVisible - MIN_ITEM_ROWS - 1, resting, this.#maxVisible);
	}

	/** The empty/no-match row, through the theme's own painter when it supplies one. */
	#emptyRow(text: string): string {
		return (this.#theme.emptyRow ?? this.#theme.hint)(text);
	}

	/**
	 * Whether this frame spends rows on the footnote band.
	 *
	 * The rows are the surface and the prose describes them, so the band never
	 * costs a row that would otherwise hold a setting a reader could have seen. It
	 * takes its rows when everything fits WITH it, and when the list overflows
	 * anyway — there the band changes how far you scroll, not whether. In the
	 * band between those two, where the list fits exactly and the band would push
	 * the tail out, the rows win.
	 *
	 * Counted WITHOUT the blank rows between groups, because those are the next
	 * thing to go: a description of the row under the cursor outranks air.
	 */
	#footnoteFits(): boolean {
		if (this.#descriptionMode() !== "footnote") return false;
		if (this.#maxVisible - FOOTNOTE_ROWS < MIN_ITEM_ROWS) return false;
		const need = this.#physicalRowsNeeded(false);
		return need + FOOTNOTE_ROWS <= this.#maxVisible || need > this.#maxVisible;
	}

	/** Physical rows the whole list wants: every item, plus each group's spacer. */
	#physicalRowsNeeded(spacers = true): number {
		let rows = 0;
		for (let index = 0; index < this.#filteredItems.length; index++) {
			if (spacers && this.#filteredItems[index]?.heading && index > 0 && rows > 0) rows++;
			rows++;
		}
		return rows;
	}

	/**
	 * The physical rows of one window: each entry names the item index it draws,
	 * or -1 for the blank row that opens a group.
	 *
	 * A group's heading used to butt directly against the last row of the group
	 * above it, so a reader scanning a column of rows met a heading with a row
	 * hard against it on both sides and no seam anywhere. One blank row before a
	 * heading gives every group after the first a top edge. The blank is a
	 * PHYSICAL row taken from the window, never an item, so nothing downstream —
	 * selection, the hit map, `#sections()` — has to know it is there.
	 *
	 * AIR IS PAID FOR OUT OF SPARE ROWS, NEVER OUT OF CONTENT. `spacers` is false
	 * once the list no longer fits: on the Subagents tab the five group seams cost
	 * five settings, and the Prune group fell off the end of a card that had the
	 * rows to show it. A seam is worth a row a reader was not going to see anyway,
	 * and nothing more than that.
	 */
	#windowPlan(startIndex: number, rows: number, spacers: boolean): { index: number }[] {
		const plan: { index: number }[] = [];
		for (let index = startIndex; index < this.#filteredItems.length && plan.length < rows; index++) {
			// No spacer above the list's own first row: a card does not open on a
			// blank line, and a spacer at the top edge of a scrolled window would
			// appear and vanish as the window moved over it.
			if (spacers && this.#filteredItems[index]?.heading && index > 0 && plan.length > 0) {
				plan.push({ index: -1 });
				if (plan.length >= rows) break;
			}
			plan.push({ index });
		}
		return plan;
	}

	#renderMainList(width: number): string[] {
		const lines: string[] = [];

		if (this.#items.length === 0) {
			lines.push(this.#emptyRow(`  ${this.#options.emptyText ?? "No settings available"}`));
			return lines;
		}

		if (this.#filteredItems.length === 0) {
			if (this.#shouldRenderSearchStatus()) {
				lines.push(this.#renderSearchStatus(width));
			}
			lines.push(this.#emptyRow("  No matching settings"));
			lines.push("");
			lines.push(truncateToWidth(this.#theme.hint("  backspace to edit search · esc to cancel"), width));
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
			// The footnote band borrows its rows from the item viewport, so the frame
			// is one height whether or not the row under the cursor says anything.
			const footnote = this.#footnoteBand(width);
			const computeStart = (vh: number) =>
				clampLow(this.#selectedIndex - Math.floor(vh / 2), 0, this.#filteredItems.length - vh);
			// Group seams come out of rows nobody would have seen: they stay while
			// the whole list still fits with them, and go the moment they would cost
			// a setting a place in the window.
			const room = this.#maxVisible - footnote.length;
			const spacers = this.#physicalRowsNeeded() <= room;
			let viewportHeight = clamp(room, 1, this.#physicalRowsNeeded(spacers));
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
			// THE SCROLL VIEW OWNS THE WIDTH ITS BAR TAKES. It reserves a breathing
			// gap and the glyph, two columns, and exposes that as `contentWidth()`;
			// the rows here subtracted one column of their own guess. Every row came
			// out a column wider than the viewport, so the view truncated it, and the
			// cell a row lost was its last — the reserved affordance at its right
			// edge, replaced on every row by an ellipsis. The list asks instead.
			const scrollView = new ScrollView([], {
				height: viewportHeight,
				scrollbar: "auto",
				totalRows: this.#filteredItems.length,
				theme: {
					track: text => this.#theme.hint(text),
					thumb: text => this.#theme.label(text, true, false),
				},
			});
			const itemRowWidth = scrollView.contentWidth(width);
			const geo = this.#geometry(itemRowWidth);
			this.#valueColStart = geo.valueCol;
			// In the flat layout the active section's heading row carries the
			// section-focus cursor (the split layout shows it in the sidebar).
			const active = sections[this.#activeSectionIndex(sections)];
			const focusedHeadingIndex = this.#sectionFocus && active?.name ? active.firstItemIndex - 1 : -1;
			const hitOffset = stickyHeadingIndex >= 0 ? 1 : 0;
			if (stickyHeadingIndex >= 0) {
				const stickyItem = this.#filteredItems[stickyHeadingIndex]!;
				lines.push(
					this.#renderItemRow(
						stickyItem,
						stickyHeadingIndex,
						geo,
						itemRowWidth,
						false,
						stickyHeadingIndex === focusedHeadingIndex,
					),
				);
				this.#hitRows[0] = undefined;
			}
			const itemRows: string[] = [];
			for (const step of this.#windowPlan(startIndex, viewportHeight, spacers)) {
				if (step.index < 0) {
					itemRows.push("");
					continue;
				}
				const item = this.#filteredItems[step.index]!;
				this.#hitRows[itemRows.length + hitOffset] = item.heading ? undefined : item.id;
				itemRows.push(
					this.#renderItemRow(item, step.index, geo, itemRowWidth, false, step.index === focusedHeadingIndex),
				);
			}
			scrollView.setLines(itemRows);
			scrollView.setScrollOffset(startIndex);
			lines.push(...scrollView.render(width));
			// Pad short lists to the viewport so the band sits at the same row
			// whether the list fills the frame or holds three rows.
			while (lines.length < this.#maxVisible - footnote.length) lines.push("");
			lines.push(...footnote);
		}

		// The legacy band, below the whole frame rather than inside the pane.
		if (this.#descriptionMode() === "reserved") {
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
			const jumpHint = sections.length >= 2 ? "pgup/pgdn to jump sections · " : "";
			const hintText = this.#options.hint ?? `enter/space to change · ${jumpHint}Type to search · esc to cancel`;
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

		// Right pane: the whole list, continuously scrollable, with the footnote
		// band at its foot INSIDE the pane, so the rule between the panes runs the
		// full height of the card and the description belongs to the column it
		// describes. The band the split layout had before was the flat layout's,
		// appended under both panes at the card's own left edge — under the
		// sidebar, past the end of the rule, describing a row two columns away.
		const footnote = this.#footnoteBand(paneWidth);
		const activeStart = active.name ? active.firstItemIndex - 1 : active.firstItemIndex;
		const room = this.#maxVisible - footnote.length;
		const spacers = this.#physicalRowsNeeded() <= room;
		const viewportHeight = clamp(room, 1, this.#physicalRowsNeeded(spacers));
		const startRow = Math.max(
			0,
			Math.min(this.#selectedIndex - Math.floor(viewportHeight / 2), this.#filteredItems.length - viewportHeight),
		);
		const scrollView = new ScrollView([], {
			height: viewportHeight,
			scrollbar: "auto",
			totalRows: this.#filteredItems.length,
			theme: {
				track: text => this.#theme.hint(text),
				thumb: text => this.#theme.label(text, true, false),
			},
		});
		const rowWidth = scrollView.contentWidth(paneWidth);
		const geo = this.#geometry(rowWidth);
		// The pane's own value column, offset by the sidebar and the rule, so a
		// click lands on the value the pointer is over.
		this.#valueColStart = sidebarWidth + 2 + geo.valueCol;
		const itemRows: string[] = [];
		for (const step of this.#windowPlan(startRow, viewportHeight, spacers)) {
			if (step.index < 0) {
				itemRows.push("");
				continue;
			}
			const item = this.#filteredItems[step.index]!;
			const dimmed = step.index < activeStart || step.index > active.lastItemIndex;
			if (!item.heading) this.#hitRows[itemRows.length] = item.id;
			itemRows.push(this.#renderItemRow(item, step.index, geo, rowWidth, dimmed));
		}
		scrollView.setLines(itemRows);
		scrollView.setScrollOffset(startRow);
		const paneRows = [...scrollView.render(paneWidth), ...footnote];

		// Sidebar rows resolve to each section's first item.
		this.#sidebarHitCol = sidebarWidth;
		for (let i = 0; i < sectionNames.length; i++) {
			this.#sidebarHitRows[i] = this.#filteredItems[sections[i].firstItemIndex]?.id;
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

		// Left and Right never reach here. This list lives in a two-pane card whose
		// category sidebar sits to its left, and a row that spent an arrow on its
		// own value left no way back to that column; a value cycles on activation,
		// which is what the product settled on.
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
