/**
 * Shared ModalShell medium picker wrapping a {@link SelectList}.
 * Replaces the DynamicBorder sandwich used by theme/thinking/queue/… selectors.
 */
import {
	type Component,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type SelectListTheme,
} from "@veyyon/tui";
import { routeSgrMouseInput, type SgrMouseEvent } from "@veyyon/utils/mouse";
import { padding } from "@veyyon/utils/padding";
import {
	computeModalDims,
	MODAL_SIZING_MEDIUM,
	type ModalShellGeometry,
	type ModalShortcut,
	type ModalSizing,
	modalWidthForContent,
	pointerMotionEnabled,
	renderModalShell,
	SELECT_LIST_SHORTCUTS,
	sizingForArea,
} from "../chrome/modal-shell";
import { routeModalCardMouse } from "./select-list-mouse-routing";

/**
 * Footer for a list that filters as you type. The list's own status row stays silent until a
 * query exists, so this chip is the one place the search is named, and the key legend that row
 * used to repeat lives only here.
 */
const SEARCHABLE_LIST_SHORTCUTS: readonly ModalShortcut[] = [{ label: "type to search" }, ...SELECT_LIST_SHORTCUTS];

/** Footer while a query is live: the cancel key clears the query before it closes the card. */
const FILTERED_LIST_SHORTCUTS: readonly ModalShortcut[] = SELECT_LIST_SHORTCUTS.map(shortcut =>
	shortcut.id === "close" ? { ...shortcut, label: "clear" } : shortcut,
);

export interface ModalSelectListCallbacks {
	onSelect: (item: SelectItem) => void;
	onCancel: () => void;
	onSelectionChange?: (item: SelectItem) => void;
}

export interface ModalSelectListOptions {
	title: string;
	items: SelectItem[];
	theme: SelectListTheme;
	/** Preselected index; -1 leaves the list default. */
	selectedIndex?: number;
	maxVisible?: number;
	/** Override terminal rows (tests). */
	getTerminalRows?: () => number;
	tipCandidates?: readonly string[];
	/**
	 * Column sizing for the hosted list.
	 *
	 * Worth exposing because the default primary column is 32 cells wide, which
	 * on this card leaves under the minimum a description needs — so a list of
	 * SHORT values with descriptions (versions, ids, keys) silently renders as
	 * values alone, dropping the half of each row that says what it is. A
	 * consumer with short values sets a narrow primary column and gets both.
	 */
	layout?: SelectListLayoutOptions;
}
/**
 * Floating medium ModalShell hosting a SelectList. Host as a fullscreen
 * overlay so the shell can paint clear underpaint around the card.
 */
export class ModalSelectListComponent implements Component {
	#list: SelectList;
	#title: string;
	#tipCandidates: readonly string[] | undefined;
	#getTerminalRows: () => number;
	#shellGeometry: ModalShellGeometry | null = null;
	#hoveredShortcutId: string | null = null;
	#onCancel: () => void;
	#onRequestRender?: () => void;

	/**
	 * Tallest body this card has ever drawn, which is the height it keeps.
	 *
	 * The card used to be the full height the vertical margins allowed, so a
	 * seven-row list sat above ten blank rows and read as a list that failed to
	 * load the rest. Sizing to the CURRENT body instead would resize the card on
	 * every filter keystroke, which is worse. A high-water mark gives both: the
	 * first paint is unfiltered, so the card takes its natural height, and
	 * filtering down never moves the frame the operator is reading.
	 *
	 * It is a high-water mark PER WIDTH, not for the life of the component. A
	 * resize changes how the same rows lay out (descriptions wrap, columns
	 * shrink), so a mark carried across widths would size the card for a body
	 * that no longer exists — the stale-frame failure a resize must never leave
	 * behind. The mark resets on a width change and rebuilds on that width's
	 * first paint, which is unfiltered often enough to be the natural height.
	 */
	#bodyRowsHighWater = 0;
	#highWaterWidth = -1;

