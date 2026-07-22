import { describe, expect, it } from "bun:test";
import {
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
} from "@veyyon/hashline";

/**
 * Patcher DEL then SWAP with re-record.
 */

describe("Patcher DEL then SWAP sequence", () => {
	it("delete last then swap first", async () => {
		let body = "A\nB\nC\n";
		const mem = new InMemoryFilesystem([["a.ts", body]]);
		const snapshots = new InMemorySnapshotStore();
		const patcher = new Patcher({ fs: mem, snapshots });

		let tag = snapshots.record("a.ts", body);
		await patcher.apply(Patch.parse(`[a.ts#${tag}]\nDEL 3.=3\n`));
		expect(mem.get("a.ts")).toBe("A\nB\n");

		body = mem.get("a.ts")!;
		tag = snapshots.record("a.ts", body);
		await patcher.apply(Patch.parse(`[a.ts#${tag}]\nSWAP 1.=1:\n+A2\n`));
		expect(mem.get("a.ts")).toBe("A2\nB\n");
	});
});
