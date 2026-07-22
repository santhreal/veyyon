/**
 * INS.HEAD on empty tagged file.
 */
import { describe, expect, it } from "bun:test";
import {
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
	formatHashlineHeader,
	computeFileHash,
} from "@veyyon/hashline";

describe("Patcher INS.HEAD empty file", () => {
	it("creates content from empty with matching empty hash", async () => {
		const fs = new InMemoryFilesystem([["e.ts", ""]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("e.ts", "");
		expect(tag).toBe(computeFileHash(""));
		const patcher = new Patcher({ fs, snapshots });
		await patcher.apply(
			Patch.parse(`${formatHashlineHeader("e.ts", tag)}\nINS.HEAD:\n+first`),
		);
		expect(fs.get("e.ts")).toBe("first");
	});
});
