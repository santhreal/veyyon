/**
 * `detectIndentFromContent` freezes `insertSpaces` from the FIRST indented
 * line, then GCD-s only space-indented widths. A later tab does not flip
 * the file to tabs; a later space does not flip a tab file to spaces.
 *
 * lsp-format-options.test.ts pins pure 2-space, pure 4-space, pure tabs, and
 * GCD of 2/4/6. It never names a mixed file — the exact buffer an operator
 * pastes after a half-reindent.
 *
 * Stay red if the first space line is ignored because a later tab "looks
 * stronger", or if a space-then-tab file reports `insertSpaces: false`.
 */
import { describe, expect, it } from "bun:test";
import { detectIndentFromContent } from "@veyyon/coding-agent/lsp/format-options";

describe("the first indented line owns insertSpaces for the whole buffer", () => {
	it("stays spaces when a tab line appears after a 2-space line", () => {
		const content = "root:\n  child: 1\n\tmisaligned: 2\n";
		expect(detectIndentFromContent(content)).toEqual({ insertSpaces: true, tabSize: 2 });
	});

	it("stays tabs when a space line appears after a tab line", () => {
		const content = "func() {\n\tstmt\n    also\n}\n";
		expect(detectIndentFromContent(content)).toEqual({ insertSpaces: false });
	});

	it("does not let a leading tab-indented comment after a blank line... wait, first indent is the comment", () => {
		const content = "\n\t// c\n    code\n";
		expect(detectIndentFromContent(content)).toEqual({ insertSpaces: false });
	});

	it("skips a whitespace-only line so a tab-only line is not 'blank'", () => {
		// line.trim().length === 0 skips spaces-only. A tab-only line trims to
		// empty too (`"\t".trim() === ""`), so it carries no indent signal.
		expect(detectIndentFromContent("\t\nfoo\n")).toEqual({});
	});

	it("treats a line that starts with a space then a tab as spaces, counting only the leading spaces", () => {
		const content = "ok\n  \tglued\n    four\n";
		const detected = detectIndentFromContent(content);
		expect(detected.insertSpaces).toBe(true);
		// First indented line is "  \\tglued": two spaces then tab. n stops at
		// the tab, unit starts at 2; "    four" GCD(2,4)=2.
		expect(detected.tabSize).toBe(2);
	});
});

describe("GCD does not collapse a 3-space file to 1 just because of a 1-space accident", () => {
	it("reports 1 when a 1-space line is present (GCD of 3 and 1 is 1) — pin the damage", () => {
		const content = "a\n   three\n one\n";
		expect(detectIndentFromContent(content)).toEqual({ insertSpaces: true, tabSize: 1 });
	});

	it("reports 3 when every indented line is a multiple of 3", () => {
		const content = "a\n   three\n      six\n";
		expect(detectIndentFromContent(content)).toEqual({ insertSpaces: true, tabSize: 3 });
	});
});
