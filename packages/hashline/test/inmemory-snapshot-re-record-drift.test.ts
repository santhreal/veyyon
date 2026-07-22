import { describe, expect, it } from "bun:test";
import {
	InMemorySnapshotStore,
	parsePatch,
	Recovery,
	computeFileHash,
} from "@veyyon/hashline";

/**
 * Re-record after drift creates new tag; old tag still usable for recovery.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

const PATH = "src/drift.ts";

describe("snapshot re-record after drift", () => {
	it("old and new tags differ; old tag recovers early edit", () => {
		const store = new InMemorySnapshotStore();
		const v0 = text(["A", "B", "C"]);
		const h0 = store.record(PATH, v0);
		const v1 = text(["A", "B", "C-DRIFT"]);
		const h1 = store.record(PATH, v1);
		expect(h0).not.toBe(h1);
		expect(h1).toBe(computeFileHash(v1));

		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v1,
			fileHash: h0,
			edits: parsePatch("SWAP 1.=1:\n+A2").edits,
		});
		expect(recovered).not.toBeNull();
		expect(recovered!.text).toContain("A2");
		expect(recovered!.text).toContain("C-DRIFT");
	});
});
