/**
 * Recovery remaps every anchored line through `diffArrays` and then REQUIRES a
 * single shared offset. Two live facts fall out of that, and neither is the
 * "later line drifted, early SWAP still works" case the adversarial corpus
 * already pins:
 *
 *   1. MIXED OFFSETS. An insert in the middle of the file moves the lines
 *      below it and leaves the lines above it. A patch that touches BOTH
 *      sides is asking to replay two different geometries onto one body.
 *      `remapEditsToCurrent` returns null rather than applying the low
 *      hunk at offset 0 and the high hunk at offset +N — that would land
 *      the high SWAP on the wrong survivor. This is the refusal, not a
 *      partial apply.
 *
 *   2. ANCHORLESS EDITS. `INS.HEAD` / `INS.TAIL` have no line anchors, so
 *      the offset list stays empty and the same function returns null even
 *      when the insert does not need a remap (HEAD is still HEAD after a
 *      suffix append). The operator then sees a stale-tag mismatch for an
 *      edit that is well-defined on the live file. That is a defect: the
 *      empty-offset path is treating "nothing to remap" as "cannot recover".
 */
import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore, parsePatch, Recovery } from "@veyyon/hashline";

const PATH = "src/mixed.ts";

function recover(previous: string, current: string, patch: string) {
	const store = new InMemorySnapshotStore();
	const tag = store.record(PATH, previous);
	store.record(PATH, current);
	return new Recovery(store).tryRecover({
		path: PATH,
		currentText: current,
		fileHash: tag,
		edits: parsePatch(patch).edits,
	});
}

describe("a patch that straddles an insertion has two offsets and must refuse", () => {
	const previous = ["alpha", "beta", "gamma", "delta"].join("\n");
	const current = ["alpha", "beta", "INSERTED", "gamma", "delta"].join("\n");

	it("refuses SWAP of the first line together with SWAP of the last line", () => {
		const result = recover(previous, current, "SWAP 1.=1:\n+ALPHA\nSWAP 4.=4:\n+DELTA");
		expect(result).toBeNull();
	});

	it("refuses DEL of a line above the insert together with DEL of a line below it", () => {
		const result = recover(previous, current, "DEL 1\nDEL 4");
		expect(result).toBeNull();
	});

	it("still remaps a patch that lives entirely below the insert (one offset)", () => {
		const result = recover(previous, current, "SWAP 3.=3:\n+GAMMA");
		expect(result).not.toBeNull();
		expect(result?.text).toBe(["alpha", "beta", "INSERTED", "GAMMA", "delta"].join("\n"));
	});

	it("still remaps a patch that lives entirely above the insert (offset 0)", () => {
		const result = recover(previous, current, "SWAP 1.=1:\n+ALPHA");
		expect(result).not.toBeNull();
		expect(result?.text).toBe(["ALPHA", "beta", "INSERTED", "gamma", "delta"].join("\n"));
	});
});

describe("a prefix deletion is the same mixed-offset trap from the other direction", () => {
	it("refuses a SWAP of the surviving head together with a SWAP of the tail that slid up", () => {
		const previous = ["keep", "drop-a", "drop-b", "tail"].join("\n");
		const current = ["keep", "tail"].join("\n");
		const result = recover(previous, current, "SWAP 1.=1:\n+KEEP\nSWAP 4.=4:\n+TAIL");
		expect(result).toBeNull();
	});
});

describe("INS.HEAD and INS.TAIL after unrelated drift do not need a remap", () => {
	it("applies INS.HEAD to the live file after a suffix append, rather than failing closed on an empty offset list", () => {
		const previous = "head\nbody";
		const current = "head\nbody\ntail";
		const result = recover(previous, current, "INS.HEAD:\n+TITLE");
		expect(result).not.toBeNull();
		expect(result?.text).toBe("TITLE\nhead\nbody\ntail");
	});

	it("applies INS.TAIL to the live file after a prefix insert", () => {
		const previous = "head\nbody";
		const current = "TITLE\nhead\nbody";
		const result = recover(previous, current, "INS.TAIL:\n+END");
		expect(result).not.toBeNull();
		expect(result?.text).toBe("TITLE\nhead\nbody\nEND");
	});
});
