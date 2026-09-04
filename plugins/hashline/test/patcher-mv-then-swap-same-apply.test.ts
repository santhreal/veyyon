/**
 * MV and line edit in one multi-hunk section if supported; else sequential apply.
 */
import { describe, expect, it } from "bun:test";
import { formatHashlineHeader, InMemoryFilesystem, InMemorySnapshotStore, Patch, Patcher } from "@veyyon/hashline";

describe("Patcher MV with line edits", () => {
	it("line edit then MV in one section", async () => {
		const content = "old\n";
		const fs = new InMemoryFilesystem([["from.ts", content]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("from.ts", content);
		const patcher = new Patcher({ fs, snapshots });
		await patcher.apply(Patch.parse(`${formatHashlineHeader("from.ts", tag)}\nSWAP 1.=1:\n+new\nMV to.ts`));
		expect(fs.get("from.ts")).toBeUndefined();
		expect(fs.get("to.ts")).toBe("new\n");
	});

	it("MV alone then edit at dest with live hash", async () => {
		const content = "body\n";
		const fs = new InMemoryFilesystem([["a.ts", content]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("a.ts", content);
		const patcher = new Patcher({ fs, snapshots });
		await patcher.apply(Patch.parse(`${formatHashlineHeader("a.ts", tag)}\nMV b.ts`));
		const live = fs.get("b.ts")!;
		const t2 = snapshots.record("b.ts", live);
		await patcher.apply(Patch.parse(`${formatHashlineHeader("b.ts", t2)}\nSWAP 1.=1:\n+BODY`));
		expect(fs.get("b.ts")).toBe("BODY\n");
	});
});
