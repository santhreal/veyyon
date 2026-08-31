import { describe, expect, it } from "bun:test";
import { CONFORMANCE_SCHEMA_VERSION, canonicalizeConformanceValue, encodeConformanceValue } from "../src/conformance";
import { startupMarker } from "../src/startup-marker";

describe("CONFORMANCE_SCHEMA_VERSION", () => {
	it("is 1", () => {
		expect(CONFORMANCE_SCHEMA_VERSION).toBe(1);
	});
});

describe("canonicalizeConformanceValue", () => {
	it("canonicalizes primitive string", () => {
		expect(canonicalizeConformanceValue("hello")).toBe('"hello"');
	});

	it("canonicalizes number", () => {
		expect(canonicalizeConformanceValue(42)).toBe("42");
	});

	it("canonicalizes boolean", () => {
		expect(canonicalizeConformanceValue(true)).toBe("true");
	});

	it("canonicalizes null", () => {
		expect(canonicalizeConformanceValue(null)).toBe("null");
	});

	it("canonicalizes NaN as special marker", () => {
		expect(canonicalizeConformanceValue(NaN)).toBe('"\\u0000conformance:nan"');
	});

	it("canonicalizes +Infinity as special marker", () => {
		expect(canonicalizeConformanceValue(Infinity)).toBe('"\\u0000conformance:+inf"');
	});

	it("canonicalizes -Infinity as special marker", () => {
		expect(canonicalizeConformanceValue(-Infinity)).toBe('"\\u0000conformance:-inf"');
	});

	it("canonicalizes -0 as 0", () => {
		expect(canonicalizeConformanceValue(-0)).toBe("0");
	});

	it("canonicalizes undefined as special marker", () => {
		expect(canonicalizeConformanceValue(undefined)).toBe('"\\u0000conformance:undefined"');
	});

	it("canonicalizes array", () => {
		expect(canonicalizeConformanceValue([3, 1, 2])).toBe("[3,1,2]");
	});

	it("canonicalizes object with sorted keys", () => {
		const result = canonicalizeConformanceValue({ b: 2, a: 1 });
		expect(result).toBe('{"a":1,"b":2}');
	});

	it("canonicalizes nested object with sorted keys", () => {
		const result = canonicalizeConformanceValue({ z: { d: 4, c: 3 }, a: 1 });
		expect(result).toBe('{"a":1,"z":{"c":3,"d":4}}');
	});

	it("canonicalizes array of objects", () => {
		const result = canonicalizeConformanceValue([{ b: 2, a: 1 }]);
		expect(result).toBe('[{"a":1,"b":2}]');
	});

	it("is deterministic for same input", () => {
		const obj = { c: 3, a: 1, b: 2 };
		expect(canonicalizeConformanceValue(obj)).toBe(canonicalizeConformanceValue(obj));
	});

	it("produces same output regardless of key insertion order", () => {
		const obj1 = { a: 1, b: 2 };
		const obj2 = { b: 2, a: 1 };
		expect(canonicalizeConformanceValue(obj1)).toBe(canonicalizeConformanceValue(obj2));
	});

	it("handles empty object", () => {
		expect(canonicalizeConformanceValue({})).toBe("{}");
	});

	it("handles empty array", () => {
		expect(canonicalizeConformanceValue([])).toBe("[]");
	});

	it("handles nested arrays", () => {
		expect(
			canonicalizeConformanceValue([
				[3, 1],
				[2, 4],
			]),
		).toBe("[[3,1],[2,4]]");
	});
});

describe("encodeConformanceValue", () => {
	it("returns sorted object for object input", () => {
		const result = encodeConformanceValue({ b: 2, a: 1 }) as Record<string, unknown>;
		expect(Object.keys(result)).toEqual(["a", "b"]);
	});

	it("returns array for array input", () => {
		expect(encodeConformanceValue([1, 2])).toEqual([1, 2]);
	});

	it("returns primitive for primitive input", () => {
		expect(encodeConformanceValue("hello")).toBe("hello");
		expect(encodeConformanceValue(42)).toBe(42);
	});

	it("normalizes -0 to 0", () => {
		expect(encodeConformanceValue(-0)).toBe(0);
	});

	it("returns special string for NaN", () => {
		expect(encodeConformanceValue(NaN)).toBe("\u0000conformance:nan");
	});

	it("returns special string for undefined", () => {
		expect(encodeConformanceValue(undefined)).toBe("\u0000conformance:undefined");
	});

	it("sorts nested object keys", () => {
		const result = encodeConformanceValue({ outer: { z: 1, a: 2 } }) as { outer: Record<string, unknown> };
		expect(Object.keys(result.outer)).toEqual(["a", "z"]);
	});
});

describe("startupMarker", () => {
	it("does not throw when VEYYON_DEBUG_STARTUP is not set", () => {
		delete process.env.VEYYON_DEBUG_STARTUP;
		expect(() => startupMarker("test message")).not.toThrow();
	});

	it("does not throw when VEYYON_DEBUG_STARTUP is set", () => {
		process.env.VEYYON_DEBUG_STARTUP = "1";
		expect(() => startupMarker("test message")).not.toThrow();
		delete process.env.VEYYON_DEBUG_STARTUP;
	});
});
