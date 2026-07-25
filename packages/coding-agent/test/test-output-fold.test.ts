/**
 * Folding test bookkeeping out of tool output, pinned.
 *
 * WHY THIS SUITE EXISTS. This module deletes bytes from what the agent sees, so
 * every failure mode is a capability regression that would show up as a lower
 * pass rate long after the change, with no obvious cause. The measured payoff is
 * real (42% fewer tool-result tokens, 22% of that billing line on a real trace),
 * which makes it tempting to widen the patterns; these tests exist to make
 * widening them fail loudly.
 *
 * The contract in one line: a line that reports a problem is never removed, and
 * nothing is ever removed silently.
 */

import { describe, expect, it } from "bun:test";
import { classifyLine, foldPassingTestOutput, MIN_FOLDABLE_LINES } from "@veyyon/coding-agent/tools/test-output-fold";

/** Build a run of `n` distinct `=== RUN` lines, enough to clear the threshold. */
function runLines(n: number): string[] {
	return Array.from({ length: n }, (_, i) => `=== RUN   TestThing/case_${i}`);
}

describe("classifyLine", () => {
	it("recognises the bookkeeping Go emits", () => {
		expect(classifyLine("=== RUN   TestFoo")).toBe("run");
		expect(classifyLine("=== CONT  TestFoo")).toBe("run");
		expect(classifyLine("=== PAUSE TestFoo")).toBe("run");
		expect(classifyLine("--- PASS: TestFoo (0.00s)")).toBe("pass");
		expect(classifyLine("    --- SKIP: TestFoo/sub (0.00s)")).toBe("pass");
		expect(classifyLine("?   \tcarvel.dev/ytt/pkg\t[no test files]")).toBe("noTestFiles");
		expect(classifyLine("ok  \tcarvel.dev/ytt/pkg/cmd\t0.075s")).toBe("packageOk");
		expect(classifyLine("ok  \tcarvel.dev/ytt/pkg/cmd\t0.075s (cached)")).toBe("packageOk");
	});

	/**
	 * The lines whose removal would cost the agent the run. Each is asserted
	 * individually rather than through folded output, so a pattern that starts
	 * matching one of them names itself in the failure.
	 */
	it("never classifies a line that reports a problem", () => {
		const mustSurvive = [
			"--- FAIL: TestDataValues (0.00s)",
			"    --- FAIL: TestDataValues/can_be_set (0.00s)",
			"FAIL\tcarvel.dev/ytt/pkg/cmd\t0.075s",
			"FAIL",
			"panic: runtime error: index out of range [3]",
			"WARNING: DATA RACE",
			"        e2e_test.go:473: ",
			"                \tError Trace:\t/app/test/e2e/e2e_test.go:473",
			"                \tError:      \tNot equal:",
			"--- BENCH: BenchmarkThing",
		];
		for (const line of mustSurvive) expect(classifyLine(line)).toBeNull();
	});

	/**
	 * A test's own stdout can start with anything, including text that looks like
	 * a verdict. The patterns require Go's exact shape, so ordinary output is not
	 * mistaken for bookkeeping and deleted.
	 */
	it("does not classify a test's own output that merely resembles a verdict", () => {
		expect(classifyLine("ok, that worked")).toBeNull();
		expect(classifyLine("=== RUNNING the migration")).toBeNull();
		expect(classifyLine("--- PASSED")).toBeNull();
		expect(classifyLine("? maybe [no test files] were found")).toBeNull();
		expect(classifyLine("ok  \tsomepkg\tnot-a-duration")).toBeNull();
	});
});

describe("foldPassingTestOutput", () => {
	/**
	 * The headline case: a large passing suite collapses to a single stated
	 * summary per class, and the surviving text says how much went.
	 */
	it("folds a large passing suite and says what it removed", () => {
		const text = [...runLines(40), "ok  \tpkg/a\t0.10s"].join("\n");
		const result = foldPassingTestOutput(text);
		expect(result.folded.run).toBe(40);
		expect(result.text).toContain("[folded 40 === RUN/CONT/PAUSE lines");
		expect(result.text.split("\n").filter(l => l.startsWith("=== RUN"))).toHaveLength(0);
		expect(result.text.length).toBeLessThan(text.length / 4);
	});

	/**
	 * The regression that motivated removing the global failure gate, and the one
	 * most likely to be reintroduced by someone being cautious: a FAILING run
	 * still folds its passing bookkeeping, and every failure line survives
	 * verbatim, in order.
	 */
	it("folds passing bookkeeping in a FAILING run while keeping every failure line", () => {
		const text = [
			...runLines(30),
			"--- FAIL: TestThing/case_7 (0.01s)",
			"    thing_test.go:42: expected 3, got 4",
			"FAIL",
			"FAIL\tcarvel.dev/ytt/pkg\t0.20s",
		].join("\n");
		const result = foldPassingTestOutput(text);
		expect(result.folded.run).toBe(30);
		expect(result.text).toContain("--- FAIL: TestThing/case_7 (0.01s)");
		expect(result.text).toContain("    thing_test.go:42: expected 3, got 4");
		expect(result.text).toContain("FAIL\tcarvel.dev/ytt/pkg\t0.20s");
		// Order preserved: the fold marker sits where the run lines were, before
		// the failure detail that followed them.
		const lines = result.text.split("\n");
		expect(lines.findIndex(l => l.startsWith("[folded"))).toBeLessThan(
			lines.findIndex(l => l.startsWith("--- FAIL")),
		);
	});

	/**
	 * Output the agent printed itself is not bookkeeping and must come through
	 * byte for byte, interleaved exactly as it was. Folding that would destroy
	 * the actual result of a computation.
	 */
	it("passes a test's own stdout through unchanged", () => {
		const text = [...runLines(20), "computed checksum: 8f14e45f", "rows written: 1042"].join("\n");
		const result = foldPassingTestOutput(text);
		expect(result.text).toContain("computed checksum: 8f14e45f");
		expect(result.text).toContain("rows written: 1042");
	});

	/**
	 * A short run is left alone: the explanatory line would cost more than the
	 * few lines it replaces, and the raw output reads better.
	 */
	it("leaves a run below the threshold untouched", () => {
		const text = runLines(MIN_FOLDABLE_LINES - 1).join("\n");
		const result = foldPassingTestOutput(text);
		expect(result.text).toBe(text);
		expect(result.skippedReason).toBe("below-threshold");
		expect(result.folded).toEqual({});
	});

	/** Text with no test output at all is returned identically, so the fold is safe to apply to any tool result. */
	it("returns unrelated output unchanged", () => {
		const text = "hello\nworld\nno tests here";
		const result = foldPassingTestOutput(text);
		expect(result.text).toBe(text);
		expect(result.skippedReason).toBe("nothing-to-fold");
	});

	/** Empty input is a no-op rather than a crash, since tool output is frequently empty. */
	it("handles empty input", () => {
		expect(foldPassingTestOutput("").text).toBe("");
	});

	/**
	 * Each class is summarised exactly once even though its lines are scattered
	 * through the output, so the result cannot accumulate one marker per line and
	 * end up larger than what it replaced.
	 */
	it("emits one marker per class, no matter how the lines are interleaved", () => {
		const text = [
			...runLines(15),
			"?   \tpkg/a\t[no test files]",
			...runLines(15),
			"?   \tpkg/b\t[no test files]",
		].join("\n");
		const result = foldPassingTestOutput(text);
		const markers = result.text.split("\n").filter(l => l.startsWith("[folded"));
		expect(markers).toHaveLength(2);
		expect(result.folded.run).toBe(30);
		expect(result.folded.noTestFiles).toBe(2);
	});
});
