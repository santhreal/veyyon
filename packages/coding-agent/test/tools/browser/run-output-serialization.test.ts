/**
 * Regression: a browser run's return value must never come back as the literal
 * text `[object Object]`.
 *
 * `cloneSafe` carries a run's return value across the boundary, and its last
 * resort was `String(value)`. A string that cannot be told apart from a real
 * result is worse than a visibly failed one: the caller reads `[object Object]`
 * as the value they returned (Law 10).
 *
 * The rendering itself now belongs to `stringifyJsonSafe` in `@veyyon/utils`,
 * which owns that contract for all five places that used to hand-roll it; its
 * own suite is `packages/utils/test/json-safe-stringify.test.ts`. What is left
 * here is what is specific to this boundary: which values cross whole, which
 * take the render path, and that the marker is what comes back when neither
 * works.
 */
import { describe, expect, it } from "bun:test";
import { cloneSafe, safeJsonStringify } from "@veyyon/coding-agent/tools/browser/run-output";

describe("safeJsonStringify delegates to the shared renderer", () => {
	it("renders with two-space indentation, which is what a run's display output uses", () => {
		expect(safeJsonStringify({ id: 7 })).toBe('{\n  "id": 7\n}');
	});

	it("carries the shared renderer's handling of a cycle rather than throwing", () => {
		// Proves the delegation is real. If this file grew its own copy again, this
		// is the test that keeps it honest about matching the owner.
		const node: Record<string, unknown> = { tag: "div" };
		node.self = node;

		expect(safeJsonStringify(node)).toBe('{\n  "tag": "div",\n  "self": "[Circular]"\n}');
	});
});

describe("cloneSafe", () => {
	it("passes a structured-cloneable value through as the same object", () => {
		// Anti-vacuity: the fast path must stay a pass-through, not a copy.
		const value = { id: 1, nested: { ok: true } };

		expect(cloneSafe(value)).toBe(value);
	});

	it("keeps undefined as undefined rather than the string 'undefined'", () => {
		expect(cloneSafe(undefined)).toBeUndefined();
	});

	it("round-trips a value that cannot be structured-cloned but can be JSON", () => {
		// A function-valued key is not cloneable. The rest of the object survives,
		// and the function is named rather than vanishing.
		const result = cloneSafe({ id: 1, onClick: function handleClick() {} });

		expect(result).toEqual({ id: 1, onClick: "[Function: handleClick]" });
	});

	it("passes a cyclic object through intact, because structuredClone supports cycles", () => {
		// Worth pinning: the JSON path would flatten the cycle to "[Circular]", and
		// it must never run for a value that can cross the boundary whole. The
		// return value keeps its real shape.
		const node: Record<string, unknown> = { tag: "div" };
		node.self = node;

		const result = cloneSafe(node) as Record<string, unknown>;

		expect(result).toBe(node);
		expect(result.self).toBe(node);
	});

	it("passes a BigInt through as a BigInt rather than degrading it to text", () => {
		// structuredClone handles BigInt, so degrading it here would lose precision
		// the caller still has. Only the display path renders it as text.
		expect(cloneSafe({ id: 12n })).toEqual({ id: 12n });
	});

	it("returns a marker naming the type when the value cannot cross at all", () => {
		// The last resort. It must be visibly a failure, because a string that reads
		// like a real result is worse than one that does not.
		const hostile = {
			get boom(): never {
				throw new Error("property access denied");
			},
		};

		expect(String(cloneSafe(hostile))).toContain("[unserializable object");
	});

	it("never returns the literal text [object Object] for any of these", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;

		// `cyclic` and the BigInt cross whole; only the function forces the JSON
		// path. None of them may come back as "[object Object]".
		for (const value of [cyclic, { big: 1n }, { fn: () => {} }]) {
			expect(safeJsonStringify(cloneSafe(value))).not.toContain("[object Object]");
		}
	});

	it("leaves a primitive alone", () => {
		expect(cloneSafe("text")).toBe("text");
		expect(cloneSafe(0)).toBe(0);
		expect(cloneSafe(false)).toBe(false);
		expect(cloneSafe(null)).toBeNull();
	});
});
