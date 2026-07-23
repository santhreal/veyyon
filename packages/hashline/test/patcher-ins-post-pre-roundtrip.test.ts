import { describe, expect, it } from "bun:test";
import { InMemoryFilesystem, InMemorySnapshotStore, Patch, Patcher } from "@veyyon/hashline";

/**
 * Patcher INS.POST / INS.PRE round-trips.
 */

describe("Patcher INS.POST / INS.PRE round-trip", () => {
	it("INS.POST 1 inserts after first line", async () => {
		const body = "A\nB\n";
		const mem = new InMemoryFilesystem([["a.ts", body]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("a.ts", body);
		const patcher = new Patcher({ fs: mem, snapshots });
		await patcher.apply(Patch.parse(`[a.ts#${tag}]\nINS.POST 1:\n+X\n`));
		expect(mem.get("a.ts")).toBe("A\nX\nB\n");
	});

	it("INS.PRE 2 inserts before second line", async () => {
		const body = "A\nB\n";
		const mem = new InMemoryFilesystem([["a.ts", body]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("a.ts", body);
		const patcher = new Patcher({ fs: mem, snapshots });
		await patcher.apply(Patch.parse(`[a.ts#${tag}]\nINS.PRE 2:\n+Y\n`));
		expect(mem.get("a.ts")).toBe("A\nY\nB\n");
	});
});
