import { describe, expect, it } from "bun:test";
import {
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
} from "@veyyon/hashline";

/**
 * Patcher DEL entire file content via full range.
 */

describe("Patcher DEL all via range", () => {
	it("DEL 1.=N empties an N-line file", async () => {
		const body = "A\nB\nC\nD\n";
		const mem = new InMemoryFilesystem([["a.ts", body]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("a.ts", body);
		const patcher = new Patcher({ fs: mem, snapshots });
		await patcher.apply(Patch.parse(`[a.ts#${tag}]\nDEL 1.=4\n`));
		const out = mem.get("a.ts")!;
		expect(out === "" || out === "\n").toBe(true);
	});
});
