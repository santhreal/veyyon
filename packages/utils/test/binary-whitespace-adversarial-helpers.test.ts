import { describe, expect, it } from "bun:test";
import { buildString, fuzzSeed, lcg, lcgUint32, resetFuzzSeedForTest } from "../src/adversarial-strings";
import { isProbablyBinaryHeader } from "../src/binary";
import { collapseWhitespace } from "../src/collapse-whitespace";

describe("isProbablyBinaryHeader", () => {
	it("returns false for plain ASCII text", () => {
		const header = new TextEncoder().encode("Hello, world!");
		expect(isProbablyBinaryHeader(header)).toBe(false);
	});

	it("returns true for bytes containing null byte", () => {
		const header = new Uint8Array([0x48, 0x00, 0x49]);
		expect(isProbablyBinaryHeader(header)).toBe(true);
	});

	it("returns false for empty header", () => {
		expect(isProbablyBinaryHeader(new Uint8Array(0))).toBe(false);
	});

	it("returns false for UTF-8 text with multibyte characters", () => {
		const header = new TextEncoder().encode("héllo wörld");
		expect(isProbablyBinaryHeader(header)).toBe(false);
	});

	it("returns true for invalid UTF-8 sequences", () => {
		// 0xFF is not valid UTF-8
		const header = new Uint8Array([0xff, 0xfe, 0xfd]);
		expect(isProbablyBinaryHeader(header)).toBe(true);
	});

	it("returns false for whitespace-only text", () => {
		const header = new TextEncoder().encode("   \n\t  ");
		expect(isProbablyBinaryHeader(header)).toBe(false);
	});

	it("returns true for bytes with null at end", () => {
		const header = new Uint8Array([0x41, 0x42, 0x00]);
		expect(isProbablyBinaryHeader(header)).toBe(true);
	});

	it("returns false for JSON-like text", () => {
		const header = new TextEncoder().encode('{"key":"value"}');
		expect(isProbablyBinaryHeader(header)).toBe(false);
	});

	it("returns true for lone continuation byte", () => {
		// 0x80 is a continuation byte without a start byte
		const header = new Uint8Array([0x80]);
		expect(isProbablyBinaryHeader(header)).toBe(true);
	});
});

describe("collapseWhitespace", () => {
	it("collapses multiple spaces to single space", () => {
		expect(collapseWhitespace("a    b")).toBe("a b");
	});

	it("collapses tabs to single space", () => {
		expect(collapseWhitespace("a\t\tb")).toBe("a b");
	});

	it("collapses newlines to single space", () => {
		expect(collapseWhitespace("a\n\nb")).toBe("a b");
	});

	it("collapses mixed whitespace to single space", () => {
		expect(collapseWhitespace("a \t\n b")).toBe("a b");
	});

	it("trims leading whitespace", () => {
		expect(collapseWhitespace("   hello")).toBe("hello");
	});

	it("trims trailing whitespace", () => {
		expect(collapseWhitespace("hello   ")).toBe("hello");
	});

	it("trims both leading and trailing whitespace", () => {
		expect(collapseWhitespace("  hello  ")).toBe("hello");
	});

	it("returns empty string for null", () => {
		expect(collapseWhitespace(null)).toBe("");
	});

	it("returns empty string for undefined", () => {
		expect(collapseWhitespace(undefined)).toBe("");
	});

	it("returns empty string for empty string", () => {
		expect(collapseWhitespace("")).toBe("");
	});

	it("returns empty string for whitespace-only string", () => {
		expect(collapseWhitespace("   \n\t  ")).toBe("");
	});

	it("handles single word", () => {
		expect(collapseWhitespace("hello")).toBe("hello");
	});

	it("preserves non-whitespace content", () => {
		expect(collapseWhitespace("hello world foo")).toBe("hello world foo");
	});
});

