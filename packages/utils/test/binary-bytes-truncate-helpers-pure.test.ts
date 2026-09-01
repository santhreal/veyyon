import { describe, expect, it } from "bun:test";
import { isProbablyBinaryHeader } from "../src/binary";
import { capTextBytes, elisionMarker, truncateHeadBytes, truncateTailBytes } from "../src/byte-truncate";
import { asStrictBytes } from "../src/bytes";

describe("isProbablyBinaryHeader", () => {
	it("returns false for plain ASCII text", () => {
		expect(isProbablyBinaryHeader(new TextEncoder().encode("hello world"))).toBe(false);
	});
	it("returns true for header with NUL byte", () => {
		const data = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00]);
		expect(isProbablyBinaryHeader(data)).toBe(true);
	});
	it("returns false for valid UTF-8 with multibyte chars", () => {
		expect(isProbablyBinaryHeader(new TextEncoder().encode("héllo wörld"))).toBe(false);
	});
	it("returns false for empty array", () => {
		expect(isProbablyBinaryHeader(new Uint8Array(0))).toBe(false);
	});
	it("returns true for invalid UTF-8 bytes", () => {
		const data = new Uint8Array([0xff, 0xfe, 0xfd]);
		expect(isProbablyBinaryHeader(data)).toBe(true);
	});
	it("returns false for emoji (valid UTF-8)", () => {
		expect(isProbablyBinaryHeader(new TextEncoder().encode("😀🌍"))).toBe(false);
	});
	it("returns true for UTF-16 LE with NUL padding", () => {
		// "hi" in UTF-16 LE: h=0x68 0x00, i=0x69 0x00
		const data = new Uint8Array([0x68, 0x00, 0x69, 0x00]);
		expect(isProbablyBinaryHeader(data)).toBe(true);
	});
	it("handles truncated multibyte sequence (stream mode)", () => {
		// Start of a 3-byte UTF-8 char truncated at 1 byte
		const data = new Uint8Array([0xe0]);
		expect(isProbablyBinaryHeader(data)).toBe(false);
	});
});

describe("asStrictBytes", () => {
	it("returns same array when it spans whole buffer", () => {
		const arr = new Uint8Array([1, 2, 3]);
		const result = asStrictBytes(arr);
		expect(result).toBe(arr);
	});
	it("copies subarray (partial view)", () => {
		const backing = new Uint8Array([1, 2, 3, 4, 5]);
		const sub = backing.subarray(1, 4);
		const result = asStrictBytes(sub);
		expect(result).not.toBe(sub);
		expect(Array.from(result)).toEqual([2, 3, 4]);
		expect(result.byteLength).toBe(3);
	});
	it("copies when byteOffset is non-zero", () => {
		const backing = new Uint8Array(10);
		const view = new Uint8Array(backing.buffer, 2, 5);
		const result = asStrictBytes(view);
		expect(result).not.toBe(view);
		expect(result.byteLength).toBe(5);
	});
	it("result has its own ArrayBuffer", () => {
		const backing = new Uint8Array([1, 2, 3, 4]);
		const sub = backing.subarray(1, 3);
		const result = asStrictBytes(sub);
		expect(result.buffer).toBeInstanceOf(ArrayBuffer);
		expect(result.byteOffset).toBe(0);
	});
	it("does not copy full-buffer view", () => {
		const arr = new Uint8Array(5);
		arr[0] = 42;
		const result = asStrictBytes(arr);
		expect(result).toBe(arr);
	});
});

