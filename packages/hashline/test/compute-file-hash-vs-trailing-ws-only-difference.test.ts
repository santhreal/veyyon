/**
 * Files that differ only by trailing spaces hash equal; differ by mid spaces do not.
 */
import { describe, expect, it } from "bun:test";
import { computeFileHash } from "@veyyon/hashline";

describe("computeFileHash trailing vs mid whitespace", () => {
	it("trailing spaces ignored", () => {
		expect(computeFileHash("hello  ")).toBe(computeFileHash("hello"));
		expect(computeFileHash("a\nb  \nc\t")).toBe(computeFileHash("a\nb\nc"));
	});

	it("mid-line spaces matter", () => {
		expect(computeFileHash("hel lo")).not.toBe(computeFileHash("hello"));
		expect(computeFileHash("a  b")).not.toBe(computeFileHash("a b"));
	});

	it("leading spaces matter", () => {
		expect(computeFileHash("  hello")).not.toBe(computeFileHash("hello"));
	});
});
