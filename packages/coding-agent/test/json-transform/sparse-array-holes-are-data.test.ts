/**
 * mapJsonStrings walks arrays by `length`, not by packed indices.
 *
 * WHY THIS SUITE EXISTS. The refusal suite pins accessors, symbols, cycles,
 * Date/Map, and key-collision. It does not pin a sparse array — the shape
 * `JSON.parse("[1,null,3]")` is packed nulls, while `a[2]="x"` is a hole
 * at 0 and 1 whose descriptor is missing.
 *
 * The walker does:
 *
 *     const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
 *     sourceValues.push(descriptor?.value);
 *
 * so a hole becomes `undefined`. JSON.stringify would emit `null` for a hole.
 * If the walker later JSON.stringifies the result, holes become null and a
 * credential that lived in a sibling index is still rewritten — but a mapper
 * that treats `undefined` as "skip" would leave a hole, and a mapper that
 * stringifies undefined would throw on non-string. Pin:
 *
 *   - holes are visited as `undefined` and survive as `undefined` (identity)
 *   - packed `null` is visited as `null` and is not turned into a hole
 *   - a hole is NOT an accessor (that refusal is a different test)
 *   - copy-on-change of a later index does not fill earlier holes with null
 */
import { describe, expect, it } from "bun:test";
import { mapJsonStrings } from "@veyyon/coding-agent/json-transform";

function sparse<T>(length: number, entries: Array<[number, T]>): T[] {
	const a: T[] = [];
	a.length = length;
	for (const [i, v] of entries) a[i] = v;
	return a;
}

describe("sparse array holes are undefined slots, not null and not skipped length", () => {
	it("preserves a leading hole when a later string is rewritten", () => {
		const input = sparse<string>(3, [[2, "secret"]]);
		expect(0 in input).toBe(false);
		expect(1 in input).toBe(false);
		expect(2 in input).toBe(true);

		const out = mapJsonStrings(input, s => (s === "secret" ? "REDACTED" : s));
		expect(out).not.toBe(input);
		expect(0 in out).toBe(false);
		expect(1 in out).toBe(false);
		expect(out[2]).toBe("REDACTED");
		expect(out.length).toBe(3);
		expect(input[2]).toBe("secret");
	});

	it("preserves a middle hole between two rewritten strings", () => {
		const input = sparse<string>(3, [
			[0, "alpha"],
			[2, "beta"],
		]);
		const out = mapJsonStrings(input, s => s.toUpperCase());
		expect(out[0]).toBe("ALPHA");
		expect(1 in out).toBe(false);
		expect(out[2]).toBe("BETA");
		expect(out.length).toBe(3);
	});

	it("returns the same array identity when holes exist but no string changed", () => {
		const input = sparse<string>(4, [[3, "keep"]]);
		const out = mapJsonStrings(input, s => s);
		expect(out).toBe(input);
		expect(0 in out).toBe(false);
		expect(out[3]).toBe("keep");
	});

	it("does not turn a packed null into a hole", () => {
		const input = [null, "secret", null];
		const out = mapJsonStrings(input, s => (s === "secret" ? "REDACTED" : s));
		expect(0 in out).toBe(true);
		expect(out[0]).toBeNull();
		expect(out[1]).toBe("REDACTED");
		expect(out[2]).toBeNull();
		expect(JSON.stringify(out)).toBe('[null,"REDACTED",null]');
	});

	it("does not fill holes with null when JSON.stringify would", () => {
		const input = sparse<string>(2, [[1, "x"]]);
		const out = mapJsonStrings(input, s => s);
		expect(out).toBe(input);
		// stringify still sees the hole as null — that is JSON, not the walker.
		expect(JSON.stringify(out)).toBe('[null,"x"]');
		expect(0 in out).toBe(false);
	});

	it("walks an empty-length array as identity", () => {
		const input: string[] = [];
		expect(mapJsonStrings(input, s => s.toUpperCase())).toBe(input);
	});

	it("walks a trailing hole after a rewritten string without collapsing length", () => {
		const input = sparse<string>(5, [[0, "a"]]);
		const out = mapJsonStrings(input, s => s + s);
		expect(out.length).toBe(5);
		expect(out[0]).toBe("aa");
		expect(1 in out).toBe(false);
		expect(4 in out).toBe(false);
	});
});
