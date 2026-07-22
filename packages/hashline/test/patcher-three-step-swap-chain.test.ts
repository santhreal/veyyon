/**
 * Three SWAP chain with tags on one line file.
 */
import { describe, expect, it } from "bun:test";
import {
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
	formatHashlineHeader,
} from "@veyyon/hashline";

describe("Patcher three-step SWAP chain", () => {
	it("v0->v1->v2->v3", async () => {
		const fs = new InMemoryFilesystem([["f.ts", "v0\n"]]);
		const snapshots = new InMemorySnapshotStore();
		let tag = snapshots.record("f.ts", "v0\n");
		const patcher = new Patcher({ fs, snapshots });
		for (const v of ["v1", "v2", "v3"]) {
			const r = await patcher.apply(
				Patch.parse(`${formatHashlineHeader("f.ts", tag)}\nSWAP 1.=1:\n+${v}`),
			);
			expect(fs.get("f.ts")).toBe(`${v}\n`);
			tag = r.sections[0]!.fileHash!;
		}
	});
});
