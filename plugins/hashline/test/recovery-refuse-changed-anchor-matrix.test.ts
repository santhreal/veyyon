/**
 * Recovery fail-closed when the anchored line content changed (not pure shift).
 * Property over target lines and mutation styles.
 */
import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore, parsePatch, Recovery } from "@veyyon/hashline";

describe("Recovery refuse changed anchor matrix", () => {
	for (const target of [1, 2, 3, 5]) {
		it(`refuses SWAP when line ${target} content mutated`, () => {
			const origLines = Array.from({ length: 6 }, (_, i) => `U${i + 1}`);
			const orig = origLines.join("\n");
			const store = new InMemorySnapshotStore();
			const h = store.record("f.ts", orig);
			const liveLines = [...origLines];
			liveLines[target - 1] = `MUTATED-${target}`;
			const r = new Recovery(store);
			const rec = r.tryRecover({
				path: "f.ts",
				currentText: liveLines.join("\n"),
				fileHash: h,
				edits: parsePatch(`SWAP ${target}.=${target}:\n+NEW`).edits,
			});
			expect(rec).toBeNull();
		});

		it(`refuses DEL when line ${target} content mutated`, () => {
			const origLines = Array.from({ length: 6 }, (_, i) => `D${i + 1}`);
			const orig = origLines.join("\n");
			const store = new InMemorySnapshotStore();
			const h = store.record("d.ts", orig);
			const liveLines = [...origLines];
			liveLines[target - 1] = `CHANGED`;
			const r = new Recovery(store);
			expect(
				r.tryRecover({
					path: "d.ts",
					currentText: liveLines.join("\n"),
					fileHash: h,
					edits: parsePatch(`DEL ${target}`).edits,
				}),
			).toBeNull();
		});
	}

	it("refuses when target line deleted from live file", () => {
		const store = new InMemorySnapshotStore();
		const h = store.record("g.ts", "a\nb\nc");
		const r = new Recovery(store);
		expect(
			r.tryRecover({
				path: "g.ts",
				currentText: "a\nc",
				fileHash: h,
				edits: parsePatch("SWAP 2.=2:\n+X").edits,
			}),
		).toBeNull();
	});

	it("refuses unknown hash even if path content matches", () => {
		const store = new InMemorySnapshotStore();
		store.record("g.ts", "a\nb");
		const r = new Recovery(store);
		expect(
			r.tryRecover({
				path: "g.ts",
				currentText: "a\nb",
				fileHash: "0000",
				edits: parsePatch("DEL 1").edits,
			}),
		).toBeNull();
	});
});