describe("truncateHeadBytes", () => {
	it("returns full text when under limit", () => {
		const result = truncateHeadBytes("hello", 100);
		expect(result.text).toBe("hello");
		expect(result.bytes).toBe(5);
	});
	it("truncates to byte limit", () => {
		const result = truncateHeadBytes("hello world", 5);
		expect(result.text).toBe("hello");
		expect(result.bytes).toBe(5);
	});
	it("returns empty for maxBytes=0", () => {
		const result = truncateHeadBytes("hello", 0);
		expect(result.text).toBe("");
		expect(result.bytes).toBe(0);
	});
	it("returns empty for negative maxBytes", () => {
		const result = truncateHeadBytes("hello", -1);
		expect(result.text).toBe("");
		expect(result.bytes).toBe(0);
	});
	it("does not split multibyte UTF-8", () => {
		// "héllo" = h(1) + é(2) + l(1) + l(1) + o(1) = 6 bytes
		// Truncating at 2 bytes should keep "h" (1 byte), not split é
		const result = truncateHeadBytes("héllo", 2);
		expect(result.text).toBe("h");
		expect(result.bytes).toBe(1);
	});
	it("handles Uint8Array input", () => {
		const data = new TextEncoder().encode("hello world");
		const result = truncateHeadBytes(data, 5);
		expect(result.text).toBe("hello");
		expect(result.bytes).toBe(5);
	});
	it("handles emoji correctly", () => {
		// 😀 is 4 bytes
		const result = truncateHeadBytes("😀😀😀", 5);
		expect(result.bytes).toBe(4);
		expect(result.text).toBe("😀");
	});
});

describe("truncateTailBytes", () => {
	it("returns full text when under limit", () => {
		const result = truncateTailBytes("hello", 100);
		expect(result.text).toBe("hello");
		expect(result.bytes).toBe(5);
	});
	it("truncates keeping tail", () => {
		const result = truncateTailBytes("hello world", 5);
		expect(result.text).toBe("world");
		expect(result.bytes).toBe(5);
	});
	it("returns empty for maxBytes=0", () => {
		const result = truncateTailBytes("hello", 0);
		expect(result.text).toBe("");
		expect(result.bytes).toBe(0);
	});
	it("does not split multibyte UTF-8", () => {
		// "héllo" = 6 bytes, tail at 4 bytes should keep "llo" (3 bytes)
		const result = truncateTailBytes("héllo", 4);
		expect(result.bytes).toBe(3);
		expect(result.text).toBe("llo");
	});
	it("handles Uint8Array input", () => {
		const data = new TextEncoder().encode("hello world");
		const result = truncateTailBytes(data, 5);
		expect(result.text).toBe("world");
		expect(result.bytes).toBe(5);
	});
});

describe("capTextBytes", () => {
	it("returns text unchanged when under limit", () => {
		const result = capTextBytes("hello", 100);
		expect(result.text).toBe("hello");
		expect(result.elidedBytes).toBe(0);
		expect(result.originalBytes).toBe(5);
	});
	it("returns text unchanged for maxBytes=0 (unbounded)", () => {
		const result = capTextBytes("hello", 0);
		expect(result.text).toBe("hello");
		expect(result.elidedBytes).toBe(0);
	});
	it("returns text unchanged for negative maxBytes", () => {
		const result = capTextBytes("hello", -1);
		expect(result.text).toBe("hello");
		expect(result.elidedBytes).toBe(0);
	});
	it("caps text with head and tail", () => {
		const long = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10";
		const result = capTextBytes(long, 30);
		expect(result.elidedBytes).toBeGreaterThan(0);
		expect(result.text).toContain("…");
	});
	it("includes elision marker", () => {
		const long = "a".repeat(1000);
		const result = capTextBytes(long, 100);
		expect(result.text).toContain("elided");
		expect(result.text).toContain("B");
	});
	it("originalBytes matches input byte length", () => {
		const text = "héllo wörld";
		const result = capTextBytes(text, 5);
		expect(result.originalBytes).toBe(Buffer.byteLength(text, "utf-8"));
	});
});

describe("elisionMarker", () => {
	it("formats marker with byte count", () => {
		expect(elisionMarker(42)).toBe("[…42B elided…]");
	});
	it("handles zero bytes", () => {
		expect(elisionMarker(0)).toBe("[…0B elided…]");
	});
	it("handles large byte counts", () => {
		expect(elisionMarker(1_000_000)).toBe("[…1000000B elided…]");
	});
});
