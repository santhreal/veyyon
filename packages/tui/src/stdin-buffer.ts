import { EventEmitter } from "events";
import { ESC } from "./ansi";
import { PASTE_END, PASTE_MAX_BYTES, PASTE_START } from "./bracketed-paste";
import { isKittyProtocolActive } from "./keys";

const PASTE_INACTIVITY_TIMEOUT_MS = 1000;
const KITTY_PRINTABLE_DEDUP_WINDOW_MS = 25;
const SGR_MOUSE_PARTIAL = /^\x1b\[<[\d;]*$/;
const PARTIAL_HOLD_MAX_MS = 150;
const MAX_CSI_BYTES = 4096;
const MAX_STRING_SEQ_BYTES = 16 * 1024 * 1024;

const SGR_MOUSE_COMPLETE = /^<\d+;\d+;\d+[Mm]$/;

function resolveEscapeEnd(buffer: string, pos: number, length: number, resumeSearchFrom: number): number {
	if (pos + 1 >= length) return -1;
	const next = buffer.charCodeAt(pos + 1);

	switch (next) {
		case 0x1b /* ESC */:
			return -1;
		case 0x5b /* [ */:
			{
				if (pos + 2 >= length) return -1;
				if (buffer.charCodeAt(pos + 2) === 0x4d /* M */) {
					if (pos + 6 <= length) return pos + 6;
					return -1;
				}
				const capEnd = Math.min(length, pos + MAX_CSI_BYTES);
				const isSgrMouse = buffer.charCodeAt(pos + 2) === 0x3c /* < */;
				let i = pos + 2;
				while (i < capEnd) {
					const code = buffer.charCodeAt(i);
					if (code >= 0x40 && code <= 0x7e) {
						if (isSgrMouse) {
							if (code !== 0x4d && code !== 0x6d) {
								i++;
								continue;
							}
							const payload = buffer.slice(pos + 2, i + 1);
							if (SGR_MOUSE_COMPLETE.test(payload)) return i + 1;
							i++;
							continue;
						}
						return i + 1;
					}
					i++;
				}
				return length - pos >= MAX_CSI_BYTES ? -2 : -1;
			}
		case 0x5d /* ] */:
			{
				const searchFrom = Math.max(pos + 2, resumeSearchFrom - 1);
				const scanLimit = Math.min(length, pos + MAX_STRING_SEQ_BYTES);
				for (let i = searchFrom; i < scanLimit; i++) {
					const code = buffer.charCodeAt(i);
					if (code === 0x07 /* BEL */) return i + 1;
					if (code === 0x1b /* ESC */) {
						if (i + 1 < scanLimit && buffer.charCodeAt(i + 1) === 0x5c /* \ */) return i + 2;
					}
				}
				return length - pos >= MAX_STRING_SEQ_BYTES ? -2 : -1;
			}
		case 0x50 /* P */:
		case 0x5f /* _ */:
			{
				const searchFrom = Math.max(pos + 2, resumeSearchFrom - 1);
				const scanLimit = Math.min(length, pos + MAX_STRING_SEQ_BYTES);
				for (let i = searchFrom; i < scanLimit; i++) {
					if (
						buffer.charCodeAt(i) === 0x1b /* ESC */ &&
						i + 1 < scanLimit &&
						buffer.charCodeAt(i + 1) === 0x5c /* \ */
					) {
						return i + 2;
					}
				}
				return length - pos >= MAX_STRING_SEQ_BYTES ? -2 : -1;
			}
		case 0x4f /* O */:
			return pos + 3 <= length ? pos + 3 : -1;
		default:
			return pos + 2;
	}
}

function escapeCapFor(next: number): number {
	return next === 0x5d || next === 0x50 || next === 0x5f ? MAX_STRING_SEQ_BYTES : MAX_CSI_BYTES;
}

function parseUnmodifiedKittyPrintableCodepoint(sequence: string): number | undefined {
	const match = sequence.match(/^\x1b\[(\d+)(?::\d*)?(?::\d+)?u$/);
	if (!match) return undefined;

	const codepoint = parseInt(match[1]!, 10);
	return codepoint >= 32 ? codepoint : undefined;
}

function extractCompleteSequences(
	buffer: string,
	resumeSearchFrom: number,
): { sequences: string[]; remainder: string; resumeSearchFrom: number } {
	const sequences: string[] = [];
	const length = buffer.length;
	let pos = 0;

	let hint = resumeSearchFrom;

	while (pos < length) {
		if (buffer.charCodeAt(pos) !== 0x1b) {
			const codePoint = buffer.codePointAt(pos)!;
			const charLength = codePoint > 0xffff ? 2 : 1;
			sequences.push(buffer.slice(pos, pos + charLength));
			pos += charLength;
			hint = 0;
			continue;
		}

		if (pos + 1 < length && buffer.charCodeAt(pos + 1) === 0x1b) {
			if (pos + 2 >= length) {
				return { sequences, remainder: buffer.slice(pos), resumeSearchFrom: 0 };
			}
			const third = buffer.charCodeAt(pos + 2);
			if (third !== 0x5b && third !== 0x4f) {
				sequences.push(ESC);
				pos += 1;
				hint = 0;
				continue;
			}
			const innerEnd = resolveEscapeEnd(buffer, pos + 1, length, 0);
			if (innerEnd === -1) {
				return { sequences, remainder: buffer.slice(pos), resumeSearchFrom: 0 };
			}
			if (innerEnd === -2) {
				const cap = escapeCapFor(third);
				const flushEnd = Math.min(length, pos + cap);
				sequences.push(buffer.slice(pos, flushEnd));
				pos = flushEnd;
				hint = 0;
				continue;
			}
			if (third === 0x5b && buffer.charCodeAt(pos + 3) === 0x3c) {
				sequences.push(ESC);
				sequences.push(buffer.slice(pos + 1, innerEnd));
				pos = innerEnd;
				hint = 0;
				continue;
			}
			sequences.push(buffer.slice(pos, innerEnd));
			pos = innerEnd;
			hint = 0;
			continue;
		}

		const end = resolveEscapeEnd(buffer, pos, length, pos === 0 ? hint : 0);
		if (end === -1) {
			const next = pos + 1 < length ? buffer.charCodeAt(pos + 1) : -1;
			const nextHint = pos === 0 && (next === 0x5d || next === 0x50 || next === 0x5f) ? length : 0;
			return { sequences, remainder: buffer.slice(pos), resumeSearchFrom: nextHint };
		}
		if (end === -2) {
			const next = buffer.charCodeAt(pos + 1);
			const cap = escapeCapFor(next);
			const flushEnd = Math.min(length, pos + cap);
			sequences.push(buffer.slice(pos, flushEnd));
			pos = flushEnd;
			hint = 0;
			continue;
		}
		sequences.push(buffer.slice(pos, end));
		pos = end;
		hint = 0;
	}

	return { sequences, remainder: "", resumeSearchFrom: 0 };
}

export type StdinBufferOptions = {
	timeout?: number;
	partialHoldTimeout?: number;
	pasteTimeout?: number;
	pasteByteLimit?: number;
};

export type StdinBufferEventMap = {
	data: [string];
	paste: [string];
};

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
