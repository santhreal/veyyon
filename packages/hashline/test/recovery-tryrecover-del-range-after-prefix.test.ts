/**
 * Recovery remaps DEL range after prefix insert.
 */
import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore, parsePatch, Recovery } from "@veyyon/hashline";

describe("Recovery DEL range after prefix", () => {
	it("DEL 2.=3 after prefix removes old 2 and 3", () => {
		const store = new InMemorySnapshotStore();
		const v0 = "a\nb\nc\nd";
		const h0 = store.record("f.ts", v0);
		const v1 = "PRE\na\nb\nc\nd";
		store.record("f.ts", v1);
		const r = new Recovery(store);
		const result = r.tryRecover({
			path: "f.ts",
			currentText: v1,
			fileHash: h0,
			edits: parsePatch("DEL 2.=3").edits,
		});
		expect(result).not.toBeNull();
		if (!result) return;
		const lines = result.text.split("\n");
		expect(lines).toContain("PRE");
		expect(lines).toContain("a");
		expect(lines).toContain("d");
		expect(lines).not.toContain("b");
		expect(lines).not.toContain("c");
	});
});
