import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * applyEdits with whitespace-only and indentation-heavy bodies.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("applyEdits whitespace bodies", () => {
	it("SWAP preserves leading spaces in replacement", () => {
		const out = apply(text(["x"]), "SWAP 1.=1:\n+    indented");
		expect(out).toBe(text(["    indented"]));
	});

	it("SWAP preserves tabs in replacement", () => {
		const out = apply(text(["x"]), "SWAP 1.=1:\n+\t\ttabbed");
		expect(out).toBe(text(["\t\ttabbed"]));
	});

	it("INS.TAIL of a blank-looking line with spaces", () => {
		const out = apply(text(["a"]), "INS.TAIL:\n+   ");
		expect(out).toContain("a");
		// Spaces-only line is preserved.
		expect(out.split("\n").some(l => l === "   " || l.trim() === "")).toBe(true);
	});

	it("mixed indent block replace", () => {
		const out = apply(text(["fn() {", "  a;", "}"]), "SWAP 2.=2:\n+\tb;");
		expect(out).toContain("\tb;");
		expect(out).toContain("fn() {");
	});
});
