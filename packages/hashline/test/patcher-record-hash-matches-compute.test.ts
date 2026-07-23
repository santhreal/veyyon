import { describe, expect, it } from "bun:test";
import { computeFileHash, InMemoryFilesystem, InMemorySnapshotStore, Patch, Patcher } from "@veyyon/hashline";

/**
 * After patcher apply, re-recorded hash matches computeFileHash of new content.
 */

describe("Patcher record hash matches compute", () => {
	it("tag after apply equals computeFileHash", async () => {
		const body = "v0\n";
		const mem = new InMemoryFilesystem([["a.ts", body]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("a.ts", body);
		const patcher = new Patcher({ fs: mem, snapshots });
		await patcher.apply(Patch.parse(`[a.ts#${tag}]\nSWAP 1.=1:\n+v1\n`));
		const next = mem.get("a.ts")!;
		expect(snapshots.record("a.ts", next)).toBe(computeFileHash(next));
		expect(computeFileHash(next)).toBe(computeFileHash("v1\n"));
	});
});
