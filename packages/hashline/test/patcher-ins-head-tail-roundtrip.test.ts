import { describe, expect, it } from "bun:test";
import {
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
} from "@veyyon/hashline";

/**
 * Patcher INS.HEAD / INS.TAIL through InMemoryFilesystem.
 */

describe("Patcher INS.HEAD / INS.TAIL round-trip", () => {
	it("INS.HEAD prepends via Patcher", async () => {
		const mem = new InMemoryFilesystem([["a.ts", "body\n"]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("a.ts", "body\n");
		const patcher = new Patcher({ fs: mem, snapshots });
		await patcher.apply(Patch.parse(`[a.ts#${tag}]\nINS.HEAD:\n+HEAD\n`));
		expect(mem.get("a.ts")).toBe("HEAD\nbody\n");
	});

	it("INS.TAIL appends via Patcher", async () => {
		const mem = new InMemoryFilesystem([["a.ts", "body\n"]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("a.ts", "body\n");
		const patcher = new Patcher({ fs: mem, snapshots });
		await patcher.apply(Patch.parse(`[a.ts#${tag}]\nINS.TAIL:\n+TAIL\n`));
		expect(mem.get("a.ts")).toBe("body\nTAIL\n");
	});
});
