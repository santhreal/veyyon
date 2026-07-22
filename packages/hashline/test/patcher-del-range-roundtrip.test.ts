import { describe, expect, it } from "bun:test";
import {
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
} from "@veyyon/hashline";

/**
 * Patcher DEL ranges through InMemoryFilesystem.
 */

describe("Patcher DEL range round-trip", () => {
	it("DEL middle range", async () => {
		const body = "A\nB\nC\nD\nE\n";
		const mem = new InMemoryFilesystem([["a.ts", body]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("a.ts", body);
		const patcher = new Patcher({ fs: mem, snapshots });
		await patcher.apply(Patch.parse(`[a.ts#${tag}]\nDEL 2.=4\n`));
		expect(mem.get("a.ts")).toBe("A\nE\n");
	});

	it("DEL first line", async () => {
		const body = "A\nB\nC\n";
		const mem = new InMemoryFilesystem([["a.ts", body]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("a.ts", body);
		const patcher = new Patcher({ fs: mem, snapshots });
		await patcher.apply(Patch.parse(`[a.ts#${tag}]\nDEL 1.=1\n`));
		expect(mem.get("a.ts")).toBe("B\nC\n");
	});

	it("DEL last line", async () => {
		const body = "A\nB\nC\n";
		const mem = new InMemoryFilesystem([["a.ts", body]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("a.ts", body);
		const patcher = new Patcher({ fs: mem, snapshots });
		await patcher.apply(Patch.parse(`[a.ts#${tag}]\nDEL 3.=3\n`));
		expect(mem.get("a.ts")).toBe("A\nB\n");
	});
});
