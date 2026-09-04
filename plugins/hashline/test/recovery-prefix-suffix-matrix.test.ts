/**
 * Recovery after prefix and suffix drift for multiple anchor lines.
 */
import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore, parsePatch, Recovery } from "@veyyon/hashline";

describe("Recovery prefix/suffix matrix", () => {
	it("prefix insert remaps DEL of unique middle", () => {
		const store = new InMemorySnapshotStore();
		const v0 = "a\nMID\nb";
		const h0 = store.record("f.ts", v0);
		const v1 = "PRE\na\nMID\nb";
		store.record("f.ts", v1);
		const r = new Recovery(store);
		const result = r.tryRecover({
			path: "f.ts",
			currentText: v1,
			fileHash: h0,
			edits: parsePatch("DEL 2").edits,
		});
		expect(result).not.toBeNull();
		if (!result) return;
		expect(result.text.split("\n")).not.toContain("MID");
		expect(result.text.split("\n")).toContain("PRE");
	});

	it("suffix append remaps SWAP of first", () => {
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
			edits: parsePatch("SWAP 1.=1:\n+H2").edits,
		});
		expect(result).not.toBeNull();
		if (!result) return;
		expect(result.text.split("\n")[0]).toBe("H2");
		expect(result.text.split("\n")).toContain("TAIL");
	});

	it("both prefix and suffix remaps middle SWAP", () => {
		const store = new InMemorySnapshotStore();
		const v0 = "a\nMID\nb";
		const h0 = store.record("f.ts", v0);
		const v1 = "PRE\na\nMID\nb\nPOST";
		store.record("f.ts", v1);
		const r = new Recovery(store);
		const result = r.tryRecover({
			path: "f.ts",
			currentText: v1,
			fileHash: h0,
			edits: parsePatch("SWAP 2.=2:\n+MID2").edits,
		});
		expect(result).not.toBeNull();
		if (!result) return;
		expect(result.text.split("\n")).toContain("MID2");
		expect(result.text.split("\n")).toContain("PRE");
		expect(result.text.split("\n")).toContain("POST");
		expect(result.text.split("\n")).not.toContain("MID");
	});
});
