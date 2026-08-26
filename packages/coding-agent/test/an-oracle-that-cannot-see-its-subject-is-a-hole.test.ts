/**
 * An oracle that cannot see its subject is a hole.
 *
 * WHY THIS SUITE EXISTS:
 * Two defects found on the same day shared one shape, and neither failed anything. The padding
 * oracle located a CardPadRow with the live-tail row mapping, so on a deeply scrolled-back frame it
 * computed a row past the end of the viewport, the bounds check dropped it, and the oracle returned
 * clean without inspecting a row. The bleed oracle recognises a transcript row by substring, and the
 * runner hardcoded the substring its own generated rows carry, so a mount supplying flavoured
 * content was judged by an oracle that could not match any of its rows and returned clean without
 * inspecting one either.
 *
 * A wrong answer is eventually investigated. An oracle that inspects nothing reports success, and a
 * sweep of 4200 states reports success too, at whatever fraction of the grid its inputs let it
 * reach. So the interesting question is not only whether an oracle passes: it is whether the thing
 * it judges was on screen at all.
 *
 * WHAT IT ASSERTS:
 * For every flavour, in a state whose transcript is definitely visible, the marker the mount
 * declares must match a row of the painted grid. That is the precondition for the bleed oracle to
 * mean anything, and it is asserted per flavour so a flavour whose marker stops matching after a
 * content change is named rather than averaged away. The flavour list is read from `FLAVORS` at run
 * time, so adding a flavour without adding its marker turns this suite red.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * - Whether the bleed oracle's judgement is correct once it can see a row. It proves the oracle has
 *   a subject, not that the verdict on that subject is right.
 * - An oracle whose subject is absent because the renderer failed to paint it. A missing row and an
 *   unrecognisable row look the same from here, which is why the assertion is on the marker
 *   matching rather than on a count of rows.
 * - The other nine oracles' preconditions. Only the two that were found blind are covered.
 *
 * MUTATION GATE:
 * Returning the marker set to the hardcoded `["transcript-output-line-"]` in the runner turns five
 * of the six flavour cases red, naming each flavour and its unmatched marker; `plain` stays green,
 * which is exactly why the hole survived. Recorded results are in the commit that added this file.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import { initTheme } from "../src/modes/theme/theme";
import { runComposerOracleScenario } from "./helpers/composer-oracle-runner";
import { contentLines, FLAVOR_MARK, FLAVORS } from "./helpers/renderer-differential";

describe("an oracle that cannot see its subject is a hole", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it.each([...FLAVORS])(
		"declares a transcript marker the painted grid actually carries: %s",
		async flavor => {
			// A transcript longer than the viewport, so rows are on screen whatever the composer's
			// height works out to.
			const scenario = await runComposerOracleScenario({
				width: 80,
				height: 24,
				transcriptLines: contentLines(flavor, 40),
				transcriptLineMarkers: [FLAVOR_MARK[flavor]],
				editorText: "run the build",
				scrollIsolation: true,
			});
			try {
				const marker = scenario.frameState.transcriptLineMarkers?.[0];
				expect(marker).toBe(FLAVOR_MARK[flavor]);

				const grid = scenario.frameState.rawViewportLines.map(line => stripAnsi(line));
				const matched = grid.filter(line => line.includes(marker!)).length;
				expect(
					matched,
					`flavour ${flavor}: marker ${JSON.stringify(marker)} matched no painted row, so the bleed oracle inspects nothing. Grid: ${JSON.stringify(grid.slice(0, 4))}`,
				).toBeGreaterThan(0);

				// The state is painted correctly, so no oracle should be complaining either. This
				// pins that supplying a real marker does not start reporting false bleed.
				expect(scenario.evaluation.failures ?? []).toEqual([]);
			} finally {
				scenario.cleanUp();
			}
		},
		120_000,
	);

	it("leaves the default marker matching the rows the runner generates on its own", async () => {
		// The default exists for a mount that does not supply content. If the generated row
		// spelling and the default marker ever drift apart, every suite relying on the default
		// goes blind at once, and nothing else would say so.
		const scenario = await runComposerOracleScenario({
			width: 80,
			height: 24,
			transcriptLines: 40,
			editorText: "run the build",
			scrollIsolation: true,
		});
		try {
			const marker = scenario.frameState.transcriptLineMarkers?.[0];
			expect(marker).toBe("transcript-output-line-");
			const grid = scenario.frameState.rawViewportLines.map(line => stripAnsi(line));
			expect(grid.filter(line => line.includes(marker!)).length).toBeGreaterThan(0);
		} finally {
			scenario.cleanUp();
		}
	}, 120_000);
});
