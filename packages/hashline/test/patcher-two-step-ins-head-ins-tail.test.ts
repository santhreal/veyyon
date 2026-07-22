/**
 * Patcher two-step HEAD then TAIL with tags.
 */
import { describe, expect, it } from "bun:test";
import {
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
	formatHashlineHeader,
} from "@veyyon/hashline";

describe("Patcher HEAD then TAIL two-step", () => {
	it("sandwiches body", async () => {
		const content = "body\n";
		const fs = new InMemoryFilesystem([["f.ts", content]]);
		const snapshots = new InMemorySnapshotStore();
		let tag = snapshots.record("f.ts", content);
		const patcher = new Patcher({ fs, snapshots });
		const r1 = await patcher.apply(
			Patch.parse(`${formatHashlineHeader("f.ts", tag)}\nINS.HEAD:\n+H`),
		);
		tag = r1.sections[0]!.fileHash!;
		await patcher.apply(
			Patch.parse(`${formatHashlineHeader("f.ts", tag)}\nINS.TAIL:\n+T`),
		);
		expect(fs.get("f.ts")).toBe("H\nbody\nT\n");
	});
});
