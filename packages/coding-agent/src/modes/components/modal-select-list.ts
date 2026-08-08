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
} from "@veyyon/tui";
import {
	applyModalReveal,
	computeModalDims,
	hitTestModalChrome,
	MODAL_SIZING_MEDIUM,
	ModalRevealDriver,
	type ModalShellGeometry,
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
	/**
	 * Play the open unfold (TOUCH-5). Honored blindly; the ambient gate
	 * (truecolor + shimmer) is the SHOW site's job via modalRevealEnabled(), so
	 * direct constructions render settled frames deterministically.
	 */
	reveal?: boolean;
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
	#reveal = new ModalRevealDriver();
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
		if (options.reveal) {
			// The driver anchors its clock at first paint, so starting here (before
			// setOnRequestRender wires the host) never skips the unfold.
			this.#reveal.start(() => this.#onRequestRender?.());
		}
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
		if (chrome.kind === "hover-shortcut") {
			if (this.#hoveredShortcutId !== chrome.id) {
				this.#hoveredShortcutId = chrome.id;
				this.#onRequestRender?.();
			}
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
		const sizing = sizingForArea(MODAL_SIZING_MEDIUM, termHeight);
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
			shortcuts: SELECT_LIST_SHORTCUTS,
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});
		this.#shellGeometry = shell.geometry;
		return applyModalReveal(shell, width, this.#reveal.value);
	}

	/** Settle the reveal so no timer outlives a dismissed card. */
	dispose(): void {
		this.#reveal.stop();
	}
}
