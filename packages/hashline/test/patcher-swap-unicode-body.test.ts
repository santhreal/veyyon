import { describe, expect, it } from "bun:test";
import { InMemoryFilesystem, InMemorySnapshotStore, Patch, Patcher } from "@veyyon/hashline";

/**
 * Patcher SWAP with unicode body content.
 */

describe("Patcher SWAP unicode body", () => {
	it("replaces line with CJK", async () => {
		const body = "old\n";
		const mem = new InMemoryFilesystem([["a.ts", body]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("a.ts", body);
		const patcher = new Patcher({ fs: mem, snapshots });
		await patcher.apply(Patch.parse(`[a.ts#${tag}]\nSWAP 1.=1:\n+日本語\n`));
		expect(mem.get("a.ts")).toBe("日本語\n");
	});

	it("replaces line with emoji", async () => {
		const body = "old\n";
		const mem = new InMemoryFilesystem([["a.ts", body]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("a.ts", body);
		const patcher = new Patcher({ fs: mem, snapshots });
		await patcher.apply(Patch.parse(`[a.ts#${tag}]\nSWAP 1.=1:\n+🙂\n`));
		expect(mem.get("a.ts")).toBe("🙂\n");
	});
});
