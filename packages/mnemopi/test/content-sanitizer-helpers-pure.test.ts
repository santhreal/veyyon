import { describe, expect, it } from "bun:test";
import {
	computeSha256,
	ENTROPY_THRESHOLD,
	isDataUri,
	looksLikeBase64Blob,
	parseDataUri,
	SIZE_BASE64_CHECK,
	SIZE_HARD_CAP,
	shannonEntropy,
} from "../src/core/content-sanitizer";

describe("constants", () => {
	it("SIZE_HARD_CAP is 1_000_000", () => {
		expect(SIZE_HARD_CAP).toBe(1_000_000);
	});
	it("SIZE_BASE64_CHECK is 100_000", () => {
		expect(SIZE_BASE64_CHECK).toBe(100_000);
	});
	it("ENTROPY_THRESHOLD is 5.0", () => {
		expect(ENTROPY_THRESHOLD).toBe(5.0);
	});
});

describe("computeSha256", () => {
	it("computes hash for string", () => {
		const hash = computeSha256("hello");
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});
	it("computes hash for Uint8Array", () => {
		const hash = computeSha256(new TextEncoder().encode("hello"));
		expect(hash).toBe(computeSha256("hello"));
	});
	it("is deterministic", () => {
		expect(computeSha256("test")).toBe(computeSha256("test"));
	});
	it("returns different hashes for different inputs", () => {
		expect(computeSha256("a")).not.toBe(computeSha256("b"));
	});
	it("known hash for 'hello'", () => {
		expect(computeSha256("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
	});
	it("hashes empty string", () => {
		expect(computeSha256("")).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("isDataUri", () => {
	it("returns true for data: prefix", () => {
		expect(isDataUri("data:text/plain,hello")).toBe(true);
	});
	it("returns true for data:image/png;base64,...", () => {
		expect(isDataUri("data:image/png;base64,abc123")).toBe(true);
	});
	it("returns false for non-data URI", () => {
		expect(isDataUri("https://example.com/image.png")).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(isDataUri("")).toBe(false);
	});
	it("returns false for similar prefix", () => {
		expect(isDataUri("datauri:text/plain,hello")).toBe(false);
	});
});

describe("parseDataUri", () => {
	it("parses simple data URI with base64 payload", () => {
		const result = parseDataUri("data:text/plain;base64,aGVsbG8=");
		expect(result).not.toBeNull();
		expect(result![0]).toBe("text/plain");
		expect(result![1].toString()).toBe("hello");
	});
	it("parses base64 data URI", () => {
		const result = parseDataUri("data:image/png;base64,aGVsbG8=");
		expect(result).not.toBeNull();
		expect(result![0]).toBe("image/png");
		expect(result![1].toString()).toBe("hello");
	});
	it("returns null for non-data URI", () => {
		expect(parseDataUri("https://example.com")).toBeNull();
	});
	it("returns null for empty string", () => {
		expect(parseDataUri("")).toBeNull();
	});
	it("defaults mime type to application/octet-stream", () => {
		const result = parseDataUri("data:;base64,aGVsbG8=");
		expect(result).not.toBeNull();
		expect(result![0]).toBe("application/octet-stream");
	});
	it("returns null for invalid base64 payload", () => {
		expect(parseDataUri("data:text/plain;base64,!!!invalid!!!")).toBeNull();
	});
});

describe("shannonEntropy", () => {
	it("returns 0 for empty string", () => {
		expect(shannonEntropy("")).toBe(0.0);
	});
	it("returns 0 for single character", () => {
		expect(shannonEntropy("aaaa")).toBe(0.0);
	});
	it("returns 1 for two equally likely characters", () => {
		expect(shannonEntropy("ab")).toBeCloseTo(1.0, 5);
	});
	it("returns 2 for four equally likely characters", () => {
		expect(shannonEntropy("abcd")).toBeCloseTo(2.0, 5);
	});
	it("returns higher entropy for diverse text", () => {
		expect(shannonEntropy("abcdefgh")).toBeGreaterThan(shannonEntropy("aaaaaaaa"));
	});
	it("returns 8 for 256 unique characters (approx)", () => {
		const chars = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join("");
		expect(shannonEntropy(chars)).toBeCloseTo(8.0, 1);
	});
	it("handles repeated patterns", () => {
		const entropy = shannonEntropy("abcabcabc");
		expect(entropy).toBeCloseTo(Math.log2(3), 5);
	});
});

describe("looksLikeBase64Blob", () => {
	it("returns false for short content", () => {
		expect(looksLikeBase64Blob("short")).toBe(false);
	});
	it("returns false for low-entropy long content", () => {
		const lowEntropy = "a".repeat(SIZE_BASE64_CHECK + 1);
		expect(looksLikeBase64Blob(lowEntropy)).toBe(false);
	});
	it("returns true for high-entropy long content", () => {
		// Generate high-entropy base64-like content
		const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
		let highEntropy = "";
		for (let i = 0; i < SIZE_BASE64_CHECK + 100; i++) {
			highEntropy += chars[i % chars.length];
		}
		expect(looksLikeBase64Blob(highEntropy)).toBe(true);
	});
	it("returns false at exactly SIZE_BASE64_CHECK with low entropy", () => {
		expect(looksLikeBase64Blob("a".repeat(SIZE_BASE64_CHECK))).toBe(false);
	});
});
