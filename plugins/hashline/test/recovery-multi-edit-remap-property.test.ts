/**
 * Recovery remaps multi-edit patches after uniform prefix shift when all
 * anchors remain unique.
 */
import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore, parsePatch, Recovery } from "@veyyon/hashline";

describe("Recovery multi-edit remap property", () => {
	for (const prefix of [1, 2, 3]) {
		it(`prefix=${prefix} DEL first+last of unique 6-line file`, () => {
			const orig = Array.from({ length: 6 }, (_, i) => `U${i + 1}`).join("\n");
			const store = new InMemorySnapshotStore();
			const h = store.record("f.ts", orig);
			const pre = Array.from({ length: prefix }, (_, i) => `P${i}`).join("\n");
			const live = `${pre}\n${orig}`;
			const r = new Recovery(store);
			const rec = r.tryRecover({
				path: "f.ts",
				currentText: live,
				fileHash: h,
				edits: parsePatch("DEL 1\nDEL 6").edits,
			});
			expect(rec).not.toBeNull();
			const out = rec!.text.split("\n");
			expect(out.slice(0, prefix)).toEqual(Array.from({ length: prefix }, (_, i) => `P${i}`));
			expect(out.slice(prefix)).toEqual(["U2", "U3", "U4", "U5"]);
		});

		it(`prefix=${prefix} SWAP two disjoint lines`, () => {
			const orig = Array.from({ length: 5 }, (_, i) => `R${i + 1}`).join("\n");
			const store = new InMemorySnapshotStore();
			const h = store.record("g.ts", orig);
			const pre = Array.from({ length: prefix }, (_, i) => `X${i}`).join("\n");
			const live = `${pre}\n${orig}`;
			const r = new Recovery(store);
			const rec = r.tryRecover({
				path: "g.ts",
				currentText: live,
				fileHash: h,
				edits: parsePatch("SWAP 1.=1:\n+A\nSWAP 3.=3:\n+C").edits,
			});
			expect(rec).not.toBeNull();
			const out = rec!.text.split("\n");
			expect(out[prefix]).toBe("A");
			expect(out[prefix + 2]).toBe("C");
		});
	}
});
