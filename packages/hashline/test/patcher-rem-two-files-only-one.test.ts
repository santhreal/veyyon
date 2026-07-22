/**
 * REM one of two files leaves the other intact.
 */
import { describe, expect, it } from "bun:test";
import {
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
	formatHashlineHeader,
} from "@veyyon/hashline";

describe("Patcher REM one of two files", () => {
	it("removes only targeted path", async () => {
		const fs = new InMemoryFilesystem([
			["keep.ts", "k\n"],
			["drop.ts", "d\n"],
		]);
		const snapshots = new InMemorySnapshotStore();
		const td = snapshots.record("drop.ts", "d\n");
		snapshots.record("keep.ts", "k\n");
		const patcher = new Patcher({ fs, snapshots });
		await patcher.apply(Patch.parse(`${formatHashlineHeader("drop.ts", td)}\nREM`));
		expect(fs.get("drop.ts")).toBeUndefined();
		expect(fs.get("keep.ts")).toBe("k\n");
	});
});
