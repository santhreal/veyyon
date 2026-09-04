import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

/**
 * INS.PRE|POST|HEAD|TAIL and multi-op applyEdits contracts. Exact text.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function apply(src: string, diff: string): string {
	const { edits } = parsePatch(diff);
	return applyEdits(src, edits).text;
}

describe("INS applyEdits adversarial", () => {
	it("INS.HEAD prepends lines", () => {
		expect(apply(text(["a", "b"]), "INS.HEAD:\n+Z")).toBe(text(["Z", "a", "b"]));
	});

	it("INS.TAIL appends lines", () => {
		expect(apply(text(["a", "b"]), "INS.TAIL:\n+Z")).toBe(text(["a", "b", "Z"]));
	});

	it("INS.POST N inserts after line N", () => {
		expect(apply(text(["a", "b", "c"]), "INS.POST 1:\n+X")).toBe(text(["a", "X", "b", "c"]));
	});

	it("INS.PRE N inserts before line N", () => {
		expect(apply(text(["a", "b", "c"]), "INS.PRE 2:\n+Y")).toBe(text(["a", "Y", "b", "c"]));
	});

	it("multi-line INS body inserts every + line", () => {
		expect(apply(text(["a"]), "INS.TAIL:\n+one\n+two")).toBe(text(["a", "one", "two"]));
	});

	it("DEL of the only line yields empty or single trailing newline file", () => {
		const out = apply(text(["only"]), "DEL 1.=1");
		expect(out === "" || out === "\n").toBe(true);
	});

	it("SWAP then DEL on original anchors both take effect", () => {
		const out = apply(text(["a", "b", "c", "d"]), "SWAP 1.=1:\n+A2\nDEL 4.=4");
		expect(out).toContain("A2");
		expect(out.includes("d")).toBe(false);
	});

	it("space form INS HEAD is rejected (dotted keywords required)", () => {
		expect(() => parsePatch("INS HEAD:\n+Z")).toThrow(/hunk header|INS\./i);
	});
});
