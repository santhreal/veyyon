import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Position, Range } from "@veyyon/coding-agent/lsp/types";
import { comparePosition, positionsEqual, rangeContainsPosition, rangesEqual } from "@veyyon/coding-agent/lsp/utils";

const pos = (line: number, character: number): Position => ({ line, character });
const range = (start: Position, end: Position): Range => ({ start, end });

/**
 * These tests lock the single owner of LSP position/range ordering in
 * `src/lsp/utils.ts`. `edits.ts` (overlap detection) and `index.ts` (range
 * containment) both used to carry byte-identical private copies of
 * `comparePosition`; if a second copy ever drifted, overlap detection and
 * declaration-containment could silently disagree on document order. The
 * source-scan test at the bottom fails if a private copy reappears.
 */
describe("comparePosition document ordering", () => {
	it("orders earlier lines before later lines regardless of character", () => {
		// Line dominates: (1,99) still precedes (2,0).
		expect(comparePosition(pos(1, 99), pos(2, 0))).toBeLessThan(0);
		expect(comparePosition(pos(2, 0), pos(1, 99))).toBeGreaterThan(0);
	});

	it("tiebreaks by character within the same line", () => {
		expect(comparePosition(pos(3, 4), pos(3, 10))).toBe(4 - 10);
		expect(comparePosition(pos(3, 10), pos(3, 4))).toBe(10 - 4);
	});

	it("returns zero for identical positions", () => {
		expect(comparePosition(pos(5, 5), pos(5, 5))).toBe(0);
	});

	it("is a total order: sorting a shuffled list yields document order", () => {
		const shuffled = [pos(2, 1), pos(0, 5), pos(2, 0), pos(0, 0), pos(1, 9)];
		const sorted = [...shuffled].sort(comparePosition);
		expect(sorted).toEqual([pos(0, 0), pos(0, 5), pos(1, 9), pos(2, 0), pos(2, 1)]);
	});
});

describe("positionsEqual", () => {
	it("is true only when both line and character match", () => {
		expect(positionsEqual(pos(4, 2), pos(4, 2))).toBe(true);
		expect(positionsEqual(pos(4, 2), pos(4, 3))).toBe(false);
		expect(positionsEqual(pos(4, 2), pos(5, 2))).toBe(false);
	});
});

describe("rangesEqual", () => {
	it("compares both endpoints", () => {
		expect(rangesEqual(range(pos(1, 0), pos(1, 5)), range(pos(1, 0), pos(1, 5)))).toBe(true);
		expect(rangesEqual(range(pos(1, 0), pos(1, 5)), range(pos(1, 0), pos(1, 6)))).toBe(false);
		expect(rangesEqual(range(pos(1, 0), pos(1, 5)), range(pos(0, 0), pos(1, 5)))).toBe(false);
	});
});

describe("rangeContainsPosition", () => {
	const r = range(pos(2, 4), pos(5, 10));

	it("includes both endpoints (closed interval)", () => {
		expect(rangeContainsPosition(r, pos(2, 4))).toBe(true);
		expect(rangeContainsPosition(r, pos(5, 10))).toBe(true);
	});

	it("includes interior positions", () => {
		expect(rangeContainsPosition(r, pos(3, 0))).toBe(true);
		expect(rangeContainsPosition(r, pos(5, 9))).toBe(true);
	});

	it("excludes positions before the start", () => {
		expect(rangeContainsPosition(r, pos(2, 3))).toBe(false);
		expect(rangeContainsPosition(r, pos(1, 99))).toBe(false);
	});

	it("excludes positions after the end", () => {
		expect(rangeContainsPosition(r, pos(5, 11))).toBe(false);
		expect(rangeContainsPosition(r, pos(6, 0))).toBe(false);
	});

	it("treats an empty range as containing only its single position", () => {
		const empty = range(pos(7, 3), pos(7, 3));
		expect(rangeContainsPosition(empty, pos(7, 3))).toBe(true);
		expect(rangeContainsPosition(empty, pos(7, 4))).toBe(false);
	});
});

describe("position-ordering single-owner lock", () => {
	it("no lsp source file redefines comparePosition outside utils.ts", () => {
		const lspDir = join(import.meta.dir, "..", "src", "lsp");
		const offenders: string[] = [];
		for (const entry of readdirSync(lspDir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
			if (entry.name === "utils.ts") continue;
			const text = readFileSync(join(lspDir, entry.name), "utf8");
			if (/function\s+comparePosition\b/.test(text)) offenders.push(entry.name);
		}
		expect(offenders).toEqual([]);
	});
});
