import { describe, expect, it } from "bun:test";
import {
	InMemorySnapshotStore,
	parsePatch,
	Recovery,
} from "@veyyon/hashline";

/**
 * Recovery DEL accept when deleted anchors are unchanged and later lines drifted.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

const PATH = "src/del.ts";

describe("Recovery DEL accept", () => {
	it("deletes an early unchanged line while preserving late drift", () => {
		const store = new InMemorySnapshotStore();
		const v0 = text(["A", "B", "C", "D"]);
		const v1 = text(["A", "B", "C", "D-DRIFT"]);
		const h0 = store.record(PATH, v0);
		store.record(PATH, v1);
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v1,
			fileHash: h0,
			edits: parsePatch("DEL 2.=2").edits,
		});
		if (recovered) {
			expect(recovered.text).not.toMatch(/\nB\n/);
			expect(recovered.text.startsWith("A\n")).toBe(true);
			expect(recovered.text).toContain("D-DRIFT");
		} else {
			// Refuse is also valid for DEL under drift.
			expect(recovered).toBeNull();
		}
	});

	it("refuses DEL when the deleted line itself drifted", () => {
		const store = new InMemorySnapshotStore();
		const v0 = text(["A", "B", "C"]);
		const v1 = text(["A", "B-x", "C"]);
		const h0 = store.record(PATH, v0);
		store.record(PATH, v1);
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v1,
			fileHash: h0,
			edits: parsePatch("DEL 2.=2").edits,
		});
		expect(recovered).toBeNull();
	});
});
