import { type Component, matchesKey, parseSgrMouse, ScrollView } from "@veyyon/tui";
import { clampLow, errorMessage } from "@veyyon/utils";
import { bottomBorder, divider, row, topBorder } from "../modes/components/overlay-box";
import { theme } from "../modes/theme/theme";
import { copyToClipboard } from "../utils/clipboard";
import {
	formatRawSseIsoTime,
	type RawSseDebugBuffer,
	type RawSseDebugRecord,
	rawSseRecordLines,
} from "./raw-sse-buffer";
import type { RawSseViewerOptions } from "./raw-sse-helpers";
import {
	expandPrettyDataLines,
	MIN_VIEWER_WIDTH,
	SCROLL_LIST_THEME,
	sanitizeFrameLine,
	VIEWER_CHROME_LINES,
} from "./raw-sse-helpers";

export { expandPrettyDataLines };

export class RawSseViewerComponent implements Component {
	readonly #buffer: RawSseDebugBuffer;
	readonly #terminalRows: number;
	readonly #onExit: () => void;
	readonly #onStatus?: (message: string) => void;
	readonly #onUpdate?: () => void;
	readonly #unsubscribe: () => void;
	#scrollOffset = 0;
	#followTail = true;
	#lastRenderWidth = MIN_VIEWER_WIDTH;
	#statusMessage: string | undefined;
	#bodyRowStart = 0;
	#bodyRowCount = 0;
	// Pretty-printed wire lines keyed by `record.sequence`. Pretty-printing is the JSON.parse + JSON.stringify per `data:` line, so we cache the result —
	readonly #prettyLinesCache = new Map<number, string[]>();

