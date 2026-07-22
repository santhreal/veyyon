import { describe, expect, it } from "bun:test";
import {
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
} from "@veyyon/hashline";

/**
 * Patcher SWAP expand 1→3 via InMemoryFilesystem.
 */

describe("Patcher SWAP expand round-trip", () => {
	it("replaces one line with three", async () => {
		const body = "A\nB\nC\n";
		const mem = new InMemoryFilesystem([["a.ts", body]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("a.ts", body);
		const patcher = new Patcher({ fs: mem, snapshots });
		await patcher.apply(Patch.parse(`[a.ts#${tag}]\nSWAP 2.=2:\n+X\n+Y\n+Z\n`));
		expect(mem.get("a.ts")).toBe("A\nX\nY\nZ\nC\n");
	});

	it("replaces three lines with one", async () => {
		const body = "A\nB\nC\nD\n";
		const mem = new InMemoryFilesystem([["a.ts", body]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("a.ts", body);
		const patcher = new Patcher({ fs: mem, snapshots });
		await patcher.apply(Patch.parse(`[a.ts#${tag}]\nSWAP 2.=4:\n+MID\n`));
		expect(mem.get("a.ts")).toBe("A\nMID\n");
	});
});
