/**
 * `TerminalPresentationDriver`: the terminal's implementation of
 * `PresentationContext`.
 *
 * This is the only module in the terminal renderer that sees a view-model and a
 * TUI at the same time. It owns three zones — the transcript, the status line
 * and the composer — and it holds one component per transcript block so an
 * update patches its own rows instead of rebuilding the frame. The engine's
 * stable-prefix reuse depends on an unchanged component returning the same array
 * reference, which is why `RowsComponent` caches per width.
 *
 * It knows nothing about the agent: no session, no message, no tool. Everything
 * it draws arrived as a `@veyyon/wire/presentation` value, and everything the
 * operator does leaves as a `UIEvent`.
 */

import { type Component, Container, type OverlayOptions, TUI } from "@veyyon/tui";
import type { Terminal } from "@veyyon/tui/terminal";
import { matchesKey, parseKey } from "@veyyon/utils/keys";
import { truncateToWidth } from "@veyyon/utils/width";
import type {
	BlockId,
	ComposerState,
	DialogResult,
	DialogViewModel,
	OverlayHandle,
	OverlayViewModel,
	PresentationCapabilities,
	PresentationContext,
	PresentationTheme,
	StatusLineState,
	TranscriptBlock,
	UIEvent,
	OverlayAnchor as WireOverlayAnchor,
} from "@veyyon/wire/presentation";
import { blockRows } from "./block-rows";
import { composerRows, dialogRows, statusRow } from "./chrome-rows";

/**
 * A component whose rows are a function of a value and the frame width.
 *
 * The cache is not an optimization detail: per the `Component` render contract,
 * returning the same array reference is the engine's proof that the rows are
 * byte-identical, and that proof is what keeps a scrolled-back transcript from
 * repainting every frame.
 */
class RowsComponent<T> implements Component {
	#value: T;
	#build: (value: T, width: number) => string[];
	#cachedWidth = -1;
	#cachedRows: string[] = [];

	constructor(value: T, build: (value: T, width: number) => string[]) {
		this.#value = value;
		this.#build = build;
	}

	get value(): T {
		return this.#value;
	}

	set(value: T): void {
		this.#value = value;
		this.#cachedWidth = -1;
	}

	invalidate(): void {
		this.#cachedWidth = -1;
	}

	render(width: number): readonly string[] {
		if (width === this.#cachedWidth) return this.#cachedRows;
		this.#cachedRows = this.#build(this.#value, width);
		this.#cachedWidth = width;
		return this.#cachedRows;
	}
}

/** A dialog rendered as an overlay, resolving once the operator answers. */
class DialogComponent implements Component {
	#dialog: DialogViewModel;
	#theme: PresentationTheme;
	#answer: (result: DialogResult) => void;
	#selectedIndex: number;
	#entered: string;
	#cachedWidth = -1;
	#cachedRows: string[] = [];

	constructor(dialog: DialogViewModel, theme: PresentationTheme, answer: (result: DialogResult) => void) {
		this.#dialog = dialog;
		this.#theme = theme;
		this.#answer = answer;
		this.#selectedIndex = dialog.kind === "select" ? dialog.selectedIndex : 0;
		this.#entered = dialog.kind === "prompt" ? dialog.initialValue : "";
	}

	get dialog(): DialogViewModel {
		return this.#dialog;
	}

	invalidate(): void {
		this.#cachedWidth = -1;
	}

	render(width: number): readonly string[] {
		if (width === this.#cachedWidth) return this.#cachedRows;
		this.#cachedRows = dialogRows(this.#dialog, width, this.#theme, {
			selectedIndex: this.#selectedIndex,
			entered: this.#entered,
		});
		this.#cachedWidth = width;
		return this.#cachedRows;
	}

