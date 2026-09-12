import { type Component, ScrollView } from "@veyyon/tui";
import { HoverController } from "@veyyon/tui/utils/hover-controller";
import { fuzzyFilter } from "@veyyon/utils/fuzzy";
import type { HoverFadeOptions } from "@veyyon/utils/motion";
import { routeSgrMouseInput, type SgrMouseEvent } from "@veyyon/utils/mouse";
import { padding } from "@veyyon/utils/padding";
import { truncateToWidth } from "@veyyon/utils/width";
import { theme } from "../../../../theme/theme";
import { matchesSelectCancel } from "../../utils/keybinding-matchers";
import {
	computeModalDims,
	MODAL_SIZING_MEDIUM,
	type ModalShellGeometry,
	type ModalShortcut,
	pointerMotionEnabled,
	renderModalShell,
	sizingForArea,
} from "../chrome/modal-shell";
import { handleListNavigationKey, routeModalCardMouse } from "./select-list-mouse-routing";
import { applySearchInput, hoverBandAt } from "./selector-helpers";

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
	#hover = new HoverController<number>();
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

	/**
	 * Band the message under the pointer (null clears). Returns true on change.
	 *
	 * The band paints on every row, the cursor row included: the pointer does not move the cursor, so
	 * suppressing it there left a row nothing could point at.
	 */
	setHoverIndex(index: number | null): boolean {
		if (this.#hover.key === index) return false;
		this.#hover.set(index);
		return true;
	}

	/**
	 * Fade the pointer band instead of switching it. The frames between two mouse
	 * reports have no input to hang off, so the card lends its repaint.
	 * `enabled: false` is the switched band.
	 */
	setHoverMotion(options: HoverFadeOptions): void {
		this.#hover.setMotion(options);
	}

	/** Drop the fade and forget the pointer, so no timer outlives the card. */
	disposeHoverMotion(): void {
		this.#hover.dispose();
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
		const query = applySearchInput(keyData, this.#searchQuery);
		if (query === undefined) return false;
		this.#setSearchQuery(query);
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
			const hoverStrength = this.#hover.strength(i);

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

		handleListNavigationKey(keyData, {
			selectedIndex: this.#selectedIndex,
			totalItems: this.#filteredMessages.length,
			onMove: next => {
				this.#selectedIndex = next;
			},
			onSelect: () => {
				const selected = this.#filteredMessages[this.#selectedIndex];
				if (selected && this.onSelect) {
					this.onSelect(selected.id);
				}
			},
		});
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

	constructor(messages: UserMessageItem[], onSelect: (entryId: string) => void, onCancel: () => void) {
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
		this.#messageList.setHoverMotion({ requestRender: cb, enabled: pointerMotionEnabled() });
	}

	/** Settle the pointer band so no timer outlives a dismissed card. */
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
		return routeModalCardMouse({
			shellGeometry: this.#shellGeometry,
			event,
			hoveredShortcutId: this.#hoveredShortcutId,
			onHoverShortcut: id => {
				this.#hoveredShortcutId = id;
				this.#onRequestRender?.();
			},
			onCancel: () => this.#onCancelCallback(),
			onConfirm: () => this.handleInput("\n"),
			onWheel: delta => {
				this.#messageList.handleWheel(delta);
				this.#onRequestRender?.();
			},
			listRowStart: this.#listRowStart,
			onHoverRow: () => {
				const line = event.row - this.#listRowStart;
				if (this.#messageList.setHoverIndex(this.#messageList.hitTest(line) ?? null)) {
					this.#onRequestRender?.();
				}
			},
			onClickRow: () => {
				const line = event.row - this.#listRowStart;
				const index = this.#messageList.hitTest(line);
				if (index !== undefined) this.#messageList.clickItem(index);
			},
		});
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
		return shell.lines;
	}
}
