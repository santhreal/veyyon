import { EventEmitter } from "events";
import { ESC } from "./ansi";
import { PASTE_END, PASTE_MAX_BYTES, PASTE_START } from "./bracketed-paste";
import { isKittyProtocolActive } from "./keys";
import type { StdinBufferEventMap, StdinBufferOptions } from "./stdin-buffer-helpers";
import {
	extractCompleteSequences,
	KITTY_PRINTABLE_DEDUP_WINDOW_MS,
	PARTIAL_HOLD_MAX_MS,
	PASTE_INACTIVITY_TIMEOUT_MS,
	parseUnmodifiedKittyPrintableCodepoint,
	SGR_MOUSE_PARTIAL,
} from "./stdin-buffer-helpers";

export class StdinBuffer extends EventEmitter<StdinBufferEventMap> {
	#buffer: string = "";
	#timeout?: NodeJS.Timeout;
	#flushDeferral?: NodeJS.Timeout;
	#partialHoldStartMs = 0;
	readonly #timeoutMs: number;
	readonly #partialHoldMaxMs: number;
	readonly #pasteTimeoutMs: number;
	readonly #pasteByteLimit: number;
	#pasteMode: boolean = false;
	#pasteChunks: string[] = [];
	#pasteOverlap: string = "";
	#pasteBytes = 0;
	#pasteWatchdog?: NodeJS.Timeout;
	#pendingKittyPrintableCodepoint: number | undefined;
	#pendingKittyPrintableAtMs = 0;
	#escapeSearchOffset = 0;

	constructor(options: StdinBufferOptions = {}) {
		super();
		this.#timeoutMs = options.timeout ?? 75;
		this.#partialHoldMaxMs = options.partialHoldTimeout ?? PARTIAL_HOLD_MAX_MS;
		this.#pasteTimeoutMs = options.pasteTimeout ?? PASTE_INACTIVITY_TIMEOUT_MS;
		this.#pasteByteLimit = options.pasteByteLimit ?? PASTE_MAX_BYTES;
	}

	process(data: string | Buffer): void {
		let str: string;
		if (Buffer.isBuffer(data)) {
			if (data.length === 1 && data[0]! > 127) {
				const byte = data[0]! - 128;
				str = `\x1b${String.fromCharCode(byte)}`;
			} else {
				str = data.toString();
			}
		} else {
			str = data;
		}

		if (this.#flushDeferral && this.#isFreshEscapeAfterDeferredFlush(str)) {
			this.#flushExpired();
		} else {
			this.#clearFlushTimer();
		}

		if (str.length === 0 && this.#buffer.length === 0) {
			this.#emitDataSequence("");
			return;
		}

		this.#buffer += str;

		if (this.#pasteMode) {
			const chunk = this.#buffer;
			this.#buffer = "";
			this.#consumePasteChunk(chunk);
			return;
		}

		const startIndex = this.#buffer.indexOf(PASTE_START);
		if (startIndex !== -1) {
			if (startIndex > 0) {
				const beforePaste = this.#buffer.slice(0, startIndex);
				const result = extractCompleteSequences(beforePaste, 0);
				for (let si = 0; si < result.sequences.length; si++) {
					this.#emitDataSequence(result.sequences[si]!);
				}
			}

			this.#escapeSearchOffset = 0;
			this.#pendingKittyPrintableCodepoint = undefined;
			this.#buffer = this.#buffer.slice(startIndex + PASTE_START.length);
			const firstChunk = this.#buffer;
			this.#buffer = "";
			this.#pasteMode = true;
			this.#pasteChunks = [];
			this.#pasteOverlap = "";
			this.#pasteBytes = 0;
			this.#consumePasteChunk(firstChunk);
			return;
		}

		const result = extractCompleteSequences(this.#buffer, this.#escapeSearchOffset);
		this.#buffer = result.remainder;
		this.#escapeSearchOffset = result.resumeSearchFrom;

		for (let si = 0; si < result.sequences.length; si++) {
			this.#emitDataSequence(result.sequences[si]!);
		}

		if (this.#buffer.length > 0) {
			this.#armFlushTimer();
		} else {
			this.#partialHoldStartMs = 0;
		}
	}

	#consumePasteChunk(chunk: string): void {
		const probe = this.#pasteOverlap + chunk;
		if (probe.indexOf(PASTE_END) === -1) {
			this.#pasteChunks.push(chunk);
			this.#pasteBytes += chunk.length;
			const keep = PASTE_END.length - 1;
			this.#pasteOverlap = probe.length > keep ? probe.slice(probe.length - keep) : probe;
			if (this.#pasteBytes > this.#pasteByteLimit) {
				this.#abortPaste();
				return;
			}
			this.#armPasteWatchdog();
			return;
		}

		const flat = this.#pasteChunks.length > 0 ? `${this.#pasteChunks.join("")}${chunk}` : chunk;
		const endIndex = flat.indexOf(PASTE_END);
		const pastedContent = flat.slice(0, endIndex);
		const remaining = flat.slice(endIndex + PASTE_END.length);

		this.#clearPasteWatchdog();
		this.#pasteMode = false;
		this.#pasteChunks = [];
		this.#pasteOverlap = "";
		this.#pasteBytes = 0;
		this.#pendingKittyPrintableCodepoint = undefined;

		this.emit("paste", pastedContent);

		if (remaining.length > 0) {
			this.process(remaining);
		}
	}

