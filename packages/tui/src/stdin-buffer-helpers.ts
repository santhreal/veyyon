import { ESC } from "./ansi";

export const PASTE_INACTIVITY_TIMEOUT_MS = 1000;
export const KITTY_PRINTABLE_DEDUP_WINDOW_MS = 25;
export const SGR_MOUSE_PARTIAL = /^\x1b\[<[\d;]*$/;
export const PARTIAL_HOLD_MAX_MS = 150;
export const MAX_CSI_BYTES = 4096;
export const MAX_STRING_SEQ_BYTES = 16 * 1024 * 1024;

export const SGR_MOUSE_COMPLETE = /^<\d+;\d+;\d+[Mm]$/;

export function resolveEscapeEnd(buffer: string, pos: number, length: number, resumeSearchFrom: number): number {
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

export function parseUnmodifiedKittyPrintableCodepoint(sequence: string): number | undefined {
	const match = sequence.match(/^\x1b\[(\d+)(?::\d*)?(?::\d+)?u$/);
	if (!match) return undefined;

	const codepoint = parseInt(match[1]!, 10);
	return codepoint >= 32 ? codepoint : undefined;
}

export function extractCompleteSequences(
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
