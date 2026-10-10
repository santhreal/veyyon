import { describe, expect, it } from "bun:test";
import {
	buildLineEntriesWithBlockContext,
	findBlockContextLines,
	lineEntriesToPlainText,
} from "@veyyon/coding-agent/utils/block-context";

/**
 * block-context.ts surfaces the off-window bracket that encloses a visible
 * window when a file is shown partially. This module had no tests. With an empty
 * source ({ path, lang } absent) the tree-sitter path is skipped and the lexical
 * bracket scanner runs, so these tests exercise the fallback deterministically
 * with no native dependency: bracket pairing across the window edge, string and
 * comment skipping (a bracket inside a string or comment must not pair), span
 * normalization/merging, and the ellipsis markers inserted across line gaps.
 */

const lines = (s: string): string[] => s.split("\n");

describe("findBlockContextLines lexical fallback", () => {
	it("surfaces the off-window closer when the opener line is visible", () => {
		const src = lines("arr(\n  1,\n  2,\n)");
		// Line 1 (the opener) is visible; the matching ")" on line 4 is not.
		expect(findBlockContextLines(src, [1], {})).toEqual(new Map([[4, ")"]]));
	});

	it("surfaces the off-window opener when the closer line is visible", () => {
		const src = lines("arr(\n  1,\n  2,\n)");
		expect(findBlockContextLines(src, [4], {})).toEqual(new Map([[1, "arr("]]));
	});

	it("ignores a bracket that lives inside a string literal", () => {
		// If the ")" on line 2 were counted it would pair with the line-1 "(" and
		// surface line 2; the real closer is line 4.
		const src = lines('arr(\n  ")",\n  item\n)');
		expect(findBlockContextLines(src, [1], {})).toEqual(new Map([[4, ")"]]));
	});

	it("ignores a bracket inside a line comment", () => {
		const src = lines("arr(\n  // )\n  item\n)");
		expect(findBlockContextLines(src, [1], {})).toEqual(new Map([[4, ")"]]));
	});

	it("ignores a bracket inside a block comment", () => {
		const src = lines("arr(\n  /* ) */\n  item\n)");
		expect(findBlockContextLines(src, [1], {})).toEqual(new Map([[4, ")"]]));
	});

	it.each([
		["parentheses", "(", ")"],
		["square brackets", "[", "]"],
		["braces", "{", "}"],
	])("pairs %s", (_kind, open, close) => {
		const src = lines(`x${open}\n  1,\n${close}`);
		expect(findBlockContextLines(src, [1], {})).toEqual(new Map([[3, close]]));
	});

	it("pairs a closer with one opener, not every open one of its kind", () => {
		const src = lines("outer(\n  inner(\n  )\n)");
		expect(findBlockContextLines(src, [1], {})).toEqual(new Map([[4, ")"]]));
	});

	it("ignores a bracket inside a single-quoted string", () => {
		const src = lines("arr(\n  ')',\n  item\n)");
		expect(findBlockContextLines(src, [1], {})).toEqual(new Map([[4, ")"]]));
	});

	it("does not end a string at a quote of another kind", () => {
		const src = lines('arr(\n  "it\'s" )\n  item\n)');
		expect(findBlockContextLines(src, [1], {})).toEqual(new Map([[2, '  "it\'s" )']]));
	});

	it("does not read the star of /* as the start of its */", () => {
		const src = lines("arr(\n  /*/ )\n  */\n)");
		expect(findBlockContextLines(src, [1], {})).toEqual(new Map([[4, ")"]]));
	});

	it("does not read the slash that ends a block comment as the start of a line comment", () => {
		const src = lines("arr(\n  /* x *// )\n  item\n)");
		expect(findBlockContextLines(src, [1], {})).toEqual(new Map([[2, "  /* x *// )"]]));
	});

	it("does not carry an escape at the end of a quoted line into the next line's string", () => {
		const src = lines('arr(\n  \'x\\\n  "" )\n  item\n)');
		expect(findBlockContextLines(src, [1], {})).toEqual(new Map([[3, '  "" )']]));
	});

	it("does not end a string at an escaped quote", () => {
		const src = lines('arr(\n  "\\")",\n  item\n)');
		expect(findBlockContextLines(src, [1], {})).toEqual(new Map([[4, ")"]]));
	});

	it("ends a string at a quote that follows an escaped backslash", () => {
		const src = lines('arr(\n  "\\\\")\nitem');
		expect(findBlockContextLines(src, [1], {})).toEqual(new Map([[2, '  "\\\\")']]));
	});

	it.each([
		["single", "'"],
		["double", '"'],
	])("ends an unterminated %s-quoted string with its line", (_kind, quote) => {
		const src = lines(`arr(\n  ${quote}it\n)`);
		expect(findBlockContextLines(src, [1], {})).toEqual(new Map([[3, ")"]]));
	});

	it("carries a template literal across lines", () => {
		const src = lines("arr(\n  `\n  )\n  `\n)");
		expect(findBlockContextLines(src, [1], {})).toEqual(new Map([[5, ")"]]));
	});

	it("carries a block comment across lines", () => {
		const src = lines("arr(\n  /*\n  )\n  */\n)");
		expect(findBlockContextLines(src, [1], {})).toEqual(new Map([[5, ")"]]));
	});

	it("pairs a bracket that follows a block comment closed on the same line", () => {
		const src = lines("arr(\n  /* x */ )\n  item\n)");
		expect(findBlockContextLines(src, [1], {})).toEqual(new Map([[2, "  /* x */ )"]]));
	});

	it.each([
		["spaces", "  # )"],
		["a tab", "\t# )"],
		["nothing", "# )"],
	])("reads # after %s as a line comment", (_prefix, comment) => {
		const src = lines(`arr(\n${comment}\n)`);
		expect(findBlockContextLines(src, [1], {})).toEqual(new Map([[3, ")"]]));
	});

	it("reads # after code as code", () => {
		const src = lines("arr(\n  x # )\n  item\n)");
		expect(findBlockContextLines(src, [1], {})).toEqual(new Map([[2, "  x # )"]]));
	});

	it("pairs a closer with the nearest opener of its kind and drops the openers inside it", () => {
		// The ")" on line 3 closes line 1 and drops the "[" on line 2, so the "]" on line 4 has no
		// opener and the visible "[" reports nothing.
		const src = lines("a(\n  [\n  )\n  ]\n)");
		expect(findBlockContextLines(src, [1, 2], {})).toEqual(new Map([[3, "  )"]]));
	});

	it("returns an empty map when the whole file is visible", () => {
		const src = lines("a(\n)");
		expect(findBlockContextLines(src, [1, 2], {}).size).toBe(0);
	});

	it("returns an empty map when nothing is visible", () => {
		const src = lines("a(\n)");
		expect(findBlockContextLines(src, [], {}).size).toBe(0);
	});

	it("never includes a line that is already visible", () => {
		const src = lines("outer(\n  inner(\n  )\n)");
		const context = findBlockContextLines(src, [2, 3], {});
		for (const lineNumber of [2, 3]) expect(context.has(lineNumber)).toBe(false);
	});
});

