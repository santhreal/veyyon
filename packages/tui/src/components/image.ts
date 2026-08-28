import { SGR_RESET } from "@veyyon/utils/ansi";
import type { ImageFallbackReason } from "@veyyon/utils/image-fallback";
import { getKittyGraphics } from "@veyyon/utils/kitty-graphics";
import type { ImageBudget } from "../core/image-budget";
import {
	getCellDimensions,
	getImageDimensions,
	type ImageDimensions,
	imageFallback,
	renderImage,
	TERMINAL,
} from "../terminal-capabilities";
import type { Component } from "../tui";

const SAVE_CURSOR = "\x1b7";
const RESTORE_CURSOR = "\x1b8";
// Direct placements reserve height with leading zero-width rows. Keep them
// non-plain so transcript blank-edge trimming does not collapse image-only blocks.
// A reserved row carries nothing but an attribute reset, so the terminal leaves the cells alone.
const RESERVED_IMAGE_ROW = SGR_RESET;

export interface ImageTheme {
	fallbackColor: (str: string) => string;
}

export interface ImageOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	filename?: string;
	/** Shared budget that caps how many inline images render as live graphics. */
	budget?: ImageBudget;
	/**
	 * Stable identity for the underlying image (e.g. `toolCallId:index`). Lets the
	 * budget hand back the same graphics id across component re-creations so a
	 * repaint replaces the placement instead of stacking a duplicate.
	 */
	imageKey?: string;
	/**
	 * Called when the picture's on-screen state changes: the cause it fell back
	 * to text, or `undefined` once it draws as a graphic. The budget and the
	 * terminal decide this inside {@link Image.render}, so a caller that has to
	 * state whether the picture reached the screen learns it here.
	 */
	onDisplayed?: (fallback: ImageFallbackReason | undefined) => void;
}

// `ImageBudget` is engine state and lives in `../core/image-budget`; it is re-exported here because
// the budget and the picture are one concept to a caller.
export * from "../core/image-budget";

export class Image implements Component {
	#base64Data: string;
	#mimeType: string;
	#dimensions: ImageDimensions;
	#theme: ImageTheme;
	#options: ImageOptions;
	#budget?: ImageBudget;
	#imageId?: number;

	#cachedLines?: string[];
	#cachedWidth?: number;
	#cachedSuppressed = false;
	#cachedImageProtocol: typeof TERMINAL.imageProtocol = null;
	#cachedCellWidthPx = 0;
	#cachedCellHeightPx = 0;
	#cachedKittyUnicodePlaceholders = false;
	// Tallest graphic placement this image has rendered. The text fallback
	// pads itself to this height so a budget demotion never shrinks the block
	// (its rows may already be committed to native scrollback).
	#renderedGraphicRows = 0;
	// The fallback cause this image last told its caller about, so a repaint that
	// changes nothing reports nothing.
	#reportedFallback: ImageFallbackReason | undefined;

	constructor(
		base64Data: string,
		mimeType: string,
		theme: ImageTheme,
		options: ImageOptions = {},
		dimensions?: ImageDimensions,
	) {
		this.#base64Data = base64Data;
		this.#mimeType = mimeType;
		this.#theme = theme;
		this.#options = options;
		this.#dimensions = dimensions || getImageDimensions(base64Data, mimeType) || { widthPx: 800, heightPx: 600 };
		this.#budget = options.budget;
		this.#imageId = options.budget ? options.budget.acquireId(options.imageKey) : undefined;
	}

	invalidate(): void {
		this.#cachedLines = undefined;
		this.#cachedWidth = undefined;
	}

