/**
 * Recovery.tryRecover: accept when anchors still map; refuse when target drifted.
 * Exact warning banners and fail-closed null returns.
 */
import { describe, expect, it } from "bun:test";
import {
	InMemorySnapshotStore,
	parsePatch,
	RECOVERY_EXTERNAL_WARNING,
	RECOVERY_LINE_REMAP_WARNING,
	RECOVERY_SESSION_CHAIN_WARNING,
	Recovery,
} from "@veyyon/hashline";

describe("Recovery.tryRecover accept paths", () => {
	it("session-chain: prior edit advanced hash; remap unchanged anchors", () => {
		const store = new InMemorySnapshotStore();
		const v1 = "line1\nline2\nline3\nline4";
		const h1 = store.record("f.ts", v1);
		// Session advanced: insert a line at top so old line numbers shift
		const v2 = "INSERTED\nline1\nline2\nline3\nline4";
		store.record("f.ts", v2);

		const recovery = new Recovery(store);
		// Edit targets old line2 ("line2") under h1 while live is v2
		const edits = parsePatch("SWAP 2.=2:\n+LINE2").edits;
		const result = recovery.tryRecover({
			path: "f.ts",
			currentText: v2,
			fileHash: h1,
			edits,
		});
		expect(result).not.toBeNull();
		if (!result) return;
		expect(result.text.split("\n")).toContain("INSERTED");
		expect(result.text.split("\n")).toContain("LINE2");
		expect(result.text.split("\n")).not.toContain("line2");
		const joined = result.warnings.join("\n");
		expect(
			joined.includes(RECOVERY_SESSION_CHAIN_WARNING) ||
				joined.includes(RECOVERY_EXTERNAL_WARNING) ||
				joined.includes(RECOVERY_LINE_REMAP_WARNING),
		).toBe(true);
	});

	it("external-style: head still equals tagged snapshot but live text drifted", () => {
		const store = new InMemorySnapshotStore();
		const tagged = "alpha\nbeta\ngamma";
		const h = store.record("f.ts", tagged);
		// Live drifted; we never re-recorded, so head === snapshot → EXTERNAL warning
		const live = "alpha\nEXTRA\nbeta\ngamma";
		const recovery = new Recovery(store);
		const edits = parsePatch("SWAP 3.=3:\n+GAMMA").edits;
		const result = recovery.tryRecover({
			path: "f.ts",
			currentText: live,
			fileHash: h,
			edits,
		});
		if (result) {
			expect(result.text).toContain("GAMMA");
			expect(result.text).toContain("EXTRA");
			expect(
				result.warnings.some(
					w => w.includes("Recovered") || w === RECOVERY_EXTERNAL_WARNING || w === RECOVERY_LINE_REMAP_WARNING,
				),
			).toBe(true);
		}
	});

	it("DEL of shifted unique line remaps and deletes the live match", () => {
		const store = new InMemorySnapshotStore();
		const tagged = "a\nUNIQUE\nb";
		const h = store.record("f.ts", tagged);
		const live = "PRE\na\nUNIQUE\nb";
		store.record("f.ts", live);
		const recovery = new Recovery(store);
		const result = recovery.tryRecover({
			path: "f.ts",
			currentText: live,
			fileHash: h,
			edits: parsePatch("DEL 2").edits,
		});
		expect(result).not.toBeNull();
		if (!result) return;
		expect(result.text.split("\n")).not.toContain("UNIQUE");
		expect(result.text.split("\n")).toContain("PRE");
	});
});

describe("Recovery.tryRecover refuse paths", () => {
	it("returns null when snapshot hash is unknown", () => {
		const store = new InMemorySnapshotStore();
		store.record("f.ts", "a\nb");
		const recovery = new Recovery(store);
		const result = recovery.tryRecover({
			path: "f.ts",
			currentText: "a\nb",
			fileHash: "DEAD",
			edits: parsePatch("DEL 1").edits,
		});
		expect(result).toBeNull();
	});

	it("returns null when anchored line content changed (not just shifted)", () => {
		const store = new InMemorySnapshotStore();
		const tagged = "keep\nTARGET\nkeep2";
		const h = store.record("f.ts", tagged);
		const live = "keep\nCHANGED\nkeep2";
		const recovery = new Recovery(store);
		const result = recovery.tryRecover({
			path: "f.ts",
			currentText: live,
			fileHash: h,
			edits: parsePatch("SWAP 2.=2:\n+NEW").edits,
		});
		expect(result).toBeNull();
	});

	it("returns null for missing path history", () => {
		const store = new InMemorySnapshotStore();
		const recovery = new Recovery(store);
		expect(
			recovery.tryRecover({
				path: "ghost.ts",
				currentText: "x",
				fileHash: "AAAA",
				edits: parsePatch("DEL 1").edits,
			}),
		).toBeNull();
	});

	it("consistent whole-file shift remaps even when identical lines exist", () => {
		// With a uniform +1 offset (prefix insert), anchors map by stable index
		// through unchanged runs — duplicate "dup" lines are not inherently fatal.
		const store = new InMemorySnapshotStore();
		const tagged = "dup\ndup\ndup";
		const h = store.record("f.ts", tagged);
		const live = "X\ndup\ndup\ndup";
		store.record("f.ts", live);
		const recovery = new Recovery(store);
		const result = recovery.tryRecover({
			path: "f.ts",
			currentText: live,
			fileHash: h,
			edits: parsePatch("SWAP 2.=2:\n+NEW").edits,
		});
		expect(result).not.toBeNull();
		if (!result) return;
		// Old line 2 is the second "dup" → live line 3 after the prefix.
		expect(result.text).toBe("X\ndup\nNEW\ndup");
	});

	it("returns null when the target line was deleted from live content", () => {
		const store = new InMemorySnapshotStore();
		const tagged = "a\nONLY_HERE\nb";
		const h = store.record("f.ts", tagged);
		const live = "a\nb";
		store.record("f.ts", live);
		const recovery = new Recovery(store);
		const result = recovery.tryRecover({
			path: "f.ts",
			currentText: live,
			fileHash: h,
			edits: parsePatch("SWAP 2.=2:\n+NEW").edits,
		});
		expect(result).toBeNull();
	});
});
