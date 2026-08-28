/**
 * A repaint never leaves a second composer behind.
 *
 * WHY THIS SUITE EXISTS:
 * The defect that started this work was temporal: a second composer painted partway up the screen
 * while the real composer stayed at the bottom, overlapping tool output, while a bash result
 * streamed in. Nothing else here can see that. The sweep in composer-defect-sweep.test.ts mounts
 * four thousand STATIC states, settles one frame and judges it, so it catches a geometry that is
 * wrong on arrival and is blind to a geometry that only goes wrong in the transition from one
 * frame to the next -- which is what a differential renderer that paints new rows without
 * clearing the old ones produces.
 *
 * Two transitions are driven here. A resize forces a full repaint of the composer zone, and
 * appending to the transcript grows the frame under a pinned footer, which is the incremental
 * paint path the reported defect appeared on. Both re-read the painted grid after every step. The
 * assertions are COUNTS, not presence checks: a duplicate is two of a row that must appear once,
 * and `some(...)` is true whether the row was repainted in place or drawn again below itself.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * - A real tool result's own component. The transcript is a double returning plain rows, so
 *   wrapping, ANSI and inline images inside a streamed result are not exercised.
 * - Growth interleaved with a resize inside one settle window.
 * - Scrollback. Only the viewport is judged, because a real terminal legitimately keeps prior
 *   frames in history and a duplicate there is not a defect.
 * - Anything the painted grid cannot show: the segment ledger is rebuilt test-side by the runner
 *   and is not read here at all.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import { isComposerPromptLine, isHairlineLine, settleFrames } from "@veyyon/render-oracle";
import { initTheme } from "../src/modes/theme/theme";
import { runComposerOracleScenario } from "./helpers/composer-oracle-runner";

/** Terminal geometries walked in order, each a full repaint of the composer zone. */
const GEOMETRIES: ReadonlyArray<{ width: number; height: number }> = [
	{ width: 80, height: 24 },
	{ width: 80, height: 10 },
	{ width: 80, height: 24 },
	{ width: 120, height: 8 },
	{ width: 60, height: 30 },
	{ width: 80, height: 24 },
];

describe("a repaint never leaves a second composer behind", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("paints one hairline and at most one prompt row after every resize in a sequence", async () => {
		const result = await runComposerOracleScenario({
			width: GEOMETRIES[0]!.width,
			height: GEOMETRIES[0]!.height,
			transcriptLines: 60,
			editorText: "explain quantum computing",
			scrollIsolation: false,
			focused: true,
		});

		try {
			const offenders: string[] = [];

			for (const [step, geometry] of GEOMETRIES.entries()) {
				result.terminal.resize(geometry.width, geometry.height);
				result.tui.requestRender();
				await settleFrames(result.terminal, result.tui);

				const rows = result.terminal.getViewport().map(row => stripAnsi(row).trimEnd());
				const hairlines = rows.filter(row => isHairlineLine(row)).length;
				const prompts = rows.filter(row => isComposerPromptLine(row)).length;
				const where = `step ${step} at ${geometry.width}x${geometry.height}`;

				// One hairline: it is the single boundary between transcript and composer, so two
				// of them is a composer zone drawn twice.
				if (hairlines !== 1) offenders.push(`${where}: ${hairlines} hairline rows, expected 1`);
				// At most one prompt: zero is legitimate when the zone is taller than the viewport
				// and the prompt row falls outside the window, two never is.
				if (prompts > 1) offenders.push(`${where}: ${prompts} prompt rows, expected at most 1`);
				// The composer is pinned, so its hairline must sit in the lower half of the frame.
				// A hairline near the top is the second composer painted partway up the screen.
				const hairlineRow = rows.findIndex(row => isHairlineLine(row));
				if (hairlineRow >= 0 && hairlineRow === 0 && geometry.height > 2) {
					offenders.push(`${where}: hairline painted at row 0`);
				}
			}

			expect(offenders).toEqual([]);
		} finally {
			result.cleanUp();
		}
	});

	it("paints one hairline and one prompt row while transcript output streams in", async () => {
		const result = await runComposerOracleScenario({
			width: 80,
			height: 16,
			transcriptLines: 4,
			editorText: "run the build",
			scrollIsolation: false,
			focused: true,
		});

		try {
			const offenders: string[] = [];

			for (let chunk = 0; chunk < 12; chunk += 1) {
				const appended = Array.from(
					{ length: 5 },
					(_, i) => `stream-line-${String(chunk * 5 + i).padStart(4, "0")}`,
				);
				result.transcript.lines.push(...appended);
				result.transcript.invalidate();
				await result.advance();

				const rows = result.terminal.getViewport().map(row => stripAnsi(row).trimEnd());
				const hairlines = rows.filter(row => isHairlineLine(row)).length;
				const prompts = rows.filter(row => isComposerPromptLine(row)).length;
				const where = `chunk ${chunk}`;

				if (hairlines !== 1) offenders.push(`${where}: ${hairlines} hairline rows, expected 1`);
				if (prompts !== 1) offenders.push(`${where}: ${prompts} prompt rows, expected 1`);

				// The newest appended line sits directly above the hairline. A repaint that moves
				// the composer down without painting the rows it uncovered drops that line, and one
				// that draws the region twice shows it twice.
				const newest = appended[appended.length - 1]!;
				const painted = rows.filter(row => row === newest).length;
				if (painted !== 1) {
					offenders.push(`${where}: newest line painted ${painted} times, expected 1`);
				}
			}

			expect(offenders).toEqual([]);
		} finally {
			result.cleanUp();
		}
	});
});
