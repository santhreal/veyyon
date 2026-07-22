import { describe, expect, it } from "bun:test";
import {
	InMemorySnapshotStore,
	parsePatch,
	Recovery,
} from "@veyyon/hashline";

/**
 * Recovery DEL first line when later lines drifted.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

const PATH = "src/df.ts";

describe("Recovery DEL first accept", () => {
	it("deletes first line with late drift", () => {
		const store = new InMemorySnapshotStore();
		const v0 = text(["A", "B", "C"]);
		const v1 = text(["A", "B", "C-DRIFT"]);
		const h0 = store.record(PATH, v0);
		store.record(PATH, v1);
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v1,
			fileHash: h0,
			edits: parsePatch("DEL 1.=1").edits,
		});
		if (recovered) {
			expect(recovered.text.startsWith("B\n")).toBe(true);
			expect(recovered.text).toContain("C-DRIFT");
			expect(recovered.text.includes("A\n")).toBe(false);
		} else {
			expect(recovered).toBeNull();
		}
	});
});
