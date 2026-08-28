const NL = "\n";

export interface ByteTruncationResult {
	text: string;
	bytes: number;
}

function asBuffer(data: Uint8Array): Buffer {
	return Buffer.isBuffer(data) ? (data as Buffer) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function findUtf8BoundaryForward(buf: Buffer, pos: number): number {
	let i = Math.max(0, pos);
	while (i < buf.length && (buf[i] & 0xc0) === 0x80) i++;
	return i;
}

function findUtf8BoundaryBackward(buf: Buffer, cut: number): number {
	let i = Math.min(buf.length, Math.max(0, cut));
	if (i >= buf.length) return buf.length;
	while (i > 0 && (buf[i] & 0xc0) === 0x80) i--;
	return i;
}

function truncateBytesWindowed(
	data: string | Uint8Array,
	maxBytes: number,
	mode: "head" | "tail",
): ByteTruncationResult {
	if (maxBytes <= 0) return { text: "", bytes: 0 };

	if (typeof data === "string") {
		if (data.length <= maxBytes) {
			const len = Buffer.byteLength(data, "utf-8");
			if (len <= maxBytes) return { text: data, bytes: len };
		}

		const window =
			mode === "head"
				? data.substring(0, Math.min(data.length, maxBytes))
				: data.substring(Math.max(0, data.length - maxBytes));
		const buf = Buffer.from(window, "utf-8");

		if (mode === "head") {
			const end = findUtf8BoundaryBackward(buf, maxBytes);
			if (end <= 0) return { text: "", bytes: 0 };
			const slice = buf.subarray(0, end);
			return { text: slice.toString("utf-8"), bytes: slice.length };
		}
		const start = findUtf8BoundaryForward(buf, Math.max(0, buf.length - maxBytes));
		const slice = buf.subarray(start);
		return { text: slice.toString("utf-8"), bytes: slice.length };
	}

	const buf = asBuffer(data);
	if (buf.length <= maxBytes) return { text: buf.toString("utf-8"), bytes: buf.length };

	if (mode === "head") {
		const end = findUtf8BoundaryBackward(buf, maxBytes);
		if (end <= 0) return { text: "", bytes: 0 };
		const slice = buf.subarray(0, end);
		return { text: slice.toString("utf-8"), bytes: slice.length };
	}
	const start = findUtf8BoundaryForward(buf, buf.length - maxBytes);
	const slice = buf.subarray(start);
	return { text: slice.toString("utf-8"), bytes: slice.length };
}

export function truncateTailBytes(data: string | Uint8Array, maxBytes: number): ByteTruncationResult {
	return truncateBytesWindowed(data, maxBytes, "tail");
}

export function truncateHeadBytes(data: string | Uint8Array, maxBytes: number): ByteTruncationResult {
	return truncateBytesWindowed(data, maxBytes, "head");
}

function trimHeadToLineBoundary(text: string): string {
	const idx = text.lastIndexOf(NL);
	return idx > 0 ? text.substring(0, idx) : text;
}

function trimTailToLineBoundary(text: string): string {
	const idx = text.indexOf(NL);
	if (idx < 0 || idx === text.length - 1) return text;
	return text.substring(idx + 1);
}

export interface TextByteCapResult {
	text: string;
	originalBytes: number;
	elidedBytes: number;
}

const HEAD_SHARE = 0.6;
const TAIL_SHARE = 0.25;

export function capTextBytes(text: string, maxBytes: number): TextByteCapResult {
	const originalBytes = Buffer.byteLength(text, "utf-8");
	if (maxBytes <= 0 || originalBytes <= maxBytes) return { text, originalBytes, elidedBytes: 0 };

	const head = trimHeadToLineBoundary(truncateHeadBytes(text, Math.floor(maxBytes * HEAD_SHARE)).text);
	const tail = trimTailToLineBoundary(truncateTailBytes(text, Math.floor(maxBytes * TAIL_SHARE)).text);
	const elidedBytes = Math.max(0, originalBytes - Buffer.byteLength(head, "utf-8") - Buffer.byteLength(tail, "utf-8"));
	return { text: `${head}\n${elisionMarker(elidedBytes)}\n${tail}`, originalBytes, elidedBytes };
}

export function elisionMarker(elidedBytes: number): string {
	return `[…${elidedBytes}B elided…]`;
}
