/**
 * Shared ModalShell medium picker wrapping a {@link SelectList}.
 * Replaces the DynamicBorder sandwich used by theme/thinking/queue/… selectors.
 */
import {
	type Component,
	padding,
	routeSgrMouseInput,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type SelectListTheme,
	type SgrMouseEvent,
	visibleWidth,
} from "@veyyon/tui";
import {
	computeModalDims,
	consumeModalChipHover,
	hitTestModalChrome,
	MODAL_SIZING_MEDIUM,
	type ModalShellGeometry,
	type ModalSizing,
	modalWidthForContent,
	modalWidthForTitle,
	pointerMotionEnabled,
	renderModalShell,
	SELECT_LIST_SHORTCUTS,
	sizingForArea,
} from "./modal-shell";

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

	/**
	 * Widest card this list has asked for at the current terminal width, which is
	 * the width the card keeps.
	 *
	 * The same argument as the height mark above, on the other axis. The card took
	 * a fixed share of the terminal — 60% up to 120 columns — whatever was in it,
	 * so a two-row picker with short descriptions drew into a 120-column frame and
	 * read as a list that had failed to load the rest of itself. Filtering can only
	 * remove rows, so measuring the CURRENT rows would narrow the card on a
	 * keystroke; the mark keeps the unfiltered width.
	 *
	 * Reset on a terminal resize, for the reason the height mark is: the primary
	 * column is capped against a share of the row, so the same items want a
	 * different width on a different terminal, and a mark carried across would size
	 * the card for content that no longer lays out that way.
	 */
	#cardWidthHighWater = 0;
	#cardWidthHighWaterArea = -1;

	constructor(options: ModalSelectListOptions, callbacks: ModalSelectListCallbacks) {
		this.#title = options.title;
		this.#tipCandidates = options.tipCandidates;
		this.#getTerminalRows = options.getTerminalRows ?? (() => process.stdout.rows || 40);
		this.#onCancel = callbacks.onCancel;

		const maxVisible = options.maxVisible ?? Math.min(12, Math.max(5, options.items.length));
		this.#list = new SelectList(options.items, maxVisible, options.theme, options.layout);
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
			this.#onCancel();
			return true;
		}
		if (chrome.kind === "shortcut" && chrome.id === "confirm") {
			this.#list.handleInput("\n");
			return true;
		}

		const geo = this.#shellGeometry;
		if (!geo) return true;
		const bodyLine = event.row - geo.bodyRowStart;
		const overBody = bodyLine >= 0 && bodyLine < geo.bodyRowCount;

		if (event.wheel !== null) {
			if (overBody) this.#list.handleWheel(event.wheel);
			return true;
		}
		if (event.motion) {
			this.#list.setHoverIndex(overBody ? (this.#list.hitTest(bodyLine) ?? null) : null);
			this.#onRequestRender?.();
			return true;
		}
		if (event.leftClick && overBody) {
			const index = this.#list.hitTest(bodyLine);
			if (index !== undefined) this.#list.clickItem(index);
		}
		return true;
	}

	render(width: number): string[] {
		const termHeight = Math.max(14, this.#getTerminalRows());
		const baseSizing = sizingForArea(MODAL_SIZING_MEDIUM, termHeight);
		// Content is measured at the WIDEST card this area allows, not at the card the
		// percentage would have given. The list's label column is capped against a
		// share of the row, so measuring inside a narrower card reports a column that
		// the wider card it is about to ask for would not have needed to truncate — and
		// the card would then settle one pass short of its own content, permanently.
		// Asking `computeModalDims` for it keeps the border-and-padding arithmetic in
		// its one owner.
		const widestDims = computeModalDims(width, termHeight, { ...baseSizing, preferredWidth: baseSizing.maxWidth });
		if (!widestDims) {
			this.#shellGeometry = null;
			return Array.from({ length: termHeight }, () => padding(width));
		}

		const sizing = this.#contentSizing(baseSizing, widestDims.contentWidth, width);
		const dims = computeModalDims(width, termHeight, sizing) ?? widestDims;

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
			shortcuts: SELECT_LIST_SHORTCUTS,
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});
		this.#shellGeometry = shell.geometry;
		return shell.lines;
	}

	/**
	 * The sizing this card's content asks for, in place of a share of the screen.
	 *
	 * The percentage was wrong in both directions. `/session`'s two rows took 60% of
	 * a wide terminal and read as a list that had failed to load; `/account`'s nine
	 * usage strings were held to the same 60% and truncated with forty columns of
	 * screen unused beside the card. A measured list knows its own width, so it says
	 * it, and `computeModalDims` still holds the answer inside `minWidth`, `maxWidth`
	 * and the area.
	 *
	 * The card never goes below its own title row either. A card sized only to its
	 * body cuts the last word off its title, and the title is the command the
	 * operator just typed.
	 */
	#contentSizing(base: ModalSizing, baseContentWidth: number, areaWidth: number): ModalSizing {
		if (this.#cardWidthHighWaterArea !== areaWidth) {
			this.#cardWidthHighWaterArea = areaWidth;
			this.#cardWidthHighWater = 0;
		}
		const wanted = Math.max(
			modalWidthForContent(this.#list.naturalWidth(baseContentWidth), base),
			modalWidthForTitle(visibleWidth(this.#title)),
		);
		this.#cardWidthHighWater = Math.max(this.#cardWidthHighWater, wanted);
		return { ...base, preferredWidth: this.#cardWidthHighWater };
	}

	/** Settle the pointer band so no timer outlives a dismissed card. */
	dispose(): void {
		this.#list.disposeHoverMotion();
	}
}
