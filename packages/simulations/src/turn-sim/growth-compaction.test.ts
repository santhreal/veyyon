/**
 * Compaction reached by ORDINARY GROWTH, on a model whose window is small.
 *
 * Every other compaction scenario here crosses the threshold with one oversized
 * prompt, which takes the pre-prompt path. This file takes the other one: a
 * session that grows a few thousand tokens per turn until the post-turn check
 * fires. That arm was broken and nothing in the suite could see it, because the
 * failure was not "no trigger" but "every candidate refused": the summarization
 * request asked for an output budget derived from the absolute reserve, the
 * estimate for history-plus-budget exceeded the whole window, admission skipped
 * the only candidate, and the session kept growing past its window while a
 * warning repeated once per turn.
 *
 * RED PROOFS, observed rather than predicted. Restoring the unbounded budget
 * (`Math.floor(0.8 * reserveTokens)` in `buildSummaryPrompt`) reds both rows: the
 * growth row sees six turns with no compaction entry and a used-token count past
 * the window, and the refusal row sees four `auto_compaction_end` events whose
 * `errorMessage` reads "holds 16000 tokens and the summary needed 23418".
 *
 * What this does NOT catch: whether the summary is any good at that budget. A
 * small window buys a shorter summary, and no simulation can judge its content.
 */

import { afterEach, expect, it } from "bun:test";
import { createSimulation, type Simulation, simTool } from "./harness";

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

/**
 * A small window with compaction on and an explicit trigger, so the crossing
 * happens through accumulation rather than through one prompt. `remote: false`
 * keeps the summarizer a request this simulation can see and count.
 */
const SMALL_WINDOW_COMPACTING = {
	"compaction.enabled": true,
	"compaction.thresholdTokens": 12_000,
	"compaction.keepRecentTokens": 2_000,
	"compaction.remote": false,
} as const;

const CONTEXT_WINDOW = 16_000;

/** Registered so a live turn is never mistaken for the summarizer, which sends no tools. */
const WORK = simTool("work", async () => ({ content: [{ type: "text", text: "tool output" }] }));

/** About 2500 tokens per round, so the threshold is crossed on the fifth. */
const ASK = `ask. ${"user chunk. ".repeat(500)}`;

async function growUntilCompacted(rounds: number): Promise<{ summarizerCalls: number }> {
	let summarizerCalls = 0;
	sim = await createSimulation({
		model: { contextWindow: CONTEXT_WINDOW },
		settings: { ...SMALL_WINDOW_COMPACTING },
		tools: [WORK],
		script: turn => {
			if ((turn.context.tools?.length ?? 0) === 0) {
				summarizerCalls += 1;
				turn.text("SUMMARY-OF-THE-EARLY-ROUNDS");
				turn.finish();
				return;
			}
			turn.usage({ input: 400, output: 40 });
			turn.text(`answer ${turn.call} ${"reply chunk. ".repeat(300)}`);
			turn.finish();
		},
	});
	for (let round = 1; round <= rounds; round += 1) {
		await sim.session.prompt(`${ASK} round ${round}`);
	}
	return { summarizerCalls };
}

it("compacts a session that grew into its threshold one turn at a time", async () => {
	const { summarizerCalls } = await growUntilCompacted(6);
	const session = sim?.session;
	if (!session || !sim) throw new Error("simulation missing");

	const compactions = sim.sessionManager.getEntries().filter(entry => entry.type === "compaction");
	// One summarizer call, one compaction entry: the accumulated arm fired once and
	// did not thrash once it was back under the bar.
	expect({ summarizerCalls, compactions: compactions.length }).toEqual({ summarizerCalls: 1, compactions: 1 });

	// And it actually shrank the context. A trigger that fires without freeing
	// anything is the failure this row exists to catch.
	const used = session.getContextBreakdown()?.usedTokens ?? 0;
	expect(used).toBeLessThan(CONTEXT_WINDOW);
	expect(used).toBeLessThan(12_000);
});

it("makes a summarization request the small model can hold", async () => {
	await growUntilCompacted(6);
	if (!sim) throw new Error("simulation missing");

	const ends = sim.eventsOfType("auto_compaction_end");
	// A refused candidate ends the compaction with a reason and no result, and it
	// is what the operator sees as a warning every single turn.
	expect(ends.map(end => end.errorMessage).filter(message => message !== undefined)).toEqual([]);
	expect(ends.length).toBe(1);
	expect(ends[0]?.result?.summary).toBe("SUMMARY-OF-THE-EARLY-ROUNDS");
});
