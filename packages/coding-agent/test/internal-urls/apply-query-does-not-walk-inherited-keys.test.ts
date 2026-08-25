/**
 * applyQuery uses inherited lookup: `(current as Record)[token]`.
 * On a plain JSON object `.__proto__` is Object.prototype, so `.constructor`
 * and `.toString` leak functions into agent:// extraction.
 *
 * parseQuery / pathToQuery leftover grammar lives in
 * parse-query-leftover-and-octal-index.test.ts — do not clone it here.
 */
import { describe, expect, it } from "bun:test";
import { applyQuery } from "@veyyon/coding-agent/internal-urls/json-query";

describe("applyQuery refuses inherited keys", () => {
	it("does not return Object.prototype for .__proto__ on a JSON object", () => {
		const data = JSON.parse('{"a":1}') as { a: number };
		expect(applyQuery(data, ".__proto__")).toBeUndefined();
	});

	it("does not return Object for .constructor on a JSON object", () => {
		expect(applyQuery({ a: 1 }, ".constructor")).toBeUndefined();
	});

	it("does not return Function.prototype.toString for .toString", () => {
		expect(applyQuery({ a: 1 }, ".toString")).toBeUndefined();
	});

	it("still returns an own key named __proto__ when it was assigned as data", () => {
		const data = Object.create(null) as Record<string, unknown>;
		// biome-ignore lint/suspicious/noProto: the own data key named __proto__ is
		// the case under test; on a null-prototype object it is a plain assignment.
		data.__proto__ = { own: true };
		expect(applyQuery(data, ".__proto__")).toEqual({ own: true });
	});
});
