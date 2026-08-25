/**
 * Committed Renderer Defect Corpus Replay and Historical Defect Regression Suite.
 *
 * WHY THIS SUITE EXISTS:
 * When rendering defects occur (such as transcript output bleeding past composer,
 * duplicated composer prompt rows, or footer clicks routed to the wrong component),
 * reproducing them as static fixture snapshots is brittle. This suite replays all
 * deterministic JSON test cases saved in the committed defect corpus against the
 * 12 formal composer defect oracles, and directly exercises the three known defect
 * classes that reached operators.
 *
 * WHAT THIS COVERS:
 * - Deterministic replay of all committed defect corpus cases in test/corpus/renderer-defect-oracle/
 * - Regression coverage for transcript bleed past boundary (Guarantee 2)
 * - Regression coverage for duplicate composer prompt (Guarantee 1)
 * - Regression coverage for footer mouse click routing (Guarantee 6)
 * - Strict assertion that every case passes all 12 composer defect oracles
 *
 * WHAT THIS DOES NOT COVER:
 * - Color theme palette values and non-Ghostty virtual terminal implementations.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme } from "../src/modes/theme/theme";
import {
	corpusStateToRunnerOptions,
	type RunnerOptions,
	runComposerOracleScenario,
} from "./helpers/composer-oracle-runner";
import { type CorpusCase, loadAllCorpusCases } from "./helpers/renderer-defect-corpus";

describe("renderer defect corpus replay", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	const cases: CorpusCase[] = loadAllCorpusCases();

	it("committed corpus contains test cases", () => {
		expect(cases.length).toBeGreaterThan(0);
	});

	// Replay each committed case
	for (const testCase of cases) {
		it(`replays corpus case ${testCase.id} [${testCase.failingOracle}] (${testCase.state.width}x${testCase.state.height}, trans=${testCase.state.transcriptLines})`, async () => {
			const options: RunnerOptions = corpusStateToRunnerOptions(testCase.state);
			const result = await runComposerOracleScenario(options);
			try {
				expect(
					result.evaluation.failures,
					`Corpus case ${testCase.id} failed oracles:\n${result.evaluation.failures.map(f => `[${f.oracle}] ${f.message}`).join("\n")}`,
				).toEqual([]);
			} finally {
				result.cleanUp();
			}
		});
	}

	describe("known defect classes regression scenarios", () => {
		it("defect class 1: output bleeding past composer boundary is prevented", async () => {
			// Deep transcript that exceeds viewport height with active scrolling
			const options: RunnerOptions = {
				width: 80,
				height: 12,
				transcriptLines: 100,
				editorText: "test command output",
				scrollIsolation: true,
				scrollOffset: 0,
			};

			const result = await runComposerOracleScenario(options);
			try {
				expect(result.evaluation.passed).toBe(true);
				expect(result.evaluation.failures).toEqual([]);

				// Explicitly verify hairline boundary separating transcript and composer
				const hairlineSeg = result.frameState.segments.find(s => s.componentName === "ComposerHairline");
				expect(hairlineSeg).toBeDefined();
				expect(hairlineSeg?.rowCount).toBe(1);

				// Pinned footer starts immediately at hairline
				const footerTop = result.frameState.screenBounds.footerTop;
				const hairlineScreenRow = hairlineSeg!.startIndex - result.frameState.windowTopRow;
				expect(hairlineScreenRow).toBe(footerTop);
			} finally {
				result.cleanUp();
			}
		});

		it("defect class 2: composer prompt is never duplicated on screen", async () => {
			// Multi-line code input in short viewport
			const options: RunnerOptions = {
				width: 40,
				height: 8,
				transcriptLines: 20,
				editorText: "line 1\nline 2\nline 3\nline 4\nline 5",
				scrollIsolation: true,
				scrollOffset: 2,
			};

			const result = await runComposerOracleScenario(options);
			try {
				expect(result.evaluation.passed).toBe(true);
				expect(result.evaluation.failures).toEqual([]);

				// Count prompt occurrences in viewport
				const promptRows = result.frameState.viewportLines
					.map((line, idx) => ({ line, idx }))
					.filter(({ line }) => line.includes("›") || line.includes("!"));

				// Must never have more than 1 prompt row
				expect(promptRows.length).toBeLessThanOrEqual(1);
			} finally {
				result.cleanUp();
			}
		});

		it("defect class 3: mouse clicks route to exact rendered footer zones without offset errors", async () => {
			const options: RunnerOptions = {
				width: 80,
				height: 24,
				transcriptLines: 15,
				editorText: "sample input",
				scrollIsolation: true,
			};

			const result = await runComposerOracleScenario(options);
			try {
				expect(result.evaluation.passed).toBe(true);
				expect(result.evaluation.failures).toEqual([]);

				// Verify routing map: footer rows route to footer components
				const routing = result.frameState.mouseRouting;
				expect(routing).toBeDefined();

				const { footerTop, footerBottom } = result.frameState.screenBounds;
				for (let r = footerTop; r <= footerBottom; r++) {
					const route = routing?.get(r);
					if (route?.routedTo) {
						expect(route.routedTo.startsWith("footer:")).toBe(true);
					}
				}
			} finally {
				result.cleanUp();
			}
		});
	});
});
