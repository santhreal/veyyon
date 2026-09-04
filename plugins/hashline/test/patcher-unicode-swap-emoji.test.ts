/**
 * Patcher SWAP to emoji and multi-script content.
 */
import { describe, expect, it } from "bun:test";
import { formatHashlineHeader, InMemoryFilesystem, InMemorySnapshotStore, Patch, Patcher } from "@veyyon/hashline";

describe("Patcher unicode/emoji SWAP", () => {
	const bodies = ["🚀", "日本語", "café", "مرحبا", "Ωmega"];
	for (const body of bodies) {
		it(body, async () => {
			const fs = new InMemoryFilesystem([["f.ts", "old\n"]]);
			const snapshots = new InMemorySnapshotStore();
			const tag = snapshots.record("f.ts", "old\n");
			const patcher = new Patcher({ fs, snapshots });
			await patcher.apply(Patch.parse(`${formatHashlineHeader("f.ts", tag)}\nSWAP 1.=1:\n+${body}`));
			expect(fs.get("f.ts")).toBe(`${body}\n`);
		});
	}
});
