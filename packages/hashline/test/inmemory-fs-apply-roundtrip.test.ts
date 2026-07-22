import { describe, expect, it } from "bun:test";
import {
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
} from "@veyyon/hashline";

/**
 * Patcher + InMemoryFilesystem round-trip apply for simple SWAPs.
 */

describe("InMemoryFilesystem Patcher round-trip", () => {
	it("applies a SWAP to a recorded file and updates content", async () => {
		const mem = new InMemoryFilesystem([["a.ts", "L1\nL2\n"]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("a.ts", "L1\nL2\n");
		const patcher = new Patcher({ fs: mem, snapshots });
		const patch = Patch.parse(`[a.ts#${tag}]\nSWAP 1.=1:\n+L1x\n`);
		await patcher.apply(patch);
		expect(mem.get("a.ts")).toBe("L1x\nL2\n");
	});

	it("applies DEL and shrinks the file", async () => {
		const mem = new InMemoryFilesystem([["a.ts", "A\nB\nC\n"]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("a.ts", "A\nB\nC\n");
		const patcher = new Patcher({ fs: mem, snapshots });
		const patch = Patch.parse(`[a.ts#${tag}]\nDEL 2.=2\n`);
		await patcher.apply(patch);
		expect(mem.get("a.ts")).toBe("A\nC\n");
	});

	it("two files in one patch update independently", async () => {
		const mem = new InMemoryFilesystem([
			["a.ts", "A\n"],
			["b.ts", "B\n"],
		]);
		const snapshots = new InMemorySnapshotStore();
		const ta = snapshots.record("a.ts", "A\n");
		const tb = snapshots.record("b.ts", "B\n");
		const patcher = new Patcher({ fs: mem, snapshots });
		const patch = Patch.parse(`[a.ts#${ta}]\nSWAP 1.=1:\n+A2\n\n[b.ts#${tb}]\nSWAP 1.=1:\n+B2\n`);
		await patcher.apply(patch);
		expect(mem.get("a.ts")).toBe("A2\n");
		expect(mem.get("b.ts")).toBe("B2\n");
	});
});
