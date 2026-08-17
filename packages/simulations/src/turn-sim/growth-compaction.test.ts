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
import { bulkProse, createSimulation, type Simulation, simTool } from "./harness";

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

const TURN_INPUT_TOKENS = 400;
const TURN_OUTPUT_TOKENS = 40;

async function growUntilCompacted(
	rounds: number,
	options: { persist?: boolean } = {},
): Promise<{ summarizerCalls: number; spendPerRound: Array<{ input: number; cost: number }> }> {
	let summarizerCalls = 0;
	sim = await createSimulation({
		persist: options.persist,
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
			turn.usage({ input: TURN_INPUT_TOKENS, output: TURN_OUTPUT_TOKENS });
			turn.text(`answer ${turn.call} ${bulkProse(520, `round${turn.call}`)}`);
			turn.finish();
		},
	});
	const spendPerRound: Array<{ input: number; cost: number }> = [];
	for (let round = 1; round <= rounds; round += 1) {
		await sim.session.prompt(`${ASK} round ${round}`);
		const stats = sim.session.getSessionStats();
		spendPerRound.push({ input: stats.tokens.input, cost: stats.cost });
	}
	return { summarizerCalls, spendPerRound };
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

/**
 * Spend is not a view of the context. Compaction replaces history, so a total
 * summed over the live context alone falls when a session compacts: `/session`
 * reports less than the operator paid, and goal mode reads the same total as its
 * token budget, so a run that compacts buys its budget back.
 *
 * RED PROOF, observed: summing `this.state.messages` instead of the stored branch
 * in `getSessionStats` reds this row, with input falling 1600 -> 800 on the round
 * that compacts.
 */
it("never un-spends a token when the history is summarized away", async () => {
	const { summarizerCalls, spendPerRound } = await growUntilCompacted(6);
	if (!sim) throw new Error("simulation missing");

	const decreases = spendPerRound.filter(
		(round, index) =>
			index > 0 && (round.input < spendPerRound[index - 1].input || round.cost < spendPerRound[index - 1].cost),
	);
	expect(decreases).toEqual([]);

	// Exactly the live turns, priced once each. The summarizer's own request is a
	// side request and is deliberately not in this total (telemetry owns
	// provider-level spend), so the arithmetic names it rather than hiding it.
	const liveTurns = sim.providerCalls() - summarizerCalls;
	expect(sim.session.getSessionStats().tokens.input).toBe(liveTurns * TURN_INPUT_TOKENS);
	expect(sim.session.getSessionStats().tokens.output).toBe(liveTurns * TURN_OUTPUT_TOKENS);
});

/**
 * A resume reads the same stored branch, so the total it reports is the same one.
 *
 * What this does NOT catch: the reader itself. Both sides call `getSessionStats`,
 * so a reader that drops the summarized range drops it identically here and this
 * row stays green; the row above is what pins the total. This one catches a resume
 * whose branch is not the one that was written.
 */
it("reports the same spend after a compacted session is reopened", async () => {
	const { spendPerRound } = await growUntilCompacted(6, { persist: true });
	if (!sim) throw new Error("simulation missing");
	const before = sim.session.getSessionStats();
	const lastRound = spendPerRound[spendPerRound.length - 1];
	expect(before.tokens.input).toBe(lastRound.input);

	const reopened = await sim.reopen();
	try {
		const after = reopened.session.getSessionStats();
		expect({ input: after.tokens.input, output: after.tokens.output, cost: after.cost }).toEqual({
			input: before.tokens.input,
			output: before.tokens.output,
			cost: before.cost,
		});
	} finally {
		await reopened.dispose();
	}
});
