import { describe, expect, it } from "bun:test";
import { InMemoryFilesystem, InMemorySnapshotStore, Patch, Patcher } from "@veyyon/hashline";

/**
 * Patcher INS into empty / single-newline files.
 */

describe("Patcher empty file INS", () => {
	it("INS.TAIL into a single-newline file", async () => {
		const body = "\n";
		const mem = new InMemoryFilesystem([["a.ts", body]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("a.ts", body);
		const patcher = new Patcher({ fs: mem, snapshots });
		await patcher.apply(Patch.parse(`[a.ts#${tag}]\nINS.TAIL:\n+line\n`));
		const out = mem.get("a.ts")!;
		expect(out).toContain("line");
	});

	it("INS.HEAD into a single-line file", async () => {
		const body = "only\n";
		const mem = new InMemoryFilesystem([["a.ts", body]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("a.ts", body);
		const patcher = new Patcher({ fs: mem, snapshots });
		await patcher.apply(Patch.parse(`[a.ts#${tag}]\nINS.HEAD:\n+top\n`));
		expect(mem.get("a.ts")).toBe("top\nonly\n");
	});
});
