import { describe, expect, it } from "bun:test";
import type { EditToolDetails, EditToolPerFileResult } from "@veyyon/coding-agent/edit/renderer";
import { MAX_EDIT_SNAPSHOT_TEXT_CHARS, pruneOversizedEditSnapshots } from "@veyyon/coding-agent/edit/snapshot-details";

/**
 * pruneOversizedEditSnapshots keeps the raw oldText/newText an edit result carries
 * (used only to render an ACP diff) from ballooning the per-turn JSONL and session
 * file (issue #3786: 300 KB+ lines). It was untested despite a subtle shared-budget
 * rule across a multi-file batch (issue #3787). The invariants that matter, locked
 * here so a regression cannot silently reintroduce unbounded snapshot bytes OR strip
 * diffs that were within budget:
 *
 *  - A single result at or below the combined char budget keeps its text untouched;
 *    over the budget it drops BOTH oldText and newText and sets snapshotsPruned.
 *  - Across perFileResults a single running budget is shared: early entries keep
 *    their snapshots, an entry that would overflow is stripped (and marked), and,
 *    because a stripped entry consumes none of the budget, a later smaller entry can
 *    still fit.
 *  - An entry that alone exceeds the budget is stripped even when it is first.
 */

const S = (n: number): string => "x".repeat(n);
const kept = (e: { oldText?: string; newText?: string }): number => (e.oldText?.length ?? 0) + (e.newText?.length ?? 0);

const details = (over: Partial<EditToolDetails>): EditToolDetails => ({ diff: "", ...over });
const fileResult = (over: Partial<EditToolPerFileResult> & { path: string }): EditToolPerFileResult => ({
	diff: "",
	...over,
});

describe("pruneOversizedEditSnapshots single result", () => {
	it("keeps snapshots at or below the combined budget untouched", () => {
		const atBudget = pruneOversizedEditSnapshots(
			details({ oldText: S(MAX_EDIT_SNAPSHOT_TEXT_CHARS - 5), newText: S(5) }),
		);
		expect(kept(atBudget)).toBe(MAX_EDIT_SNAPSHOT_TEXT_CHARS);
		expect(atBudget.snapshotsPruned).toBeUndefined();
	});

	it("drops both snapshots and marks the result when over the budget", () => {
		const over = pruneOversizedEditSnapshots(details({ oldText: S(MAX_EDIT_SNAPSHOT_TEXT_CHARS), newText: S(1) }));
		expect(over.oldText).toBeUndefined();
		expect(over.newText).toBeUndefined();
		expect(over.snapshotsPruned).toBe(true);
	});
});

describe("pruneOversizedEditSnapshots multi-file batch", () => {
	it("shares one budget: early entries keep, an overflowing entry is stripped, a later small entry still fits", () => {
		const half = Math.round(MAX_EDIT_SNAPSHOT_TEXT_CHARS * 0.6);
		const result = pruneOversizedEditSnapshots(
			details({
				perFileResults: [
					fileResult({ path: "a", oldText: S(half) }),
					fileResult({ path: "b", oldText: S(half) }),
					fileResult({ path: "c", oldText: S(100) }),
				],
			}),
		);
		const entries = result.perFileResults ?? [];
		expect(entries.map(e => [e.path, kept(e), Boolean(e.snapshotsPruned)])).toEqual([
			["a", half, false],
			["b", 0, true],
			["c", 100, false],
		]);
	});

	it("strips an entry that alone exceeds the budget even when it is first", () => {
		const result = pruneOversizedEditSnapshots(
			details({
				perFileResults: [
					fileResult({ path: "big", oldText: S(MAX_EDIT_SNAPSHOT_TEXT_CHARS + 1) }),
					fileResult({ path: "small", oldText: S(50) }),
				],
			}),
		);
		const entries = result.perFileResults ?? [];
		expect(entries.map(e => [e.path, kept(e), Boolean(e.snapshotsPruned)])).toEqual([
			["big", 0, true],
			["small", 50, false],
		]);
	});
});
