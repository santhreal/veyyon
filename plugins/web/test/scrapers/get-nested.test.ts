import { describe, expect, it } from "bun:test";
import { getNested } from "@veyyon/web/scrapers/utils";

describe("getNested", () => {
	it("traverses nested object properties along a dot-separated path", () => {
		const obj = { a: { b: { c: "hello" } } };
		expect(getNested(obj, "a.b.c")).toBe("hello");
		expect(getNested(obj, "a.b")).toEqual({ c: "hello" });
	});

	it("returns undefined for missing or nullish intermediate properties", () => {
		const obj = { a: { b: null, d: undefined } };
		expect(getNested(obj, "a.b.c")).toBeUndefined();
		expect(getNested(obj, "a.d.e")).toBeUndefined();
		expect(getNested(obj, "a.missing.key")).toBeUndefined();
	});

	it("returns undefined for non-object root or empty path", () => {
		expect(getNested(null, "a.b")).toBeUndefined();
		expect(getNested(undefined, "a.b")).toBeUndefined();
		expect(getNested("string", "a.b")).toBeUndefined();
		expect(getNested(123, "a.b")).toBeUndefined();
		expect(getNested({ a: 1 }, "")).toBeUndefined();
	});

	it("handles numeric keys in nested objects", () => {
		const obj = { items: ["first", "second"] };
		expect(getNested(obj, "items.1")).toBe("second");
	});
});
