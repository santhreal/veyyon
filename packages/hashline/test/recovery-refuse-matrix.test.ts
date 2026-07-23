import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore, parsePatch, Recovery } from "@veyyon/hashline";

/**
 * Recovery refuse matrix: many divergence patterns return null.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

const PATH = "src/r.ts";

describe("Recovery refuse matrix", () => {
	it("refuses when each anchor line of a multi-line SWAP has diverged", () => {
		const store = new InMemorySnapshotStore();
		const v0 = text(["A", "B", "C", "D"]);
		const v1 = text(["A-x", "B-x", "C-x", "D"]);
		const h0 = store.record(PATH, v0);
		store.record(PATH, v1);
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v1,
			fileHash: h0,
			edits: parsePatch("SWAP 1.=3:\n+X\n+Y\n+Z").edits,
		});
		expect(recovered).toBeNull();
	});

	it("refuses unknown tag regardless of current text matching snapshot", () => {
		const store = new InMemorySnapshotStore();
		const v0 = text(["A", "B"]);
		store.record(PATH, v0);
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v0,
			fileHash: "0000",
			edits: parsePatch("SWAP 1.=1:\n+X").edits,
		});
		expect(recovered).toBeNull();
	});

	it("refuses empty store", () => {
		const store = new InMemorySnapshotStore();
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: text(["A"]),
			fileHash: "abcd",
			edits: parsePatch("SWAP 1.=1:\n+X").edits,
		});
		expect(recovered).toBeNull();
	});

	it("accepts when only non-anchor lines diverged", () => {
		const store = new InMemorySnapshotStore();
		const v0 = text(["KEEP", "mid", "TAIL"]);
		const v1 = text(["KEEP", "mid", "TAIL-DRIFT"]);
		const h0 = store.record(PATH, v0);
		store.record(PATH, v1);
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v1,
			fileHash: h0,
			edits: parsePatch("SWAP 1.=1:\n+KEEP2").edits,
		});
		expect(recovered).not.toBeNull();
		expect(recovered!.text).toContain("KEEP2");
		expect(recovered!.text).toContain("TAIL-DRIFT");
	});
});
