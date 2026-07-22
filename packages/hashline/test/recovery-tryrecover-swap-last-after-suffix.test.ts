/**
 * Recovery SWAP last line after a suffix was appended on live.
 */
import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore, parsePatch, Recovery } from "@veyyon/hashline";

describe("Recovery SWAP last after suffix", () => {
	it("remaps last line swap", () => {
		const store = new InMemorySnapshotStore();
		const v0 = "a\nb\nLAST";
		const h0 = store.record("f.ts", v0);
		const v1 = "a\nb\nLAST\nTAIL";
		store.record("f.ts", v1);
		const r = new Recovery(store);
		const result = r.tryRecover({
			path: "f.ts",
			currentText: v1,
			fileHash: h0,
			edits: parsePatch("SWAP 3.=3:\n+LAST2").edits,
		});
		expect(result).not.toBeNull();
		if (!result) return;
		expect(result.text.split("\n")).toContain("LAST2");
		expect(result.text.split("\n")).toContain("TAIL");
		expect(result.text.split("\n")).not.toContain("LAST");
	});
});