	constructor(options: ModalSelectListOptions, callbacks: ModalSelectListCallbacks) {
		this.#title = options.title;
		this.#tipCandidates = options.tipCandidates;
		this.#getTerminalRows = options.getTerminalRows ?? (() => process.stdout.rows || 40);
		this.#onCancel = callbacks.onCancel;

		const maxVisible = options.maxVisible ?? Math.min(12, Math.max(5, options.items.length));
		// The footer names every key and the search, so the list's status row carries only a live
		// query. Left on, it printed a second legend (`↑↓ move · ↵ select · esc close`) directly
		// above the footer's own.
		this.#list = new SelectList(options.items, maxVisible, options.theme, {
			statusLegend: false,
			searchPrompt: false,
			...options.layout,
		});
		if (options.selectedIndex !== undefined && options.selectedIndex >= 0) {
			this.#list.setSelectedIndex(options.selectedIndex);
		}
		this.#list.onSelect = item => callbacks.onSelect(item);
		this.#list.onCancel = () => callbacks.onCancel();
		if (callbacks.onSelectionChange) {
			this.#list.onSelectionChange = item => callbacks.onSelectionChange?.(item);
		}
	}

	setOnRequestRender(cb: () => void): void {
		this.#onRequestRender = cb;
		// The pointer band fades only once the card has a repaint to lend it: the
		// frames between two mouse reports have no input to hang off. Same ambient
		// gate as the unfold, so a terminal that shows no structural motion shows a
		// switched band, which is what it had before.
		this.#list.setHoverMotion({ requestRender: cb, enabled: pointerMotionEnabled() });
	}

	getSelectList(): SelectList {
		return this.#list;
	}

	invalidate(): void {
		this.#list.invalidate();
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			this.#handleMouse(data);
			return;
		}
		this.#list.handleInput(data);
	}

	#handleMouse(data: string): void {
		routeSgrMouseInput(data, event => this.#routeMouse(event));
	}

	#routeMouse(event: SgrMouseEvent): boolean {
		const geo = this.#shellGeometry;
		return routeModalCardMouse({
			shellGeometry: geo,
			event,
			hoveredShortcutId: this.#hoveredShortcutId,
			onHoverShortcut: id => {
				this.#hoveredShortcutId = id;
				this.#onRequestRender?.();
			},
			onCancel: () => this.#onCancel(),
			onCloseChip: () => this.#list.cancel(),
			onConfirm: () => this.#list.handleInput("\n"),
			onWheel: delta => {
				if (geo && event.row >= geo.bodyRowStart && event.row < geo.bodyRowStart + geo.bodyRowCount) {
					this.#list.handleWheel(delta);
				}
			},
			listRowStart: geo?.bodyRowStart,
			onHoverRow: line => {
				if (geo && line !== null && line >= 0 && line < geo.bodyRowCount) {
					this.#list.setHoverIndex(this.#list.hitTest(line) ?? null);
				} else {
					this.#list.setHoverIndex(null);
				}
				this.#onRequestRender?.();
			},
			onClickRow: line => {
				if (geo && line >= 0 && line < geo.bodyRowCount) {
					const index = this.#list.hitTest(line);
					if (index !== undefined) this.#list.clickItem(index);
				}
			},
		});
	}

	/**
	 * The medium card, widened until every row fits whole.
	 *
	 * The medium card is 60% of the terminal, which cut `/mcp`'s usage hints and descriptions while
	 * a third of the screen stood empty. Only the floor rises, to the width the list reports it
	 * needs, so a list that already fits keeps the shared proportions and `computeModalDims` still
	 * caps the card at the sizing's maximum and the terminal's edge.
	 */
	#sizing(termHeight: number): ModalSizing {
		const base = sizingForArea(MODAL_SIZING_MEDIUM, termHeight);
		const needed = modalWidthForContent(this.#list.naturalWidth(), base);
		return needed <= base.minWidth ? base : { ...base, minWidth: needed };
	}

	#shortcuts(): readonly ModalShortcut[] {
		if (this.#list.hasActiveFilter()) return FILTERED_LIST_SHORTCUTS;
		return this.#list.isSearchable() ? SEARCHABLE_LIST_SHORTCUTS : SELECT_LIST_SHORTCUTS;
	}

	render(width: number): string[] {
		const termHeight = Math.max(14, this.#getTerminalRows());
		const sizing = this.#sizing(termHeight);
		const dims = computeModalDims(width, termHeight, sizing);
		if (!dims) {
			this.#shellGeometry = null;
			return Array.from({ length: termHeight }, () => padding(width));
		}

		const body = [...this.#list.render(dims.contentWidth)];
		if (this.#highWaterWidth !== dims.contentWidth) {
			this.#highWaterWidth = dims.contentWidth;
			this.#bodyRowsHighWater = 0;
		}
		this.#bodyRowsHighWater = Math.max(this.#bodyRowsHighWater, body.length);
		const shell = renderModalShell({
			title: this.#title,
			sizing,
			areaWidth: width,
			areaHeight: termHeight,
			body,
			preferredBodyRows: this.#bodyRowsHighWater,
			tipCandidates: this.#tipCandidates,
			shortcuts: this.#shortcuts(),
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});
		this.#shellGeometry = shell.geometry;
		return shell.lines;
	}

	/** Settle the pointer band so no timer outlives a dismissed card. */
	dispose(): void {
		this.#list.disposeHoverMotion();
	}
}
