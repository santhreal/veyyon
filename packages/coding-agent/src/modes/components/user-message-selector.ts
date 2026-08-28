import {
	type Component,
	extractPrintableText,
	fuzzyFilter,
	HoverFade,
	type HoverFadeOptions,
	matchesKey,
	padding,
	routeSgrMouseInput,
	ScrollView,
	type SgrMouseEvent,
	truncateToWidth,
} from "@veyyon/tui";
import { theme } from "../../modes/theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../../modes/utils/keybinding-matchers";
import {
	computeModalDims,
	consumeModalChipHover,
	hitTestModalChrome,
	MODAL_SIZING_MEDIUM,
	type ModalShellGeometry,
	type ModalShortcut,
	pointerMotionEnabled,
	renderModalShell,
	sizingForArea,
} from "./modal-shell";
import { hoverBandAt, SCROLL_LIST_THEME } from "./selector-helpers";

interface UserMessageItem {
	id: string; // Entry ID in the session
	text: string; // The message text
	timestamp?: string; // Optional timestamp if available
}

const USER_MESSAGE_SHORTCUTS: readonly ModalShortcut[] = [
	{ label: "up/down navigate" },
	{ label: "enter select", clickable: true, id: "confirm" },
	{ label: "esc close", clickable: true, id: "close" },
];

class UserMessageList implements Component {
	#filteredMessages: UserMessageItem[];
	#searchQuery = "";
	#selectedIndex: number = 0;
	onSelect?: (entryId: string) => void;
	onCancel?: () => void;
	#maxVisible: number = 10; // Max messages visible
	#hoveredIndex: number | null = null;
	#hoverFade?: HoverFade;
	#hitRows: (number | undefined)[] = [];

	constructor(private readonly messages: UserMessageItem[]) {
		this.#filteredMessages = messages;
		this.#selectedIndex = Math.max(0, this.#filteredMessages.length - 1);
	}

	invalidate(): void {}

