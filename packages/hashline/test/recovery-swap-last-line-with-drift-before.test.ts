import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore, parsePatch, Recovery } from "@veyyon/hashline";

/**
 * Recovery when early lines drifted but the SWAP target is late and unchanged.
 * Document accept vs refuse for late anchors with early drift.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

const PATH = "src/late.ts";

describe("Recovery late SWAP with early drift", () => {
	it("SWAP last line when first line drifted", () => {
		const store = new InMemorySnapshotStore();
		const v0 = text(["A", "B", "C"]);
		const v1 = text(["A-DRIFT", "B", "C"]);
		const h0 = store.record(PATH, v0);
		store.record(PATH, v1);
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v1,
			fileHash: h0,
			edits: parsePatch("SWAP 3.=3:\n+C2").edits,
		});
		// If recovery only checks anchors of the edit, C is unchanged → accept.
		// If recovery is more conservative, refuse.
		if (recovered) {
			expect(recovered.text).toContain("C2");
			expect(recovered.text).toContain("A-DRIFT");
		} else {
			expect(recovered).toBeNull();
		}
	});
});