	handleInput(data: string): void {
		const dialog = this.#dialog;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.#answer({ outcome: "cancelled" });
			return;
		}
		switch (dialog.kind) {
			case "confirm": {
				if (matchesKey(data, "enter") || matchesKey(data, "y")) {
					this.#answer({ outcome: "confirmed" });
				} else if (matchesKey(data, "n")) {
					this.#answer({ outcome: "cancelled" });
				}
				return;
			}
			case "tool-approval": {
				// An approval is never the default: only an explicit yes approves, and
				// every other answer refuses.
				if (matchesKey(data, "y") || matchesKey(data, "enter")) {
					// A remembered answer is a separate gesture the session asks for; a
					// bare yes approves this call only.
					this.#answer({ outcome: "approved", remember: false });
				} else if (matchesKey(data, "n")) {
					this.#answer({ outcome: "rejected" });
				}
				return;
			}
			case "select": {
				const last = dialog.options.length - 1;
				if (matchesKey(data, "up")) {
					this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
					this.#cachedWidth = -1;
				} else if (matchesKey(data, "down")) {
					this.#selectedIndex = Math.min(last, this.#selectedIndex + 1);
					this.#cachedWidth = -1;
				} else if (matchesKey(data, "enter") && this.#selectedIndex >= 0) {
					const option = dialog.options[this.#selectedIndex];
					if (option !== undefined) {
						this.#answer({ outcome: "selected", values: [option.value] });
					}
				}
				return;
			}
			case "prompt": {
				if (matchesKey(data, "enter")) {
					this.#answer({ outcome: "entered", value: this.#entered });
					return;
				}
				if (matchesKey(data, "backspace")) {
					this.#entered = this.#entered.slice(0, -1);
					this.#cachedWidth = -1;
					return;
				}
				const key = parseKey(data);
				if (key !== undefined && key.length === 1) {
					this.#entered += key;
					this.#cachedWidth = -1;
				}
				return;
			}
		}
	}
}

/** Empty state, so the driver never renders from an absent theme or status. */
const NO_BLOCKS: readonly TranscriptBlock[] = [];

export interface TerminalDriverOptions {
	/** Theme to start with. A session pushes its own through `setTheme`. */
	theme: PresentationTheme;
	/** Draw the hardware cursor. Off in a test, on in a session with a composer. */
	showHardwareCursor?: boolean;
}

/** Rows a page-scroll gesture moves, as a fraction of the viewport. */
const PAGE_FRACTION = 0.8;

export class TerminalPresentationDriver implements PresentationContext {
	#terminal: Terminal;
	#tui: TUI;
	#theme: PresentationTheme;

	#transcript = new Container();
	/** One component per block, by id, so an update patches rows rather than rebuilding the frame. */
	#blocks = new Map<BlockId, RowsComponent<TranscriptBlock>>();
	#status: RowsComponent<StatusLineState | undefined>;
	#composer: RowsComponent<ComposerState | undefined>;

	#handlers = new Set<(event: UIEvent) => void>();
	#detachInput: (() => void) | undefined;
	#overlays = new Map<string, { component: Component; hide: () => void }>();
	#running = false;
	#lastWidth: number;
	#lastHeight: number;

