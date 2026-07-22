import { describe, expect, it } from "bun:test";
import {
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
	computeFileHash,
} from "@veyyon/hashline";

/**
 * After a successful apply, re-recording the new content yields a new tag.
 */

describe("Patcher record after apply", () => {
	it("new content hash differs from old tag", async () => {
		const body = "old\n";
		const mem = new InMemoryFilesystem([["a.ts", body]]);
		const snapshots = new InMemorySnapshotStore();
		const oldTag = snapshots.record("a.ts", body);
		const patcher = new Patcher({ fs: mem, snapshots });
		await patcher.apply(Patch.parse(`[a.ts#${oldTag}]\nSWAP 1.=1:\n+new\n`));
		const next = mem.get("a.ts")!;
		expect(next).toBe("new\n");
		const newTag = snapshots.record("a.ts", next);
		expect(newTag).toBe(computeFileHash(next));
		expect(newTag).not.toBe(oldTag);
	});
});
