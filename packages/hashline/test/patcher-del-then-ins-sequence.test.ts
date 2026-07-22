import { describe, expect, it } from "bun:test";
import {
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
} from "@veyyon/hashline";

/**
 * Sequential Patcher DEL then INS with re-record.
 */

describe("Patcher DEL then INS sequence", () => {
	it("delete middle then insert head", async () => {
		let body = "A\nB\nC\n";
		const mem = new InMemoryFilesystem([["a.ts", body]]);
		const snapshots = new InMemorySnapshotStore();
		const patcher = new Patcher({ fs: mem, snapshots });

		let tag = snapshots.record("a.ts", body);
		await patcher.apply(Patch.parse(`[a.ts#${tag}]\nDEL 2.=2\n`));
		expect(mem.get("a.ts")).toBe("A\nC\n");

		body = mem.get("a.ts")!;
		tag = snapshots.record("a.ts", body);
		await patcher.apply(Patch.parse(`[a.ts#${tag}]\nINS.HEAD:\n+H\n`));
		expect(mem.get("a.ts")).toBe("H\nA\nC\n");
	});
});
