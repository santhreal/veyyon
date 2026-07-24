import {
	type Component,
	extractPrintableText,
	fuzzyFilter,
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
	applyModalReveal,
	hitTestModalChrome,
	MODAL_SIZING_MEDIUM,
	ModalRevealDriver,
	type ModalShellGeometry,
	type ModalShortcut,
	renderModalShell,
	withCompact,
} from "./modal-shell";

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

/**
 * Custom user message list component with selection
 */
class UserMessageList implements Component {
	#filteredMessages: UserMessageItem[];
	#searchQuery = "";
	#selectedIndex: number = 0;
	onSelect?: (entryId: string) => void;
	onCancel?: () => void;
	#maxVisible: number = 10; // Max messages visible

	constructor(private readonly messages: UserMessageItem[]) {
		// Store messages in chronological order (oldest to newest)
		this.#filteredMessages = messages;
		// Start with the last (most recent) message selected
		this.#selectedIndex = Math.max(0, this.#filteredMessages.length - 1);
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

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

		if (this.messages.length === 0) {
			lines.push(theme.fg("muted", "  No user messages found"));
			return lines;
		}

		const total = this.#filteredMessages.length;

		// Calculate visible range with scrolling
		const startIndex = Math.max(
			0,
			Math.min(this.#selectedIndex - Math.floor(this.#maxVisible / 2), total - this.#maxVisible),
		);
		const endIndex = Math.min(startIndex + this.#maxVisible, total);

		// Render visible messages (2 lines per message + blank line)
		const overflow = total > this.#maxVisible;
		const rowWidth = Math.max(0, width - (overflow ? 1 : 0));
		const messageLines: string[] = [];
		for (let i = startIndex; i < endIndex; i++) {
			const message = this.#filteredMessages[i];
			if (!message) continue;
			const isSelected = i === this.#selectedIndex;

			// Normalize message to single line
			const normalizedMessage = message.text.replace(/\n/g, " ").trim();

			// First line: cursor + message
			const cursor = isSelected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const maxMsgWidth = rowWidth - 2; // Account for cursor (2 chars)
			const truncatedMsg = truncateToWidth(normalizedMessage, maxMsgWidth);
			const messageLine = cursor + (isSelected ? theme.bold(truncatedMsg) : truncatedMsg);

			messageLines.push(messageLine);

			// Second line: metadata (position in history)
			const position = this.messages.indexOf(message) + 1;
			const metadata = `  Message ${position} of ${this.messages.length}`;
			const metadataLine = theme.fg("muted", metadata);
			messageLines.push(metadataLine);
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
				theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
			});
			sv.setScrollOffset(Math.round(startIndex * linesPerItem));
			lines.push(...sv.render(width));
		}

		// Add search indicator if needed
		if (this.#shouldRenderSearchStatus()) {
			lines.push(this.#renderStatusLine(total));
		}

		return lines;
	}

	handleInput(keyData: string): void {
		// Escape / cancel
		if (matchesSelectCancel(keyData)) {
			if (this.onCancel) {
				this.onCancel();
			}
			return;
		}

		if (this.#handleSearchInput(keyData)) {
			return;
		}

		// Up arrow - go to previous (older) message, wrap to bottom when at top
		if (matchesSelectUp(keyData)) {
			if (this.#filteredMessages.length > 0) {
				this.#selectedIndex =
					this.#selectedIndex === 0 ? this.#filteredMessages.length - 1 : this.#selectedIndex - 1;
			}
		}
		// Down arrow - go to next (newer) message, wrap to top when at bottom
		else if (matchesSelectDown(keyData)) {
			if (this.#filteredMessages.length > 0) {
				this.#selectedIndex =
					this.#selectedIndex === this.#filteredMessages.length - 1 ? 0 : this.#selectedIndex + 1;
			}
		}
		// Enter - select message and branch
		else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selected = this.#filteredMessages[this.#selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.id);
			}
		}
	}
}

/**
 * `/branch` picker: pick a prior user message to branch from, inside a
 * floating ModalShell medium card.
 */
export class UserMessageSelectorComponent implements Component {
	#messageList: UserMessageList;
	#onCancelCallback: () => void;
	#shellGeometry: ModalShellGeometry | null = null;
	#hoveredShortcutId: string | null = null;
	#onRequestRender?: () => void;
	#reveal = new ModalRevealDriver();

	constructor(
		messages: UserMessageItem[],
		onSelect: (entryId: string) => void,
		onCancel: () => void,
		/** Play the open unfold (TOUCH-5). Show site decides via modalRevealEnabled(). */
		reveal?: boolean,
	) {
		if (reveal) {
			this.#reveal.start(() => this.#onRequestRender?.());
		}
		this.#onCancelCallback = onCancel;
		this.#messageList = new UserMessageList(messages);
		this.#messageList.onSelect = onSelect;
		this.#messageList.onCancel = onCancel;

		// Auto-cancel if no messages
		if (messages.length === 0) {
			setTimeout(() => onCancel(), 100);
		}
	}

	setOnRequestRender(cb: () => void): void {
		this.#onRequestRender = cb;
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
			this.#onCancelCallback();
			return true;
		}
		if (chrome.kind === "shortcut" && chrome.id === "confirm") {
			this.handleInput("\n");
			return true;
		}
		return true;
	}

	render(width: number): readonly string[] {
		const height = process.stdout.rows || 40;
		const sizing = withCompact(MODAL_SIZING_MEDIUM, height < 24);
		const dims = computeModalDims(width, height, sizing);
		if (!dims) {
			this.#shellGeometry = null;
			return Array.from({ length: height }, () => padding(width));
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
		return applyModalReveal(shell, width, this.#reveal.value);
	}
}
