/**
 * normalizeTools keeps only valid tools from mixed arrays of size 20.
 */
import { describe, expect, it } from "bun:test";
import { normalizeTools } from "@veyyon/agent-core";
import { type } from "arktype";

const schema = type({ x: "string" });

function tool(name: string) {
	return {
		name,
		label: name,
		description: name,
		parameters: schema,
		async execute() {
			return { content: [{ type: "text" as const, text: "ok" }], details: {} };
		},
	};
}

describe("normalizeTools mixed valid/invalid", () => {
	it("keeps every other real tool", () => {
		const arr: unknown[] = [];
		const expected: string[] = [];
		for (let i = 0; i < 20; i++) {
			if (i % 2 === 0) {
				arr.push(tool(`t${i}`));
				expected.push(`t${i}`);
			} else {
				arr.push(null, undefined, {}, { name: 1 }, "x");
			}
		}
		const out = normalizeTools(arr as never, false);
		expect(out.map(t => t.name)).toEqual(expected);
	});

	it("returns cached result on second call with same tools array and options", () => {
		// WHY: normalizeTools caches by tools array reference + options key.
		// The filter must still run on cache miss (first call), but on cache hit
		// the same result object must be returned without re-filtering.
		const arr: unknown[] = [tool("a"), tool("b")];
		const first = normalizeTools(arr as never, false);
		const second = normalizeTools(arr as never, false);
		expect(second).toBe(first); // same reference — cache hit
	});

	it("cache miss when options change returns different result", () => {
		const arr: unknown[] = [tool("a")];
		const noIntent = normalizeTools(arr as never, false);
		const withIntent = normalizeTools(arr as never, true);
		expect(withIntent).not.toBe(noIntent);
	});

	it("cache miss when tools array changes returns filtered result", () => {
		const arr1: unknown[] = [tool("a"), null, tool("b")];
		const arr2: unknown[] = [tool("a"), null, tool("c")];
		const r1 = normalizeTools(arr1 as never, false);
		const r2 = normalizeTools(arr2 as never, false);
		expect(r1.map(t => t.name)).toEqual(["a", "b"]);
		expect(r2.map(t => t.name)).toEqual(["a", "c"]);
	});
});