describe("buildLineEntriesWithBlockContext", () => {
	it("emits visible lines in order with an ellipsis across a gap", () => {
		const src = lines("L1\nL2\nL3\nL4\nL5");
		const entries = buildLineEntriesWithBlockContext(src, [
			{ startLine: 1, endLine: 1 },
			{ startLine: 4, endLine: 4 },
		]);
		expect(entries).toEqual([
			{ kind: "line", lineNumber: 1, text: "L1", context: false },
			{ kind: "ellipsis" },
			{ kind: "line", lineNumber: 4, text: "L4", context: false },
		]);
	});

	it("merges adjacent spans so no ellipsis appears between touching ranges", () => {
		const src = lines("L1\nL2\nL3\nL4");
		const entries = buildLineEntriesWithBlockContext(src, [
			{ startLine: 1, endLine: 2 },
			{ startLine: 3, endLine: 4 },
		]);
		expect(entries.every(e => e.kind === "line")).toBe(true);
		expect(entries.map(e => (e.kind === "line" ? e.lineNumber : 0))).toEqual([1, 2, 3, 4]);
	});

	it("clamps spans to the file bounds and drops inverted spans", () => {
		const src = lines("L1\nL2\nL3");
		const entries = buildLineEntriesWithBlockContext(src, [
			{ startLine: -5, endLine: 2 }, // clamps to 1..2
			{ startLine: 3, endLine: 1 }, // inverted, dropped
			{ startLine: 3, endLine: 99 }, // clamps to 3..3
		]);
		expect(entries.map(e => (e.kind === "line" ? e.lineNumber : 0))).toEqual([1, 2, 3]);
	});

	it("marks an off-window bracket boundary as a context line", () => {
		const src = lines("arr(\n  1,\n  2,\n)");
		// Only line 4 (the closer) is visible; the opener on line 1 is surfaced as
		// context and must carry context: true.
		const entries = buildLineEntriesWithBlockContext(src, [{ startLine: 4, endLine: 4 }]);
		const opener = entries.find(e => e.kind === "line" && e.lineNumber === 1);
		expect(opener).toEqual({ kind: "line", lineNumber: 1, text: "arr(", context: true });
	});

	it("applies the lineText override to substitute display text", () => {
		const src = lines("hello\nworld");
		const entries = buildLineEntriesWithBlockContext(
			src,
			[{ startLine: 1, endLine: 2 }],
			{},
			{
				lineText: (lineNumber, sourceText) => `${lineNumber}:${sourceText}`,
			},
		);
		expect(entries.map(e => (e.kind === "line" ? e.text : "…"))).toEqual(["1:hello", "2:world"]);
	});
});

describe("lineEntriesToPlainText", () => {
	it("renders lines joined by newlines with the ellipsis marker for gaps", () => {
		const src = lines("L1\nL2\nL3\nL4");
		const entries = buildLineEntriesWithBlockContext(src, [
			{ startLine: 1, endLine: 1 },
			{ startLine: 4, endLine: 4 },
		]);
		expect(lineEntriesToPlainText(entries)).toBe("L1\n…\nL4");
	});

	it("honors a custom ellipsis string", () => {
		const src = lines("L1\nL2\nL3");
		const entries = buildLineEntriesWithBlockContext(src, [
			{ startLine: 1, endLine: 1 },
			{ startLine: 3, endLine: 3 },
		]);
		expect(lineEntriesToPlainText(entries, "...")).toBe("L1\n...\nL3");
	});
});