	render(width: number): readonly string[] {
		const imageProtocol = TERMINAL.imageProtocol;
		const hasProtocol = imageProtocol != null;
		const cellDimensions = getCellDimensions();
		const kittyUnicodePlaceholders = getKittyGraphics().unicodePlaceholders;
		// observe() must run on every pass — even a cache hit — so the image keeps
		// its display-order slot in the budget. Only graphics-capable frames count
		// toward (and are demoted by) the budget; without a protocol every image is
		// already text.
		const suppressed = hasProtocol && this.#budget !== undefined ? this.#budget.observe(this.#imageId ?? 0) : false;

		if (
			this.#cachedLines &&
			this.#cachedWidth === width &&
			this.#cachedSuppressed === suppressed &&
			this.#cachedImageProtocol === imageProtocol &&
			this.#cachedCellWidthPx === cellDimensions.widthPx &&
			this.#cachedCellHeightPx === cellDimensions.heightPx &&
			this.#cachedKittyUnicodePlaceholders === kittyUnicodePlaceholders
		) {
			return this.#cachedLines;
		}

		const cap = this.#options.maxWidthCells;
		const maxWidth = cap != null && cap > 0 ? Math.min(width - 2, cap) : width - 2;

		let lines: string[];
		let fallback: ImageFallbackReason | undefined;

		if (hasProtocol && !suppressed) {
			// Transmit the data once (keyed by id); thereafter renderImage returns
			// just the placement, so repaints never re-send the base64.
			const needsTransmit = this.#imageId != null && (this.#budget?.shouldTransmit(this.#imageId) ?? false);
			const result = renderImage(this.#base64Data, this.#dimensions, {
				maxWidthCells: maxWidth,
				maxHeightCells: this.#options.maxHeightCells,
				imageId: this.#imageId,
				includeTransmit: needsTransmit,
			});

			if (result?.transmit && this.#imageId != null && this.#budget !== undefined) {
				this.#budget.enqueueTransmit(this.#imageId, result.transmit);
			}

			if (result?.lines) {
				// Unicode placeholders: the image is already a block of real text-cell
				// lines (line 0 carries the virtual-placement APC). No cursor moves.
				lines = result.lines;
			} else if (result) {
				// Direct placement: return `rows` lines so TUI accounts for image
				// height. First (rows-1) lines are empty (TUI clears them); the last
				// saves the final-row cursor, moves up to the image origin, emits the
				// image sequence, then restores the final-row cursor. Save/restore is
				// required because CUU clamps at the viewport top when leading rows are
				// clipped away.
				lines = [];
				for (let i = 0; i < result.rows - 1; i++) {
					lines.push(RESERVED_IMAGE_ROW);
				}
				const cursorRows = result.rows - 1;
				const moveUp = cursorRows > 0 ? `\x1b[${cursorRows}A` : "";
				const placement = moveUp + (result.sequence ?? "");
				lines.push(cursorRows > 0 ? SAVE_CURSOR + placement + RESTORE_CURSOR : placement);
			} else {
				fallback = "unsupported-format";
				lines = this.#fallbackLines(fallback);
			}
			this.#renderedGraphicRows = Math.max(this.#renderedGraphicRows, lines.length);
		} else {
			fallback = suppressed ? "over-budget" : "no-protocol";
			lines = this.#fallbackLines(fallback);
		}

		// Only a change is reported: the same cause every frame would ask a caller
		// to decide over and over whether anything moved.
		if (fallback !== this.#reportedFallback) {
			this.#reportedFallback = fallback;
			this.#options.onDisplayed?.(fallback);
		}

		this.#cachedLines = lines;
		this.#cachedWidth = width;
		this.#cachedSuppressed = suppressed;
		this.#cachedImageProtocol = imageProtocol;
		this.#cachedCellWidthPx = cellDimensions.widthPx;
		this.#cachedCellHeightPx = cellDimensions.heightPx;
		this.#cachedKittyUnicodePlaceholders = kittyUnicodePlaceholders;

		return lines;
	}

	/**
	 * Text fallback, height-preserving once a graphic has rendered: a demoted
	 * image must keep occupying the rows its placement used, because those
	 * rows may already be committed to native scrollback — shrinking the block
	 * would shift everything below it and force the renderer's commit-resync
	 * (stale band + recommit). Reserved rows stay non-plain so blank-edge
	 * trimming cannot collapse the block either.
	 */
	#fallbackLines(reason: ImageFallbackReason): string[] {
		const fallback = this.#theme.fallbackColor(
			imageFallback({
				mimeType: this.#mimeType,
				dimensions: this.#dimensions,
				filename: this.#options.filename,
				reason,
			}),
		);
		if (this.#renderedGraphicRows <= 1) return [fallback];
		const lines: string[] = [];
		for (let i = 0; i < this.#renderedGraphicRows - 1; i++) {
			lines.push(RESERVED_IMAGE_ROW);
		}
		lines.push(fallback);
		return lines;
	}
}
