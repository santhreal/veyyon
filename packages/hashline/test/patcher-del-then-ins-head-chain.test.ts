/**
 * Patcher: DEL all content then INS.HEAD to repopulate with new tag chain.
 */
import { describe, expect, it } from "bun:test";
import {
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
	formatHashlineHeader,
} from "@veyyon/hashline";

describe("Patcher DEL then INS.HEAD chain", () => {
	it("clear file then insert new head content", async () => {
		const content = "a\nb\n";
		const fs = new InMemoryFilesystem([["f.ts", content]]);
		const snapshots = new InMemorySnapshotStore();
		let tag = snapshots.record("f.ts", content);
		const patcher = new Patcher({ fs, snapshots });
		const r1 = await patcher.apply(
			Patch.parse(`${formatHashlineHeader("f.ts", tag)}\nDEL 1.=2`),
		);
		tag = r1.sections[0]!.fileHash!;
		const afterDel = fs.get("f.ts")!;
		// empty or trailing phantom
		expect(afterDel === "" || afterDel === "\n").toBe(true);
		const r2 = await patcher.apply(
			Patch.parse(`${formatHashlineHeader("f.ts", tag)}\nINS.HEAD:\n+new`),
		);
		expect(fs.get("f.ts")).toContain("new");
		expect(r2.sections[0]?.fileHash).toMatch(/^[0-9A-F]{4}$/);
	});
});
