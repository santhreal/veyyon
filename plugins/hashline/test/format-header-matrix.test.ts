/**
 * formatReplaceHeader / formatDeleteHeader / formatInsertHeader / formatHashlineHeader
 * are the single source of truth for authored ops and read headers.
 */
import { describe, expect, it } from "bun:test";
import {
	computeFileHash,
	formatDeleteHeader,
	formatHashlineHeader,
	formatInsertHeader,
	formatNumberedLine,
	formatNumberedLines,
	formatReplaceHeader,
	HL_DELETE_KEYWORD,
	HL_FILE_HASH_LENGTH,
	HL_FILE_HASH_SEP,
	HL_FILE_PREFIX,
	HL_FILE_SUFFIX,
	HL_HEADER_COLON,
	HL_INSERT_AFTER,
	HL_INSERT_BEFORE,
	HL_INSERT_HEAD,
	HL_INSERT_KEYWORD,
	HL_INSERT_TAIL,
	HL_LINE_BODY_SEP,
	HL_RANGE_SEP,
	HL_REPLACE_KEYWORD,
	parsePatch,
} from "@veyyon/hashline";

describe("format*Header exact strings", () => {
	it("formatReplaceHeader uses SWAP N.=M:", () => {
		expect(formatReplaceHeader(1, 1)).toBe(`${HL_REPLACE_KEYWORD} 1${HL_RANGE_SEP}1${HL_HEADER_COLON}`);
		expect(formatReplaceHeader(3, 9)).toBe(`SWAP 3.=9:`);
	});

	it("formatDeleteHeader omits range for single line", () => {
		expect(formatDeleteHeader(5)).toBe(`${HL_DELETE_KEYWORD} 5`);
		expect(formatDeleteHeader(5, 5)).toBe(`DEL 5`);
		expect(formatDeleteHeader(2, 8)).toBe(`DEL 2.=8`);
	});

	it("formatInsertHeader covers all cursor kinds", () => {
		expect(formatInsertHeader({ kind: "before_anchor", anchor: { line: 4 } })).toBe(
			`${HL_INSERT_KEYWORD}.${HL_INSERT_BEFORE} 4${HL_HEADER_COLON}`,
		);
		expect(formatInsertHeader({ kind: "after_anchor", anchor: { line: 7 } })).toBe(
			`${HL_INSERT_KEYWORD}.${HL_INSERT_AFTER} 7${HL_HEADER_COLON}`,
		);
		expect(formatInsertHeader({ kind: "bof" })).toBe(`${HL_INSERT_KEYWORD}.${HL_INSERT_HEAD}${HL_HEADER_COLON}`);
		expect(formatInsertHeader({ kind: "eof" })).toBe(`${HL_INSERT_KEYWORD}.${HL_INSERT_TAIL}${HL_HEADER_COLON}`);
	});

	it("formatHashlineHeader is [path#HASH]", () => {
		expect(formatHashlineHeader("src/a.ts", "ABCD")).toBe(
			`${HL_FILE_PREFIX}src/a.ts${HL_FILE_HASH_SEP}ABCD${HL_FILE_SUFFIX}`,
		);
	});
});

describe("format headers round-trip through parsePatch", () => {
	it("formatReplaceHeader + body parses as replace edits", () => {
		const { edits } = parsePatch(`${formatReplaceHeader(2, 2)}\n+X`);
		expect(edits.some(e => e.kind === "delete")).toBe(true);
		expect(edits.some(e => e.kind === "insert" && e.text === "X")).toBe(true);
	});

	it("formatDeleteHeader parses as delete", () => {
		const { edits } = parsePatch(formatDeleteHeader(3, 5));
		expect(edits.filter(e => e.kind === "delete").map(e => (e.kind === "delete" ? e.anchor.line : 0))).toEqual([
			3, 4, 5,
		]);
	});

	it("formatInsertHeader parses matching cursor", () => {
		const post = parsePatch(`${formatInsertHeader({ kind: "after_anchor", anchor: { line: 2 } })}\n+Z`);
		const e = post.edits[0];
		expect(e?.kind).toBe("insert");
		if (e?.kind === "insert") {
			expect(e.cursor.kind).toBe("after_anchor");
			if (e.cursor.kind === "after_anchor") expect(e.cursor.anchor.line).toBe(2);
		}

		const head = parsePatch(`${formatInsertHeader({ kind: "bof" })}\n+H`);
		if (head.edits[0]?.kind === "insert") expect(head.edits[0].cursor.kind).toBe("bof");

		const tail = parsePatch(`${formatInsertHeader({ kind: "eof" })}\n+T`);
		if (tail.edits[0]?.kind === "insert") expect(tail.edits[0].cursor.kind).toBe("eof");
	});
});

describe("computeFileHash and numbered lines", () => {
	it("hash length is always HL_FILE_HASH_LENGTH uppercase hex", () => {
		for (const text of ["", "a", "a\nb", "unicode ☃", "x".repeat(1000)]) {
			const h = computeFileHash(text);
			expect(h).toHaveLength(HL_FILE_HASH_LENGTH);
			expect(h).toMatch(/^[0-9A-F]+$/);
		}
	});

	it("trailing whitespace normalization: hash ignores trailing spaces/tabs/CR per line", () => {
		// normalizeFileHashText strips trailing [ \t\r] before newline/end
		expect(computeFileHash("a  \nb")).toBe(computeFileHash("a\nb"));
		expect(computeFileHash("a\t\nb")).toBe(computeFileHash("a\nb"));
	});

	it("content change changes hash", () => {
		expect(computeFileHash("a")).not.toBe(computeFileHash("b"));
		expect(computeFileHash("a\n")).not.toBe(computeFileHash("a"));
	});

	it("formatNumberedLine and formatNumberedLines stay in lockstep", () => {
		expect(formatNumberedLine(3, "body")).toBe(`3${HL_LINE_BODY_SEP}body`);
		const text = "x\ny\n";
		// trailing newline → phantom empty third line (patcher addressable append)
		expect(formatNumberedLines(text)).toBe("1:x\n2:y\n3:");
		expect(formatNumberedLines("only", 10)).toBe("10:only");
	});
});
