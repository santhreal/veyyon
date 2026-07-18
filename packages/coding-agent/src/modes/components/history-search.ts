import {
	type Component,
	Ellipsis,
	Input,
	matchesKey,
	padding,
	routeSgrMouseInput,
	type SgrMouseEvent,
	truncateToWidth,
	visibleWidth,
} from "@veyyon/tui";
import type { HistoryEntry, HistoryStorage } from "../../session/history-storage";
import { theme } from "../theme/theme";
import {
	matchesAppInterrupt,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../utils/keybinding-matchers";
import {
	computeModalDims,
	hitTestModalChrome,
	MODAL_SIZING_MEDIUM,
	type ModalShellGeometry,
	renderModalShell,
	SELECT_LIST_SHORTCUTS,
	withCompact,
} from "./modal-shell";
import { centeredWindow, contentRowWidth, renderScrollableList } from "./selector-helpers";

/** Visible result rows; also the jump distance for PageUp/PageDown. */
const MAX_VISIBLE = 10;

/** Split a query the same way `HistoryStorage` tokenizes it, so highlights align with matches. */
function queryTokens(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(tok => tok.length > 0);
}

/** Wrap every case-insensitive occurrence of any token in `text` with the accent color. */
function highlightTokens(text: string, tokens: string[]): string {
	if (tokens.length === 0) return text;

	const lower = text.toLowerCase();
	const ranges: Array<[number, number]> = [];
	for (const tok of tokens) {
		let from = lower.indexOf(tok);
		while (from !== -1) {
			ranges.push([from, from + tok.length]);
			from = lower.indexOf(tok, from + tok.length);
		}
	}
	if (ranges.length === 0) return text;

	ranges.sort((a, b) => a[0] - b[0]);
	let out = "";
	let pos = 0;
	for (const [start, end] of ranges) {
		if (end <= pos) continue; // fully covered by a previous (merged) range
		const from = Math.max(start, pos);
		if (from > pos) out += text.slice(pos, from);
		out += theme.fg("accent", text.slice(from, end));
		pos = end;
	}
	if (pos < text.length) out += text.slice(pos);
	return out;
}

/** Compact "time since" label (e.g. `now`, `5m`, `2h`, `3d`, `2w`, `6mo`, `1y`) from epoch seconds. */
function relativeTime(epochSeconds: number): string {
	const seconds = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
	if (seconds < 60) return "now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;
	if (days < 30) return `${Math.floor(days / 7)}w`;
	if (days < 365) return `${Math.floor(days / 30)}mo`;
	return `${Math.floor(days / 365)}y`;
}

class HistoryResultsList implements Component {
	#results: HistoryEntry[] = [];
	#tokens: string[] = [];
	#selectedIndex = 0;
	#maxVisible = MAX_VISIBLE;

	setResults(results: HistoryEntry[], selectedIndex: number, tokens: string[]): void {
		this.#results = results;
		this.#selectedIndex = selectedIndex;
		this.#tokens = tokens;
	}

	setSelectedIndex(selectedIndex: number): void {
		this.#selectedIndex = selectedIndex;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): readonly string[] {
		const lines: string[] = [];

		if (this.#results.length === 0) {
			const message = this.#tokens.length > 0 ? "No matching history" : "No history yet";
			lines.push(theme.fg("muted", `  ${theme.status.info} ${message}`));
			return lines;
		}

		const cursorSymbol = `${theme.nav.cursor} `;
		const gutterWidth = visibleWidth(cursorSymbol);

		const { startIndex, endIndex } = centeredWindow(this.#selectedIndex, this.#results.length, this.#maxVisible);

		const rowWidth = contentRowWidth(width, this.#results.length, this.#maxVisible);
		const rows: string[] = [];

		for (let i = startIndex; i < endIndex; i++) {
			const entry = this.#results[i];
			const isSelected = i === this.#selectedIndex;

			const timeStr = relativeTime(entry.created_at);
			const timeWidth = visibleWidth(timeStr);
			const showTime = rowWidth >= gutterWidth + 12 + timeWidth;

			const promptBudget = Math.max(4, rowWidth - gutterWidth - (showTime ? timeWidth + 1 : 0));
			const normalized = entry.prompt.replace(/\s+/g, " ").trim();
			const plain = truncateToWidth(normalized, promptBudget);
			const highlighted = highlightTokens(plain, this.#tokens);

			const cursor = isSelected ? theme.fg("accent", cursorSymbol) : padding(gutterWidth);
			let line = cursor + (isSelected ? theme.bold(highlighted) : highlighted);

			if (showTime) {
				// Pad the prompt region so the timestamp sits flush right with a one-cell gap.
				line = `${truncateToWidth(line, rowWidth - timeWidth - 1, Ellipsis.Unicode, true)} ${theme.fg("dim", timeStr)}`;
			}

			rows.push(
				isSelected
					? theme.bg("selectedBg", truncateToWidth(line, rowWidth, Ellipsis.Omit, true))
					: truncateToWidth(line, rowWidth),
			);
		}

		lines.push(...renderScrollableList(rows, { width, totalRows: this.#results.length, scrollOffset: startIndex }));
		return lines;
	}
}

/** `/history` search — floating ModalShell card with a live search row and result list. */
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
			this.handleInput("\n");
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
		const sizing = withCompact(MODAL_SIZING_MEDIUM, height < 24);
		const dims = computeModalDims(width, height, sizing);
		if (!dims) {
			this.#shellGeometry = null;
			return Array.from({ length: height }, () => padding(width));
		}

		const searchLine = this.#searchInput.render(dims.contentWidth)[0] ?? "";
		const body = [...this.#resultsList.render(dims.contentWidth)];

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
		return shell.lines;
	}
}
