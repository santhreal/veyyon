import { describe, expect, it } from "bun:test";
import {
	BARE_BODY_AUTO_PIPED_WARNING,
	BEGIN_PATCH_MARKER,
	blockSingleLineMessage,
	blockUnresolvedMessage,
	DELETE_BLOCK_TAKES_NO_BODY,
	DELETE_TAKES_NO_BODY,
	EMPTY_BLOCK,
	EMPTY_INSERT,
	EMPTY_REPLACE,
	END_PATCH_MARKER,
	formatAnchoredContext,
	insertAfterBlockCloserLoweredWarning,
	insertAfterBlockUnresolvedLoweredWarning,
	MINUS_ROW_REJECTED,
	MISMATCH_CONTEXT,
	MOVE_TAKES_NO_BODY,
	REM_TAKES_NO_BODY,
	UNRESOLVED_BLOCK_INTERNAL,
} from "../src/messages";
import {
	DEFAULT_MAX_PATHS,
	DEFAULT_MAX_TOTAL_BYTES,
	DEFAULT_MAX_VERSIONS_PER_PATH,
	mergeClippedLines,
	mergeSeenLines,
	type Snapshot,
} from "../src/snapshots-helpers";

describe("message constants", () => {
	it("BEGIN_PATCH_MARKER is correct", () => {
		expect(BEGIN_PATCH_MARKER).toBe("*** Begin Patch");
	});
	it("END_PATCH_MARKER is correct", () => {
		expect(END_PATCH_MARKER).toBe("*** End Patch");
	});
	it("BARE_BODY_AUTO_PIPED_WARNING mentions + prefix", () => {
		expect(BARE_BODY_AUTO_PIPED_WARNING).toContain("+");
	});
	it("MINUS_ROW_REJECTED mentions range", () => {
		expect(MINUS_ROW_REJECTED).toContain("range");
	});
	it("EMPTY_REPLACE mentions SWAP and DEL", () => {
		expect(EMPTY_REPLACE).toContain("SWAP");
		expect(EMPTY_REPLACE).toContain("DEL");
	});
	it("EMPTY_BLOCK mentions SWAP.BLK", () => {
		expect(EMPTY_BLOCK).toContain("SWAP.BLK");
	});
	it("DELETE_TAKES_NO_BODY mentions DEL and SWAP", () => {
		expect(DELETE_TAKES_NO_BODY).toContain("DEL");
		expect(DELETE_TAKES_NO_BODY).toContain("SWAP");
	});
	it("REM_TAKES_NO_BODY mentions REM", () => {
		expect(REM_TAKES_NO_BODY).toContain("REM");
	});
	it("MOVE_TAKES_NO_BODY mentions MV", () => {
		expect(MOVE_TAKES_NO_BODY).toContain("MV");
	});
	it("DELETE_BLOCK_TAKES_NO_BODY mentions DEL.BLK", () => {
		expect(DELETE_BLOCK_TAKES_NO_BODY).toContain("DEL.BLK");
	});
	it("EMPTY_INSERT mentions INS", () => {
		expect(EMPTY_INSERT).toContain("INS");
	});
	it("UNRESOLVED_BLOCK_INTERNAL mentions SWAP.BLK", () => {
		expect(UNRESOLVED_BLOCK_INTERNAL).toContain("SWAP.BLK");
	});
});

describe("MISMATCH_CONTEXT", () => {
	it("is 2", () => {
		expect(MISMATCH_CONTEXT).toBe(2);
	});
});

describe("formatAnchoredContext", () => {
	it("formats context lines around anchor", () => {
		const fileLines = ["line1", "line2", "line3", "line4", "line5"];
		const result = formatAnchoredContext([3], fileLines);
		expect(result.length).toBeGreaterThan(0);
		expect(result.some(l => l.includes("line3"))).toBe(true);
	});
	it("includes lines before and after anchor", () => {
		const fileLines = ["a", "b", "c", "d", "e"];
		const result = formatAnchoredContext([3], fileLines);
		expect(result.some(l => l.includes("b"))).toBe(true);
		expect(result.some(l => l.includes("d"))).toBe(true);
	});
	it("handles anchor at start of file", () => {
		const fileLines = ["a", "b", "c"];
		const result = formatAnchoredContext([1], fileLines);
		expect(result.length).toBeGreaterThan(0);
	});
	it("handles anchor at end of file", () => {
		const fileLines = ["a", "b", "c"];
		const result = formatAnchoredContext([3], fileLines);
		expect(result.length).toBeGreaterThan(0);
	});
});

