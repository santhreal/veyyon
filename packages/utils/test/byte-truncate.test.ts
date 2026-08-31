import { describe, expect, it } from "bun:test";
import { capTextBytes, elisionMarker, truncateHeadBytes, truncateTailBytes } from "../src/byte-truncate";

describe("truncateHeadBytes", () => {
	it("returns empty text for zero or negative maxBytes", () => {
		expect(truncateHeadBytes("hello", 0)).toEqual({ text: "", bytes: 0 });
		expect(truncateHeadBytes("hello", -1)).toEqual({ text: "", bytes: 0 });
	});

	it("returns full string when within byte budget", () => {
		const result = truncateHeadBytes("hello", 100);
		expect(result.text).toBe("hello");
		expect(result.bytes).toBe(5);
	});

	it("returns full string when string length equals maxBytes but all ASCII", () => {
		const result = truncateHeadBytes("hello", 5);
		expect(result.text).toBe("hello");
		expect(result.bytes).toBe(5);
	});

	it("truncates ASCII string at byte boundary", () => {
		const result = truncateHeadBytes("hello world", 5);
		expect(result.text).toBe("hello");
		expect(result.bytes).toBe(5);
	});

	it("truncates at UTF-8 boundary for multi-byte chars", () => {
		// "héllo" = h(1) + é(2) + l(1) + l(1) + o(1) = 6 bytes
		// Truncating at 2 bytes should give "h" (1 byte), not split é
		const result = truncateHeadBytes("héllo", 2);
		expect(result.text).toBe("h");
		expect(result.bytes).toBe(1);
	});

	it("truncates at exact multi-byte boundary", () => {
		// "ééé" = 6 bytes, truncating at 2 gives "é"
		const result = truncateHeadBytes("ééé", 2);
		expect(result.text).toBe("é");
		expect(result.bytes).toBe(2);
	});

	it("handles emoji (4-byte UTF-8)", () => {
		// "a😀b" = a(1) + 😀(4) + b(1) = 6 bytes
		// Truncating at 3 bytes should give "a" (1 byte), not split the emoji
		const result = truncateHeadBytes("a😀b", 3);
		expect(result.text).toBe("a");
		expect(result.bytes).toBe(1);
	});

	it("returns empty when truncation point is before first char", () => {
		// "é" is 2 bytes, truncating at 1 byte gives nothing
		const result = truncateHeadBytes("é", 1);
		expect(result.text).toBe("");
		expect(result.bytes).toBe(0);
	});

	it("handles Uint8Array input", () => {
		const buf = Buffer.from("hello world", "utf-8");
		const result = truncateHeadBytes(buf, 5);
		expect(result.text).toBe("hello");
		expect(result.bytes).toBe(5);
	});

	it("handles Uint8Array with multi-byte chars", () => {
		const buf = Buffer.from("héllo", "utf-8");
		const result = truncateHeadBytes(buf, 2);
		expect(result.text).toBe("h");
		expect(result.bytes).toBe(1);
	});

	it("returns full Uint8Array when within budget", () => {
		const buf = Buffer.from("hi", "utf-8");
		const result = truncateHeadBytes(buf, 100);
		expect(result.text).toBe("hi");
		expect(result.bytes).toBe(2);
	});

	it("handles empty string", () => {
		const result = truncateHeadBytes("", 10);
		expect(result.text).toBe("");
		expect(result.bytes).toBe(0);
	});

	it("handles string shorter than maxBytes but with multi-byte chars", () => {
		// "é" has length 1 but 2 bytes; maxBytes=10 > length=1 so it checks byteLength
		const result = truncateHeadBytes("é", 10);
		expect(result.text).toBe("é");
		expect(result.bytes).toBe(2);
	});
});