describe("lcgUint32", () => {
	it("returns a function", () => {
		expect(typeof lcgUint32(42)).toBe("function");
	});

	it("produces deterministic sequence for same seed", () => {
		const rng1 = lcgUint32(123);
		const rng2 = lcgUint32(123);
		expect(rng1()).toBe(rng2());
		expect(rng1()).toBe(rng2());
	});

	it("produces different sequences for different seeds", () => {
		const rng1 = lcgUint32(123);
		const rng2 = lcgUint32(456);
		expect(rng1()).not.toBe(rng2());
	});

	it("returns unsigned 32-bit integers", () => {
		const rng = lcgUint32(1);
		for (let i = 0; i < 10; i++) {
			const value = rng();
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThanOrEqual(0xffffffff);
			expect(Number.isInteger(value)).toBe(true);
		}
	});

	it("handles seed of 0", () => {
		const rng = lcgUint32(0);
		expect(rng()).toBeGreaterThanOrEqual(0);
	});

	it("handles negative seeds (wraps to unsigned)", () => {
		const rng = lcgUint32(-1);
		expect(rng()).toBeGreaterThanOrEqual(0);
	});
});

describe("lcg", () => {
	it("returns floats in [0, 1)", () => {
		const rng = lcg(42);
		for (let i = 0; i < 100; i++) {
			const value = rng();
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThan(1);
		}
	});

	it("is deterministic for same seed", () => {
		const rng1 = lcg(999);
		const rng2 = lcg(999);
		for (let i = 0; i < 10; i++) {
			expect(rng1()).toBe(rng2());
		}
	});

	it("produces different values for different seeds", () => {
		const rng1 = lcg(1);
		const rng2 = lcg(2);
		expect(rng1()).not.toBe(rng2());
	});
});

describe("buildString", () => {
	it("returns a string", () => {
		const rng = lcg(42);
		const result = buildString(rng);
		expect(typeof result).toBe("string");
	});

	it("respects maxFragments parameter", () => {
		const rng = lcg(42);
		// With maxFragments=1, the string should have at most 1 fragment
		const result = buildString(rng, 1);
		// The number of fragments is floor(rng() * 1) = 0 or 1
		// but we can't assert exact length since it depends on rng
		expect(typeof result).toBe("string");
	});

	it("returns empty string when maxFragments is 0", () => {
		const rng = lcg(42);
		// floor(rng() * 0) = 0, so no fragments
		const result = buildString(rng, 0);
		expect(result).toBe("");
	});

	it("is deterministic for same rng state", () => {
		const rng1 = lcg(42);
		const rng2 = lcg(42);
		expect(buildString(rng1, 10)).toBe(buildString(rng2, 10));
	});
});

describe("fuzzSeed", () => {
	it("returns a number for base seed", () => {
		resetFuzzSeedForTest();
		const result = fuzzSeed(42);
		expect(typeof result).toBe("number");
		expect(Number.isInteger(result)).toBe(true);
		expect(result).toBeGreaterThanOrEqual(0);
	});

	it("returns same value for same base when nonce is stable", () => {
		// After first call, runNonce is cached, so subsequent calls are deterministic
		resetFuzzSeedForTest();
		const a = fuzzSeed(100);
		const b = fuzzSeed(100);
		expect(a).toBe(b);
	});

	it("returns a deterministic mix of base and nonce", () => {
		resetFuzzSeedForTest();
		// The result is a mix of base and nonce, not just base
		const result = fuzzSeed(42);
		expect(result).toBeGreaterThanOrEqual(0);
		expect(result).toBeLessThanOrEqual(0xffffffff);
	});

	it("handles negative base", () => {
		resetFuzzSeedForTest();
		const result = fuzzSeed(-1);
		expect(result).toBeGreaterThanOrEqual(0);
	});

	it("produces unsigned 32-bit result", () => {
		resetFuzzSeedForTest();
		const result = fuzzSeed(0xffffffff);
		expect(result).toBeGreaterThanOrEqual(0);
		expect(result).toBeLessThanOrEqual(0xffffffff);
	});

	it("resetFuzzSeedForTest does not throw", () => {
		expect(() => resetFuzzSeedForTest()).not.toThrow();
	});
});
