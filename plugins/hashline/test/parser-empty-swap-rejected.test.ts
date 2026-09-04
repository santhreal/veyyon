/**
 * A bodyless `SWAP N.=M:` is a parse error, never a silent delete. The
 * EMPTY_REPLACE message existed but was never enforced: the parser used to
 * route a zero-payload replace through the delete path, so a truncated
 * stream that lost the body rows silently deleted the whole target range
 * (silent data loss, Law 10). This suite locks the rejection in, plus the
 * negative twins that must keep parsing: DEL as the explicit delete form,
 * SWAP with a body, and SWAP whose body is a single empty `+` row (an
 * intentional blank line, which IS a body).
 */
import { describe, expect, it } from "bun:test";
import { EMPTY_REPLACE, parsePatch } from "@veyyon/hashline";

describe("parser rejects bodyless SWAP", () => {
	it("SWAP with zero body rows throws EMPTY_REPLACE with the line number", () => {
		expect(() => parsePatch("SWAP 1.=1:")).toThrow(EMPTY_REPLACE);
		expect(() => parsePatch("SWAP 1.=1:")).toThrow(/^line 1: /);
	});

	it("bodyless SWAP over a multi-line range throws instead of deleting the range", () => {
		expect(() => parsePatch("SWAP 2.=5:\n")).toThrow(EMPTY_REPLACE);
	});

	it("bodyless SWAP mid-patch reports its own line, edits before it are not emitted", () => {
		expect(() => parsePatch("SWAP 1.=1:\n+kept\nSWAP 3.=3:")).toThrow(/^line 3: /);
	});

	it("negative twin: DEL of the same range still parses (the explicit delete form)", () => {
		const { edits } = parsePatch("DEL 2.=5");
		expect(edits).toHaveLength(4);
		expect(edits.every(e => e.kind === "delete")).toBe(true);
	});

	it("negative twin: SWAP with a body still parses", () => {
		const { edits } = parsePatch("SWAP 1.=1:\n+content");
		expect(edits.some(e => e.kind === "insert")).toBe(true);
	});

	it("boundary: a single empty `+` row is a body (intentional blank line), not bodyless", () => {
		const { edits } = parsePatch("SWAP 1.=1:\n+");
		const inserts = edits.filter(e => e.kind === "insert");
		expect(inserts).toHaveLength(1);
		expect((inserts[0] as { text: string }).text).toBe("");
	});
});
