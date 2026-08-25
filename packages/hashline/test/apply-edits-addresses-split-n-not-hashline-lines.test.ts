/**
 * Two line splitters exist in hashline, and they do not agree.
 *
 * splitHashlineLines (tokenizer.ts) is the documented addressing model
 * (docs/migration/hashline-contract.md): LF terminates a line, a CR immediately
 * before that LF is trimmed, a lone CR is content, and a trailing terminator
 * adds no phantom line. "a\n" is therefore one line, ["a"].
 *
 * applyEdits (apply.ts) does text.split("\n"). "a\n" is therefore two lines,
 * ["a", ""]. trailingPhantomLine then treats that empty string as a real
 * address for inserts and swaps, and only as a non-line for DELETE: dropTrailingPhantomDeletes
 * silently drops DEL of the phantom, so DEL 1.=2 on a one-line newline-terminated
 * file becomes "delete line 1" instead of "line 2 does not exist".
 *
 * formatNumberedLines documents this lockstep with the applier, so a numbered
 * read of "a\n" shows "1:a\n2:" — an extra line the tokenizer would never
 * name. computeFileHash independently strips trailing CR (and spaces/tabs)
 * before hashing, so "hello" and "hello\r" mint the same tag even though
 * splitHashlineLines treats the CR as content.
 *
 * This file pins the documented addressing model. Cases that fail are the
 * defect. splitHashlineLines is asserted first so a change there cannot move
 * the goalposts.
 */
import { describe, expect, it } from "bun:test";
import {
	applyEdits,
	computeFileHash,
	formatNumberedLines,
	parsePatch,
	splitHashlineLines,
} from "@veyyon/hashline";

function apply(text: string, patch: string): string {
	const parsed = parsePatch(patch);
	expect(parsed.warnings).toEqual([]);
	return applyEdits(text, parsed.edits).text;
}

describe("splitHashlineLines is the documented addressing model", () => {
	it("treats a trailing LF as a terminator, not a phantom line", () => {
		expect(splitHashlineLines("a\n")).toEqual(["a"]);
		expect(splitHashlineLines("a\nb\n")).toEqual(["a", "b"]);
		expect(splitHashlineLines("a")).toEqual(["a"]);
		expect(splitHashlineLines("")).toEqual([""]);
	});

	it("trims CR only when it sits immediately before LF", () => {
		expect(splitHashlineLines("a\r\nb")).toEqual(["a", "b"]);
		expect(splitHashlineLines("ca\rfe\n")).toEqual(["ca\rfe"]);
		// A CR at the end of the last segment is treated as a terminator, same as CR-before-LF.
		expect(splitHashlineLines("hello\r")).toEqual(["hello"]);
	});
});

describe("applyEdits must address the same lines splitHashlineLines names", () => {
	it("DEL 2 on a trailing-newline one-line file is out of range, not a silent no-op", () => {
		expect(() => apply("a\n", "DEL 2")).toThrow(/does not exist/);
		expect(apply("a\n", "DEL 1")).toBe("");
	});

	it("DEL 1.=2 on a trailing-newline one-line file is out of range, not a delete of line 1", () => {
		expect(() => apply("a\n", "DEL 1.=2")).toThrow(/does not exist/);
	});

	it("INS.TAIL on a trailing-newline one-line file appends after line 1, keeping the terminator", () => {
		expect(apply("a\n", "INS.TAIL:\n+b")).toBe("a\nb\n");
	});

	it("SWAP 2 does not exist on a trailing-newline one-line file", () => {
		expect(() => apply("a\n", "SWAP 2.=2:\n+Z")).toThrow(/does not exist/);
	});

	it("a lone CR is content on the line, so SWAP 1 replaces the whole ca<CR>fe", () => {
		expect(splitHashlineLines("ca\rfe")).toEqual(["ca\rfe"]);
		expect(apply("ca\rfe", "SWAP 1.=1:\n+x")).toBe("x");
	});

	it("CRLF SWAP of line 2 keeps CR LF on every line, including the edited one", () => {
		const original = "one\r\ntwo\r\nthree";
		expect(splitHashlineLines(original)).toEqual(["one", "two", "three"]);
		expect(apply(original, "SWAP 2.=2:\n+TWO")).toBe("one\r\nTWO\r\nthree");
	});
});

describe("formatNumberedLines must not invent a line the tokenizer does not name", () => {
	it("does not print a phantom empty line for a trailing terminator", () => {
		expect(formatNumberedLines("a\n")).toBe("1:a");
		expect(formatNumberedLines("a\nb\n")).toBe("1:a\n2:b");
		expect(formatNumberedLines("a")).toBe("1:a");
	});
});

describe("computeFileHash must not collapse a lone CR that is line content", () => {
	it("hashes a mid-line CR as content, matching the tokenizer", () => {
		expect(splitHashlineLines("ca\rfe")).toEqual(["ca\rfe"]);
		expect(computeFileHash("ca\rfe")).not.toBe(computeFileHash("cafe"));
	});

	it("still hashes CRLF and LF identically, because CR-before-LF is a terminator not content", () => {
		expect(computeFileHash("a\r\nb")).toBe(computeFileHash("a\nb"));
	});
});
