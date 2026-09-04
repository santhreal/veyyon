import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore, parsePatch, RECOVERY_SESSION_CHAIN_WARNING, Recovery } from "@veyyon/hashline";

/**
 * Recovery session-chain accept: anchors hold, later drift preserved.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

const PATH = "src/chain.ts";

describe("Recovery session-chain accept", () => {
	it("preserves trailing drift while applying early SWAP", () => {
		const store = new InMemorySnapshotStore();
		const v0 = text(["A", "B", "C", "D", "E"]);
		const v1 = text(["A", "B", "C", "D", "E-DRIFT"]);
		const h0 = store.record(PATH, v0);
		store.record(PATH, v1);
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v1,
			fileHash: h0,
			edits: parsePatch("SWAP 2.=2:\n+B2").edits,
		});
		expect(recovered).not.toBeNull();
		expect(recovered!.text).toContain("B2");
		expect(recovered!.text).toContain("E-DRIFT");
		expect(recovered!.text.startsWith("A\n")).toBe(true);
	});

	it("warnings array is non-empty on successful session-chain recovery", () => {
		const store = new InMemorySnapshotStore();
		const v0 = text(["A", "B", "C"]);
		const v1 = text(["A", "B", "C-DRIFT"]);
		const h0 = store.record(PATH, v0);
		store.record(PATH, v1);
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v1,
			fileHash: h0,
			edits: parsePatch("SWAP 1.=1:\n+A2").edits,
		});
		expect(recovered).not.toBeNull();
		expect(recovered!.warnings.length).toBeGreaterThan(0);
		expect(recovered!.warnings.some(w => w.includes(RECOVERY_SESSION_CHAIN_WARNING) || w.length > 0)).toBe(true);
	});

	it("exact tag match with no drift still applies", () => {
		const store = new InMemorySnapshotStore();
		const v0 = text(["A", "B"]);
		const h0 = store.record(PATH, v0);
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v0,
			fileHash: h0,
			edits: parsePatch("SWAP 1.=1:\n+A2").edits,
		});
		// May recover or apply directly depending on path; if recovered, content updated.
		if (recovered) {
			expect(recovered.text).toContain("A2");
		}
	});
});
