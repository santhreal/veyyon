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

import { type Component, type OverlayOptions, TUI, type TUIStartOptions } from "@veyyon/tui";
import { ScrollView } from "@veyyon/tui/components/scroll-view";
import type { Terminal } from "@veyyon/tui/terminal";
import { matchesKey } from "@veyyon/utils/keys";
import * as logger from "@veyyon/utils/logger";
import { replaceTabs } from "@veyyon/utils/tab-width";
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
	StatusCapabilities,
	StatusLineState,
	SubmitEvent,
	TranscriptBlock,
	UIEvent,
	OverlayAnchor as WireOverlayAnchor,
} from "@veyyon/wire/presentation";
import { applyPresentationTheme, getEditorTheme, theme } from "../../theme/theme";
import { bottomBorder, row, topBorder } from "./components/chrome/overlay-box";
import { applyComposerState } from "./components/composer/composer-chrome";
import { CustomEditor } from "./components/composer/custom-editor";
import { createDialogComponent } from "./components/dialogs/dialog-factory";
import { StatusLineComponent } from "./components/status-line/component";
import { ChatTranscriptBuilder } from "./components/transcript/chat-transcript-builder";
import { TranscriptBlockComponent } from "./components/transcript/transcript-block-component";

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

class OverlayComponent extends ScrollView {
	#view: OverlayViewModel;

	constructor(
		view: OverlayViewModel,
		readonly viewportHeight: () => number,
		readonly dismiss: () => void,
	) {
		super(view.rows, { height: 0 });
		this.#view = view;
	}

	set(view: OverlayViewModel): void {
		this.#view = view;
		this.setLines(view.rows);
	}