describe("blockUnresolvedMessage", () => {
	it("returns message for replace op", () => {
		const msg = blockUnresolvedMessage(5, "replace");
		expect(msg).toContain("5");
		expect(msg).toContain("SWAP.BLK");
	});
	it("returns message for delete op", () => {
		const msg = blockUnresolvedMessage(10, "delete");
		expect(msg).toContain("10");
		expect(msg).toContain("DEL.BLK");
	});
});

describe("blockSingleLineMessage", () => {
	it("returns message for replace op", () => {
		const msg = blockSingleLineMessage(5, "replace");
		expect(msg).toContain("5");
	});
	it("returns message for delete op", () => {
		const msg = blockSingleLineMessage(10, "delete");
		expect(msg).toContain("10");
	});
	it("returns message for insert_after op", () => {
		const msg = blockSingleLineMessage(7, "insert_after");
		expect(msg).toContain("7");
	});
});

describe("insertAfterBlockCloserLoweredWarning", () => {
	it("mentions INS.BLK.POST and INS.POST", () => {
		const msg = insertAfterBlockCloserLoweredWarning(10);
		expect(msg).toContain("INS.BLK.POST");
		expect(msg).toContain("INS.POST");
		expect(msg).toContain("10");
	});
});

describe("insertAfterBlockUnresolvedLoweredWarning", () => {
	it("mentions INS.BLK.POST and INS.POST", () => {
		const msg = insertAfterBlockUnresolvedLoweredWarning(15);
		expect(msg).toContain("INS.BLK.POST");
		expect(msg).toContain("INS.POST");
		expect(msg).toContain("15");
	});
});

describe("snapshot constants", () => {
	it("DEFAULT_MAX_PATHS is 30", () => {
		expect(DEFAULT_MAX_PATHS).toBe(30);
	});
	it("DEFAULT_MAX_VERSIONS_PER_PATH is 4", () => {
		expect(DEFAULT_MAX_VERSIONS_PER_PATH).toBe(4);
	});
	it("DEFAULT_MAX_TOTAL_BYTES is 64 MiB", () => {
		expect(DEFAULT_MAX_TOTAL_BYTES).toBe(64 * 1024 * 1024);
	});
});

describe("mergeSeenLines", () => {
	it("adds lines to snapshot seenLines", () => {
		const snapshot: Snapshot = {
			path: "test.ts",
			text: "hello",
			hash: "1A2B",
			recordedAt: Date.now(),
		};
		mergeSeenLines(snapshot, [1, 2, 3]);
		expect(snapshot.seenLines).toEqual(new Set([1, 2, 3]));
	});
	it("merges into existing seenLines", () => {
		const snapshot: Snapshot = {
			path: "test.ts",
			text: "hello",
			hash: "1A2B",
			recordedAt: Date.now(),
			seenLines: new Set([1, 2]),
		};
		mergeSeenLines(snapshot, [3, 4]);
		expect(snapshot.seenLines).toEqual(new Set([1, 2, 3, 4]));
	});
	it("does nothing for undefined lines", () => {
		const snapshot: Snapshot = {
			path: "test.ts",
			text: "hello",
			hash: "1A2B",
			recordedAt: Date.now(),
		};
		mergeSeenLines(snapshot, undefined);
		expect(snapshot.seenLines).toBeUndefined();
	});
	it("handles empty iterable", () => {
		const snapshot: Snapshot = {
			path: "test.ts",
			text: "hello",
			hash: "1A2B",
			recordedAt: Date.now(),
		};
		mergeSeenLines(snapshot, []);
		expect(snapshot.seenLines).toBeDefined();
		expect(snapshot.seenLines!.size).toBe(0);
	});
});

describe("mergeClippedLines", () => {
	it("adds lines to snapshot clippedLines", () => {
		const snapshot: Snapshot = {
			path: "test.ts",
			text: "hello",
			hash: "1A2B",
			recordedAt: Date.now(),
		};
		mergeClippedLines(snapshot, [5, 6]);
		expect(snapshot.clippedLines).toEqual(new Set([5, 6]));
	});
	it("merges into existing clippedLines", () => {
		const snapshot: Snapshot = {
			path: "test.ts",
			text: "hello",
			hash: "1A2B",
			recordedAt: Date.now(),
			clippedLines: new Set([1]),
		};
		mergeClippedLines(snapshot, [2, 3]);
		expect(snapshot.clippedLines).toEqual(new Set([1, 2, 3]));
	});
	it("does nothing for undefined lines", () => {
		const snapshot: Snapshot = {
			path: "test.ts",
			text: "hello",
			hash: "1A2B",
			recordedAt: Date.now(),
		};
		mergeClippedLines(snapshot, undefined);
		expect(snapshot.clippedLines).toBeUndefined();
	});
});
