/**
 * Recovery session-chain path emits RECOVERY_SESSION_CHAIN_WARNING when head !== snapshot.
 */
import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore, parsePatch, RECOVERY_SESSION_CHAIN_WARNING, Recovery } from "@veyyon/hashline";

describe("Recovery session-chain warning exact", () => {
	it("includes RECOVERY_SESSION_CHAIN_WARNING when head advanced past tagged", () => {
		const store = new InMemorySnapshotStore();
		const v0 = "a\nb\nc";
		const h0 = store.record("f.ts", v0);
		const v1 = "a\nb\nc\nd";
		store.record("f.ts", v1);
		expect(store.head("f.ts")!.hash).not.toBe(h0);
		const r = new Recovery(store);
		const result = r.tryRecover({
			path: "f.ts",
			currentText: v1,
			fileHash: h0,
			edits: parsePatch("SWAP 2.=2:\n+B").edits,
		});
		expect(result).not.toBeNull();
		if (!result) return;
		expect(result.warnings).toContain(RECOVERY_SESSION_CHAIN_WARNING);
		expect(result.text.split("\n")).toContain("B");
	});
});
