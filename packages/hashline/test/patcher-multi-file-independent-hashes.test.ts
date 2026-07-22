/**
 * Three-file batch: each section uses its own tag; all land.
 */
import { describe, expect, it } from "bun:test";
import {
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
	formatHashlineHeader,
	computeFileHash,
} from "@veyyon/hashline";

describe("Patcher three-file independent hashes", () => {
	it("applies A B C in one patch", async () => {
		const files: Record<string, string> = {
			"a.ts": "A0\n",
			"b.ts": "B0\n",
			"c.ts": "C0\n",
		};
		const fs = new InMemoryFilesystem(Object.entries(files));
		const snapshots = new InMemorySnapshotStore();
		const tags: Record<string, string> = {};
		for (const [p, c] of Object.entries(files)) tags[p] = snapshots.record(p, c);
		const patcher = new Patcher({ fs, snapshots });
		const result = await patcher.apply(
			Patch.parse(
				[
					formatHashlineHeader("a.ts", tags["a.ts"]!),
					"SWAP 1.=1:",
					"+A1",
					formatHashlineHeader("b.ts", tags["b.ts"]!),
					"SWAP 1.=1:",
					"+B1",
					formatHashlineHeader("c.ts", tags["c.ts"]!),
					"SWAP 1.=1:",
					"+C1",
				].join("\n"),
			),
		);
		expect(result.sections).toHaveLength(3);
		expect(fs.get("a.ts")).toBe("A1\n");
		expect(fs.get("b.ts")).toBe("B1\n");
		expect(fs.get("c.ts")).toBe("C1\n");
		expect(result.sections[0]?.fileHash).toBe(computeFileHash("A1\n"));
		expect(result.sections[1]?.fileHash).toBe(computeFileHash("B1\n"));
		expect(result.sections[2]?.fileHash).toBe(computeFileHash("C1\n"));
	});
});
