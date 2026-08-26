/**
 * WHY: this bench decides whether a prune of the `edit` tool description ships, on two
 * numbers: how many fixtures still pass, and what the run cost in tokens. Both were
 * computed inline in a `main()` that needed a live model, and the invocation parser
 * accepted `--limit ten` as `NaN` tasks and `--model` with no value as an empty model,
 * so a run could report a comparison it never made.
 *
 * The class this closes: an invocation that looks valid and measures something else, and
 * a summary whose totals do not come from the outcomes it reports. Both seams are
 * exported and driven directly.
 *
 * What it does not catch: whether a fixture's verification is correct (owned by
 * `verifyExpectedFileSubset`), and the token accounting a provider reports.
 */

import { describe, expect, it } from "bun:test";
import { parseBenchArgs, summarizeBenchOutcomes, type TaskOutcome } from "../../src/benches/edit-prompt-bench";

function outcome(id: string, overrides: Partial<TaskOutcome> = {}): TaskOutcome {
	return { id, passed: true, inputTokens: 1_000, outputTokens: 100, durationMs: 5_000, ...overrides };
}

describe("reading an edit-prompt bench invocation", () => {
	it("refuses a run that names no model, since the measurement is per model", () => {
		expect(() => parseBenchArgs([])).toThrow(/--model is required/);
		expect(() => parseBenchArgs(["--label", "before"])).toThrow(/--model is required/);
	});

	it("refuses a --model flag that arrived with no value instead of running an empty model", () => {
		expect(() => parseBenchArgs(["--model"])).toThrow(/--model is required/);
	});

	it("defaults the label to run and leaves the json path and limit absent", () => {
		expect(parseBenchArgs(["--model", "cursor/cursor-grok-4.5-medium"])).toEqual({
			model: "cursor/cursor-grok-4.5-medium",
			label: "run",
			json: undefined,
			limit: undefined,
		});
	});

	it("reads the label, the json destination and the task limit", () => {
		expect(
			parseBenchArgs(["--model", "a/one", "--label", "after", "--json", "runs/after.json", "--limit", "5"]),
		).toEqual({ model: "a/one", label: "after", json: "runs/after.json", limit: 5 });
	});

	it("refuses a --limit that is not a number rather than slicing by NaN", () => {
		expect(() => parseBenchArgs(["--model", "a/one", "--limit", "ten"])).toThrow(/--limit expects a number/);
	});

	it("treats a valueless --label or --json as absent rather than as the literal true", () => {
		expect(parseBenchArgs(["--model", "a/one", "--label", "--json"])).toEqual({
			model: "a/one",
			label: "run",
			json: undefined,
			limit: undefined,
		});
	});
});

describe("summarizing a bench run", () => {
	const identity = { label: "after", model: "a/one", editToolDescriptionTokens: 1_970 };

	it("counts passes and sums the tokens of every outcome, including failed ones", () => {
		const report = summarizeBenchOutcomes(
			[
				outcome("one"),
				outcome("two", { passed: false, inputTokens: 2_000, outputTokens: 250 }),
				outcome("three", { inputTokens: 500, outputTokens: 50 }),
			],
			identity,
		);

		expect(report.passed).toBe(2);
		expect(report.total).toBe(3);
		expect(report.totalInputTokens).toBe(3_500);
		expect(report.totalOutputTokens).toBe(400);
	});

	it("carries the prompt size and identity the run was measured under", () => {
		const report = summarizeBenchOutcomes([outcome("one")], identity);

		expect(report.label).toBe("after");
		expect(report.model).toBe("a/one");
		expect(report.editToolDescriptionTokens).toBe(1_970);
	});

	it("reports a run of no outcomes as zero of zero rather than as a pass", () => {
		const report = summarizeBenchOutcomes([], identity);

		expect(report).toMatchObject({ passed: 0, total: 0, totalInputTokens: 0, totalOutputTokens: 0 });
		expect(report.tasks).toEqual([]);
	});

	it("keeps every outcome in its own list, in the order the run produced them", () => {
		const outcomes = [outcome("one"), outcome("two", { passed: false, error: "timed out" })];
		const report = summarizeBenchOutcomes(outcomes, identity);

		expect(report.tasks.map(task => task.id)).toEqual(["one", "two"]);
		expect(report.tasks).not.toBe(outcomes);
		expect(report.tasks[1].error).toBe("timed out");
	});
});
