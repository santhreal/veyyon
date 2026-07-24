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
	applyModalReveal,
	computeModalDims,
	hitTestModalChrome,
	MODAL_SIZING_MEDIUM,
	ModalRevealDriver,
	type ModalShellGeometry,
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
