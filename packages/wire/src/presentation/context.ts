/**
 * `PresentationContext`: the whole contract between a session and whatever
 * draws it. A terminal driver implements it; a browser client implements it;
 * a test double implements it and asserts on the calls.
 *
 * The session calls these methods and never reaches past them. Everything the
 * renderer sends back arrives through {@link PresentationContext.onInput} as a
 * `UIEvent`, so the two directions cannot be confused.
 */

import type { ComposerState } from "./composer";
import type { UIEvent } from "./events";
import type { DialogResult, DialogViewModel, OverlayHandle, OverlayViewModel } from "./overlay";
import type { StatusLineState } from "./status";
import type { PresentationTheme } from "./theme";
import type { BlockId, TranscriptBlock } from "./transcript";

/** What the surface can actually do. A session degrades rather than assuming. */
export interface PresentationCapabilities {
	/** Inline images can be displayed. */
	images: boolean;
	/** True colour is available; false means the renderer quantizes. */
	trueColor: boolean;
	/** Pointer events are reported. */
	mouse: boolean;
	/** Hyperlinks can be attached to text. */
	hyperlinks: boolean;
	/** The surface keeps its own scrollback above the viewport. */
	nativeScrollback: boolean;
	/** Text can be styled bold/italic/underline. */
	textStyles: boolean;
}

export interface PresentationContext {
	start(): void;
	stop(): void;
	readonly running: boolean;

	/** Replace the whole transcript. Used on session load and on branch switch. */
	setTranscriptBlocks(blocks: readonly TranscriptBlock[]): void;
	appendTranscriptBlock(block: TranscriptBlock): void;
	/** Patch a block in place. Unknown ids are ignored, not an error. */
	updateTranscriptBlock(id: BlockId, patch: Partial<TranscriptBlock>): void;
	removeTranscriptBlock(id: BlockId): void;
	clearTranscript(): void;

	setStatusLine(state: StatusLineState): void;
	setComposerState(state: ComposerState): void;
	focusComposer(): void;

	/** Show a dialog and resolve with the operator's answer. */
	showDialog(dialog: DialogViewModel): Promise<DialogResult>;
	showOverlay(overlay: OverlayViewModel): OverlayHandle;
	/** Close an overlay by id. Unknown ids are ignored, not an error. */
	closeOverlay(id: string): void;

	scrollToLive(): void;
	scrollBy(rows: number): void;
	/** Rows the transcript is scrolled back from the live tail; 0 while following it. */
	readonly scrollPosition: number;
	/** True when there is anything above the viewport to scroll to. */
	readonly scrollable: boolean;

	setTheme(theme: PresentationTheme): void;

	/** Subscribe to operator input. Returns an unsubscribe function. */
	onInput(handler: (event: UIEvent) => void): () => void;

	readonly width: number;
	readonly height: number;
	readonly capabilities: PresentationCapabilities;
}
