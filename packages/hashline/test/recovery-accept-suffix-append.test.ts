/**
 * Recovery accepts SWAP of first line after suffix append.
 */
import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore, parsePatch, Recovery } from "@veyyon/hashline";

describe("Recovery suffix append accept", () => {
	it("SWAP first line after TAIL was added", () => {
		const store = new InMemorySnapshotStore();
		const v0 = "HEAD\nbody";
		const h0 = store.record("f.ts", v0);
		const v1 = "HEAD\nbody\nTAIL";
		store.record("f.ts", v1);
		const r = new Recovery(store);
		const result = r.tryRecover({
			path: "f.ts",
			currentText: v1,
			fileHash: h0,
			edits: parsePatch("SWAP 1.=1:\n+HEAD2").edits,
		});
		expect(result).not.toBeNull();
		if (!result) return;
		expect(result.text.split("\n")).toEqual(["HEAD2", "body", "TAIL"]);
	});

	it("DEL last line of tagged after prefix", () => {
		const store = new InMemorySnapshotStore();
		const v0 = "a\nb\nc";
		const h0 = store.record("f.ts", v0);
		const v1 = "PRE\na\nb\nc";
		store.record("f.ts", v1);
		const r = new Recovery(store);
		const result = r.tryRecover({
			path: "f.ts",
			currentText: v1,
			fileHash: h0,
			edits: parsePatch("DEL 3").edits,
		});
		expect(result).not.toBeNull();
		if (!result) return;
		expect(result.text.split("\n")).not.toContain("c");
		expect(result.text.split("\n")).toContain("PRE");
	});
});
