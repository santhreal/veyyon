/**
 * Recovery remaps anchors after a uniform prefix insertion when every anchored
 * line still matches uniquely. Property over shift sizes and target lines.
 */
import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore, parsePatch, Recovery } from "@veyyon/hashline";

describe("Recovery uniform prefix shift matrix", () => {
	for (const prefixLines of [1, 2, 3, 5]) {
		for (const target of [1, 2, 3, 5, 8]) {
			it(`prefix=${prefixLines} SWAP line ${target}`, () => {
				const origLines = Array.from({ length: 10 }, (_, i) => `uniq-${i + 1}`);
				const orig = origLines.join("\n");
				const store = new InMemorySnapshotStore();
				const h = store.record("f.ts", orig);
				const prefix = Array.from({ length: prefixLines }, (_, i) => `PRE-${i}`).join("\n");
				const live = `${prefix}\n${orig}`;
				const r = new Recovery(store);
				const rec = r.tryRecover({
					path: "f.ts",
					currentText: live,
					fileHash: h,
					edits: parsePatch(`SWAP ${target}.=${target}:\n+NEW-${target}`).edits,
				});
				expect(rec).not.toBeNull();
				const out = rec!.text.split("\n");
				// Prefix intact, target remapped to target+prefixLines
				expect(out.slice(0, prefixLines)).toEqual(Array.from({ length: prefixLines }, (_, i) => `PRE-${i}`));
				expect(out[prefixLines + target - 1]).toBe(`NEW-${target}`);
				// Unchanged neighbors
				if (target > 1) expect(out[prefixLines + target - 2]).toBe(`uniq-${target - 1}`);
				if (target < 10) expect(out[prefixLines + target]).toBe(`uniq-${target + 1}`);
				expect(rec!.warnings.some(w => /remap/i.test(w))).toBe(true);
			});
		}
	}

	for (const prefixLines of [1, 3]) {
		it(`prefix=${prefixLines} multi DEL first and last`, () => {
			const origLines = Array.from({ length: 6 }, (_, i) => `row-${i + 1}`);
			const orig = origLines.join("\n");
			const store = new InMemorySnapshotStore();
			const h = store.record("g.ts", orig);
			const prefix = Array.from({ length: prefixLines }, (_, i) => `P${i}`).join("\n");
			const live = `${prefix}\n${orig}`;
			const r = new Recovery(store);
			const rec = r.tryRecover({
				path: "g.ts",
				currentText: live,
				fileHash: h,
				edits: parsePatch("DEL 1\nDEL 6").edits,
			});
			expect(rec).not.toBeNull();
			const out = rec!.text.split("\n");
			expect(out.slice(0, prefixLines)).toEqual(Array.from({ length: prefixLines }, (_, i) => `P${i}`));
			expect(out.slice(prefixLines)).toEqual(["row-2", "row-3", "row-4", "row-5"]);
		});
	}
});
