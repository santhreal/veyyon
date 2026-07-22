import { describe, expect, it } from "bun:test";
import {
	InMemorySnapshotStore,
	parsePatch,
	Recovery,
} from "@veyyon/hashline";

/**
 * Recovery with multi-line SWAP when only non-anchor later lines drifted.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

const PATH = "src/ms.ts";

describe("Recovery multi-line SWAP accept", () => {
	it("replaces two early lines while preserving late drift", () => {
		const store = new InMemorySnapshotStore();
		const v0 = text(["A", "B", "C", "D", "E"]);
		const v1 = text(["A", "B", "C", "D", "E-DRIFT"]);
		const h0 = store.record(PATH, v0);
		store.record(PATH, v1);
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v1,
			fileHash: h0,
			edits: parsePatch("SWAP 1.=2:\n+A2\n+B2").edits,
		});
		expect(recovered).not.toBeNull();
		expect(recovered!.text).toContain("A2");
		expect(recovered!.text).toContain("B2");
		expect(recovered!.text).toContain("E-DRIFT");
	});

	it("refuses multi-line SWAP when first anchor diverged", () => {
		const store = new InMemorySnapshotStore();
		const v0 = text(["A", "B", "C"]);
		const v1 = text(["A-x", "B", "C"]);
		const h0 = store.record(PATH, v0);
		store.record(PATH, v1);
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v1,
			fileHash: h0,
			edits: parsePatch("SWAP 1.=2:\n+X\n+Y").edits,
		});
		expect(recovered).toBeNull();
	});
});
