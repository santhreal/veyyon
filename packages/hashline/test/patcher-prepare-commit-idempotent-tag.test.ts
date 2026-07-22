/**
 * prepare+commit records a new snapshot tag matching computeFileHash of written text.
 */
import { describe, expect, it } from "bun:test";
import {
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
	computeFileHash,
	formatHashlineHeader,
} from "@veyyon/hashline";

describe("Patcher prepare+commit tag identity", () => {
	it("committed section fileHash matches live content hash", async () => {
		const content = "before\n";
		const fs = new InMemoryFilesystem([["p.ts", content]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("p.ts", content);
		const patcher = new Patcher({ fs, snapshots });
		const section = Patch.parse(
			`${formatHashlineHeader("p.ts", tag)}\nSWAP 1.=1:\n+after`,
		).sections[0]!;
		const prepared = await patcher.prepare(section);
		const committed = await patcher.commit(prepared);
		const live = fs.get("p.ts")!;
		expect(live).toBe("after\n");
		expect(committed.fileHash).toBe(computeFileHash(live));
		expect(snapshots.head("p.ts")!.hash).toBe(committed.fileHash);
	});
});
