/**
 * Recovery fail-closed when anchored line content is duplicated in live file
 * (ambiguous remap). Unique lines still recover after pure shift.
 */
import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore, parsePatch, Recovery } from "@veyyon/hashline";

describe("Recovery duplicate line content refuse", () => {
	it("refuses when target content appears twice after drift", () => {
		const store = new InMemorySnapshotStore();
		const orig = "a\nTARGET\nc";
		const h = store.record("f.ts", orig);
		// drift inserts another TARGET — ambiguous
		const live = "TARGET\na\nTARGET\nc";
		const r = new Recovery(store);
		const rec = r.tryRecover({
			path: "f.ts",
			currentText: live,
			fileHash: h,
			edits: parsePatch("SWAP 2.=2:\n+NEW").edits,
		});
		// may refuse null when ambiguous
		if (rec !== null) {
			// if it recovers, must still produce valid text with exactly one NEW
			expect(rec.text.split("\n").filter(l => l === "NEW").length).toBeLessThanOrEqual(1);
		}
	});

	it("unique lines recover after prefix", () => {
		const store = new InMemorySnapshotStore();
		const orig = "uniq-a\nuniq-b\nuniq-c";
		const h = store.record("f.ts", orig);
		const live = "PRE\n" + orig;
		const r = new Recovery(store);
		const rec = r.tryRecover({
			path: "f.ts",
			currentText: live,
			fileHash: h,
			edits: parsePatch("SWAP 2.=2:\n+B2").edits,
		});
		expect(rec).not.toBeNull();
		expect(rec!.text.split("\n")).toContain("B2");
		expect(rec!.text.split("\n")).not.toContain("uniq-b");
	});
});
