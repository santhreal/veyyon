/**
 * Locks exact operator-facing message strings and format helpers in messages.ts.
 * These strings are the recovery/rejection contract models and hosts read.
 */
import { describe, expect, it } from "bun:test";
import {
	ABORT_MARKER,
	afterInsertLandingShiftWarning,
	ambiguousBoundaryEchoMessage,
	ambiguousCloserSpareMessage,
	BARE_BODY_AUTO_PIPED_WARNING,
	BEGIN_PATCH_MARKER,
	BLOCK_RESOLVER_UNAVAILABLE,
	blockInsertLandingShiftWarning,
	blockSingleLineMessage,
	blockUnresolvedMessage,
	DELETE_BLOCK_TAKES_NO_BODY,
	DELETE_TAKES_NO_BODY,
	EMPTY_BLOCK,
	EMPTY_INSERT,
	EMPTY_REPLACE,
	END_PATCH_MARKER,
	formatAnchoredContext,
	HEADTAIL_DRIFT_WARNING,
	insertAfterBlockCloserLoweredWarning,
	insertAfterBlockUnresolvedLoweredWarning,
	MINUS_ROW_REJECTED,
	MISMATCH_CONTEXT,
	missingSnapshotTagMessage,
	MOVE_TAKES_NO_BODY,
	pathRecoveredFromTagMessage,
	REM_TAKES_NO_BODY,
	REPLACE_PAIR_COALESCED_WARNING,
	RECOVERY_EXTERNAL_WARNING,
	RECOVERY_LINE_REMAP_WARNING,
	RECOVERY_SESSION_CHAIN_WARNING,
	UNRESOLVED_BLOCK_INTERNAL,
	unseenLinesMessage,
} from "../src/messages";
import { HL_FILE_HASH_SEP, HL_FILE_PREFIX, HL_FILE_SUFFIX, HL_RANGE_SEP } from "../src/format";

describe("message markers and static warnings", () => {
	it("exports exact envelope markers", () => {
		expect(BEGIN_PATCH_MARKER).toBe("*** Begin Patch");
		expect(END_PATCH_MARKER).toBe("*** End Patch");
		expect(ABORT_MARKER).toBe("*** Abort");
	});

	it("exports exact body/op rejection strings used by parser", () => {
		expect(EMPTY_REPLACE).toContain(`SWAP N${HL_RANGE_SEP}M:`);
		expect(EMPTY_REPLACE).toContain("DEL");
		expect(EMPTY_BLOCK).toContain("SWAP.BLK");
		expect(EMPTY_INSERT).toBe("`INS` needs at least one `+TEXT` body row.");
		expect(DELETE_TAKES_NO_BODY).toContain("DEL");
		expect(DELETE_BLOCK_TAKES_NO_BODY).toContain("DEL.BLK");
		expect(REM_TAKES_NO_BODY).toContain("`REM`");
		expect(MOVE_TAKES_NO_BODY).toContain("`MV");
		expect(MINUS_ROW_REJECTED).toContain("`-` rows are not valid");
		expect(BARE_BODY_AUTO_PIPED_WARNING).toContain("Auto-prefixed bare body");
		expect(REPLACE_PAIR_COALESCED_WARNING).toContain("Two hunks targeted the same range");
	});

	it("exports exact recovery and drift warnings", () => {
		expect(RECOVERY_EXTERNAL_WARNING).toContain("previous read snapshot");
		expect(RECOVERY_SESSION_CHAIN_WARNING).toContain("in-session snapshot");
		expect(RECOVERY_LINE_REMAP_WARNING).toContain("remapping stale line anchors");
		expect(HEADTAIL_DRIFT_WARNING).toContain("INS.HEAD");
		expect(HEADTAIL_DRIFT_WARNING).toContain("INS.TAIL");
		expect(BLOCK_RESOLVER_UNAVAILABLE).toContain("no block resolver");
		expect(UNRESOLVED_BLOCK_INTERNAL).toContain("resolveBlockEdits");
	});

	it("MISMATCH_CONTEXT is 2 lines either side", () => {
		expect(MISMATCH_CONTEXT).toBe(2);
	});
});

