import { describe, expect, it } from "bun:test";
import {
	InMemorySnapshotStore,
	parsePatch,
	Recovery,
} from "@veyyon/hashline";

/**
 * Recovery INS.TAIL with late drift.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

const PATH = "src/it.ts";

describe("Recovery INS.TAIL accept", () => {
	it("appends with late drift preserved", () => {
		const store = new InMemorySnapshotStore();
		const v0 = text(["A", "B"]);
		const v1 = text(["A", "B-DRIFT"]);
		const h0 = store.record(PATH, v0);
		store.record(PATH, v1);
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v1,
			fileHash: h0,
			edits: parsePatch("INS.TAIL:\n+T").edits,
		});
		if (recovered) {
			expect(recovered.text).toContain("T");
			expect(recovered.text).toContain("B-DRIFT");
		}
	});
});
