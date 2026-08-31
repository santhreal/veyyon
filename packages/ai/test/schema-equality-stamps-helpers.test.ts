import { describe, expect, it } from "bun:test";
import { areJsonValuesEqual, mergeCompatibleEnumSchemas, mergePropertySchemas } from "../src/utils/schema/equality";
import { isMultipleOf } from "../src/utils/schema/multiple-of";
import { spillToDescription } from "../src/utils/schema/spill";
import { enter, epochNext, exit, once, stamp } from "../src/utils/schema/stamps";

describe("areJsonValuesEqual", () => {
	it("returns true for identical primitives", () => {
		expect(areJsonValuesEqual(1, 1)).toBe(true);
	});
	it("returns true for identical strings", () => {
		expect(areJsonValuesEqual("a", "a")).toBe(true);
	});
	it("returns false for different primitives", () => {
		expect(areJsonValuesEqual(1, 2)).toBe(false);
	});
	it("returns true for identical arrays", () => {
		expect(areJsonValuesEqual([1, 2], [1, 2])).toBe(true);
	});
	it("returns false for arrays of different length", () => {
		expect(areJsonValuesEqual([1, 2], [1, 2, 3])).toBe(false);
	});
	it("returns false for arrays with different elements", () => {
		expect(areJsonValuesEqual([1, 2], [1, 3])).toBe(false);
	});
	it("returns true for identical objects", () => {
		expect(areJsonValuesEqual({ a: 1 }, { a: 1 })).toBe(true);
	});
	it("returns false for objects with different keys", () => {
		expect(areJsonValuesEqual({ a: 1 }, { b: 1 })).toBe(false);
	});
	it("returns false for objects with different values", () => {
		expect(areJsonValuesEqual({ a: 1 }, { a: 2 })).toBe(false);
	});
	it("returns false for object vs array", () => {
		expect(areJsonValuesEqual({ a: 1 }, [1])).toBe(false);
	});
	it("returns true for nested identical objects", () => {
		expect(areJsonValuesEqual({ a: { b: [1, 2] } }, { a: { b: [1, 2] } })).toBe(true);
	});
	it("returns true for null vs null", () => {
		expect(areJsonValuesEqual(null, null)).toBe(true);
	});
	it("returns false for null vs undefined", () => {
		expect(areJsonValuesEqual(null, undefined)).toBe(false);
	});
	it("returns true for empty objects", () => {
		expect(areJsonValuesEqual({}, {})).toBe(true);
	});
	it("returns true for empty arrays", () => {
		expect(areJsonValuesEqual([], [])).toBe(true);
	});
	it("returns false for objects with different key counts", () => {
		expect(areJsonValuesEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
	});
});

describe("mergeCompatibleEnumSchemas", () => {
	it("merges two compatible enum schemas", () => {
		const existing = { type: "string", enum: ["a", "b"] };
		const incoming = { type: "string", enum: ["b", "c"] };
		const result = mergeCompatibleEnumSchemas(existing, incoming);
		expect(result).not.toBeNull();
		expect(result?.enum).toEqual(["a", "b", "c"]);
	});
	it("returns null for non-record inputs", () => {
		expect(mergeCompatibleEnumSchemas("hello", 42)).toBeNull();
	});
	it("returns null when existing has no enum", () => {
		expect(mergeCompatibleEnumSchemas({ type: "string" }, { type: "string", enum: ["a"] })).toBeNull();
	});
	it("returns null when incoming has no enum", () => {
		expect(mergeCompatibleEnumSchemas({ type: "string", enum: ["a"] }, { type: "string" })).toBeNull();
	});
	it("returns null when types differ", () => {
		expect(mergeCompatibleEnumSchemas({ type: "string", enum: ["a"] }, { type: "number", enum: [1] })).toBeNull();
	});
	it("returns null when non-enum keys differ", () => {
		expect(
			mergeCompatibleEnumSchemas({ type: "string", enum: ["a"], extra: 1 }, { type: "string", enum: ["b"] }),
		).toBeNull();
	});
	it("deduplicates enum values", () => {
		const result = mergeCompatibleEnumSchemas(
			{ type: "string", enum: ["a", "b"] },
			{ type: "string", enum: ["a", "b"] },
		);
		expect(result?.enum).toEqual(["a", "b"]);
	});
});

describe("mergePropertySchemas", () => {
	it("returns existing when schemas are equal", () => {
		const result = mergePropertySchemas({ type: "string" }, { type: "string" });
		expect(result).toEqual({ type: "string" });
	});
	it("merges compatible enum schemas", () => {
		const result = mergePropertySchemas({ type: "string", enum: ["a"] }, { type: "string", enum: ["b"] });
		expect(result).toEqual({ type: "string", enum: ["a", "b"] });
	});
	it("creates anyOf for incompatible schemas", () => {
		const result = mergePropertySchemas({ type: "string" }, { type: "number" });
		expect(result).toEqual({ anyOf: [{ type: "string" }, { type: "number" }] });
	});
	it("deduplicates anyOf variants", () => {
		const result = mergePropertySchemas({ type: "string" }, { type: "string" });
		expect(result).toEqual({ type: "string" });
	});
});

describe("isMultipleOf", () => {
	it("returns true for exact multiple", () => {
		expect(isMultipleOf(10, 5)).toBe(true);
	});
	it("returns true for 0 multipleOf (always passes)", () => {
		expect(isMultipleOf(7, 0)).toBe(true);
	});
	it("returns false for non-multiple", () => {
		expect(isMultipleOf(7, 3)).toBe(false);
	});
	it("returns true for 0 value", () => {
		expect(isMultipleOf(0, 5)).toBe(true);
	});
	it("handles floating point with tolerance", () => {
		expect(isMultipleOf(0.3, 0.1)).toBe(true);
	});
	it("returns true for negative multipleOf", () => {
		expect(isMultipleOf(10, -5)).toBe(true);
	});
});

describe("spillToDescription", () => {
	it("appends spill format to description", () => {
		const node: { description?: string } = {};
		spillToDescription(node, [["minLength", 5]]);
		expect(node.description).toBe("{minLength: 5}");
	});
	it("appends to existing description", () => {
		const node: { description?: string } = { description: "A field" };
		spillToDescription(node, [["minLength", 5]]);
		expect(node.description).toBe("A field\n\n{minLength: 5}");
	});
	it("appends paren format", () => {
		const node: { description?: string } = {};
		spillToDescription(node, [["pattern", "^a"]], "paren");
		expect(node.description).toBe(" (pattern: ^a)");
	});
	it("skips undefined entries", () => {
		const node: { description?: string } = {};
		spillToDescription(node, [["minLength", undefined]]);
		expect(node.description).toBeUndefined();
	});
	it("handles multiple entries in spill format", () => {
		const node: { description?: string } = {};
		spillToDescription(node, [
			["minLength", 1],
			["maxLength", 10],
		]);
		expect(node.description).toBe("{minLength: 1, maxLength: 10}");
	});
	it("handles string values in paren format", () => {
		const node: { description?: string } = {};
		spillToDescription(node, [["format", "date-time"]], "paren");
		expect(node.description).toBe(" (format: date-time)");
	});
	it("handles non-string values in paren format", () => {
		const node: { description?: string } = {};
		spillToDescription(node, [["minimum", 5]], "paren");
		expect(node.description).toBe(" (minimum: 5)");
	});
});

describe("stamp", () => {
	it("computes and caches value", () => {
		const target = {} as object;
		let calls = 0;
		const v1 = stamp(target, Symbol("k"), () => {
			calls++;
			return 42;
		});
		const v2 = stamp(target, Symbol("k"), () => {
			calls++;
			return 99;
		});
		// Different symbols, so both compute
		expect(v1).toBe(42);
		expect(v2).toBe(99);
		expect(calls).toBe(2);
	});
	it("returns cached value for same symbol", () => {
		const target = {} as object;
		const key = Symbol("k");
		let calls = 0;
		stamp(target, key, () => {
			calls++;
			return 42;
		});
		const v2 = stamp(target, key, () => {
			calls++;
			return 99;
		});
		expect(v2).toBe(42);
		expect(calls).toBe(1);
	});
});

describe("epochNext", () => {
	it("returns incrementing values", () => {
		const a = epochNext();
		const b = epochNext();
		expect(b).toBe(a + 1);
	});
});

describe("once", () => {
	it("returns true for first call with given epoch", () => {
		const target = {} as object;
		const epoch = epochNext();
		expect(once(target, epoch)).toBe(true);
	});
	it("returns false for second call with same epoch", () => {
		const target = {} as object;
		const epoch = epochNext();
		once(target, epoch);
		expect(once(target, epoch)).toBe(false);
	});
	it("returns true for newer epoch", () => {
		const target = {} as object;
		const e1 = epochNext();
		once(target, e1);
		const e2 = epochNext();
		expect(once(target, e2)).toBe(true);
	});
});

describe("enter/exit", () => {
	it("returns true for first enter", () => {
		const target = {} as object;
		expect(enter(target)).toBe(true);
	});
	it("returns false for second enter without exit", () => {
		const target = {} as object;
		enter(target);
		expect(enter(target)).toBe(false);
	});
	it("returns true after exit", () => {
		const target = {} as object;
		enter(target);
		exit(target);
		expect(enter(target)).toBe(true);
	});
	it("exit on unentered target is no-op", () => {
		const target = {} as object;
		expect(() => exit(target)).not.toThrow();
	});
});
