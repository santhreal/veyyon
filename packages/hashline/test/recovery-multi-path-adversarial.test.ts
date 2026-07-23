import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore, parsePatch, Recovery } from "@veyyon/hashline";

/**
 * Recovery across multiple paths in one store — isolation of tags and refuse.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

describe("Recovery multi-path isolation", () => {
	it("tag for path A does not recover path B", () => {
		const store = new InMemorySnapshotStore();
		const a = "src/a.ts";
		const b = "src/b.ts";
		const va = text(["A1", "A2"]);
		const vb = text(["B1", "B2"]);
		const ha = store.record(a, va);
		store.record(b, vb);
		const { edits } = parsePatch("SWAP 1.=1:\n+A1x");
		const recovered = new Recovery(store).tryRecover({
			path: b,
			currentText: vb,
			fileHash: ha,
			edits,
		});
		// Wrong path's tag must not apply to B.
		expect(recovered).toBeNull();
	});

	it("each path recovers independently when anchors hold", () => {
		const store = new InMemorySnapshotStore();
		const a = "src/a.ts";
		const b = "src/b.ts";
		const va0 = text(["A1", "A2", "A3"]);
		const vb0 = text(["B1", "B2", "B3"]);
		const ha = store.record(a, va0);
		const hb = store.record(b, vb0);
		// Drift later lines on both.
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
