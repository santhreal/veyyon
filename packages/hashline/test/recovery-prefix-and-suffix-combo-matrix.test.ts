/**
 * Recovery when both a unique prefix and suffix were added: anchors remap
 * by content uniqueness.
 */
import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore, parsePatch, Recovery } from "@veyyon/hashline";

describe("Recovery prefix+suffix combo matrix", () => {
	for (const pre of [1, 2]) {
		for (const suf of [1, 2]) {
			for (const target of [1, 3, 5]) {
				it(`pre=${pre} suf=${suf} SWAP ${target}`, () => {
					const origLines = Array.from({ length: 6 }, (_, i) => `C-${i + 1}`);
					const orig = origLines.join("\n");
					const store = new InMemorySnapshotStore();
					const h = store.record("f.ts", orig);
					const prefix = Array.from({ length: pre }, (_, i) => `P${i}`).join("\n");
					const suffix = Array.from({ length: suf }, (_, i) => `S${i}`).join("\n");
					const live = `${prefix}\n${orig}\n${suffix}`;
					const r = new Recovery(store);
					const rec = r.tryRecover({
						path: "f.ts",
						currentText: live,
						fileHash: h,
						edits: parsePatch(`SWAP ${target}.=${target}:\n+NEW`).edits,
					});
					expect(rec).not.toBeNull();
					const out = rec!.text.split("\n");
					expect(out.slice(0, pre)).toEqual(
						Array.from({ length: pre }, (_, i) => `P${i}`),
					);
					expect(out[pre + target - 1]).toBe("NEW");
					expect(out.slice(out.length - suf)).toEqual(
						Array.from({ length: suf }, (_, i) => `S${i}`),
					);
				});
			}
		}
	}
});
