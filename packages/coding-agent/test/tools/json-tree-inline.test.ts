import { describe, expect, it } from "bun:test";
import { formatArgsInline, formatScalar } from "@veyyon/coding-agent/tools/json-tree";

/**
 * formatScalar and formatArgsInline render tool-call arguments into the single collapsed
 * inline line shown in the tool tree. Neither had a direct test (only the multi-line tree
 * renderer downstream did). They are width-budgeting logic: a regression could overrun the
 * available width, starve later keys, or mis-escape a value. Pinned:
 *   - formatScalar renders each JSON type (null/undefined/bool/number as-is, strings quoted
 *     with \n and \t escaped and width-truncated, arrays as "[N items]", objects as
 *     "{N keys}");
 *   - formatArgsInline joins key=value pairs with ", ", skips hidden meta keys, and collapses
 *     to the "…" ellipsis when the width runs out.
 */

describe("formatScalar", () => {
	it("renders primitives verbatim and quotes/escapes/truncates strings", () => {
		expect(formatScalar(null, 60)).toBe("null");
		expect(formatScalar(undefined, 60)).toBe("undefined");
		expect(formatScalar(true, 60)).toBe("true");
		expect(formatScalar(42, 60)).toBe("42");
		expect(formatScalar("hello\nworld\ttab", 60)).toBe('"hello\\nworld\\ttab"');
		expect(formatScalar("abcdefghij", 4)).toBe('"abc…"');
	});

	it("summarizes arrays and objects by their size", () => {
		expect(formatScalar([1, 2, 3], 60)).toBe("[3 items]");
		expect(formatScalar({ a: 1, b: 2 }, 60)).toBe("{2 keys}");
	});
});

describe("formatArgsInline", () => {
	it("joins key=value pairs with a comma separator", () => {
		expect(formatArgsInline({ path: "/a", count: 3 }, 80)).toBe('path="/a", count=3');
	});

	it("skips hidden meta keys like __partialJson", () => {
		expect(formatArgsInline({ path: "/a", __partialJson: "x" }, 80)).toBe('path="/a"');
	});

	it("collapses to an ellipsis when the width is exhausted", () => {
		expect(formatArgsInline({ a: "x", b: "y" }, 2)).toBe("…");
		expect(formatArgsInline({ aaa: "verylongvalue", bbb: "y" }, 12)).toBe('aaa="…"');
	});
});
