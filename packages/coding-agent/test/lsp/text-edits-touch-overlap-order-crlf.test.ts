/**
 * LSP text edits are applied bottom-up so later ranges keep their indices.
 * Four facts the existing lsp-regressions suite never drives on the in-memory
 * applier itself:
 *
 *   1. TOUCHING ranges (end of A == start of B) are adjacent, not overlapping.
 *      Refusing them drops legal insert-then-replace sequences from servers.
 *   2. OVERLAPPING non-identical ranges throw. Identical non-empty duplicates
 *      collapse first, so a noisy server that emits the same edit twice still
 *      applies once.
 *   3. Two empty inserts at the SAME position land in ARRAY order (LSP §3.17.3).
 *      The sort tiebreaks by original index descending so the bottom-up pass
 *      reconstructs that order. Flipping the tiebreak silently reverses
 *      "AB" into "BA".
 *   4. `split("\\n")` on a CRLF file leaves a trailing CR on every line but
 *      the last. A character index from an LSP server is in the document the
 *      server saw (no CR, or CRLF as one terminator). Applying against the
 *      CR-bearing slice writes past the graphic character and can leave a
 *      stray `\\r` in the middle of the replacement. The document after a
 *      single-line replace of "ab" on a CRLF file must still be CRLF, with
 *      no CR glued to the new text.
 */
import { describe, expect, it } from "bun:test";
import {
	applyTextEditsToString,
	flattenWorkspaceTextEdits,
	rangesOverlap,
	sortAndValidateTextEdits,
} from "@veyyon/coding-agent/lsp/edits";
import type { Range, TextEdit } from "@veyyon/coding-agent/lsp/types";

function range(sl: number, sc: number, el: number, ec: number): Range {
	return { start: { line: sl, character: sc }, end: { line: el, character: ec } };
}

function edit(r: Range, newText: string): TextEdit {
	return { range: r, newText };
}

describe("touching is not overlapping", () => {
	it("treats [0,2) and [2,4) as adjacent", () => {
		expect(rangesOverlap(range(0, 0, 0, 2), range(0, 2, 0, 4))).toBe(false);
	});

	it("treats [0,2) and [0,2) as overlapping when the range is non-empty", () => {
		expect(rangesOverlap(range(0, 0, 0, 2), range(0, 0, 0, 2))).toBe(true);
	});

	it("applies a replace that ends where the next insert starts", () => {
		const out = applyTextEditsToString("abcd", [
			edit(range(0, 0, 0, 2), "AB"),
			edit(range(0, 2, 0, 2), "-"),
		]);
		expect(out).toBe("AB-cd");
	});
});

describe("overlap refuse vs identical collapse", () => {
	it("throws on overlapping distinct replacements", () => {
		expect(() =>
			sortAndValidateTextEdits([edit(range(0, 0, 0, 3), "A"), edit(range(0, 2, 0, 4), "B")]),
		).toThrow(/overlapping LSP edits/);
	});

	it("collapses two byte-identical non-empty edits into one apply", () => {
		const out = applyTextEditsToString("hello", [
			edit(range(0, 0, 0, 5), "HELLO"),
			edit(range(0, 0, 0, 5), "HELLO"),
		]);
		expect(out).toBe("HELLO");
	});
});

describe("same-position inserts keep array order", () => {
	it("inserts A then B at 0:0 as AB, not BA", () => {
		const out = applyTextEditsToString("x", [
			edit(range(0, 0, 0, 0), "A"),
			edit(range(0, 0, 0, 0), "B"),
		]);
		expect(out).toBe("ABx");
	});
});

describe("CRLF documents keep CRLF and do not glue CR onto the replacement", () => {
	it("replacing the first graphic line does not leave a CR in the new text", () => {
		const out = applyTextEditsToString("ab\r\ncd", [edit(range(0, 0, 0, 2), "AB")]);
		expect(JSON.stringify(out)).toBe(JSON.stringify("AB\r\ncd"));
	});
});

describe("flattenWorkspaceTextEdits does not walk inherited URIs", () => {
	it("ignores a URI that only lives on the prototype of `changes`", () => {
		const stolen: TextEdit[] = [edit(range(0, 0, 0, 0), "STOLEN")];
		const changes = Object.assign(Object.create({ "file:///stolen": stolen }), {
			"file:///real": [edit(range(0, 0, 0, 1), "R")],
		}) as Record<string, TextEdit[]>;
		const flat = flattenWorkspaceTextEdits({ changes });
		expect([...flat.keys()]).toEqual(["file:///real"]);
		expect(flat.has("file:///stolen")).toBe(false);
	});
});