describe("formatAnchoredContext exact rows", () => {
	const lines = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];

	it("marks anchors with * and neighbors with space within MISMATCH_CONTEXT", () => {
		const rows = formatAnchoredContext([5], lines);
		expect(rows).toEqual([" 3:c", " 4:d", "*5:e", " 6:f", " 7:g"]);
	});

	it("inserts ... between non-adjacent anchor windows", () => {
		const rows = formatAnchoredContext([1, 10], lines);
		expect(rows).toEqual(["*1:a", " 2:b", " 3:c", "...", " 8:h", " 9:i", "*10:j"]);
	});

	it("ignores out-of-range anchors without inventing rows", () => {
		expect(formatAnchoredContext([0, 99], lines)).toEqual([]);
		expect(formatAnchoredContext([-1], lines)).toEqual([]);
	});

	it("clamps window at file edges", () => {
		expect(formatAnchoredContext([1], lines)).toEqual(["*1:a", " 2:b", " 3:c"]);
		expect(formatAnchoredContext([10], lines)).toEqual([" 8:h", " 9:i", "*10:j"]);
	});

	it("dedupes overlapping windows without duplicate line numbers", () => {
		const rows = formatAnchoredContext([4, 5], lines);
		const bodies = rows.filter(r => r !== "...").map(r => r.slice(1));
		const lineNums = bodies.map(b => Number(b.split(":")[0]));
		expect(new Set(lineNums).size).toBe(lineNums.length);
		expect(rows.filter(r => r.startsWith("*"))).toEqual(["*4:d", "*5:e"]);
	});
});

describe("block and boundary message builders", () => {
	it("blockUnresolvedMessage includes op phrase and optional context", () => {
		const base = blockUnresolvedMessage(3, "replace");
		expect(base).toContain("SWAP.BLK 3:");
		expect(base).toContain("line 3");
		expect(base).toContain(`SWAP 3${HL_RANGE_SEP}M`);

		const del = blockUnresolvedMessage(9, "delete");
		expect(del).toContain("DEL.BLK 9");
		expect(del).toContain("DEL 9");

		const withCtx = blockUnresolvedMessage(2, "replace", ["x", "y", "z"]);
		expect(withCtx).toContain("*2:y");
		expect(withCtx.split("\n\n")).toHaveLength(2);
	});

	it("insert-after-block lowering warnings are exact", () => {
		expect(insertAfterBlockCloserLoweredWarning(12)).toContain("INS.BLK.POST 12:");
		expect(insertAfterBlockCloserLoweredWarning(12)).toContain("INS.POST 12:");
		expect(insertAfterBlockUnresolvedLoweredWarning(4)).toContain("could not resolve");
		expect(insertAfterBlockUnresolvedLoweredWarning(4)).toContain("INS.POST 4:");
	});

	it("ambiguousBoundaryEchoMessage distinguishes leading vs trailing", () => {
		const lead = ambiguousBoundaryEchoMessage(5, 8, "leading", 2);
		expect(lead).toContain(`SWAP 5${HL_RANGE_SEP}8:`);
		expect(lead).toContain("just above the range");
		expect(lead).toContain("2 line(s)");

		const trail = ambiguousBoundaryEchoMessage(1, 3, "trailing", 1);
		expect(trail).toContain("just below the range");
		expect(trail).toContain("1 line(s)");
	});

	it("ambiguousCloserSpareMessage singular vs plural closers", () => {
		const one = ambiguousCloserSpareMessage(2, 10, 10, 1);
		expect(one).toContain("line 10");
		expect(one).not.toContain("lines 10-");

		const many = ambiguousCloserSpareMessage(2, 12, 10, 3);
		expect(many).toContain("lines 10-12");
	});

	it("landing-shift warnings encode exact numbers", () => {
		expect(afterInsertLandingShiftWarning(20, 24, 3)).toBe(
			"INS.POST 20: body indented shallower than the anchor, so the landing moved past 3 closing lines to after line 24. For the deeper position inside the block, re-issue with the body indented to match.",
		);
		expect(afterInsertLandingShiftWarning(1, 2, 1)).toContain("1 closing line");
		expect(blockInsertLandingShiftWarning(5, 12, 11)).toContain("INS.BLK.POST 5:");
		expect(blockInsertLandingShiftWarning(5, 12, 11)).toContain("closing line 12");
		expect(blockInsertLandingShiftWarning(5, 12, 11)).toContain("after line 11");
	});

	it("blockSingleLineMessage points at plain form for each op", () => {
		expect(blockSingleLineMessage(7, "replace")).toContain("SWAP.BLK 7");
		expect(blockSingleLineMessage(7, "replace")).toContain(`SWAP 7${HL_RANGE_SEP}7:`);
		expect(blockSingleLineMessage(3, "delete")).toContain("DEL.BLK 3");
		expect(blockSingleLineMessage(3, "delete")).toContain("DEL 3");
		expect(blockSingleLineMessage(9, "insert_after")).toContain("INS.BLK.POST");
		expect(blockSingleLineMessage(9, "insert_after")).toContain("INS.POST 9:");
	});
});

