/**
 * mapJsonStrings walks arrays by `length`. A hole is `undefined` (descriptor
 * missing); packed `null` is a present slot. Position of the hole is one
 * contract, not three.
 */
import { describe, expect, it } from "bun:test";
import { mapJsonStrings } from "@veyyon/coding-agent/json-transform";

function sparse<T>(length: number, entries: Array<[number, T]>): T[] {
	const a: T[] = [];
	a.length = length;
	for (const [i, v] of entries) a[i] = v;
	return a;
}

describe("sparse array holes are undefined slots, not null", () => {
	it("preserves holes (and length) when a later string is rewritten", () => {
		const input = sparse<string>(3, [[2, "secret"]]);
		const out = mapJsonStrings(input, s => (s === "secret" ? "REDACTED" : s));
		expect(out).not.toBe(input);
		expect(0 in out).toBe(false);
		expect(1 in out).toBe(false);
		expect(out[2]).toBe("REDACTED");
		expect(out.length).toBe(3);
		expect(input[2]).toBe("secret");
	});

	it("returns the same array identity when holes exist but no string changed", () => {
		const input = sparse<string>(4, [[3, "keep"]]);
		const out = mapJsonStrings(input, s => s);
		expect(out).toBe(input);
		expect(0 in out).toBe(false);
		expect(JSON.stringify(out)).toBe('[null,null,null,"keep"]');
	});

	it("does not turn a packed null into a hole", () => {
		const input = [null, "secret", null];
		const out = mapJsonStrings(input, s => (s === "secret" ? "REDACTED" : s));
		expect(0 in out).toBe(true);
		expect(out[0]).toBeNull();
		expect(JSON.stringify(out)).toBe('[null,"REDACTED",null]');
	});
});
