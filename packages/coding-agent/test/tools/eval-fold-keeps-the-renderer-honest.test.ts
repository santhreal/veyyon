/**
 * The eval tool folds test bookkeeping out of what the MODEL reads, and out of nothing else.
 *
 * WHY THIS SUITE EXISTS. `output-fold` cuts per-test bookkeeping from tool output because
 * that output is re-read as a cache token on every later turn: on a measured 66-turn trace,
 * three verbose test results were 67% of all tool-result bytes. The fold is applied at one point
 * in `eval`, the model-facing accumulation, while `cellResult.output` keeps the raw text so the
 * transcript renderer still shows the operator the run in full.
 *
 * That separation existed only in the code. It typechecked, and it was asserted NOWHERE, so a
 * refactor that read the folded string into the cell (or the raw string into the result) would
 * have been silent: the operator would lose output they never knew was there, or the whole cost
 * saving would evaporate with every test still green. These tests pin BOTH halves against a real
 * `EvalTool.execute` call, and they assert bytes rather than lengths, because "shorter" is not
 * the claim — "the bookkeeping went and the failures did not" is.
 *
 * The backend is stubbed to return captured-shape Go test output. What is under test is the
 * tool's wiring, not a language runtime.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import * as evalIndex from "@veyyon/coding-agent/eval";
import type { EvalToolDetails } from "@veyyon/coding-agent/eval/types";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { EvalTool } from "@veyyon/coding-agent/tools/eval";
import { MIN_FOLDABLE_LINES } from "@veyyon/coding-agent/tools/output-fold";

function makeSession(): ToolSession {
	return {
		cwd: "/tmp/eval-fold-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
	};
}

function backendResult(output: string, overrides: Record<string, unknown> = {}) {
	return {
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		artifactId: undefined,
		totalLines: output.split("\n").length,
		totalBytes: output.length,
		outputLines: output.split("\n").length,
		outputBytes: output.length,
		displayOutputs: [] as unknown[],
		...overrides,
	};
}

/**
 * A `go test -v` run in the shape the trace captured: bookkeeping for tests that passed, one
 * genuine failure, and a final verdict. Long enough to clear the fold's minimum.
 */
function goTestOutput(): string {
	const lines: string[] = [];
	for (let index = 0; index < MIN_FOLDABLE_LINES + 8; index++) {
		lines.push(`=== RUN   TestThing/case_${index}`);
		lines.push(`--- PASS: TestThing/case_${index} (0.00s)`);
	}
	lines.push("=== RUN   TestBroken");
	lines.push("    thing_test.go:42: expected 3, got 4");
	lines.push("--- FAIL: TestBroken (0.01s)");
	lines.push("FAIL");
	lines.push("FAIL\texample.com/pkg\t0.312s");
	return `${lines.join("\n")}\n`;
}

/** The text of a tool result, which is what the model reads. */
function resultText(result: { content?: unknown[] }): string {
	return (result.content ?? [])
		.filter(
			(block): block is { type: "text"; text: string } =>
				!!block && typeof block === "object" && (block as { type?: string }).type === "text",
		)
		.map(block => block.text)
		.join("\n");
}

async function runEval(output: string): Promise<{ modelText: string; cellOutput: string }> {
	vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async () => backendResult(output)) as never);
	const tool = new EvalTool(makeSession());
	let details: EvalToolDetails | undefined;
	const result = await tool.execute("call-fold", { language: "js", code: "runTests()" }, undefined, update => {
		if (update.details) details = update.details as EvalToolDetails;
	});
	const cells = (result.details as EvalToolDetails | undefined)?.cells ?? details?.cells ?? [];
	return { modelText: resultText(result as { content?: unknown[] }), cellOutput: cells[0]?.output ?? "" };
}

describe("EvalTool and the test-output fold", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("hands the model folded output and the renderer the raw run", async () => {
		const raw = goTestOutput();

		const { modelText, cellOutput } = await runEval(raw);

		// The renderer's copy is the run, byte for byte apart from the trailing newline
		// the cell trims. This is the half that had no test at all, and losing it costs
		// the operator output they cannot get back.
		expect(cellOutput).toBe(raw.trimEnd());
		// The model's copy is not.
		expect(modelText).not.toBe(raw);
		expect(modelText.length).toBeLessThan(raw.length);
	});

	it("keeps every failure line verbatim in what the model reads", async () => {
		// The whole safety claim of the fold. A saving that eats a failure is not a
		// saving, it is a bug that makes the agent answer the wrong question.
		const { modelText } = await runEval(goTestOutput());

		expect(modelText).toContain("--- FAIL: TestBroken (0.01s)");
		expect(modelText).toContain("thing_test.go:42: expected 3, got 4");
		expect(modelText).toContain("FAIL\texample.com/pkg\t0.312s");
	});

	it("removes the per-test bookkeeping from what the model reads", async () => {
		const { modelText } = await runEval(goTestOutput());

		expect(modelText).not.toContain("=== RUN   TestThing/case_0");
		expect(modelText).not.toContain("--- PASS: TestThing/case_0 (0.00s)");
		// And says exactly what went, rather than dropping lines silently: the counts are
		// the 21 `=== RUN` lines (20 passing cases plus the failing test's own) and the
		// 20 `--- PASS` lines.
		expect(modelText).toContain("[folded 21 === RUN/CONT/PAUSE lines; failures are never folded]");
		expect(modelText).toContain("[folded 20 --- PASS/SKIP lines; failures are never folded]");
	});

	it("leaves output with nothing foldable in it identical on both sides", async () => {
		// The negative twin. A fold that rewrote ordinary output would corrupt every
		// eval result in the session, and "shorter" would still look like success.
		const raw = "hello from the kernel\nsecond line\n";

		const { modelText, cellOutput } = await runEval(raw);

		expect(cellOutput).toBe(raw.trimEnd());
		expect(modelText).toContain("hello from the kernel");
		expect(modelText).toContain("second line");
		expect(modelText).not.toContain("[folded");
	});

	it("leaves a short bookkeeping run alone, below the fold's minimum", async () => {
		// Folding three lines into a marker line saves nothing and costs the reader
		// the actual text, so the fold has a floor. Pinned here because the wiring is
		// where a floor regression would show up as "output changed for no reason".
		const raw = ["=== RUN   TestOnly", "--- PASS: TestOnly (0.00s)", "ok\texample.com/pkg\t0.10s"].join("\n");

		const { modelText, cellOutput } = await runEval(`${raw}\n`);

		expect(cellOutput).toBe(raw);
		expect(modelText).toContain("=== RUN   TestOnly");
		expect(modelText).toContain("--- PASS: TestOnly (0.00s)");
	});

	it("folds the model's copy on a non-zero exit too", async () => {
		// A failing suite is the expensive case: the trace's largest result was a
		// FAILING run whose bulk was bookkeeping for the tests that passed. An
		// exit-code gate here would protect exactly the bytes worth removing.
		const raw = goTestOutput();
		vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async () =>
			backendResult(raw, { exitCode: 1 })) as never);
		const tool = new EvalTool(makeSession());

		const result = await tool.execute("call-fold-fail", { language: "js", code: "runTests()" }, undefined, () => {});

		const modelText = resultText(result as { content?: unknown[] });
		expect(modelText).not.toContain("--- PASS: TestThing/case_0 (0.00s)");
		expect(modelText).toContain("--- FAIL: TestBroken (0.01s)");
		expect((result.details as EvalToolDetails | undefined)?.cells?.[0]?.output).toBe(raw.trimEnd());
	});
});
