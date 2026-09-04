/**
 * Recovery.tryRecover null matrix: every fail-closed situation returns null.
 */
import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore, parsePatch, Recovery } from "@veyyon/hashline";

describe("Recovery.tryRecover null matrix", () => {
	it("unknown hash", () => {
		const store = new InMemorySnapshotStore();
		store.record("f.ts", "a\nb");
		const r = new Recovery(store);
		expect(
			r.tryRecover({
				path: "f.ts",
				currentText: "a\nb",
				fileHash: "0000",
				edits: parsePatch("DEL 1").edits,
			}),
		).toBeNull();
	});

	it("unknown path", () => {
		const store = new InMemorySnapshotStore();
		const r = new Recovery(store);
		expect(
			r.tryRecover({
				path: "missing.ts",
				currentText: "x",
				fileHash: "AAAA",
				edits: parsePatch("DEL 1").edits,
			}),
		).toBeNull();
	});

	it("content changed at anchor", () => {
		const store = new InMemorySnapshotStore();
		const h = store.record("f.ts", "a\nOLD\nc");
		const r = new Recovery(store);
		expect(
			r.tryRecover({
				path: "f.ts",
				currentText: "a\nNEW\nc",
				fileHash: h,
				edits: parsePatch("SWAP 2.=2:\n+X").edits,
			}),
		).toBeNull();
	});

	it("target line deleted", () => {
		const store = new InMemorySnapshotStore();
		const h = store.record("f.ts", "a\nGONE\nb");
		const r = new Recovery(store);
		expect(
			r.tryRecover({
				path: "f.ts",
				currentText: "a\nb",
				fileHash: h,
				edits: parsePatch("SWAP 2.=2:\n+X").edits,
			}),
		).toBeNull();
	});

	it("evicted version after ring full", () => {
		const store = new InMemorySnapshotStore({ maxVersionsPerPath: 1 });
		const h0 = store.record("f.ts", "v0");
		store.record("f.ts", "v1");
		expect(store.byHash("f.ts", h0)).toBeNull();
		const r = new Recovery(store);
		expect(
			r.tryRecover({
				path: "f.ts",
				currentText: "v1",
				fileHash: h0,
				edits: parsePatch("SWAP 1.=1:\n+X").edits,
			}),
		).toBeNull();
	});
});
