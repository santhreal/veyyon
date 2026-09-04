/**
 * The composer owns the bottom rows of the terminal, and it is drawn exactly once.
 *
 * WHY THIS SUITE EXISTS:
 * A second composer was painted partway up the screen while the real composer stayed at the
 * bottom, overlapping tool output, while a bash result streamed in. These three scenarios drive
 * the real composer zone through a virtual terminal and assert the guarantees that defect broke:
 * the hairline is the boundary between transcript and composer, the prompt is drawn once, and a
 * click anywhere inside the footer reaches a footer component.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * - Bleed of real transcript content. The bleed oracles key on the synthetic marker
 *   `transcript-output-line-` that the runner emits (helpers/composer-oracle-runner.ts), so a
 *   real bash result or diff carries no prefix they recognize. They constrain the frame
 *   geometry, not production content.
 * - Anything outside three fixed terminal geometries. The state space is swept in
 *   composer-defect-sweep.test.ts; these are the named defects that reached an operator.
 * - Colour, styling, image protocols, and non-Ghostty terminal emulators.
 * - A scrolled-back state whose transcript is shorter than the viewport. The oracles locate a
 *   component's screen row as `segment.startIndex - windowTopRow` against a ledger the runner
 *   rebuilds, and that subtraction does not hold when scrollback is requested with nothing to
 *   scroll: oracle 9 then reports the capability line as a padding row. The sweep never reaches
 *   it either, because it couples scrollOffset to `transcriptCount > height`, so the combination
 *   is unswept rather than proven.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { isComposerPromptLine, isHairlineLine } from "../src/modes/terminal/components/composer/composer-defect-oracle";
import { initTheme } from "../src/theme/theme";
import { type RunnerOptions, type RunnerResult, runComposerOracleScenario } from "./helpers/composer-oracle-runner";

/** Prompt rows on the painted grid, counted through the oracle's own prompt predicate. */
const countPromptRows = (result: RunnerResult): number =>
	result.frameState.viewportLines.filter(line => isComposerPromptLine(line, result.frameState.expectedPromptGlyph))
		.length;

describe("the composer owns the bottom rows and appears once", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("separates transcript from composer with a hairline on one row, on the grid and in the ledger", async () => {
		// Transcript deeper than the viewport, so the frame is longer than the screen.
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
			expect(result.evaluation.failures).toEqual([]);

			const hairline = result.frameState.segments.find(s => s.componentName === "ComposerHairline");
			expect(hairline?.rowCount).toBe(1);

			// The hairline is the first footer row on the painted grid AND on the segment ledger.
			// Checking only the painted row lets a ledger that points elsewhere pass, and the
			// ledger is what mouse hit-testing reads, so the two disagreeing is the defect.
			const { footerTop } = result.frameState.screenBounds;
			expect((hairline?.startIndex ?? -1) - result.frameState.windowTopRow).toBe(footerTop);
			expect(isHairlineLine(result.frameState.viewportLines[footerTop] ?? "")).toBe(true);
		} finally {
			result.cleanUp();
		}
	});

	it("draws one composer prompt row when it is in the window, and never a second", async () => {
		// A roomy viewport in live tail, where the composer prompt is on screen and must be there
		// exactly once. Deliberately not a scrolled-back state: asking for scrollOffset 2 with a
		// transcript shorter than the viewport is a state with nothing to scroll, and the ledger
		// row mapping the oracles use does not hold there, as recorded in the header above.
		const roomy = await runComposerOracleScenario({
			width: 80,
			height: 24,
			transcriptLines: 60,
			editorText: "line 1\nline 2",
			scrollIsolation: false,
			scrollOffset: 0,
		});
		try {
			expect(roomy.evaluation.failures).toEqual([]);
			expect(countPromptRows(roomy)).toBe(1);
		} finally {
			roomy.cleanUp();
		}

		// A viewport too short for the composer zone, which is where the duplicate was seen. The
		// prompt row is pushed out of the window here, so zero is correct and two never is: the
		// guarantee is uniqueness, and `<= 1` would also accept the composer having vanished.
		const tight = await runComposerOracleScenario({
			width: 40,
			height: 8,
			transcriptLines: 20,
			editorText: "line 1\nline 2\nline 3\nline 4\nline 5",
			scrollIsolation: true,
			scrollOffset: 2,
		});
		try {
			expect(tight.evaluation.failures).toEqual([]);
			expect(countPromptRows(tight)).toBeLessThanOrEqual(1);
		} finally {
			tight.cleanUp();
		}
	});

	it("never dispatches a footer click to the transcript, or a transcript click to the footer", async () => {
		const options: RunnerOptions = {
			width: 80,
			height: 24,
			transcriptLines: 15,
			editorText: "sample input",
			scrollIsolation: true,
		};

		const result = await runComposerOracleScenario(options);
		try {
			expect(result.evaluation.failures).toEqual([]);

			// A footer row that dispatches to nothing is inert chrome -- the hairline, the padding
			// rows and the status line take no clicks -- so a null route is correct. A footer row
			// that reaches the TRANSCRIPT is the offset defect, and so is a transcript row that
			// reaches the footer. Those two are what this asserts, over every probed row.
			const { footerTop, footerBottom } = result.frameState.screenBounds;
			const routing = result.frameState.mouseRouting ?? new Map();
			const footerLeaks: Array<{ row: number; routedTo: string }> = [];
			const transcriptLeaks: Array<{ row: number; routedTo: string }> = [];
			for (const [row, route] of routing) {
				if (!route.routedTo) continue;
				const inFooter = row >= footerTop && row <= footerBottom;
				if (inFooter && !route.routedTo.startsWith("footer:")) {
					footerLeaks.push({ row, routedTo: route.routedTo });
				}
				if (!inFooter && route.routedTo.startsWith("footer:")) {
					transcriptLeaks.push({ row, routedTo: route.routedTo });
				}
			}

			expect(footerLeaks).toEqual([]);
			expect(transcriptLeaks).toEqual([]);

			// The oracle only judges rows the harness probed, so an unprobed footer row is an
			// unchecked one. Every footer row must be in the map for a pass to mean anything.
			const unprobed: number[] = [];
			for (let row = footerTop; row <= footerBottom; row += 1) {
				if (!routing.has(row)) unprobed.push(row);
			}
			expect(unprobed).toEqual([]);
		} finally {
			result.cleanUp();
		}
	});
});
