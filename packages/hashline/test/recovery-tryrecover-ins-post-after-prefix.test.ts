/**
 * Recovery remaps INS.POST after a prefix insert drift.
 */
import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore, parsePatch, Recovery } from "@veyyon/hashline";

describe("Recovery INS.POST after prefix", () => {
	it("inserts after remapped anchor", () => {
		const store = new InMemorySnapshotStore();
		const v0 = "a\nb\nc";
		const h0 = store.record("f.ts", v0);
		const v1 = "PRE\na\nb\nc";
		store.record("f.ts", v1);
		const r = new Recovery(store);
		// original INS.POST 2 inserts after 'b'
		const result = r.tryRecover({
			path: "f.ts",
			currentText: v1,
			fileHash: h0,
			edits: parsePatch("INS.POST 2:\n+X").edits,
		});
		expect(result).not.toBeNull();
		if (!result) return;
		const lines = result.text.split("\n");
		expect(lines).toContain("X");
		expect(lines).toContain("PRE");
		// X should be after b
		const bi = lines.indexOf("b");
		const xi = lines.indexOf("X");
		expect(xi).toBe(bi + 1);
	});
});