describe("path and unseen-line message builders", () => {
	it("missingSnapshotTagMessage embeds path and header shape", () => {
		const msg = missingSnapshotTagMessage("src/a.ts");
		expect(msg).toContain("src/a.ts");
		expect(msg).toContain(`${HL_FILE_PREFIX}src/a.ts${HL_FILE_HASH_SEP}tag${HL_FILE_SUFFIX}`);
		expect(msg).toContain("write tool");
	});

	it("pathRecoveredFromTagMessage names both paths and tag", () => {
		const msg = pathRecoveredFromTagMessage("a.ts", "pkg/a.ts", "ABCD");
		expect(msg).toContain('"a.ts"');
		expect(msg).toContain("pkg/a.ts");
		expect(msg).toContain(`${HL_FILE_HASH_SEP}ABCD`);
		expect(msg).toContain(`${HL_FILE_PREFIX}pkg/a.ts${HL_FILE_HASH_SEP}TAG${HL_FILE_SUFFIX}`);
	});

	it("unseenLinesMessage without reveal asks for ranged re-read", () => {
		const msg = unseenLinesMessage("f.ts", [3, 4, 5, 9], "1A2B");
		expect(msg).toContain("lines 3-5, 9");
		expect(msg).toContain(`${HL_FILE_PREFIX}f.ts${HL_FILE_HASH_SEP}1A2B${HL_FILE_SUFFIX}`);
		expect(msg).toContain("f.ts:3-5,9");
		expect(msg).toContain("Re-read them in full");
	});

	it("unseenLinesMessage with full reveal allows same-tag retry", () => {
		const msg = unseenLinesMessage("f.ts", [2], "CAFE", {
			lines: [{ line: 2, text: "secret" }],
			truncated: false,
		});
		expect(msg).toContain("  2:secret");
		expect(msg).toContain("straight retry now succeeds");
		expect(msg).not.toContain("Re-read them in full first");
	});

	it("unseenLinesMessage truncated reveal still requires remainder re-read", () => {
		const msg = unseenLinesMessage("f.ts", [1, 2, 3, 4], "DEAD", {
			lines: [
				{ line: 1, text: "a" },
				{ line: 2, text: "b" },
			],
			truncated: true,
		});
		expect(msg).toContain("first 2 unseen");
		expect(msg).toContain("  1:a");
		expect(msg).toContain("  2:b");
		expect(msg).toContain("remainder");
		expect(msg).toContain("f.ts:1-4");
	});

	it("unseenLinesMessage compresses singleton and multi ranges in order", () => {
		const msg = unseenLinesMessage("x", [10, 1, 2, 3, 1, 20], "0000");
		expect(msg).toContain("lines 1-3, 10, 20");
	});
});
