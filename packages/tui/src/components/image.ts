import { SGR_RESET } from "../ansi";
import { getKittyGraphics } from "../kitty-graphics";
import {
	getCellDimensions,
	getImageDimensions,
	type ImageDimensions,
	type ImageFallbackReason,
	imageFallback,
	renderImage,
	TERMINAL,
} from "../terminal-capabilities";
import type { Component } from "../tui";

export interface ImageTheme {
	fallbackColor: (str: string) => string;
}

export interface ImageOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	filename?: string;
	budget?: ImageBudget;
	imageKey?: string;
	onDisplayed?: (fallback: ImageFallbackReason | undefined) => void;
}

const EMPTY_IDS: readonly number[] = [];
const EMPTY_TRANSMITS: readonly string[] = [];
const SAVE_CURSOR = "\x1b7";
const RESTORE_CURSOR = "\x1b8";
const RESERVED_IMAGE_ROW = SGR_RESET;

export const DEFAULT_MAX_INLINE_IMAGES = 8;

let nextImageBudgetSeed = Math.floor(Math.random() * 0xffffff);
function nextImageIdSeed(): number {
	nextImageBudgetSeed = (nextImageBudgetSeed + 0x10000) & 0xffffff;
	return nextImageBudgetSeed || 1;
}
export class ImageBudget {
	#cap: number;
	#requestRender: () => void;
	#nextId = nextImageIdSeed();
	#keyToId = new Map<string, number>();
	#idToKey = new Map<number, string>();
	#passIds: number[] = [];
	#onTerminal = 0;
	#planned = 0;
	#applyingReset = false;
	#lastTotal = 0;
	#purgeIds: number[] = [];
	#transmitted = new Set<number>();
	#pendingTransmits: string[] = [];
	#stablePass = false;
	#suppressedIds = new Set<number>();

	constructor(cap: number = DEFAULT_MAX_INLINE_IMAGES, requestRender: () => void = () => {}) {
		this.#cap = normalizeCap(cap);
		this.#requestRender = requestRender;
	}

	get cap(): number {
		return this.#cap;
	}

	get enabled(): boolean {
		return this.#cap > 0;
	}

	setRequestRender(requestRender: () => void): void {
		this.#requestRender = requestRender;
	}

	setCap(cap: number): void {
		const next = normalizeCap(cap);
		if (next === this.#cap) return;
		this.#cap = next;
		this.#reconcile(this.#lastTotal);
	}

	acquireId(key?: string): number {
		if (key) {
			const existing = this.#keyToId.get(key);
			if (existing !== undefined) return existing;
			const id = this.#nextId;
			this.#nextId = (this.#nextId + 1) & 0xffffff || 1;
			this.#keyToId.set(key, id);
			this.#idToKey.set(id, key);
			return id;
		}
		const id = this.#nextId;
		this.#nextId = (this.#nextId + 1) & 0xffffff || 1;
		return id;
	}

	beginPass(stable = false): void {
		this.#passIds.length = 0;
		this.#stablePass = stable;
		this.#applyingReset = !stable && this.#cap > 0 && this.#planned > this.#onTerminal;
	}

	observe(imageId: number): boolean {
		if (this.#stablePass) {
			const suppressed = this.#cap > 0 && this.#suppressedIds.has(imageId);
			if (suppressed) this.#forgetKeyForId(imageId);
			return suppressed;
		}
		const index = this.#passIds.length;
		this.#passIds.push(imageId);
		const suppressed = this.#cap > 0 && index < this.#planned;
		if (suppressed) this.#forgetKeyForId(imageId);
		return suppressed;
	}

	endPass(): boolean {
		const total = this.#passIds.length;
		this.#lastTotal = total;
		let reset = false;
		if (this.#applyingReset) {
			for (let i = this.#onTerminal; i < this.#planned && i < total; i++) {
				const id = this.#passIds[i];
				this.#purgeIds.push(id);
				this.#transmitted.delete(id);
				this.#forgetKeyForId(id);
			}
			this.#onTerminal = this.#planned;
			this.#applyingReset = false;
			reset = true;
		}
		this.#reconcile(total);
		this.#suppressedIds = new Set(this.#passIds.slice(0, this.#onTerminal));
		return reset;
	}

	takePurgeIds(): readonly number[] {
		if (this.#purgeIds.length === 0) return EMPTY_IDS;
		const ids = this.#purgeIds;
		this.#purgeIds = [];
		return ids;
	}

	takeAllTransmittedIds(): readonly number[] {
		if (this.#transmitted.size === 0) return EMPTY_IDS;
		const ids = new Array<number>(this.#transmitted.size);
		let ii = 0;
		for (const id of this.#transmitted) ids[ii++] = id;
		this.#transmitted.clear();
		this.#purgeIds = [];
		this.#pendingTransmits = [];
		this.#keyToId.clear();
		this.#idToKey.clear();
		return ids;
	}

	shouldTransmit(imageId: number): boolean {
		return !this.#transmitted.has(imageId);
	}

	enqueueTransmit(imageId: number, sequence: string): void {
		if (this.#transmitted.has(imageId)) return;
		this.#transmitted.add(imageId);
		this.#pendingTransmits.push(sequence);
	}

	hasPendingTransmits(): boolean {
		return this.#pendingTransmits.length > 0;
	}

	get quiescent(): boolean {
		return (
			this.#lastTotal === 0 &&
			this.#pendingTransmits.length === 0 &&
			this.#purgeIds.length === 0 &&
			this.#planned === this.#onTerminal
		);
	}

	takeTransmits(): readonly string[] {
		if (this.#pendingTransmits.length === 0) return EMPTY_TRANSMITS;
		const sequences = this.#pendingTransmits;
		this.#pendingTransmits = [];
		return sequences;
	}

	forgetTransmitted(): void {
		if (this.#transmitted.size === 0 && this.#pendingTransmits.length === 0) return;
		this.#transmitted.clear();
		this.#pendingTransmits = [];
	}

	#forgetKeyForId(id: number): void {
		const key = this.#idToKey.get(id);
		if (key === undefined) return;
		this.#idToKey.delete(id);
		if (this.#keyToId.get(key) === id) this.#keyToId.delete(key);
	}

	#reconcile(total: number): void {
		const desired = this.#cap > 0 ? Math.max(0, total - this.#cap) : 0;
		if (desired === this.#planned) {
			if (this.#planned < this.#onTerminal) this.#onTerminal = this.#planned;
			return;
		}
		this.#planned = desired;
		if (desired <= this.#onTerminal) this.#onTerminal = desired;
		this.#requestRender();
	}
}

function normalizeCap(cap: number): number {
	if (!Number.isFinite(cap)) return 0;
	return Math.max(0, Math.trunc(cap));
}

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
	#renderedGraphicRows = 0;
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
				lines = result.lines;
			} else if (result) {
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
