/**
 * `normalizeFileHashText` strips only trailing spaces/tabs/CR before a newline
 * or end of string: `/[ \t\r]+(?=\n|$)/g`. A CR in the MIDDLE of a line is
 * content.
 *
 * Existing compute-file-hash-stability-matrix.test.ts pins trailing CR/LF
 * equivalence (`x\\r\\n` vs `x\\n`). It does not pin `ca\\rfe` vs `cafe`.
 * `hashline-parse-text-lone-cr-is-content.test.ts` pins parse, not the hash
 * tag. If mid-line CR were stripped, two different files would share a tag
 * and a follow-up edit would apply against the wrong snapshot.
 */
import { describe, expect, it } from "bun:test";
import { computeFileHash } from "@veyyon/hashline";

describe("computeFileHash treats a mid-line CR as content", () => {
	it("hashes ca\\rfe differently from cafe", () => {
		expect(computeFileHash("ca\rfe")).not.toBe(computeFileHash("cafe"));
	});

	it("hashes ca\\rfe differently from ca\\nfe", () => {
		expect(computeFileHash("ca\rfe")).not.toBe(computeFileHash("ca\nfe"));
	});

	it("still equates a trailing CR with the trimmed form", () => {
		expect(computeFileHash("hello\r")).toBe(computeFileHash("hello"));
		expect(computeFileHash("hello\r\n")).toBe(computeFileHash("hello\n"));
	});

	it("still equates trailing spaces/tabs with the trimmed form", () => {
		expect(computeFileHash("hello  ")).toBe(computeFileHash("hello"));
		expect(computeFileHash("hello\t")).toBe(computeFileHash("hello"));
	});

	it("does not strip a CR that sits before a letter, even at start of file", () => {
		expect(computeFileHash("\rhello")).not.toBe(computeFileHash("hello"));
	});

	it("does not strip a CR between two newlines' payloads", () => {
		expect(computeFileHash("a\rb\nc")).not.toBe(computeFileHash("ab\nc"));
		expect(computeFileHash("a\rb\nc")).not.toBe(computeFileHash("a\nb\nc"));
	});
});
