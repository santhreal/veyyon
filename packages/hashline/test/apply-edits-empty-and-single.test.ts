import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * applyEdits on empty and single-line files.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	return applyEdits(src, parsePatch(diff).edits).text;
}

describe("applyEdits empty and single-line", () => {
	it("INS.TAIL on single-line appends", () => {
		expect(apply(text(["only"]), "INS.TAIL:\n+more")).toBe(text(["only", "more"]));
	});

	it("INS.HEAD on single-line prepends", () => {
		expect(apply(text(["only"]), "INS.HEAD:\n+more")).toBe(text(["more", "only"]));
	});

	it("SWAP only line", () => {
		expect(apply(text(["only"]), "SWAP 1.=1:\n+new")).toBe(text(["new"]));
	});

	it("DEL only line", () => {
		const out = apply(text(["only"]), "DEL 1.=1");
		expect(out === "" || out === "\n").toBe(true);
	});

	it("INS.HEAD on empty-ish newline file", () => {
		const out = apply("\n", "INS.HEAD:\n+X");
		expect(out).toContain("X");
	});
});