	#isSearchEnabled(): boolean {
		return this.messages.length > this.#maxVisible;
	}

	#shouldRenderSearchStatus(): boolean {
		return this.#isSearchEnabled() || this.#searchQuery.length > 0;
	}

	#renderStatusLine(_total: number): string {
		const query = this.#searchQuery.trim();
		const suffix = query ? `Search: ${this.#searchQuery}` : "Type to search";
		return theme.fg("muted", `  ${suffix}`);
	}

	#setSearchQuery(query: string): void {
		this.#searchQuery = query;
		this.#filteredMessages = query.trim()
			? fuzzyFilter(this.messages, query, message => `${message.text} ${message.timestamp ?? ""}`)
			: this.messages;
		this.#selectedIndex = query.trim() ? 0 : Math.max(0, this.#filteredMessages.length - 1);
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

	#hoverStrength(index: number): number {
		if (this.#hoverFade !== undefined) return this.#hoverFade.strengthAt(index);
		return index === this.#hoveredIndex ? 1 : 0;
	}

	handleWheel(delta: -1 | 1): void {
		if (this.#filteredMessages.length === 0) return;
		const total = this.#filteredMessages.length;
		this.#selectedIndex =
			delta < 0
				? this.#selectedIndex === 0
					? total - 1
					: this.#selectedIndex - 1
				: this.#selectedIndex === total - 1
					? 0
					: this.#selectedIndex + 1;
	}

	clickItem(index: number): void {
		const message = this.#filteredMessages[index];
		if (!message) return;
		this.#selectedIndex = index;
		this.onSelect?.(message.id);
	}

	#handleSearchInput(keyData: string): boolean {
		if (!this.#isSearchEnabled()) return false;

		if (matchesKey(keyData, "backspace")) {
			if (this.#searchQuery.length === 0) return false;
			const chars = [...this.#searchQuery];
			chars.pop();
			this.#setSearchQuery(chars.join(""));
			return true;
		}

		const printableText = extractPrintableText(keyData);
		if (printableText === undefined) return false;
		if (this.#searchQuery.length === 0 && printableText.trim().length === 0) return false;

		this.#setSearchQuery(this.#searchQuery + printableText);
		return true;
	}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		this.#hitRows = [];

		if (this.messages.length === 0) {
			lines.push(theme.fg("muted", "  No user messages found"));
			return lines;
		}

		const total = this.#filteredMessages.length;

		const startIndex = Math.max(
			0,
			Math.min(this.#selectedIndex - Math.floor(this.#maxVisible / 2), total - this.#maxVisible),
		);
		const endIndex = Math.min(startIndex + this.#maxVisible, total);

		const overflow = total > this.#maxVisible;
		const rowWidth = Math.max(0, width - (overflow ? 1 : 0));
		const messageLines: string[] = [];
		for (let i = startIndex; i < endIndex; i++) {
			const message = this.#filteredMessages[i];
			if (!message) continue;
			const isSelected = i === this.#selectedIndex;
			const hoverStrength = this.#hoverStrength(i);

			const normalizedMessage = message.text.replace(/\n/g, " ").trim();

			const cursor = isSelected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const maxMsgWidth = rowWidth - 2; // Account for cursor (2 chars)
			const truncatedMsg = truncateToWidth(normalizedMessage, maxMsgWidth);
			const messageLine = cursor + (isSelected ? theme.bold(truncatedMsg) : truncatedMsg);

			this.#hitRows[messageLines.length] = i;
			messageLines.push(hoverStrength > 0 ? hoverBandAt(messageLine, rowWidth, hoverStrength) : messageLine);

			const position = this.messages.indexOf(message) + 1;
			const metadata = `  Message ${position} of ${this.messages.length}`;
			const metadataLine = theme.fg("muted", metadata);
			this.#hitRows[messageLines.length] = i;
			messageLines.push(hoverStrength > 0 ? hoverBandAt(metadataLine, rowWidth, hoverStrength) : metadataLine);
			messageLines.push(""); // Blank line between messages
		}

		if (total === 0) {
			lines.push(theme.fg("muted", "  No matching messages"));
		} else {
			const visibleCount = endIndex - startIndex;
			const linesPerItem = visibleCount > 0 ? messageLines.length / visibleCount : 1;
			const sv = new ScrollView(messageLines, {
				height: messageLines.length,
				scrollbar: "auto",
				totalRows: Math.round(total * linesPerItem),
				theme: SCROLL_LIST_THEME,
			});
			sv.setScrollOffset(Math.round(startIndex * linesPerItem));
			const svLines = sv.render(width);
			for (let li = 0; li < svLines.length; li++) lines.push(svLines[li]!);
		}

		if (this.#shouldRenderSearchStatus()) {
			lines.push(this.#renderStatusLine(total));
		}

		return lines;
	}

	handleInput(keyData: string): void {
		if (matchesSelectCancel(keyData)) {
			if (this.onCancel) {
				this.onCancel();
			}
			return;
		}

		if (this.#handleSearchInput(keyData)) {
			return;
		}

		if (matchesSelectUp(keyData)) {
			if (this.#filteredMessages.length > 0) {
				this.#selectedIndex =
					this.#selectedIndex === 0 ? this.#filteredMessages.length - 1 : this.#selectedIndex - 1;
			}
		} else if (matchesSelectDown(keyData)) {
			if (this.#filteredMessages.length > 0) {
				this.#selectedIndex =
					this.#selectedIndex === this.#filteredMessages.length - 1 ? 0 : this.#selectedIndex + 1;
			}
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selected = this.#filteredMessages[this.#selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.id);
			}
		}
	}
}

export class UserMessageSelectorComponent implements Component {
	#messageList: UserMessageList;
	#onCancelCallback: () => void;
	#shellGeometry: ModalShellGeometry | null = null;
	#hoveredShortcutId: string | null = null;
	#listRowStart = 0;
	#onRequestRender?: () => void;

	constructor(messages: UserMessageItem[], onSelect: (entryId: string) => void, onCancel: () => void) {
		this.#onCancelCallback = onCancel;
		this.#messageList = new UserMessageList(messages);
		this.#messageList.onSelect = onSelect;
		this.#messageList.onCancel = onCancel;

		if (messages.length === 0) {
			setTimeout(() => onCancel(), 100);
		}
	}

	setOnRequestRender(cb: () => void): void {
		this.#onRequestRender = cb;
		this.#messageList.setHoverMotion({ requestRender: cb, enabled: pointerMotionEnabled() });
	}

	dispose(): void {
		this.#messageList.disposeHoverMotion();
	}

	invalidate(): void {
		this.#messageList.invalidate();
	}

	getMessageList(): UserMessageList {
		return this.#messageList;
	}

	handleInput(keyData: string): void {
		if (keyData.startsWith("\x1b[<")) {
			routeSgrMouseInput(keyData, event => this.#routeMouse(event));
			return;
		}
		this.#messageList.handleInput(keyData);
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
			this.#onCancelCallback();
			return true;
		}
		if (chrome.kind === "shortcut" && chrome.id === "confirm") {
			this.handleInput("\n");
			return true;
		}
		if (event.wheel !== null) {
			this.#messageList.handleWheel(event.wheel);
			this.#onRequestRender?.();
			return true;
		}
		const line = event.row - this.#listRowStart;
		if (event.motion) {
			if (this.#messageList.setHoverIndex(this.#messageList.hitTest(line) ?? null)) {
				this.#onRequestRender?.();
			}
			return true;
		}
		if (event.leftClick) {
			const index = this.#messageList.hitTest(line);
			if (index !== undefined) this.#messageList.clickItem(index);
			return true;
		}
		return true;
	}

	render(width: number): readonly string[] {
		const height = process.stdout.rows || 40;
		const sizing = sizingForArea(MODAL_SIZING_MEDIUM, height);
		const dims = computeModalDims(width, height, sizing);
		if (!dims) {
			this.#shellGeometry = null;
			return new Array(height).fill(padding(width));
		}

		const body = [
			theme.fg("muted", "Select a message to create a new branch from that point"),
			"",
			...this.#messageList.render(dims.contentWidth),
		];

		const shell = renderModalShell({
			title: "Branch from Message",
			sizing,
			areaWidth: width,
			areaHeight: height,
			body,
			shortcuts: USER_MESSAGE_SHORTCUTS,
			hoveredShortcutId: this.#hoveredShortcutId,
			showClose: true,
		});
		this.#shellGeometry = shell.geometry;
		this.#listRowStart = (shell.geometry?.bodyRowStart ?? 0) + 2;
		return shell.lines;
	}
}
