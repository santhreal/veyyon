const LF = 0x0a;
const CR = 0x0d;

const decoder = new TextDecoder();

export interface JsonlByteSkip {
	offset: number;
	length: number;
}

export interface VisitJsonlBytesOptions<T> {
	decode?: (text: string) => T | undefined;
	onSkip?: (skip: JsonlByteSkip) => void;
}

function lineText(bytes: Uint8Array, start: number, end: number): string {
	let contentEnd = end;
	while (contentEnd > start && bytes[contentEnd - 1] === CR) contentEnd--;
	return decoder.decode(bytes.subarray(start, contentEnd));
}

function decodeJson<T>(text: string): T | undefined {
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

export function decodeJsonlLine<T = unknown>(
	bytes: Uint8Array,
	options?: { decode?: (text: string) => T | undefined },
): T | undefined {
	const text = lineText(bytes, 0, bytes.length);
	if (text.length === 0) return undefined;
	return options?.decode ? options.decode(text) : decodeJson<T>(text);
}

export function visitJsonlBytes<T = unknown>(
	bytes: Uint8Array,
	visit: (item: T) => void,
	options?: VisitJsonlBytesOptions<T>,
): number {
	const custom = options?.decode;
	const onSkip = options?.onSkip;
	let cursor = 0;
	let read = 0;

	while (cursor < bytes.length) {
		const newline = bytes.indexOf(LF, cursor);
		const hasNewline = newline !== -1;
		const lineEnd = hasNewline ? newline : bytes.length;

		let contentEnd = lineEnd;
		if (contentEnd > cursor && bytes[contentEnd - 1] === CR) {
			contentEnd--;
			while (contentEnd > cursor && bytes[contentEnd - 1] === CR) contentEnd--;
		}

		if (contentEnd <= cursor) {
			if (!hasNewline) break;
			cursor = newline + 1;
			read = cursor;
			continue;
		}

		let item: T | undefined;
		if (custom === undefined) {
			try {
				item = JSON.parse(decoder.decode(bytes.subarray(cursor, contentEnd))) as T;
			} catch {
				item = undefined;
			}
		} else {
			item = custom(decoder.decode(bytes.subarray(cursor, contentEnd)));
		}

		if (item !== undefined) {
			visit(item);
			read = hasNewline ? newline + 1 : lineEnd;
		} else if (hasNewline) {
			onSkip?.({ offset: cursor, length: contentEnd - cursor });
			read = newline + 1;
		} else {
			break;
		}

		cursor = hasNewline ? newline + 1 : lineEnd;
	}

	return read;
}

export interface JsonlBytesResult<T> {
	items: T[];
	read: number;
}

export function parseJsonlBytes<T = unknown>(
	bytes: Uint8Array,
	options?: VisitJsonlBytesOptions<T>,
): JsonlBytesResult<T> {
	const items: T[] = [];
	const read = visitJsonlBytes<T>(bytes, item => items.push(item), options);
	return { items, read };
}
