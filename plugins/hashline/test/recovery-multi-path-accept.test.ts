import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore, parsePatch, Recovery } from "@veyyon/hashline";

/**
 * Independent recovery on two paths in one store with late drift each.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

describe("Recovery multi-path accept", () => {
	it("recovers SWAP on each path independently", () => {
		const store = new InMemorySnapshotStore();
		const a = "a.ts";
		const b = "b.ts";
		const va0 = text(["A1", "A2", "A3"]);
		const vb0 = text(["B1", "B2", "B3"]);
		const ha = store.record(a, va0);
		const hb = store.record(b, vb0);
		const va1 = text(["A1", "A2", "A3-DRIFT"]);
		const vb1 = text(["B1", "B2", "B3-DRIFT"]);
		store.record(a, va1);
		store.record(b, vb1);

		const ra = new Recovery(store).tryRecover({
			path: a,
			currentText: va1,
			fileHash: ha,
			edits: parsePatch("SWAP 1.=1:\n+A1x").edits,
		});
		const rb = new Recovery(store).tryRecover({
			path: b,
			currentText: vb1,
			fileHash: hb,
			edits: parsePatch("SWAP 1.=1:\n+B1x").edits,
		});
		expect(ra).not.toBeNull();
		expect(rb).not.toBeNull();
		expect(ra!.text).toContain("A1x");
		expect(ra!.text).toContain("A3-DRIFT");
		expect(rb!.text).toContain("B1x");
		expect(rb!.text).toContain("B3-DRIFT");
	});
});
