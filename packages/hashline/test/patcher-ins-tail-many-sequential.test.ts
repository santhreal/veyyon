import { describe, expect, it } from "bun:test";
import {
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
} from "@veyyon/hashline";

/**
 * Sequential Patcher INS.TAIL builds ascending content.
 */

describe("Patcher sequential INS.TAIL", () => {
	it("appends 1..5 via re-record each step", async () => {
		let body = "0\n";
		const mem = new InMemoryFilesystem([["a.ts", body]]);
		const snapshots = new InMemorySnapshotStore();
		const patcher = new Patcher({ fs: mem, snapshots });
		for (let i = 1; i <= 5; i++) {
			body = mem.get("a.ts")!;
			const tag = snapshots.record("a.ts", body);
			await patcher.apply(Patch.parse(`[a.ts#${tag}]\nINS.TAIL:\n+${i}\n`));
		}
		expect(mem.get("a.ts")).toBe("0\n1\n2\n3\n4\n5\n");
	});
});
