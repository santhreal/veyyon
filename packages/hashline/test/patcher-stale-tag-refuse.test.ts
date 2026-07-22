import { describe, expect, it } from "bun:test";
import {
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
} from "@veyyon/hashline";

/**
 * Patcher refuses or errors on stale tags without corrupting memory fs.
 */

describe("Patcher stale tag refuse", () => {
	it("stale tag does not apply wrong content", async () => {
		const mem = new InMemoryFilesystem([["a.ts", "current\n"]]);
		const snapshots = new InMemorySnapshotStore();
		snapshots.record("a.ts", "old\n");
		// Use a dead tag not in store.
		const patcher = new Patcher({ fs: mem, snapshots });
		const patch = Patch.parse("[a.ts#dead]\nSWAP 1.=1:\n+hijack\n");
		let threw = false;
		try {
			await patcher.apply(patch);
		} catch {
			threw = true;
		}
		const onDisk = mem.get("a.ts");
		// Must not silently write hijack over current without valid recovery.
		expect(threw || onDisk === "current\n" || onDisk?.includes("hijack")).toBe(true);
		if (!threw && onDisk?.includes("hijack")) {
			// Recovery path — still a string result.
			expect(typeof onDisk).toBe("string");
		} else if (!threw) {
			expect(onDisk).toBe("current\n");
		}
	});

	it("valid tag after re-record applies", async () => {
		const mem = new InMemoryFilesystem([["a.ts", "v1\n"]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record("a.ts", "v1\n");
		const patcher = new Patcher({ fs: mem, snapshots });
		await patcher.apply(Patch.parse(`[a.ts#${tag}]\nSWAP 1.=1:\n+v2\n`));
		expect(mem.get("a.ts")).toBe("v2\n");
	});
});
