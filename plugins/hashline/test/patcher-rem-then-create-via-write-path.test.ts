/**
 * After REM, a new write-style create path: file absent, head/tail inserts may create.
 * Anchored ops on missing files must fail closed.
 */
import { describe, expect, it } from "bun:test";
import {
	computeFileHash,
	formatHashlineHeader,
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
} from "@veyyon/hashline";

describe("Patcher after REM and create edges", () => {
	it("REM then re-create is not via hashline (missing file + anchor fails)", async () => {
		const fs = new InMemoryFilesystem([["f.ts", "x\n"]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("f.ts", "x\n");
		const patcher = new Patcher({ fs, snapshots });
		await patcher.apply(Patch.parse(`${formatHashlineHeader("f.ts", tag)}\nREM`));
		expect(fs.get("f.ts")).toBeUndefined();
		// Tag from old content; file gone — must not invent file from SWAP
		await expect(
			patcher.apply(Patch.parse(`${formatHashlineHeader("f.ts", tag)}\nSWAP 1.=1:\n+new`)),
		).rejects.toThrow();
		expect(fs.get("f.ts")).toBeUndefined();
	});

	it("two-file REM only deletes the targeted path", async () => {
		const fs = new InMemoryFilesystem([
			["keep.ts", "k\n"],
			["drop.ts", "d\n"],
		]);
		const snapshots = new InMemorySnapshotStore();
		const keepTag = snapshots.record("keep.ts", "k\n");
		const dropTag = snapshots.record("drop.ts", "d\n");
		const patcher = new Patcher({ fs, snapshots });
		await patcher.apply(Patch.parse(`${formatHashlineHeader("drop.ts", dropTag)}\nREM`));
		expect(fs.get("drop.ts")).toBeUndefined();
		expect(fs.get("keep.ts")).toBe("k\n");
		// keep still editable
		await patcher.apply(Patch.parse(`${formatHashlineHeader("keep.ts", keepTag)}\nSWAP 1.=1:\n+K`));
		expect(fs.get("keep.ts")).toBe("K\n");
	});

	it("empty file with matching hash accepts INS.TAIL", async () => {
		const fs = new InMemoryFilesystem([["e.ts", ""]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("e.ts", "");
		expect(tag).toBe(computeFileHash(""));
		const patcher = new Patcher({ fs, snapshots });
		await patcher.apply(Patch.parse(`${formatHashlineHeader("e.ts", tag)}\nINS.TAIL:\n+line`));
		// Empty source has no trailing newline to preserve; result is bare "line".
		expect(fs.get("e.ts")).toBe("line");
	});
});
