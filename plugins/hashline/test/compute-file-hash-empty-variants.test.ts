/**
 * Empty and near-empty content hashes.
 */
import { describe, expect, it } from "bun:test";
import { computeFileHash } from "@veyyon/hashline";

describe("computeFileHash empty variants", () => {
	it("empty string stable", () => {
		expect(computeFileHash("")).toBe(computeFileHash(""));
		expect(computeFileHash("")).toMatch(/^[0-9A-F]{4}$/);
	});

	it("empty vs single newline differ", () => {
		expect(computeFileHash("")).not.toBe(computeFileHash("\n"));
	});

	it("empty vs spaces may differ or match per trailing-ws rule", () => {
		// trailing spaces on final line are stripped before hash
		expect(computeFileHash("  ")).toBe(computeFileHash(""));
		expect(computeFileHash("\t")).toBe(computeFileHash(""));
	});

	it("single letter differs from empty", () => {
		expect(computeFileHash("a")).not.toBe(computeFileHash(""));
	});
});