	constructor(options: RawSseViewerOptions) {
		this.#buffer = options.buffer;
		this.#terminalRows = options.terminalRows;
		this.#onExit = options.onExit;
		this.#onStatus = options.onStatus;
		this.#onUpdate = options.onUpdate;
		this.#unsubscribe = this.#buffer.subscribe(() => {
			this.#followIfNeeded();
			this.#onUpdate?.();
		});
	}

	dispose(): void {
		this.#unsubscribe();
	}

	handleInput(keyData: string): void {
		if (keyData.startsWith("\x1b[<") && this.#handleMouse(keyData)) {
			return;
		}

		if (matchesKey(keyData, "escape") || matchesKey(keyData, "esc")) {
			this.dispose();
			this.#onExit();
			return;
		}

		if (matchesKey(keyData, "ctrl+c")) {
			this.#copyAll();
			return;
		}

		if (matchesKey(keyData, "up")) {
			this.#followTail = false;
			this.#scrollOffset = Math.max(0, this.#scrollOffset - 1);
			this.#onUpdate?.();
			return;
		}

		if (matchesKey(keyData, "down")) {
			this.#followTail = false;
			this.#scrollOffset = Math.min(this.#maxScrollOffset(), this.#scrollOffset + 1);
			this.#onUpdate?.();
			return;
		}

		if (matchesKey(keyData, "pageUp")) {
			this.#followTail = false;
			this.#scrollOffset = Math.max(0, this.#scrollOffset - this.#bodyHeight());
			this.#onUpdate?.();
			return;
		}

		if (matchesKey(keyData, "pageDown")) {
			this.#followTail = false;
			this.#scrollOffset = Math.min(this.#maxScrollOffset(), this.#scrollOffset + this.#bodyHeight());
			this.#onUpdate?.();
			return;
		}

		if (matchesKey(keyData, "end")) {
			this.#followTail = true;
			this.#scrollToTail();
			this.#onUpdate?.();
		}
	}

	#handleMouse(keyData: string): boolean {
		const event = parseSgrMouse(keyData);
		if (!event) return false;

		const overBody = event.row >= this.#bodyRowStart && event.row < this.#bodyRowStart + this.#bodyRowCount;
		if (event.wheel !== null && overBody) {
			this.#followTail = false;
			this.#scrollOffset = clampLow(this.#scrollOffset + event.wheel * 3, 0, this.#maxScrollOffset());
			this.#onUpdate?.();
			return true;
		}

		if (!event.leftClick) return false;
		if (event.row === 1) {
			this.#followTail = !this.#followTail;
			this.#followIfNeeded();
			this.#onUpdate?.();
			return true;
		}
		if (overBody) {
			this.#followTail = false;
			const clickedOffset = this.#scrollOffset + event.row - this.#bodyRowStart;
			this.#scrollOffset = clampLow(clickedOffset, 0, this.#maxScrollOffset());
			this.#onUpdate?.();
			return true;
		}
		return false;
	}

	invalidate(): void {}

	render(width: number): readonly string[] {
		this.#lastRenderWidth = Math.max(MIN_VIEWER_WIDTH, width);
		this.#followIfNeeded();

		const contentWidth = Math.max(1, this.#lastRenderWidth - 4);
		const bodyHeight = this.#bodyHeight();
		const rawLines = this.#renderRawLines(contentWidth);
		const sv = new ScrollView(rawLines.slice(this.#scrollOffset, this.#scrollOffset + bodyHeight), {
			height: bodyHeight,
			scrollbar: "auto",
			totalRows: rawLines.length,
			theme: SCROLL_LIST_THEME,
		});
		sv.setScrollOffset(this.#scrollOffset);
		const bodyRows = sv.render(contentWidth);
		this.#bodyRowStart = 3;
		this.#bodyRowCount = bodyHeight;

		return [
			topBorder(this.#lastRenderWidth, "Raw Provider Stream"),
			row(this.#summaryText(), this.#lastRenderWidth),
			divider(this.#lastRenderWidth),
			...bodyRows.map(line => row(line, this.#lastRenderWidth)),
			divider(this.#lastRenderWidth),
			row(this.#statusText(), this.#lastRenderWidth),
			bottomBorder(this.#lastRenderWidth),
		];
	}

	#renderRawLines(innerWidth: number): string[] {
		const snapshot = this.#buffer.snapshot();
		if (snapshot.records.length === 0) {
			return [
				theme.fg("muted", "No raw SSE frames captured yet."),
				theme.fg("muted", "HTTP SSE providers populate this view while a model response is streaming."),
			];
		}

		const lines: string[] = [];
		if (snapshot.droppedRecords > 0) {
			lines.push(
				theme.fg(
					"warning",
					`: veyyon-debug-dropped records=${snapshot.droppedRecords} chars=${snapshot.droppedChars}`,
				),
			);
			lines.push("");
		}
		const firstSequence = snapshot.records[0]?.sequence;
		for (const record of snapshot.records) {
			for (const line of this.#prettyLinesFor(record)) {
				lines.push(sanitizeFrameLine(line, innerWidth));
			}
			if (record.kind === "event" && record.truncated) {
				lines.push(theme.fg("warning", `: veyyon-debug-event-truncated originalChars=${record.originalChars}`));
			}
			lines.push("");
		}
		if (firstSequence !== undefined) this.#pruneCache(firstSequence);
		return lines;
	}

	#prettyLinesFor(record: RawSseDebugRecord): string[] {
		const cached = this.#prettyLinesCache.get(record.sequence);
		if (cached) return cached;
		const expanded = expandPrettyDataLines(rawSseRecordLines(record));
		this.#prettyLinesCache.set(record.sequence, expanded);
		return expanded;
	}

	#pruneCache(firstSequence: number): void {
		// Bounded by the buffer eviction rate; with `MAX_RAW_SSE_EVENTS = 1000`
		// this rarely runs and only walks freshly-evicted entries.
		for (const key of this.#prettyLinesCache.keys()) {
			if (key < firstSequence) this.#prettyLinesCache.delete(key);
		}
	}
	#summaryText(): string {
		const snapshot = this.#buffer.snapshot();
		const last = snapshot.lastUpdatedAt
			? `${theme.fg("muted", "last")} ${theme.fg("accent", formatRawSseIsoTime(snapshot.lastUpdatedAt))}`
			: theme.fg("muted", "waiting for first frame");
		const follow = this.#followTail ? theme.fg("success", "follow on") : theme.fg("warning", "follow off");
		return `${theme.fg("muted", "events")} ${theme.fg("accent", String(snapshot.totalEvents))}  ${theme.fg("muted", "records")} ${theme.fg("accent", String(snapshot.records.length))}  ${last}  ${follow}`;
	}

	#statusText(): string {
		const help = "Esc close · Ctrl+C copy raw · End follow tail · wheel scroll · click summary toggles follow";
		return this.#statusMessage
			? `${theme.fg("success", this.#statusMessage)}  ${theme.fg("dim", help)}`
			: theme.fg("dim", help);
	}

	#bodyHeight(): number {
		return Math.max(3, (process.stdout.rows || this.#terminalRows || 24) - VIEWER_CHROME_LINES);
	}
	#followIfNeeded(): void {
		if (this.#followTail) this.#scrollToTail();
	}

	#scrollToTail(): void {
		this.#scrollOffset = this.#maxScrollOffset();
	}

	#maxScrollOffset(): number {
		const contentWidth = Math.max(1, this.#lastRenderWidth - 4);
		return Math.max(0, this.#renderRawLines(contentWidth).length - this.#bodyHeight());
	}

	#copyAll(): void {
		const payload = this.#buffer.toRawText();
		if (payload.trim().length === 0) {
			const message = "No raw SSE frames to copy";
			this.#statusMessage = message;
			this.#onStatus?.(message);
			this.#onUpdate?.();
			return;
		}

		try {
			copyToClipboard(payload);
			const message = "Copied raw SSE stream";
			this.#statusMessage = message;
			this.#onStatus?.(message);
		} catch (error) {
			const message = errorMessage(error);
			this.#statusMessage = `Copy failed: ${message}`;
		}
		this.#onUpdate?.();
	}
}
