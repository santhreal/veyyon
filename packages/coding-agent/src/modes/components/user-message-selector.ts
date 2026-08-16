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
	applyModalReveal,
	beginModalExit,
	computeModalDims,
	consumeModalChipHover,
	hitTestModalChrome,
	MODAL_SIZING_MEDIUM,
	ModalRevealDriver,
	type ModalShellGeometry,
	type ModalShortcut,
	modalRevealEnabled,
	renderModalShell,
	sizingForArea,
} from "./modal-shell";
import { hoverBandAt } from "./selector-helpers";

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
	/** Pointer-highlighted message (never the selected one; selection owns its rows). */
	#hoveredIndex: number | null = null;
	/**
	 * The cross-fade, once the card has lent this list a repaint
	 * ({@link setHoverMotion}). Absent, the band is switched.
	 */
	#hoverFade?: HoverFade;
	/** Per-render map of 0-based rendered line → filtered-message index. */
	#hitRows: (number | undefined)[] = [];

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

	/** Resolve a rendered line (0-based within this list) to a message index. */
	hitTest(line: number): number | undefined {
		return this.#hitRows[line];
	}

	/** Highlight the message under the pointer (null clears). Returns true on change. */
	setHoverIndex(index: number | null): boolean {
		if (this.#hoveredIndex === index) return false;
		this.#hoveredIndex = index;
		this.#hoverFade?.set(index);
		return true;
	}

	/**
	 * Fade the pointer band instead of switching it. The frames between two mouse
	 * reports have no input to hang off, so the card lends its repaint.
	 * `enabled: false` is the switched band.
	 */
	setHoverMotion(options: HoverFadeOptions): void {
		this.#hoverFade?.dispose();
		this.#hoverFade = new HoverFade(options);
		if (this.#hoveredIndex !== null) this.#hoverFade.set(this.#hoveredIndex);
	}

	/** Drop the fade and forget the pointer, so no timer outlives the card. */
	disposeHoverMotion(): void {
		this.#hoverFade?.dispose();
		this.#hoverFade = undefined;
		this.#hoveredIndex = null;
	}

	/** Band strength for a message: 0 for the selected one, which owns its own styling. */
	#hoverStrength(index: number, isSelected: boolean): number {
		if (isSelected) return 0;
		if (this.#hoverFade !== undefined) return this.#hoverFade.strengthAt(index);
		return index === this.#hoveredIndex ? 1 : 0;
	}

	/** Move the selection one step for a wheel notch (wraps like the arrow keys). */
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

	/** Select the message under the pointer and confirm it, like Enter. */
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
			const hoverStrength = this.#hoverStrength(i, isSelected);

			// Normalize message to single line
			const normalizedMessage = message.text.replace(/\n/g, " ").trim();

			// First line: cursor + message
			const cursor = isSelected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const maxMsgWidth = rowWidth - 2; // Account for cursor (2 chars)
			const truncatedMsg = truncateToWidth(normalizedMessage, maxMsgWidth);
			const messageLine = cursor + (isSelected ? theme.bold(truncatedMsg) : truncatedMsg);

			this.#hitRows[messageLines.length] = i;
			messageLines.push(hoverStrength > 0 ? hoverBandAt(messageLine, rowWidth, hoverStrength) : messageLine);

			// Second line: metadata (position in history)
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
	/** Frame row where the message list begins (shell body start + hint + blank). */
	#listRowStart = 0;
	#onRequestRender?: () => void;
	#reveal = new ModalRevealDriver();
	/**
	 * Fade out on the shared clock before the host drops this card. The overlay stack keeps painting
	 * it and stops routing input to it the moment this is called.
	 */
	beginOverlayExit(requestRender: () => void, done: () => void): boolean {
		return beginModalExit(this.#reveal, requestRender, done);
	}

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
		// The pointer band fades only once the card has a repaint to lend it: the
		// frames between two mouse reports have no input to hang off. Same ambient
		// gate as the open unfold; without it the band is switched.
		this.#messageList.setHoverMotion({ requestRender: cb, enabled: modalRevealEnabled() });
	}

	/** Settle the reveal and the pointer band so no timer outlives a dismissed card. */
	dispose(): void {
		this.#reveal.stop();
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
		// The body leads with a hint line and a blank before the list's own rows.
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
		// The body leads with a hint line and a blank before the list's own rows.
		this.#listRowStart = (shell.geometry?.bodyRowStart ?? 0) + 2;
		return applyModalReveal(shell, width, this.#reveal.value);
	}
}
