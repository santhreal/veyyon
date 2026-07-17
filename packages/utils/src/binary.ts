import { Buffer } from "node:buffer";
/**
 * Content-based binary/text classification for files that are about to be
 * decoded as UTF-8 text and shown to a model or user.
 *
 * The read tool and `@file` auto-read both materialize file bytes as UTF-8
 * strings. For a binary file (font, object, archive, packed blob) that decode
 * is lossy: NUL bytes and invalid sequences survive as control characters and
 * U+FFFD replacements, which corrupt terminal rendering and waste the context
 * window with mojibake. Sniff the header first and refuse instead.
 *
 * @example
 * if (await isProbablyBinary(path)) return "[binary file omitted]";
 * const text = await Bun.file(path).text();
 */
import { peekFile, peekFileSync } from "./peek-file";

/** Header window sniffed for the binary heuristic; mirrors git's 8000-byte scan. */
const BINARY_SNIFF_BYTES = 8192;

/**
 * Classify an in-memory byte header as binary (non-UTF-8-text).
 *
 * Binary when the header contains a NUL byte (true binary, plus UTF-16/UTF-32
 * text whose ASCII range is NUL-padded) or when it is not valid UTF-8. The
 * decode runs in streaming mode so a multibyte sequence truncated at the header
 * boundary is tolerated, while any genuinely invalid byte still fails — matching
 * the strict `fatal` decode the `local://`/`ssh://` read paths already use.
 */
export function isProbablyBinaryHeader(header: Uint8Array): boolean {
	if (header.indexOf(0) !== -1) return true;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(header, { stream: true });
		return false;
	} catch {
		return true;
	}
}

/**
 * Sniff the first {@link BINARY_SNIFF_BYTES} of `filePath` and report whether it
 * is binary (non-UTF-8-text). See {@link isProbablyBinaryHeader} for the rule.
 */
export function isProbablyBinary(filePath: string, maxBytes = BINARY_SNIFF_BYTES): Promise<boolean> {
	return peekFile(filePath, maxBytes, isProbablyBinaryHeader);
}

/** Synchronous {@link isProbablyBinary}. */
export function isProbablyBinarySync(filePath: string, maxBytes = BINARY_SNIFF_BYTES): boolean {
	return peekFileSync(filePath, maxBytes, isProbablyBinaryHeader);
}

const HEX_DIGITS = "0123456789abcdef";

/** Lowercase hex encoding of a byte buffer (digests, signatures, cache keys). */
export function bytesToHex(bytes: Uint8Array | ArrayBuffer): string {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let out = "";
	for (let i = 0; i < view.length; i++) {
		const b = view[i];
		out += HEX_DIGITS[b >> 4] + HEX_DIGITS[b & 15];
	}
	return out;
}

/** First 16 bytes of every SQLite database file: "SQLite format 3\0". */
export const SQLITE_MAGIC = new Uint8Array([
	0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
]);

/** True when the buffer starts with the SQLite database magic header. */
export function looksLikeSqlite(bytes: Uint8Array): boolean {
	if (bytes.byteLength < SQLITE_MAGIC.byteLength) return false;
	for (const [index, byte] of SQLITE_MAGIC.entries()) {
		if (bytes[index] !== byte) return false;
	}
	return true;
}

/**
 * Coerce a Uint8Array to one backed by a plain `ArrayBuffer` it fully covers,
 * copying when the input is a view, offset slice, or SharedArrayBuffer-backed.
 * Needed for APIs typed against `Uint8Array<ArrayBuffer>` (e.g. WebCrypto).
 */
export function toStrictUint8Array(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
		return bytes as Uint8Array<ArrayBuffer>;
	}
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}

/** UTF-8 encoded byte length of a string. */
export function utf8ByteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

/** Strict UTF-8 decode: null on any invalid byte sequence. */
export function decodeStrictUtf8(bytes: Uint8Array): string | null {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}
