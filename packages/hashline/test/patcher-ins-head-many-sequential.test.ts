import { describe, expect, it } from "bun:test";
import {
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
} from "@veyyon/hashline";

/**
 * Sequential Patcher INS.HEAD stacks newest at top.
 */

describe("Patcher sequential INS.HEAD", () => {
	it("prepends 1..5 with newest at top", async () => {
		let body = "0\n";
		const mem = new InMemoryFilesystem([["a.ts", body]]);
		const snapshots = new InMemorySnapshotStore();
		const patcher = new Patcher({ fs: mem, snapshots });
		for (let i = 1; i <= 5; i++) {
			body = mem.get("a.ts")!;
			const tag = snapshots.record("a.ts", body);
			await patcher.apply(Patch.parse(`[a.ts#${tag}]\nINS.HEAD:\n+${i}\n`));
		}
		expect(mem.get("a.ts")).toBe("5\n4\n3\n2\n1\n0\n");
	});
});
