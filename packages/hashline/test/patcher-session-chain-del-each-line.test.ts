/**
 * Patcher: delete lines one-by-one from top with refreshed hashes.
 */
import { describe, expect, it } from "bun:test";
import { formatHashlineHeader, InMemoryFilesystem, InMemorySnapshotStore, Patch, Patcher } from "@veyyon/hashline";

describe("Patcher sequential DEL first line", () => {
	it("deletes until empty-ish", async () => {
		let content = "a\nb\nc\n";
		const fs = new InMemoryFilesystem([["f.ts", content]]);
		const snapshots = new InMemorySnapshotStore();
		let tag = snapshots.record("f.ts", content);
		const patcher = new Patcher({ fs, snapshots });
		for (let i = 0; i < 3; i++) {
			const r = await patcher.apply(Patch.parse(`${formatHashlineHeader("f.ts", tag)}\nDEL 1`));
			tag = r.sections[0]!.fileHash!;
			content = fs.get("f.ts")!;
		}
		expect(content === "" || content === "\n").toBe(true);
	});
});
