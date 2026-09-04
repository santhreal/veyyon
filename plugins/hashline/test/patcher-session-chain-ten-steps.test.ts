/**
 * Ten sequential SWAP applies with refreshed hashes.
 */
import { describe, expect, it } from "bun:test";
import { formatHashlineHeader, InMemoryFilesystem, InMemorySnapshotStore, Patch, Patcher } from "@veyyon/hashline";

describe("Patcher ten-step session chain", () => {
	it("SWAP line 1 ten times with successive tags", async () => {
		const fs = new InMemoryFilesystem([["f.ts", "v0\n"]]);
		const snapshots = new InMemorySnapshotStore({ maxVersionsPerPath: 12 });
		let tag = snapshots.record("f.ts", "v0\n");
		const patcher = new Patcher({ fs, snapshots });
		for (let i = 1; i <= 10; i++) {
			const r = await patcher.apply(Patch.parse(`${formatHashlineHeader("f.ts", tag)}\nSWAP 1.=1:\n+v${i}`));
			expect(fs.get("f.ts")).toBe(`v${i}\n`);
			tag = r.sections[0]!.fileHash!;
		}
		expect(fs.get("f.ts")).toBe("v10\n");
	});
});
