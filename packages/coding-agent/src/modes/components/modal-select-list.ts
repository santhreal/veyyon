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
	type SelectListTheme,
	type SgrMouseEvent,
} from "@veyyon/tui";
import {
	computeModalDims,
	hitTestModalChrome,
	MODAL_SIZING_MEDIUM,
	type ModalShellGeometry,
	type ModalShortcut,
	renderModalShell,
	SELECT_LIST_SHORTCUTS,
	withCompact,
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
	/** Footer shortcut chips. Defaults to the generic select-list set; pass a
	 *  custom set to name list-specific actions (e.g. a per-row `^O changelog`).
	 *  Keep the `confirm`/`close` ids on the primary/cancel chips so mouse clicks
	 *  route the same as Enter/Esc. */
	shortcuts?: readonly ModalShortcut[];
}

/**
 * Floating medium ModalShell hosting a SelectList. Host as a fullscreen
 * overlay so the shell can paint clear underpaint around the card.
 */
export class ModalSelectListComponent implements Component {
	#list: SelectList;
	#title: string;
	#tipCandidates: readonly string[] | undefined;
	#shortcuts: readonly ModalShortcut[];
	#getTerminalRows: () => number;
	#shellGeometry: ModalShellGeometry | null = null;
	#hoveredShortcutId: string | null = null;
	#onCancel: () => void;
	#onRequestRender?: () => void;

	constructor(options: ModalSelectListOptions, callbacks: ModalSelectListCallbacks) {
		this.#title = options.title;
		this.#tipCandidates = options.tipCandidates;
		this.#shortcuts = options.shortcuts ?? SELECT_LIST_SHORTCUTS;
		this.#getTerminalRows = options.getTerminalRows ?? (() => process.stdout.rows || 40);
		this.#onCancel = callbacks.onCancel;

		const maxVisible = options.maxVisible ?? Math.min(12, Math.max(5, options.items.length));
		this.#list = new SelectList(options.items, maxVisible, options.theme);
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

	/** Swap the modal title (e.g. into a confirm question and back). */
	setTitle(title: string): void {
		this.#title = title;
	}

	/** Swap the footer shortcut chips (e.g. into a confirm/cancel pair and back). */
	setShortcuts(shortcuts: readonly ModalShortcut[]): void {
		this.#shortcuts = shortcuts;
	}

	/** Swap the rotating tip line (e.g. "type to search" ↔ a confirm caveat). */
	setTipCandidates(tipCandidates: readonly string[] | undefined): void {
		this.#tipCandidates = tipCandidates;
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
		const sizing = withCompact(MODAL_SIZING_MEDIUM, termHeight < 24);
		const dims = computeModalDims(width, termHeight, sizing);
		if (!dims) {
			this.#shellGeometry = null;
			return Array.from({ length: termHeight }, () => padding(width));
		}

		const body = [...this.#list.render(dims.contentWidth)];
		const shell = renderModalShell({
			title: this.#title,
			sizing,
			areaWidth: width,
			areaHeight: termHeight,
			body,
			tipCandidates: this.#tipCandidates,
			shortcuts: this.#shortcuts,
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});
		this.#shellGeometry = shell.geometry;
		return shell.lines;
	}
}
