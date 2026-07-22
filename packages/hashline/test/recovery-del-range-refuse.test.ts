import { describe, expect, it } from "bun:test";
import {
	InMemorySnapshotStore,
	parsePatch,
	Recovery,
} from "@veyyon/hashline";

/**
 * Recovery DEL range refuse when any deleted line drifted.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

const PATH = "src/dr.ts";

describe("Recovery DEL range refuse", () => {
	it("refuses DEL 2.=3 when line 2 drifted", () => {
		const store = new InMemorySnapshotStore();
		const v0 = text(["A", "B", "C", "D"]);
		const v1 = text(["A", "B-x", "C", "D"]);
		const h0 = store.record(PATH, v0);
		store.record(PATH, v1);
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v1,
			fileHash: h0,
			edits: parsePatch("DEL 2.=3").edits,
		});
		expect(recovered).toBeNull();
	});

	it("refuses DEL 2.=3 when line 3 drifted", () => {
		const store = new InMemorySnapshotStore();
		const v0 = text(["A", "B", "C", "D"]);
		const v1 = text(["A", "B", "C-x", "D"]);
		const h0 = store.record(PATH, v0);
		store.record(PATH, v1);
		const recovered = new Recovery(store).tryRecover({
			path: PATH,
			currentText: v1,
			fileHash: h0,
			edits: parsePatch("DEL 2.=3").edits,
		});
		expect(recovered).toBeNull();
	});
});
