/**
 * Recovery after suffix-only append: line numbers for original content stay
 * stable (no remap needed for anchors still pointing at same content), but
 * recovery still accepts when hash is stale via session remap path.
 */
import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore, parsePatch, Recovery } from "@veyyon/hashline";

describe("Recovery uniform suffix append matrix", () => {
	for (const suffixLines of [1, 2, 4]) {
		for (const target of [1, 3, 5]) {
			it(`suffix=${suffixLines} SWAP ${target}`, () => {
				const origLines = Array.from({ length: 7 }, (_, i) => `S-${i + 1}`);
				const orig = origLines.join("\n");
				const store = new InMemorySnapshotStore();
				const h = store.record("s.ts", orig);
				const suffix = Array.from({ length: suffixLines }, (_, i) => `SUF-${i}`).join("\n");
				const live = `${orig}\n${suffix}`;
				const r = new Recovery(store);
				const rec = r.tryRecover({
					path: "s.ts",
					currentText: live,
					fileHash: h,
					edits: parsePatch(`SWAP ${target}.=${target}:\n+Z${target}`).edits,
				});
				expect(rec).not.toBeNull();
				const out = rec!.text.split("\n");
				expect(out[target - 1]).toBe(`Z${target}`);
				// Suffix still present at the end
				expect(out.slice(out.length - suffixLines)).toEqual(
					Array.from({ length: suffixLines }, (_, i) => `SUF-${i}`),
				);
				// Non-target original lines preserved
				for (let i = 1; i <= 7; i++) {
					if (i === target) continue;
					expect(out[i - 1]).toBe(`S-${i}`);
				}
			});
		}
	}

	it("suffix append + INS.POST last original lands before suffix", () => {
		const orig = "a\nb\nc";
		const store = new InMemorySnapshotStore();
		const h = store.record("i.ts", orig);
		const live = "a\nb\nc\nTAIL";
		const r = new Recovery(store);
		const rec = r.tryRecover({
			path: "i.ts",
			currentText: live,
			fileHash: h,
			edits: parsePatch("INS.POST 3:\n+mid").edits,
		});
		expect(rec).not.toBeNull();
		expect(rec!.text).toBe("a\nb\nc\nmid\nTAIL");
	});
});
