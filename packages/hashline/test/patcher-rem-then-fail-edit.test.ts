/**
 * After REM, further anchored edit with old tag fails and stays missing.
 */
import { describe, expect, it } from "bun:test";
import {
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
	formatHashlineHeader,
} from "@veyyon/hashline";

describe("Patcher REM then edit fails", () => {
	it("file stays missing after failed re-edit", async () => {
		const fs = new InMemoryFilesystem([["f.ts", "x\n"]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("f.ts", "x\n");
		const patcher = new Patcher({ fs, snapshots });
		await patcher.apply(Patch.parse(`${formatHashlineHeader("f.ts", tag)}\nREM`));
		expect(fs.get("f.ts")).toBeUndefined();
		await expect(
			patcher.apply(Patch.parse(`${formatHashlineHeader("f.ts", tag)}\nSWAP 1.=1:\n+y`)),
		).rejects.toThrow();
		expect(fs.get("f.ts")).toBeUndefined();
	});
});
