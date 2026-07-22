import { describe, expect, it } from "bun:test";
import {
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
	Recovery,
	parsePatch,
} from "@veyyon/hashline";

/**
 * After apply, store records new snapshot; recovery from old tag with drift.
 */

function text(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

describe("Patcher then Recovery setup", () => {
	it("old tag with late drift can still recover early SWAP", async () => {
		const path = "a.ts";
		const v0 = text(["A", "B", "C"]);
		const mem = new InMemoryFilesystem([[path, v0]]);
		const snapshots = new InMemorySnapshotStore();
		const h0 = snapshots.record(path, v0);
		const patcher = new Patcher({ fs: mem, snapshots });
		// External drift of last line without going through patcher.
		const v1 = text(["A", "B", "C-DRIFT"]);
		mem.set(path, v1);
		snapshots.record(path, v1);

		const recovered = new Recovery(snapshots).tryRecover({
			path,
			currentText: v1,
			fileHash: h0,
			edits: parsePatch("SWAP 1.=1:\n+A2").edits,
		});
		expect(recovered).not.toBeNull();
		expect(recovered!.text).toContain("A2");
		expect(recovered!.text).toContain("C-DRIFT");

		// Apply recovered text via patcher is out of band; just lock recovery result.
		void patcher;
	});
});
