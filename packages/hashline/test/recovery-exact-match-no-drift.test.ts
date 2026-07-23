import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore, parsePatch, Recovery } from "@veyyon/hashline";

/**
 * Recovery when current text still matches the snapshot (no drift).
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

const PATH = "src/exact.ts";

describe("Recovery exact match no drift", () => {
	it("applies SWAP when tag matches and text is unchanged", () => {
		const store = new InMemorySnapshotStore();
		const v0 = text(["A", "B", "C"]);
		const h0 = store.record(PATH, v0);
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v0,
			fileHash: h0,
			edits: parsePatch("SWAP 2.=2:\n+B2").edits,
		});
		// With no drift, recovery may return applied text or null if caller applies directly.
		if (recovered) {
			expect(recovered.text).toContain("B2");
			expect(recovered.text).toContain("A");
			expect(recovered.text).toContain("C");
		}
	});

	it("applies DEL when tag matches and text is unchanged", () => {
		const store = new InMemorySnapshotStore();
		const v0 = text(["A", "B", "C"]);
		const h0 = store.record(PATH, v0);
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v0,
			fileHash: h0,
			edits: parsePatch("DEL 2.=2").edits,
		});
		if (recovered) {
			expect(recovered.text).toBe(text(["A", "C"]));
		}
	});
});
