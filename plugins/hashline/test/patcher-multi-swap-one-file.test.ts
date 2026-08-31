import { describe, expect, it } from "bun:test";
import { InMemoryFilesystem, InMemorySnapshotStore, Patch, Patcher } from "@veyyon/hashline";

/**
 * Multiple disjoint SWAPs on one file via Patcher.
 */

describe("Patcher multi-SWAP one file", () => {
	it("swaps lines 1 and 3 in one section", async () => {
		const body = "A\nB\nC\nD\n";
		const mem = new InMemoryFilesystem([["a.ts", body]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("a.ts", body);
		const patcher = new Patcher({ fs: mem, snapshots });
		await patcher.apply(Patch.parse(`[a.ts#${tag}]\nSWAP 1.=1:\n+A2\nSWAP 3.=3:\n+C2\n`));
		expect(mem.get("a.ts")).toBe("A2\nB\nC2\nD\n");
	});
});
