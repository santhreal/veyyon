/**
 * Single-line block resolution rejects with blockSingleLineMessage (not expanded).
 */
import { describe, expect, it } from "bun:test";
import { type BlockResolver, blockSingleLineMessage, parsePatch, resolveBlockEdits } from "@veyyon/hashline";

const single: BlockResolver = ({ line }) => ({ start: line, end: line });

describe("resolveBlockEdits single-line block reject", () => {
	it("SWAP.BLK single-line span throws blockSingleLineMessage", () => {
		const edits = parsePatch("SWAP.BLK 5:\n+x").edits;
		expect(() => resolveBlockEdits(edits, "t", "f.ts", single)).toThrow(blockSingleLineMessage(5, "replace"));
	});

	it("DEL.BLK single-line span throws for delete op", () => {
		const edits = parsePatch("DEL.BLK 3").edits;
		expect(() => resolveBlockEdits(edits, "t", "f.ts", single)).toThrow(blockSingleLineMessage(3, "delete"));
	});

	it("drop mode skips single-line blocks without throw", () => {
		const edits = parsePatch("SWAP.BLK 1:\n+x\nDEL 9").edits;
		const resolved = resolveBlockEdits(edits, "t", "f.ts", single, { onUnresolved: "drop" });
		expect(resolved.some(e => e.kind === "block")).toBe(false);
		expect(resolved.some(e => e.kind === "delete" && e.anchor.line === 9)).toBe(true);
	});

	it("multi-line span still expands", () => {
		const multi: BlockResolver = ({ line }) => ({ start: line, end: line + 2 });
		const edits = parsePatch("SWAP.BLK 1:\n+A").edits;
		const resolved = resolveBlockEdits(edits, "t", "f.ts", multi);
		expect(resolved.every(e => e.kind !== "block")).toBe(true);
		expect(resolved.filter(e => e.kind === "delete")).toHaveLength(3);
	});
});
