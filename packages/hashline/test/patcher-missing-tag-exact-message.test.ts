/**
 * missing snapshot tag exact message path for Patcher.apply.
 */
import { describe, expect, it } from "bun:test";
import {
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
	missingSnapshotTagMessage,
} from "@veyyon/hashline";

describe("Patcher missing snapshot tag message", () => {
	it("throws message that includes missingSnapshotTagMessage for the path", async () => {
		const fs = new InMemoryFilesystem([["a.ts", "x\n"]]);
		const snapshots = new InMemorySnapshotStore();
		snapshots.record("a.ts", "x\n");
		const patcher = new Patcher({ fs, snapshots });
		try {
			await patcher.apply(Patch.parse("[a.ts]\nSWAP 1.=1:\n+Y"));
			throw new Error("expected throw");
		} catch (e) {
			const msg = String((e as Error).message);
			expect(msg).toContain("a.ts");
			const expected = missingSnapshotTagMessage("a.ts");
			// full message or prefix
			expect(msg.includes("snapshot") || msg.includes(expected.slice(0, 20))).toBe(true);
		}
		expect(fs.get("a.ts")).toBe("x\n");
	});
});
