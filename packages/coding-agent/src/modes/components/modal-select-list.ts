/** Shared ModalShell medium picker wrapping a {@link SelectList}. Replaces the DynamicBorder sandwich used by theme/thinking/queue/… selectors. */
import { type Component, padding, routeSgrMouseInput, SelectList, type SgrMouseEvent } from "@veyyon/tui";
import type { ModalSelectListCallbacks, ModalSelectListOptions } from "./modal-select-list-helpers";
import {
	computeModalDims,
	consumeModalChipHover,
	hitTestModalChrome,
	MODAL_SIZING_MEDIUM,
	type ModalShellGeometry,
	pointerMotionEnabled,
	renderModalShell,
	SELECT_LIST_SHORTCUTS,
	sizingForArea,
} from "./modal-shell";

export class ModalSelectListComponent implements Component {
	#list: SelectList;
	#title: string;
	#tipCandidates: readonly string[] | undefined;
	#getTerminalRows: () => number;
	#shellGeometry: ModalShellGeometry | null = null;
	#hoveredShortcutId: string | null = null;
	#onCancel: () => void;
	#onRequestRender?: () => void;

	/** Tallest body this card has ever drawn, which is the height it keeps. The card used to be the full height the vertical margins allowed, so a */
	#bodyRowsHighWater = 0;
	#highWaterWidth = -1;

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
		// The pointer band fades only once the card has a repaint to lend it: the frames between two mouse reports have no input to hang off. Same ambient
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
		const sizing = sizingForArea(MODAL_SIZING_MEDIUM, termHeight);
		const dims = computeModalDims(width, termHeight, sizing);
		if (!dims) {
			this.#shellGeometry = null;
			return new Array(termHeight).fill(padding(width));
		}

		const body = this.#list.render(dims.contentWidth).slice();
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

	/** Settle the pointer band so no timer outlives a dismissed card. */
	dispose(): void {
		this.#list.disposeHoverMotion();
	}
}
