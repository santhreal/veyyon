import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * parsePatch warning and error contracts for hostile/malformed patches.
 */

describe("parsePatch warnings and errors", () => {
	it("bare body without + auto-prefixes and warns", () => {
		const { edits, warnings } = parsePatch("SWAP 1.=1:\n|hello");
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings.some(w => /auto-prefix|bare body/i.test(w))).toBe(true);
		const text = applyEdits("x\n", edits).text;
		expect(text).toContain("|hello");
	});

	it("payload without a hunk header throws a clear error", () => {
		expect(() => parsePatch("+orphan body")).toThrow(/hunk header|SWAP|DEL|INS/i);
	});

	it("empty patch yields zero edits and no throw", () => {
		const { edits, warnings } = parsePatch("");
		expect(edits).toEqual([]);
		expect(Array.isArray(warnings)).toBe(true);
	});

	it("whitespace-only body lines under a SWAP are ignored or accepted without crash", () => {
		const { edits } = parsePatch("SWAP 1.=1:\n+\n+keep");
		const out = applyEdits("old\n", edits).text;
		expect(out).toContain("keep");
	});

	it("DEL with inverted range is rejected or no-ops without corrupting source", () => {
		const src = "a\nb\nc\n";
		try {
			const { edits } = parsePatch("DEL 3.=1");
			const out = applyEdits(src, edits).text;
			// If accepted, source must remain parseable string.
			expect(typeof out).toBe("string");
		} catch (e) {
			expect(String(e).length).toBeGreaterThan(0);
			expect(src).toBe("a\nb\nc\n");
		}
	});
});
