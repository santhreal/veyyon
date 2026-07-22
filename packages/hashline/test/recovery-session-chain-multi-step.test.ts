/**
 * Multi-step session recovery: v0→v1→v2 content chain, stale tags from each version.
 */
import { describe, expect, it } from "bun:test";
import {
	InMemorySnapshotStore,
	parsePatch,
	Recovery,
	RECOVERY_SESSION_CHAIN_WARNING,
} from "@veyyon/hashline";

describe("Recovery multi-step session chain", () => {
	it("tag from v0 still remaps after two session advances", () => {
		const store = new InMemorySnapshotStore({ maxVersionsPerPath: 4 });
		const v0 = "A\nB\nC";
		const h0 = store.record("f.ts", v0);
		const v1 = "A\nB\nC\nD"; // append
		store.record("f.ts", v1);
		const v2 = "PRE\nA\nB\nC\nD"; // prepend
		store.record("f.ts", v2);

		const recovery = new Recovery(store);
		// Under h0, line 2 is B; after two drifts B should still map
		const result = recovery.tryRecover({
			path: "f.ts",
			currentText: v2,
			fileHash: h0,
			edits: parsePatch("SWAP 2.=2:\n+BNEW").edits,
		});
		expect(result).not.toBeNull();
		if (!result) return;
		expect(result.text.split("\n")).toContain("BNEW");
		expect(result.text.split("\n")).toContain("PRE");
		expect(result.text.split("\n")).toContain("D");
		expect(result.warnings.some(w => w.includes("Recovered") || w === RECOVERY_SESSION_CHAIN_WARNING)).toBe(
			true,
		);
	});

	it("tag from middle version remaps on latest", () => {
		const store = new InMemorySnapshotStore();
		store.record("f.ts", "x\ny\nz");
		const h1 = store.record("f.ts", "x\nMID\ny\nz");
		const live = "HEAD\nx\nMID\ny\nz";
		store.record("f.ts", live);
		const recovery = new Recovery(store);
		const result = recovery.tryRecover({
			path: "f.ts",
			currentText: live,
			fileHash: h1,
			edits: parsePatch("SWAP 2.=2:\n+MID2").edits,
		});
		expect(result).not.toBeNull();
		if (!result) return;
		expect(result.text).toContain("MID2");
		expect(result.text).toContain("HEAD");
	});

	it("evicted old version cannot recover", () => {
		const store = new InMemorySnapshotStore({ maxVersionsPerPath: 2 });
		const h0 = store.record("f.ts", "v0");
		store.record("f.ts", "v1");
		store.record("f.ts", "v2"); // drops v0
		expect(store.byHash("f.ts", h0)).toBeNull();
		const recovery = new Recovery(store);
		expect(
			recovery.tryRecover({
				path: "f.ts",
				currentText: "v2",
				fileHash: h0,
				edits: parsePatch("SWAP 1.=1:\n+X").edits,
			}),
		).toBeNull();
	});
});