	constructor(terminal: Terminal, options: TerminalDriverOptions) {
		this.#terminal = terminal;
		this.#theme = options.theme;
		this.#lastWidth = terminal.columns;
		this.#lastHeight = terminal.rows;
		this.#tui = new TUI(terminal, options.showHardwareCursor ?? false);
		this.#status = new RowsComponent<StatusLineState | undefined>(undefined, (state, width) =>
			state === undefined ? [] : [statusRow(state, width, this.#theme)],
		);
		this.#composer = new RowsComponent<ComposerState | undefined>(undefined, (state, width) =>
			state === undefined ? [] : composerRows(state, width, this.#theme),
		);
		this.#tui.addChild(this.#transcript);
		this.#tui.addChild(this.#status);
		this.#tui.addChild(this.#composer);
		// The status line and the composer are the live footer: scroll isolation
		// keeps them pinned while the transcript above them scrolls.
		this.#tui.setPinnedFooterChildCount(2);
	}

	/** The engine, for a host that also drives its own components. */
	get tui(): TUI {
		return this.#tui;
	}

	start(): void {
		if (this.#running) return;
		this.#running = true;
		this.#detachInput = this.#tui.addInputListener(data => this.#routeInput(data));
		this.#tui.start();
	}

	stop(): void {
		if (!this.#running) return;
		this.#running = false;
		this.#detachInput?.();
		this.#detachInput = undefined;
		for (const [, overlay] of this.#overlays) overlay.hide();
		this.#overlays.clear();
		this.#tui.stop();
	}

	get running(): boolean {
		return this.#running;
	}

	setTranscriptBlocks(blocks: readonly TranscriptBlock[]): void {
		this.#transcript.disposeChildren();
		this.#blocks.clear();
		for (const block of blocks) this.#append(block);
		this.#tui.requestRender();
	}

	appendTranscriptBlock(block: TranscriptBlock): void {
		this.#append(block);
		this.#tui.requestRender();
	}

	#append(block: TranscriptBlock): void {
		const existing = this.#blocks.get(block.id);
		if (existing !== undefined) {
			// A re-append of a live id is an update: appending a second component
			// would draw the same block twice and leave the first one stale.
			existing.set(block);
			return;
		}
		const component = new RowsComponent<TranscriptBlock>(block, (value, width) =>
			blockRows(value, width, this.#theme),
		);
		this.#blocks.set(block.id, component);
		this.#transcript.addChild(component);
	}

	updateTranscriptBlock(id: BlockId, patch: Partial<TranscriptBlock>): void {
		const component = this.#blocks.get(id);
		// An unknown id is ignored by contract: a session that patches a block the
		// operator's filter dropped must not fail.
		if (component === undefined) return;
		component.set({ ...component.value, ...patch } as TranscriptBlock);
		this.#tui.requestComponentRender(component);
	}

	removeTranscriptBlock(id: BlockId): void {
		const component = this.#blocks.get(id);
		if (component === undefined) return;
		this.#blocks.delete(id);
		this.#transcript.removeChild(component);
		this.#tui.requestRender();
	}

	clearTranscript(): void {
		this.setTranscriptBlocks(NO_BLOCKS);
	}

	setStatusLine(state: StatusLineState): void {
		this.#status.set(state);
		this.#tui.requestComponentRender(this.#status);
	}

	setComposerState(state: ComposerState): void {
		this.#composer.set(state);
		this.#tui.requestComponentRender(this.#composer);
	}

	focusComposer(): void {
		this.#tui.setFocus(this.#composer);
	}

	showDialog(dialog: DialogViewModel): Promise<DialogResult> {
		const { promise, resolve } = Promise.withResolvers<DialogResult>();
		let settled = false;
		const component = new DialogComponent(dialog, this.#theme, result => {
			if (settled) return;
			settled = true;
			handle.hide();
			resolve(result);
		});
		const handle = this.#tui.showOverlay(component, { anchor: "center", width: "80%" });
		return promise;
	}

	showOverlay(overlay: OverlayViewModel): OverlayHandle {
		const component = new RowsComponent<OverlayViewModel>(overlay, (value, width) =>
			value.rows.map(row => truncateToWidth(row, Math.max(1, width))),
		);
		const handle = this.#tui.showOverlay(component, engineOverlayOptions(overlay.anchor));
		this.#overlays.set(overlay.id, { component, hide: handle.hide });
		return {
			id: overlay.id,
			close: () => {
				this.closeOverlay(overlay.id);
			},
			update: (next: OverlayViewModel) => {
				component.set(next);
				this.#tui.requestRender();
			},
		};
	}

	closeOverlay(id: string): void {
		const overlay = this.#overlays.get(id);
		// Unknown ids are ignored by contract; a double close is the ordinary case
		// when a host and an operator dismiss the same card.
		if (overlay === undefined) return;
		this.#overlays.delete(id);
		overlay.hide();
	}

	scrollToLive(): void {
		this.#tui.scrollToLiveTail();
	}

	scrollBy(rows: number): void {
		this.#tui.scrollByRows(rows);
	}

	get scrollPosition(): number {
		return this.#tui.virtualScrollNewRows;
	}

	get scrollable(): boolean {
		return this.#tui.frameScrollable;
	}

	setTheme(theme: PresentationTheme): void {
		this.#theme = theme;
		// Every cached row carries the old palette's escapes, so the whole tree is
		// rebuilt rather than repainted. `Container.invalidate` walks its children,
		// and the driver's three zones are all children of the engine's root.
		this.#tui.invalidate();
		this.#tui.requestRender();
	}

	onInput(handler: (event: UIEvent) => void): () => void {
		this.#handlers.add(handler);
		return () => {
			this.#handlers.delete(handler);
		};
	}

	get width(): number {
		return this.#terminal.columns;
	}

	get height(): number {
		return this.#terminal.rows;
	}

	get capabilities(): PresentationCapabilities {
		return TERMINAL_CAPABILITIES;
	}

	/** Deliver a `UIEvent` to every subscriber. A throwing handler must not stop the rest. */
	emit(event: UIEvent): void {
		for (const handler of [...this.#handlers]) handler(event);
	}

	/**
	 * Translate a keystroke into a `UIEvent`.
	 *
	 * Returning `{ consume: true }` takes the byte away from the component tree,
	 * so only the gestures the driver owns are consumed and everything else — a
	 * printable character, a composer edit — reaches the focused component.
	 */
	#routeInput(data: string): { consume?: boolean } | undefined {
		const size = this.#noticeResize();
		if (size !== undefined) this.emit(size);
		if (matchesKey(data, "ctrl+c")) {
			this.emit({ type: "interrupt" });
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+d")) {
			// Ctrl+D leaves the session with its state kept: the operator asked to
			// stop reading, not to discard the conversation.
			this.emit({ type: "exit", save: true });
			return { consume: true };
		}
		if (matchesKey(data, "pageUp")) {
			this.emit({ type: "scroll", delta: -this.#pageRows() });
			return { consume: true };
		}
		if (matchesKey(data, "pageDown")) {
			this.emit({ type: "scroll", delta: this.#pageRows() });
			return { consume: true };
		}
		if (matchesKey(data, "shift+end")) {
			this.emit({ type: "scroll-to-live" });
			return { consume: true };
		}
		return undefined;
	}

	#pageRows(): number {
		return Math.max(1, Math.trunc(this.#terminal.rows * PAGE_FRACTION));
	}

	/**
	 * A resize is not a keystroke, but the terminal reports one by delivering the
	 * next input after the dimensions changed, so the size is compared on every
	 * byte rather than polled.
	 */
	#noticeResize(): UIEvent | undefined {
		const width = this.#terminal.columns;
		const height = this.#terminal.rows;
		if (width === this.#lastWidth && height === this.#lastHeight) return undefined;
		this.#lastWidth = width;
		this.#lastHeight = height;
		return { type: "resize", width, height };
	}
}

/**
 * What a terminal can do. Images and true colour are probed by
 * `@veyyon/tui`'s capability layer; the rest are properties of the protocol the
 * engine speaks and are the same on every terminal it supports.
 */
const TERMINAL_CAPABILITIES: PresentationCapabilities = {
	images: true,
	trueColor: true,
	mouse: true,
	hyperlinks: true,
	nativeScrollback: true,
	textStyles: true,
};

/**
 * Engine overlay options for a wire anchor.
 *
 * The two anchor vocabularies are deliberately different: the contract states
 * where the operator sees the card, and the engine takes a nine-point grid plus
 * a fullscreen mode. `fullscreen` is the one that is not a position at all — it
 * borrows the alternate screen, which is why it cannot be expressed as an
 * anchor and is mapped to the option instead.
 */
function engineOverlayOptions(anchor: WireOverlayAnchor): OverlayOptions {
	switch (anchor) {
		case "center":
			return { anchor: "center", width: OVERLAY_WIDTH };
		case "top":
			return { anchor: "top-center", width: OVERLAY_WIDTH };
		case "bottom":
			return { anchor: "bottom-center", width: OVERLAY_WIDTH };
		case "fullscreen":
			return { anchor: "center", width: "100%", maxHeight: "100%", fullscreen: true };
	}
}

/** Columns a dialog or overlay card occupies, as a fraction of the frame. */
const OVERLAY_WIDTH = "80%";
