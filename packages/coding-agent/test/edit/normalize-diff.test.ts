import { describe, expect, it } from "bun:test";
import { normalizeCreateContent, normalizeDiff } from "../../src/edit/diff";

/**
 * normalizeDiff and normalizeCreateContent clean up model-produced patch text
 * before it is parsed. Neither had a test. They decide which lines survive to the
 * parser, so their grammar is load-bearing and pinned here.
 *
 * normalizeDiff:
 *   - strips trailing empty lines;
 *   - removes a leading/trailing patch wrapper (`*** Begin Patch`, `*** End Patch`,
 *     bare `***`);
 *   - drops diff metadata lines (`diff --git `, `index `, `--- `, `+++ `,
 *     `*** Update File:`, mode/rename headers) while KEEPING real content lines,
 *     including `+`/`-` lines whose only distinction from the `+++ `/`--- ` file
 *     headers is the trailing space;
 *   - a trailing WHITESPACE-only line that starts with a space is treated as a diff
 *     context line (unified-diff context lines begin with a space) and is therefore
 *     NOT stripped. This edge is pinned so any change is deliberate.
 *
 * normalizeCreateContent strips a leading `+ ` / `+` from every line ONLY when
 * every non-empty line is so prefixed (the model wrapped new-file content in
 * additions); otherwise it returns the content untouched.
 */

describe("normalizeDiff", () => {
	it("strips patch wrappers and metadata while keeping the content lines", () => {
		const diff = [
			"*** Begin Patch",
			"*** Update File: f.ts",
			"--- a/f.ts",
			"+++ b/f.ts",
			" ctx",
			"-old",
			"+new",
			"*** End Patch",
			"",
		].join("\n");
		expect(normalizeDiff(diff)).toBe(" ctx\n-old\n+new");
	});

	it("drops the `+++ `/`--- ` file headers but keeps `+`/`-` content lines", () => {
		expect(normalizeDiff("+++ b/x\n+real add")).toBe("+real add");
		expect(normalizeDiff("--- a/x\n-real remove")).toBe("-real remove");
	});

	it("removes a bare `***` wrapper at the start and end", () => {
		expect(normalizeDiff("***\n+x\n***")).toBe("+x");
	});

	it("strips all trailing empty lines", () => {
		expect(normalizeDiff(" a\n+b\n\n\n")).toBe(" a\n+b");
	});

	it("leaves a diff with no wrappers or metadata untouched", () => {
		expect(normalizeDiff(" a\n-b\n+c")).toBe(" a\n-b\n+c");
	});

	it("keeps a trailing whitespace-only line, treating it as a diff context line", () => {
		// A line beginning with a space is a unified-diff context line, so the
		// trailing "  " is preserved rather than trimmed as blank padding.
		expect(normalizeDiff("+b\n  ")).toBe("+b\n  ");
	});
});

describe("normalizeCreateContent", () => {
	it("strips the leading + when every non-empty line is a `+`/`+ ` addition", () => {
		expect(normalizeCreateContent("+ line one\n+line two\n+")).toBe("line one\nline two\n");
	});

	it("preserves interior empty lines while stripping the additions around them", () => {
		expect(normalizeCreateContent("+a\n\n+b")).toBe("a\n\nb");
	});

	it("returns the content unchanged when not every non-empty line is an addition", () => {
		expect(normalizeCreateContent("+ line\nplain")).toBe("+ line\nplain");
	});

	it("returns plain content with no `+` prefixes unchanged", () => {
		expect(normalizeCreateContent("hello\nworld")).toBe("hello\nworld");
	});
});
