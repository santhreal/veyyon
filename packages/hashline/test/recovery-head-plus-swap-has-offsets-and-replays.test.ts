/**
 * INS.HEAD plus a numbered SWAP produces offsets, so recovery can run.
 *
 * WHY THIS SUITE EXISTS. Pure INS.HEAD dies on `offsets.length === 0`. A
 * mixed patch that also SWAP/DELs a numbered line pushes at least one
 * offset. Recovery then requires every offset equal. The BOF insert is
 * copied through unchanged (`cursor.kind === "bof"`), so it still lands
 * at the live file's start after the numbered op remaps. That is the
 * path that still works today, and the reason a model that pairs a head
 * insert with any anchored edit accidentally survives when a pure
 * INS.HEAD does not.
 */
import { describe, expect, it } from "bun:test";
import { InMemorySnapshotStore, parsePatch, Recovery } from "@veyyon/hashline";

describe("INS.HEAD + SWAP of an unchanged line recovers across a suffix append", () => {
	it("replays both the head insert and the swapped first line", () => {
		const store = new InMemorySnapshotStore();
		const original = "keep-a\nkeep-b";
		const drifted = "keep-a\nkeep-b\nTAIL";
		const tag = store.record("f.ts", original);
		const recovered = new Recovery(store).tryRecover({
			path: "f.ts",
			currentText: drifted,
			fileHash: tag,
			edits: parsePatch("INS.HEAD:\n+new-head\nSWAP 1.=1:\n+KEEP-A").edits,
		});
		expect(recovered).not.toBeNull();
		expect(recovered?.text.split("\n")).toEqual(["new-head", "KEEP-A", "keep-b", "TAIL"]);
	});
});

describe("INS.TAIL + DEL of the original last line recovers across a prefix insert", () => {
	it("remaps the delete and still appends at EOF", () => {
		const store = new InMemorySnapshotStore();
		const original = "keep-a\nkeep-b";
		const drifted = "PRE\nkeep-a\nkeep-b";
		const tag = store.record("f.ts", original);
		const recovered = new Recovery(store).tryRecover({
			path: "f.ts",
			currentText: drifted,
			fileHash: tag,
			edits: parsePatch("INS.TAIL:\n+new-tail\nDEL 2").edits,
		});
		expect(recovered).not.toBeNull();
		expect(recovered?.text.split("\n")).toEqual(["PRE", "keep-a", "new-tail"]);
	});
});