	#armPasteWatchdog(): void {
		if (this.#pasteWatchdog) clearTimeout(this.#pasteWatchdog);
		this.#pasteWatchdog = setTimeout(() => {
			this.#pasteWatchdog = undefined;
			this.#abortPaste();
		}, this.#pasteTimeoutMs);
	}

	#clearPasteWatchdog(): void {
		if (this.#pasteWatchdog) {
			clearTimeout(this.#pasteWatchdog);
			this.#pasteWatchdog = undefined;
		}
	}

	#abortPaste(): void {
		this.#clearPasteWatchdog();
		const content = this.#pasteChunks.join("");
		this.#pasteMode = false;
		this.#pasteChunks = [];
		this.#pasteOverlap = "";
		this.#pasteBytes = 0;
		this.emit("paste", content);
	}

	#emitDataSequence(sequence: string): void {
		const rawCodepoint = sequence.length === 1 ? sequence.codePointAt(0) : undefined;
		if (
			rawCodepoint !== undefined &&
			rawCodepoint === this.#pendingKittyPrintableCodepoint &&
			Date.now() - this.#pendingKittyPrintableAtMs <= KITTY_PRINTABLE_DEDUP_WINDOW_MS
		) {
			this.#pendingKittyPrintableCodepoint = undefined;
			return;
		}

		this.#pendingKittyPrintableCodepoint = parseUnmodifiedKittyPrintableCodepoint(sequence);
		if (this.#pendingKittyPrintableCodepoint !== undefined) {
			this.#pendingKittyPrintableAtMs = Date.now();
		}
		this.emit("data", sequence);
	}

	#armFlushTimer(): void {
		this.#timeout = setTimeout(() => {
			this.#timeout = undefined;
			this.#flushDeferral = setTimeout(() => {
				this.#flushDeferral = undefined;
				this.#flushExpired();
			});
		}, this.#timeoutMs);
	}

	#clearFlushTimer(): void {
		if (this.#timeout) {
			clearTimeout(this.#timeout);
			this.#timeout = undefined;
		}
		if (this.#flushDeferral) {
			clearTimeout(this.#flushDeferral);
			this.#flushDeferral = undefined;
		}
	}

	#isFreshEscapeAfterDeferredFlush(str: string): boolean {
		if (!str.startsWith(ESC) || this.#buffer.length === 0) return false;
		if (
			str.startsWith(`${ESC}\\`) &&
			(this.#buffer.startsWith(`${ESC}]`) ||
				this.#buffer.startsWith(`${ESC}P`) ||
				this.#buffer.startsWith(`${ESC}_`))
		) {
			return false;
		}
		return true;
	}

	#shouldHoldPartial(): boolean {
		return SGR_MOUSE_PARTIAL.test(this.#buffer) || isKittyProtocolActive();
	}

	#flushExpired(): void {
		if (this.#buffer.length === 0) {
			this.#partialHoldStartMs = 0;
			return;
		}
		if (this.#shouldHoldPartial()) {
			if (this.#partialHoldStartMs === 0) this.#partialHoldStartMs = Date.now();
			if (Date.now() - this.#partialHoldStartMs < this.#partialHoldMaxMs) {
				this.#armFlushTimer();
				return;
			}
		}
		this.#partialHoldStartMs = 0;
		const flushed = this.flush();
		for (let si = 0; si < flushed.length; si++) {
			this.#emitDataSequence(flushed[si]!);
		}
	}

	flush(): string[] {
		this.#clearFlushTimer();

		if (this.#buffer.length === 0) {
			return [];
		}

		const buffered = this.#buffer;
		this.#buffer = "";
		this.#escapeSearchOffset = 0;
		this.#pendingKittyPrintableCodepoint = undefined;
		if (buffered === `${ESC}${ESC}`) {
			return [ESC, ESC];
		}
		return [buffered];
	}

	clear(): void {
		this.#clearFlushTimer();
		this.#clearPasteWatchdog();
		this.#buffer = "";
		this.#pasteMode = false;
		this.#pasteChunks = [];
		this.#pasteOverlap = "";
		this.#pasteBytes = 0;
		this.#pendingKittyPrintableCodepoint = undefined;
		this.#partialHoldStartMs = 0;
		this.#escapeSearchOffset = 0;
	}

	getBuffer(): string {
		return this.#buffer;
	}

	destroy(): void {
		this.clear();
	}
}
