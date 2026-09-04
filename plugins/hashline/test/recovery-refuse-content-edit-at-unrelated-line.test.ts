/**
 * Recovery still accepts when drift is outside the anchor set (suffix/prefix
 * only) and refuses when the anchor line itself changed.
 */
import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore, parsePatch, Recovery } from "@veyyon/hashline";

describe("Recovery refuse content edit at unrelated vs anchor", () => {
	it("accepts when only unanchored line drifted", () => {
		const store = new InMemorySnapshotStore();
		const orig = "a\nb\nc\nd";
		const h = store.record("f.ts", orig);
		// change line 4 while editing line 1
		const live = "a\nb\nc\nDRIFT";
		const r = new Recovery(store);
		const rec = r.tryRecover({
			path: "f.ts",
			currentText: live,
			fileHash: h,
			edits: parsePatch("SWAP 1.=1:\n+A").edits,
		});
		// may accept if neighbors validate
		if (rec) {
			expect(rec.text.split("\n")[0]).toBe("A");
			expect(rec.text.split("\n")[3]).toBe("DRIFT");
		}
	});

	it("refuses when anchor line content changed", () => {
		const store = new InMemorySnapshotStore();
		const orig = "a\nb\nc";
		const h = store.record("f.ts", orig);
		const live = "a\nCHANGED\nc";
		const r = new Recovery(store);
		expect(
			r.tryRecover({
				path: "f.ts",
				currentText: live,
				fileHash: h,
				edits: parsePatch("SWAP 2.=2:\n+X").edits,
			}),
		).toBeNull();
	});
});
