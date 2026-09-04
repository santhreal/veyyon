/**
 * Patcher: SWAP then DEL with hash chain.
 */
import { describe, expect, it } from "bun:test";
import { formatHashlineHeader, InMemoryFilesystem, InMemorySnapshotStore, Patch, Patcher } from "@veyyon/hashline";

describe("Patcher SWAP then DEL session", () => {
	it("replace middle then delete it", async () => {
		const content = "a\nb\nc\n";
		const fs = new InMemoryFilesystem([["f.ts", content]]);
		const snapshots = new InMemorySnapshotStore();
		let tag = snapshots.record("f.ts", content);
		const patcher = new Patcher({ fs, snapshots });
		const r1 = await patcher.apply(Patch.parse(`${formatHashlineHeader("f.ts", tag)}\nSWAP 2.=2:\n+B`));
		expect(fs.get("f.ts")).toBe("a\nB\nc\n");
		tag = r1.sections[0]!.fileHash!;
		await patcher.apply(Patch.parse(`${formatHashlineHeader("f.ts", tag)}\nDEL 2`));
		expect(fs.get("f.ts")).toBe("a\nc\n");
	});
});
