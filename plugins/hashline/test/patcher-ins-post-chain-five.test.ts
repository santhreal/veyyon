/**
 * Five INS.POST steps building a list with refreshed tags.
 */
import { describe, expect, it } from "bun:test";
import { formatHashlineHeader, InMemoryFilesystem, InMemorySnapshotStore, Patch, Patcher } from "@veyyon/hashline";

describe("Patcher five INS.POST chain", () => {
	it("appends 1..5 after initial seed", async () => {
		const fs = new InMemoryFilesystem([["f.ts", "seed\n"]]);
		const snapshots = new InMemorySnapshotStore();
		let tag = snapshots.record("f.ts", "seed\n");
		const patcher = new Patcher({ fs, snapshots });
		for (let i = 1; i <= 5; i++) {
			// always POST after last line: line number grows
			const lastLine = i; // seed is line 1, after first insert 2 lines, etc.
			const r = await patcher.apply(
				Patch.parse(`${formatHashlineHeader("f.ts", tag)}\nINS.POST ${lastLine}:\n+${i}`),
			);
			tag = r.sections[0]!.fileHash!;
		}
		expect(fs.get("f.ts")).toBe("seed\n1\n2\n3\n4\n5\n");
	});
});
