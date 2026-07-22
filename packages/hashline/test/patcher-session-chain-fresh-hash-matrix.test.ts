/**
 * Patcher session chain: each apply returns a fresh fileHash that must be used
 * for the next section binding.
 */
import { describe, expect, it } from "bun:test";
import {
	computeFileHash,
	formatHashlineHeader,
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
} from "@veyyon/hashline";

describe("Patcher session chain fresh hash matrix", () => {
	for (const steps of [2, 3, 5]) {
		it(`${steps} sequential SWAP steps`, async () => {
			let text = "v0\n";
			const fs = new InMemoryFilesystem([["c.ts", text]]);
			const snapshots = new InMemorySnapshotStore();
			let tag = snapshots.record("c.ts", text);
			const patcher = new Patcher({ fs, snapshots });

			for (let s = 1; s <= steps; s++) {
				const result = await patcher.apply(
					Patch.parse(
						`${formatHashlineHeader("c.ts", tag)}\nSWAP 1.=1:\n+v${s}`,
					),
				);
				text = `v${s}\n`;
				expect(fs.get("c.ts")).toBe(text);
				expect(result.sections[0]?.fileHash).toBe(computeFileHash(text));
				tag = result.sections[0]!.fileHash!;
				// also record for recovery store
				snapshots.record("c.ts", text);
			}
		});
	}

	it("stale hash after chain fails closed", async () => {
		const text = "a\n";
		const fs = new InMemoryFilesystem([["c.ts", text]]);
		const snapshots = new InMemorySnapshotStore();
		const tag0 = snapshots.record("c.ts", text);
		const patcher = new Patcher({ fs, snapshots });
		const r1 = await patcher.apply(
			Patch.parse(`${formatHashlineHeader("c.ts", tag0)}\nSWAP 1.=1:\n+b`),
		);
		// reuse tag0 instead of r1 hash
		await expect(
			patcher.apply(Patch.parse(`${formatHashlineHeader("c.ts", tag0)}\nSWAP 1.=1:\n+c`)),
		).rejects.toThrow();
		// file may have recovered or stayed — either way not "c" without recovery of unique content
		expect(r1.sections[0]?.fileHash).toBe(computeFileHash("b\n"));
	});
});
