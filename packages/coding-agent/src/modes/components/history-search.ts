import {
	type Component,
	Ellipsis,
	HoverFade,
	type HoverFadeOptions,
	Input,
	matchesKey,
	padding,
	routeSgrMouseInput,
	type SgrMouseEvent,
	truncateToWidth,
	visibleWidth,
} from "@veyyon/tui";
import { collapseWhitespace } from "@veyyon/utils";
import type { HistoryEntry, HistoryStorage } from "../../session/history-storage";
import { theme } from "../theme/theme";
import {
	matchesAppInterrupt,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../utils/keybinding-matchers";
import { highlightTokens, MAX_VISIBLE, queryTokens, relativeTime } from "./history-search-helpers";
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
import { centeredWindow, hoverBandAt, renderScrollableList, selectionBand } from "./selector-helpers";

class HistoryResultsList implements Component {
	#results: HistoryEntry[] = [];
	#tokens: string[] = [];
	#selectedIndex = 0;
	#maxVisible = MAX_VISIBLE;
	#hoveredIndex: number | null = null;
	#hoverFade?: HoverFade;
	#hitRows: (number | undefined)[] = [];

	setResults(results: HistoryEntry[], selectedIndex: number, tokens: string[]): void {
		this.#results = results;
		this.#selectedIndex = selectedIndex;
		this.#tokens = tokens;
	}

	setSelectedIndex(selectedIndex: number): void {
		this.#selectedIndex = selectedIndex;
	}

	hitTest(line: number): number | undefined {
		return this.#hitRows[line];
	}

	setHoverIndex(index: number | null): boolean {
		if (this.#hoveredIndex === index) return false;
		this.#hoveredIndex = index;
		this.#hoverFade?.set(index);
		return true;
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

	#hoverStrength(index: number, isSelected: boolean): number {
		if (isSelected) return 0;
		if (this.#hoverFade !== undefined) return this.#hoverFade.strengthAt(index);
		return index === this.#hoveredIndex ? 1 : 0;
	}

	invalidate(): void {}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		this.#hitRows = [];

		if (this.#results.length === 0) {
			const message = this.#tokens.length > 0 ? "No matching history" : "No history yet";
			lines.push(theme.fg("muted", `  ${theme.status.info} ${message}`));
			return lines;
		}

		const cursorSymbol = `${theme.nav.cursor} `;
		const gutterWidth = visibleWidth(cursorSymbol);

		const { startIndex, endIndex } = centeredWindow(this.#selectedIndex, this.#results.length, this.#maxVisible);

		lines.push(
			...renderScrollableList(
				{ width, visibleRows: endIndex - startIndex, totalRows: this.#results.length, scrollOffset: startIndex },
				rowWidth => {
					const rows: string[] = [];
					for (let i = startIndex; i < endIndex; i++) {
						const entry = this.#results[i];
						const isSelected = i === this.#selectedIndex;
						const hoverStrength = this.#hoverStrength(i, isSelected);

						const timeStr = relativeTime(entry.created_at);
						const timeWidth = visibleWidth(timeStr);
						const showTime = rowWidth >= gutterWidth + 12 + timeWidth;

						const promptBudget = Math.max(4, rowWidth - gutterWidth - (showTime ? timeWidth + 1 : 0));
						const normalized = collapseWhitespace(entry.prompt);
						const plain = truncateToWidth(normalized, promptBudget);
						const highlighted = highlightTokens(plain, this.#tokens);

						const cursor = isSelected ? theme.fg("accent", cursorSymbol) : padding(gutterWidth);
						let line = cursor + (isSelected ? theme.bold(highlighted) : highlighted);

						if (showTime) {
							line = `${truncateToWidth(line, rowWidth - timeWidth - 1, Ellipsis.Unicode, true)} ${theme.fg("dim", timeStr)}`;
						}

						this.#hitRows[rows.length] = i;
						if (isSelected) rows.push(selectionBand(line, rowWidth));
						else if (hoverStrength > 0) rows.push(hoverBandAt(line, rowWidth, hoverStrength));
						else rows.push(truncateToWidth(line, rowWidth));
					}
					return rows;
				},
			),
		);
		return lines;
	}
}

export class HistorySearchComponent implements Component {
	#historyStorage: HistoryStorage;
	#searchInput: Input;
	#results: HistoryEntry[] = [];
	#selectedIndex = 0;
	#resultsList: HistoryResultsList;
	#onSelect: (prompt: string) => void;
	#onCancel: () => void;
	#resultLimit = 100;
	#shellGeometry: ModalShellGeometry | null = null;
	#listRowStart = 0;
	#hoveredShortcutId: string | null = null;
	#onRequestRender?: () => void;

	constructor(historyStorage: HistoryStorage, onSelect: (prompt: string) => void, onCancel: () => void) {
		this.#historyStorage = historyStorage;
		this.#onSelect = onSelect;
		this.#onCancel = onCancel;

		this.#searchInput = new Input();
		this.#searchInput.onSubmit = () => {
			const selected = this.#results[this.#selectedIndex];
			if (selected) {
				this.#onSelect(selected.prompt);
			}
		};
		this.#searchInput.onEscape = () => {
			this.#onCancel();
		};

		this.#resultsList = new HistoryResultsList();
		this.#updateResults();
	}

	setOnRequestRender(cb: () => void): void {
		this.#onRequestRender = cb;
		this.#resultsList.setHoverMotion({ requestRender: cb, enabled: pointerMotionEnabled() });
	}

	dispose(): void {
		this.#resultsList.disposeHoverMotion();
	}

	invalidate(): void {
		this.#resultsList.invalidate();
	}

	handleInput(keyData: string): void {
		if (keyData.startsWith("\x1b[<")) {
			routeSgrMouseInput(keyData, event => this.#routeMouse(event));
			return;
		}

		if (matchesSelectUp(keyData)) {
			if (this.#results.length === 0) return;
			this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
			this.#resultsList.setSelectedIndex(this.#selectedIndex);
			return;
		}

		if (matchesSelectDown(keyData)) {
			if (this.#results.length === 0) return;
			this.#selectedIndex = Math.min(this.#results.length - 1, this.#selectedIndex + 1);
			this.#resultsList.setSelectedIndex(this.#selectedIndex);
			return;
		}

		if (matchesSelectPageUp(keyData)) {
			if (this.#results.length === 0) return;
			this.#selectedIndex = Math.max(0, this.#selectedIndex - MAX_VISIBLE);
			this.#resultsList.setSelectedIndex(this.#selectedIndex);
			return;
		}

		if (matchesSelectPageDown(keyData)) {
			if (this.#results.length === 0) return;
			this.#selectedIndex = Math.min(this.#results.length - 1, this.#selectedIndex + MAX_VISIBLE);
			this.#resultsList.setSelectedIndex(this.#selectedIndex);
			return;
		}

		if (matchesKey(keyData, "home")) {
			if (this.#results.length === 0) return;
			this.#selectedIndex = 0;
			this.#resultsList.setSelectedIndex(this.#selectedIndex);
			return;
		}

		if (matchesKey(keyData, "end")) {
			if (this.#results.length === 0) return;
			this.#selectedIndex = this.#results.length - 1;
			this.#resultsList.setSelectedIndex(this.#selectedIndex);
			return;
		}

		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selected = this.#results[this.#selectedIndex];
			if (selected) {
				this.#onSelect(selected.prompt);
			}
			return;
		}

		if (matchesAppInterrupt(keyData)) {
			this.#onCancel();
			return;
		}

		this.#searchInput.handleInput(keyData);
		this.#updateResults();
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
			this.handleInput("\n");
			return true;
		}
		if (event.wheel !== null) {
			if (this.#results.length > 0) {
				this.#selectedIndex = Math.max(0, Math.min(this.#results.length - 1, this.#selectedIndex + event.wheel));
				this.#resultsList.setSelectedIndex(this.#selectedIndex);
				this.#onRequestRender?.();
			}
			return true;
		}
		const line = event.row - this.#listRowStart;
		if (event.motion) {
			const hovered = this.#resultsList.hitTest(line) ?? null;
			if (this.#resultsList.setHoverIndex(hovered)) this.#onRequestRender?.();
			return true;
		}
		if (event.leftClick) {
			const index = this.#resultsList.hitTest(line);
			if (index !== undefined) {
				this.#selectedIndex = index;
				this.#resultsList.setSelectedIndex(index);
				this.handleInput("\n");
			}
			return true;
		}
		return true;
	}

	#updateResults(): void {
		const query = this.#searchInput.getValue().trim();
		this.#results = query
			? this.#historyStorage.search(query, this.#resultLimit)
			: this.#historyStorage.getRecent(this.#resultLimit);
		this.#selectedIndex = 0;
		this.#resultsList.setResults(this.#results, this.#selectedIndex, query ? queryTokens(query) : []);
	}

	render(width: number): readonly string[] {
		const height = process.stdout.rows || 40;
		const sizing = sizingForArea(MODAL_SIZING_MEDIUM, height);
		const dims = computeModalDims(width, height, sizing);
		if (!dims) {
			this.#shellGeometry = null;
			return new Array(height).fill(padding(width));
		}

		const searchLine = this.#searchInput.render(dims.contentWidth)[0] ?? "";
		const body = this.#resultsList.render(dims.contentWidth).slice();

		const shell = renderModalShell({
			title: "Search History",
			sizing,
			areaWidth: width,
			areaHeight: height,
			body,
			searchLine,
			shortcuts: SELECT_LIST_SHORTCUTS,
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});
		this.#shellGeometry = shell.geometry;
		this.#listRowStart = shell.geometry?.bodyRowStart ?? 0;
		return shell.lines;
	}
}
