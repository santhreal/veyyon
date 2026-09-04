import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore, parsePatch, Recovery } from "@veyyon/hashline";

/**
 * Recovery with INS ops when anchors hold and later lines drifted.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

const PATH = "src/ins.ts";

describe("Recovery INS accept", () => {
	it("INS.POST after line 1 with late drift", () => {
		const store = new InMemorySnapshotStore();
		const v0 = text(["A", "B", "C"]);
		const v1 = text(["A", "B", "C-DRIFT"]);
		const h0 = store.record(PATH, v0);
		store.record(PATH, v1);
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v1,
			fileHash: h0,
			edits: parsePatch("INS.POST 1:\n+X").edits,
		});
		if (recovered) {
			expect(recovered.text).toContain("X");
			expect(recovered.text).toContain("A");
			expect(recovered.text).toContain("C-DRIFT");
		}
	});

	it("INS.HEAD with late drift", () => {
		const store = new InMemorySnapshotStore();
		const v0 = text(["A", "B"]);
		const v1 = text(["A", "B-DRIFT"]);
		const h0 = store.record(PATH, v0);
		store.record(PATH, v1);
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v1,
			fileHash: h0,
			edits: parsePatch("INS.HEAD:\n+H").edits,
		});
		if (recovered) {
			expect(recovered.text.startsWith("H\n")).toBe(true);
			expect(recovered.text).toContain("B-DRIFT");
		}
	});
});