	handleInput(data: string): void {
		if (!this.#view.interactive) return;
		if (this.#view.dismissable && matchesKey(data, "escape")) {
			this.dismiss();
			return;
		}
		this.handleScrollKey(data);
	}

	override render(width: number): readonly string[] {
		const height = Math.max(0, this.viewportHeight());
		const framed = width >= 4 && height >= 2;
		this.setHeight(Math.min(this.#view.rows.length, Math.max(0, height - (framed ? 2 : 0))));
		const lines = super.render(Math.max(0, width - (framed ? 4 : 0)));
		if (!framed) return lines;
		return [
			topBorder(width, replaceTabs(this.#view.title ?? "").replace(/[\r\n]/g, " "), theme),
			...lines.map(line => row(line, width, theme)),
			bottomBorder(width, theme),
		];
	}
}

/**
 * Surface provided by a host (such as InteractiveMode) that already owns an
 * engine, composer, transcript, and status presentation.
 */
export interface TerminalDriverSurface {
	getTui(): TUI;
	getComposer(): CustomEditor;
	transcript: Pick<
		PresentationContext,
		| "setTranscriptBlocks"
		| "appendTranscriptBlock"
		| "updateTranscriptBlock"
		| "removeTranscriptBlock"
		| "clearTranscript"
	>;
	setStatusLine(state: StatusLineState): void;
}

export interface TerminalDriverOptions {
	/** Theme to start with. A session pushes its own through `setTheme`. */
	theme: PresentationTheme;
	/** Draw the hardware cursor. Off in a test, on in a session with a composer. */
	showHardwareCursor?: boolean;
	/** Working directory for path shortening. */
	cwd?: string;
	/** Optional local refresh actions, separate from serializable status snapshots. */
	statusCapabilities?: StatusCapabilities;
	/** Optional adopted surface hosting the TUI, composer, transcript, and status. */
	surface?: TerminalDriverSurface;
	/** Optional engine start options used when starting a standalone TUI. */
	startOptions?: TUIStartOptions;
}

export type AdoptedTerminalDriverOptions = Omit<TerminalDriverOptions, "theme"> & {
	surface: TerminalDriverSurface;
};

/** Rows a page-scroll gesture moves, as a fraction of the viewport. */
const PAGE_FRACTION = 0.8;

export class TerminalPresentationDriver implements PresentationContext {
	#surface: TerminalDriverSurface;
	#tui: TUI | undefined;
	#statusCapabilities: StatusCapabilities | undefined;
	#startOptions: TUIStartOptions | undefined;
	#standaloneTranscript: ChatTranscriptBuilder | undefined;
	#status: RowsComponent<StatusLineState | undefined> | undefined;
	#statusRenderer: StatusLineComponent | undefined;
	#boundComposer: CustomEditor | undefined;
	#restoreComposerCallbacks: (() => void) | undefined;
	#composerChange: CustomEditor["onComposerChange"];
	#composerSubmit: CustomEditor["onComposerSubmit"];

	#composerText = "";
	#composerCursorOffset = 0;
	#handlers = new Set<(event: UIEvent) => void>();
	#detachInput: (() => void) | undefined;
	#overlays = new Map<string, { component: Component; hide: () => void }>();
	#dialogs = new Map<string, () => void>();
	#running = false;
	#lastWidth: number;
	#lastHeight: number;

	constructor(terminal: Terminal, options: TerminalDriverOptions | AdoptedTerminalDriverOptions) {
		this.#statusCapabilities = options.statusCapabilities;
		this.#startOptions = options.startOptions;
		this.#lastWidth = terminal.columns;
		this.#lastHeight = terminal.rows;

		if (options.surface !== undefined) {
			this.#surface = options.surface;
		} else {
			applyPresentationTheme((options as TerminalDriverOptions).theme);
			const tui = new TUI(terminal, options.showHardwareCursor ?? false);
			this.#tui = tui;
			this.#standaloneTranscript = new ChatTranscriptBuilder({
				ui: tui,
				cwd: options.cwd ?? process.cwd(),
				groupReadEntries: false,
				requestRender: () => tui.requestRender(),
			});
			this.#status = new RowsComponent<StatusLineState | undefined>(undefined, (state, width) => {
				if (state === undefined) return [];
				this.#statusRenderer ??= this.#createStatusRenderer();
				const line = this.#statusRenderer.renderQuietLine(width);
				return line === null ? [] : [line];
			});
			const composer = new CustomEditor(getEditorTheme());
			composer.setUseTerminalCursor(tui.getShowHardwareCursor());
			composer.setShimmerRepaintHandler(() => tui.requestComponentRender(composer));
			this.#surface = {
				getTui: () => tui,
				getComposer: () => composer,
				transcript: this.#standaloneTranscript,
				setStatusLine: state => this.#status!.set(state),
			};
			tui.addChild(this.#standaloneTranscript.container);
			tui.addChild(this.#status);
			tui.addChild(composer);
			tui.setFocus(composer);
			// Keep status and composer pinned while the transcript scrolls.
			tui.setPinnedFooterChildCount(2);
		}
		this.syncComposer();
	}
	/**
	 * Synchronize composer bindings with the adopted surface.
	 *
	 * When the host replaces the active editor component at runtime (e.g. in
	 * `InteractiveMode.setEditorComponent`), this rebinds change and submit
	 * notification callbacks to the new composer while preserving host handlers.
	 */
	syncComposer(): CustomEditor {
		const composer = this.#surface.getComposer();
		if (
			composer !== this.#boundComposer ||
			composer.onComposerChange !== this.#composerChange ||
			composer.onComposerSubmit !== this.#composerSubmit
		) {
			this.#restoreComposerCallbacks?.();
			this.#boundComposer = composer;
			this.#composerText = composer.getText();
			this.#composerCursorOffset = composer.getCursorOffset();
			const previousOnChange = composer.onComposerChange;
			const previousOnSubmit = composer.onComposerSubmit;
			const chainedOnChange = (state: ComposerState) => {
				previousOnChange?.(state);
				if (state.text === this.#composerText && state.cursorOffset === this.#composerCursorOffset) return;
				this.#composerText = state.text;
				this.#composerCursorOffset = state.cursorOffset;
				this.emit({ type: "composer-change", text: state.text, cursorOffset: state.cursorOffset });
			};
			const chainedOnSubmit = (event: SubmitEvent) => {
				previousOnSubmit?.(event);
				this.emit(event);
			};
			composer.onComposerChange = chainedOnChange;
			composer.onComposerSubmit = chainedOnSubmit;
			this.#composerChange = chainedOnChange;
			this.#composerSubmit = chainedOnSubmit;
			this.#restoreComposerCallbacks = () => {
				if (composer.onComposerChange === chainedOnChange) {
					composer.onComposerChange = previousOnChange;
				}
				if (composer.onComposerSubmit === chainedOnSubmit) {
					composer.onComposerSubmit = previousOnSubmit;
				}
			};
		}
		return composer;
	}

	/** The engine, for a host that also drives its own components. */
	get tui(): TUI {
		return this.#surface.getTui();
	}

	/**
	 * Start the presentation driver.
	 *
	 * In standalone mode, the driver owns the engine and invokes `TUI.start(options)`.
	 * In adopted mode, the host (such as `InteractiveMode`) owns the engine and its
	 * startup lifecycle; the driver attaches input listeners and synchronizes the
	 * composer without issuing a second engine start or clearing scrollback.
	 */
	start(options?: TUIStartOptions): void {
		if (this.#running) return;
		this.#running = true;
		const tui = this.tui;
		this.#detachInput = tui.addInputListener(data => this.#routeInput(data));
		if (this.#standaloneTranscript !== undefined) {
			for (const block of this.#standaloneTranscript.container.children) {
				if (block instanceof TranscriptBlockComponent && !block.isTranscriptBlockFinalized()) block.remount();
			}
		}
		this.syncComposer();
		this.#tui?.start(options ?? this.#startOptions);
	}

	/**
	 * Stop the presentation driver.
	 *
	 * In standalone mode, the driver stops its own TUI engine. In adopted mode,
	 * the driver cancels modal dialogs, dismisses overlays, restores composer
	 * callbacks and detaches input listeners without stopping the host-owned engine.
	 */
	stop(): void {
		for (const cancel of this.#dialogs.values()) cancel();
		for (const [, overlay] of this.#overlays) overlay.hide();
		this.#overlays.clear();
		this.#statusRenderer?.dispose();
		this.#statusRenderer = undefined;
		this.#restoreComposerCallbacks?.();
		this.#composerChange = undefined;
		this.#composerSubmit = undefined;
		this.#restoreComposerCallbacks = undefined;
		this.#boundComposer = undefined;
		if (this.#standaloneTranscript !== undefined) {
			for (const block of this.#standaloneTranscript.container.children) {
				if (block instanceof TranscriptBlockComponent) block.stopAnimation();
			}
		}
		if (!this.#running) return;
		this.#running = false;
		this.#detachInput?.();
		this.#detachInput = undefined;
		this.#tui?.stop();
	}

	get running(): boolean {
		return this.#running;
	}

	setTranscriptBlocks(blocks: readonly TranscriptBlock[]): void {
		this.#surface.transcript.setTranscriptBlocks(blocks);
		this.tui.requestRender();
	}

	appendTranscriptBlock(block: TranscriptBlock): void {
		this.#surface.transcript.appendTranscriptBlock(block);
		this.tui.requestRender();
	}

	updateTranscriptBlock(id: BlockId, patch: Partial<TranscriptBlock>): void {
		this.#surface.transcript.updateTranscriptBlock(id, patch);
		this.tui.requestRender();
	}

	removeTranscriptBlock(id: BlockId): void {
		this.#surface.transcript.removeTranscriptBlock(id);
		this.tui.requestRender();
	}

	clearTranscript(): void {
		this.#surface.transcript.clearTranscript();
		this.tui.requestRender();
	}

	setStatusLine(state: StatusLineState): void {
		this.#surface.setStatusLine(state);
		this.tui.requestRender();
	}

	setComposerState(state: ComposerState): void {
		const composer = this.syncComposer();
		applyComposerState(composer, state);
		this.#composerText = composer.getText();
		this.#composerCursorOffset = composer.getCursorOffset();
		this.tui.requestComponentRender(composer);
	}

	focusComposer(): void {
		this.tui.setFocus(this.syncComposer());
	}
	showDialog(dialog: DialogViewModel): Promise<DialogResult> {
		this.closeOverlay(dialog.id);
		const { promise, resolve } = Promise.withResolvers<DialogResult>();
		let settled = false;
		let component: Component | undefined;
		let hide: (() => void) | undefined;
		const answer = (result: DialogResult): void => {
			if (settled) return;
			settled = true;
			this.#dialogs.delete(dialog.id);
			try {
				hide?.();
				component?.dispose?.();
			} finally {
				resolve(result);
			}
		};
		const tui = this.tui;
		component = createDialogComponent(dialog, answer, {
			tui,
			onRequestRender: () => tui.requestRender(),
		});
		if (settled) {
			component.dispose?.();
			return promise;
		}
		const handle = tui.showOverlay(component, { anchor: "center", width: "80%" });
		hide = () => handle.hide();
		this.#dialogs.set(dialog.id, () => answer({ outcome: "cancelled" }));
		return promise;
	}

	showOverlay(overlay: OverlayViewModel): OverlayHandle {
		this.closeOverlay(overlay.id);
		const id = overlay.id;
		let closed = false;
		const close = (): void => {
			if (closed) return;
			closed = true;
			this.#overlays.delete(id);
			handle.hide();
		};
		const component = new OverlayComponent(overlay, () => this.height, close);
		const options = engineOverlayOptions(overlay.anchor);
		options.interactive = overlay.interactive;
		const tui = this.tui;
		const handle = tui.showOverlay(component, options);
		this.#overlays.set(id, { component, hide: close });
		return {
			id,
			close,
			update: (next: OverlayViewModel) => {
				if (closed) return;
				if (next.id !== id) throw new Error(`Cannot change overlay id from ${id} to ${next.id}`);
				component.set(next);
				const layout = engineOverlayOptions(next.anchor);
				options.anchor = layout.anchor;
				options.width = layout.width;
				options.maxHeight = layout.maxHeight;
				options.fullscreen = layout.fullscreen;
				const wasInteractive = options.interactive;
				options.interactive = next.interactive;
				if (!wasInteractive && next.interactive) tui.setFocus(component);
				else if (!next.interactive && tui.getFocused() === component) this.focusComposer();
				tui.requestRender();
			},
		};
	}

	closeOverlay(id: string): void {
		this.#dialogs.get(id)?.();
		const overlay = this.#overlays.get(id);
		// Unknown ids are ignored by contract; a double close is the ordinary case
		// when a host and an operator dismiss the same card.
		if (overlay === undefined) return;
		this.#overlays.delete(id);
		overlay.hide();
	}

	scrollToLive(): void {
		this.tui.scrollToLiveTail();
	}

	scrollBy(rows: number): void {
		this.tui.scrollByRows(rows);
	}

	get scrollPosition(): number {
		return this.tui.virtualScrollNewRows;
	}

	get scrollable(): boolean {
		return this.tui.frameScrollable;
	}

	setTheme(theme: PresentationTheme): void {
		applyPresentationTheme(theme);
		this.#statusRenderer?.dispose();
		this.#statusRenderer = undefined;
		if (this.#standaloneTranscript !== undefined) {
			for (const block of this.#standaloneTranscript.container.children) {
				if (block instanceof TranscriptBlockComponent) block.remount();
			}
		}
		const tui = this.tui;
		tui.invalidate();
		tui.requestRender();
	}

	onInput(handler: (event: UIEvent) => void): () => void {
		this.#handlers.add(handler);
		return () => {
			this.#handlers.delete(handler);
		};
	}

	get width(): number {
		return this.tui.terminal.columns;
	}

	get height(): number {
		return this.tui.terminal.rows;
	}

	get capabilities(): PresentationCapabilities {
		return TERMINAL_CAPABILITIES;
	}

	/** Deliver a `UIEvent` to every subscriber. A throwing handler must not stop the rest. */
	emit(event: UIEvent): void {
		for (const handler of [...this.#handlers]) {
			try {
				handler(event);
			} catch (error) {
				logger.error("Terminal input subscriber failed", { eventType: event.type, error });
			}
		}
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
		if (this.#dialogs.size > 0) {
			if (matchesKey(data, "ctrl+c")) {
				let cancel: (() => void) | undefined;
				for (const dismiss of this.#dialogs.values()) cancel = dismiss;
				cancel?.();
				return { consume: true };
			}
			return undefined;
		}
		if (this.#tui === undefined) {
			return undefined;
		}
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
		if (this.tui.hasOverlay()) return undefined;
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
		return Math.max(1, Math.trunc(this.tui.terminal.rows * PAGE_FRACTION));
	}

	/**
	 * A resize is not a keystroke, but the terminal reports one by delivering the
	 * next input after the dimensions changed, so the size is compared on every
	 * byte rather than polled.
	 */
	#noticeResize(): UIEvent | undefined {
		const width = this.tui.terminal.columns;
		const height = this.tui.terminal.rows;
		if (width === this.#lastWidth && height === this.#lastHeight) return undefined;
		this.#lastWidth = width;
		this.#lastHeight = height;
		return { type: "resize", width, height };
	}

	#createStatusRenderer(): StatusLineComponent {
		const status = this.#status!;
		const renderer = new StatusLineComponent({
			getSnapshot: () => {
				const current = status.value;
				if (current === undefined) throw new Error("Status rendering requires a snapshot");
				return current;
			},
			capabilities: this.#statusCapabilities,
			getRevision: () => status.value?.sessionRevision ?? 0,
		});
		renderer.watchGitState(() => {
			this.#status!.invalidate();
			this.#tui!.requestComponentRender(this.#status!);
		});
		return renderer;
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
