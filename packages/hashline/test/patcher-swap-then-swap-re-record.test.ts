import { describe, expect, it } from "bun:test";
import {
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
} from "@veyyon/hashline";

/**
 * Two sequential Patcher SWAPs with re-record between them.
 */

describe("Patcher swap then swap re-record", () => {
	it("applies two edits in sequence with fresh tags", async () => {
		let body = "A\nB\nC\n";
		const mem = new InMemoryFilesystem([["a.ts", body]]);
		const snapshots = new InMemorySnapshotStore();
		const patcher = new Patcher({ fs: mem, snapshots });

		let tag = snapshots.record("a.ts", body);
		await patcher.apply(Patch.parse(`[a.ts#${tag}]\nSWAP 1.=1:\n+A2\n`));
		expect(mem.get("a.ts")).toBe("A2\nB\nC\n");

		body = mem.get("a.ts")!;
		tag = snapshots.record("a.ts", body);
		await patcher.apply(Patch.parse(`[a.ts#${tag}]\nSWAP 3.=3:\n+C2\n`));
		expect(mem.get("a.ts")).toBe("A2\nB\nC2\n");
	});
});
