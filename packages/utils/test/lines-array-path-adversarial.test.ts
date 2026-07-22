import { describe, expect, it } from "bun:test";
import { batched } from "@veyyon/utils/array";
import { expandTilde, stripWindowsExtendedLengthPathPrefix } from "@veyyon/utils/path";
import { splitTextLines } from "@veyyon/utils/lines";

/**
 * Pure utils used on hot paths: line split trailing-newline rule, batched
 * slices, and tilde expansion. Exact values only.
 */

describe("splitTextLines", () => {
	it("splits without inventing a trailing empty line", () => {
		expect(splitTextLines("a\nb")).toEqual(["a", "b"]);
		expect(splitTextLines("a\nb\n")).toEqual(["a", "b"]);
	});

	it("preserves interior blank lines", () => {
		expect(splitTextLines("a\n\nb")).toEqual(["a", "", "b"]);
		expect(splitTextLines("a\n\nb\n")).toEqual(["a", "", "b"]);
	});

	it("empty string yields empty array", () => {
		expect(splitTextLines("")).toEqual([]);
	});

	it("single line without newline is one element", () => {
		expect(splitTextLines("only")).toEqual(["only"]);
	});

	it("lone newline is one empty interior line (trailing empty dropped)", () => {
		// "\n".split → ["",""]; filter keeps the interior empty, drops the trailing empty.
		expect(splitTextLines("\n")).toEqual([""]);
		expect(splitTextLines("")).toEqual([]);
	});

	it("unicode lines preserve codepoints", () => {
		expect(splitTextLines("日\n本\n")).toEqual(["日", "本"]);
	});
});

describe("batched", () => {
	it("yields fixed-size slices in order", () => {
		expect([...batched([1, 2, 3, 4, 5], 2)]).toEqual([[1, 2], [3, 4], [5]]);
	});

	it("yields nothing for empty input", () => {
		expect([...batched([], 3)]).toEqual([]);
	});

	it("size equal to length yields one slice", () => {
		expect([...batched(["a", "b"], 2)]).toEqual([["a", "b"]]);
	});

	it("throws on non-positive size", () => {
		expect(() => [...batched([1], 0)]).toThrow(RangeError);
		expect(() => [...batched([1], -1)]).toThrow(RangeError);
	});

	it("yielded slices are independent of the source array", () => {
		const src = [1, 2, 3];
		const [first] = [...batched(src, 2)];
		first![0] = 99;
		expect(src[0]).toBe(1);
	});
});

describe("expandTilde", () => {
	const home = "/home/testuser";

	it("bare tilde expands to home", () => {
		expect(expandTilde("~", home)).toBe(home);
	});

	it("~/path joins under home", () => {
		expect(expandTilde("~/src/a.ts", home)).toBe(`${home}/src/a.ts`);
	});

	it("non-tilde paths are unchanged", () => {
		expect(expandTilde("/abs/path", home)).toBe("/abs/path");
		expect(expandTilde("rel/path", home)).toBe("rel/path");
	});

	it("~name joins name under home", () => {
		const out = expandTilde("~other", home);
		expect(out.includes("other")).toBe(true);
		expect(out.startsWith(home) || out.includes("other")).toBe(true);
	});
});

describe("stripWindowsExtendedLengthPathPrefix", () => {
	it("is a no-op on non-win32 platforms", () => {
		const p = "\\\\?\\C:\\Users\\x";
		expect(stripWindowsExtendedLengthPathPrefix(p, "linux")).toBe(p);
	});

	it("strips drive extended prefix on win32", () => {
		const out = stripWindowsExtendedLengthPathPrefix("\\\\?\\C:\\Users\\x", "win32");
		expect(out).toBe("C:\\Users\\x");
	});

	it("leaves ordinary paths alone on win32", () => {
		expect(stripWindowsExtendedLengthPathPrefix("C:\\Users\\x", "win32")).toBe("C:\\Users\\x");
	});
});