describe("truncateTailBytes", () => {
	it("returns empty text for zero or negative maxBytes", () => {
		expect(truncateTailBytes("hello", 0)).toEqual({ text: "", bytes: 0 });
		expect(truncateTailBytes("hello", -1)).toEqual({ text: "", bytes: 0 });
	});

	it("returns full string when within byte budget", () => {
		const result = truncateTailBytes("hello", 100);
		expect(result.text).toBe("hello");
		expect(result.bytes).toBe(5);
	});

	it("truncates ASCII string keeping the tail", () => {
		const result = truncateTailBytes("hello world", 5);
		expect(result.text).toBe("world");
		expect(result.bytes).toBe(5);
	});

	it("truncates at UTF-8 boundary for multi-byte chars in tail", () => {
		// "héllo" = 6 bytes, tail of 3 bytes should give "llo" (3 bytes)
		const result = truncateTailBytes("héllo", 3);
		expect(result.text).toBe("llo");
		expect(result.bytes).toBe(3);
	});

	it("handles emoji in tail", () => {
		// "a😀b" = 6 bytes, tail of 3 bytes should give "b" (1 byte)
		// because 😀 starts at byte offset 1 and is 4 bytes, so start=4, giving "b"
		const result = truncateTailBytes("a😀b", 3);
		expect(result.text).toBe("b");
		expect(result.bytes).toBe(1);
	});

	it("handles Uint8Array input", () => {
		const buf = Buffer.from("hello world", "utf-8");
		const result = truncateTailBytes(buf, 5);
		expect(result.text).toBe("world");
		expect(result.bytes).toBe(5);
	});

	it("handles empty string", () => {
		const result = truncateTailBytes("", 10);
		expect(result.text).toBe("");
		expect(result.bytes).toBe(0);
	});

	it("handles string shorter than maxBytes with multi-byte chars", () => {
		const result = truncateTailBytes("é", 10);
		expect(result.text).toBe("é");
		expect(result.bytes).toBe(2);
	});

	it("handles exact byte boundary in tail", () => {
		// "ééé" = 6 bytes, tail of 4 bytes should give "éé" (4 bytes)
		const result = truncateTailBytes("ééé", 4);
		expect(result.text).toBe("éé");
		expect(result.bytes).toBe(4);
	});
});

describe("capTextBytes", () => {
	it("returns original text when within budget", () => {
		const result = capTextBytes("hello", 100);
		expect(result.text).toBe("hello");
		expect(result.originalBytes).toBe(5);
		expect(result.elidedBytes).toBe(0);
	});

	it("returns original text for zero maxBytes", () => {
		const result = capTextBytes("hello", 0);
		expect(result.text).toBe("hello");
		expect(result.elidedBytes).toBe(0);
	});

	it("caps text with head and tail portions", () => {
		const longText = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10";
		const result = capTextBytes(longText, 30);
		expect(result.originalBytes).toBe(Buffer.byteLength(longText, "utf-8"));
		expect(result.elidedBytes).toBeGreaterThan(0);
		expect(result.text).toContain("…");
		expect(result.text).toContain("elided");
	});

	it("includes elision marker in capped text", () => {
		const longText = "a".repeat(200);
		const result = capTextBytes(longText, 50);
		expect(result.text).toContain("elided");
		expect(result.elidedBytes).toBeGreaterThan(0);
	});

	it("preserves head and tail content", () => {
		const longText = "HEAD_DATA\nmiddle\nTAIL_DATA";
		// Make it long enough to trigger capping
		const text = "HEAD_DATA\n" + "x".repeat(200) + "\nTAIL_DATA";
		const result = capTextBytes(text, 60);
		expect(result.text).toContain("HEAD_DATA");
		expect(result.text).toContain("TAIL_DATA");
	});

	it("handles multi-byte text", () => {
		const longText = "é".repeat(100);
		const result = capTextBytes(longText, 50);
		expect(result.originalBytes).toBe(200);
		expect(result.elidedBytes).toBeGreaterThan(0);
	});
});

describe("elisionMarker", () => {
	it("formats byte count in marker", () => {
		expect(elisionMarker(100)).toBe("[…100B elided…]");
	});

	it("handles zero bytes", () => {
		expect(elisionMarker(0)).toBe("[…0B elided…]");
	});

	it("handles large byte counts", () => {
		expect(elisionMarker(1048576)).toBe("[…1048576B elided…]");
	});
});
