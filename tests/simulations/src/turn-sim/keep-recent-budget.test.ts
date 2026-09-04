/**
 * What `compaction.keepRecentTokens` buys, measured on the wire.
 *
 * WHY THIS FILE EXISTS. `compaction-crossings.test.ts` proves a compaction fires
 * and that the request after it is still well paired, and says in its own header
 * that how much survived is out of scope. That leaves the operator's own budget
 * unobserved end to end: it is the one compaction number a user sets expecting a
 * visible amount of conversation to stay, and between the setting and the cut it
 * passes a window ceiling, a provider-vs-estimate ratio and a cut-point search,
 * each of which can quietly reduce it to nothing. A budget that buys the same
 * tail whatever it says is indistinguishable from a dead knob, and a budget that
 * cuts inside the exchange that just finished is worse than no compaction at all.
 *
 * HOW IT IS OBSERVED. Every round sends a uniquely marked prompt, so the request
 * that follows the compaction names exactly which rounds survived. The threshold
 * is a fixed token count rather than `auto`, which keeps the window ceiling out
 * of the measurement: an absolute trigger is a trigger the operator stated.
 *
 * RED PROOFS, observed rather than predicted.
 *   - Pinning the budget to a constant in `prepareCompaction`
 *     (`keepRecentTokens = 2000` instead of `settings.keepRecentTokens`) reds
 *     BOTH rows: the sweep keeps 4 rounds at every budget, so the knob is dead,
 *     and the split-turn row loses its second summarization because a pinned
 *     2000 never needs a split.
 *   - Disabling the split-turn arm alone (`if (false && isSplitTurn && ...)`)
 *     reds only the second row, with one summarization where two are due.
 *
 * NOT asserted: the summary's content, and the token savings. The engine owns
 * both, and neither is what an operator reads this setting as promising. The
 * provider-vs-estimate ratio that also scales the budget is out of scope too: a
 * simulation can only reach it by reporting a prompt count far above the
 * conversation, which moves the trigger as well as the budget, so a row built on
 * it would not be measuring the budget any more.
 */

import { afterEach, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { createSimulation, type Simulation, simTool } from "./harness";
import { describeViolations, pairingViolations } from "./invariants";

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

/** Registered by every simulation here, so a live turn is never mistaken for the summarizer. */
const WORK = simTool("work", async () => ({ content: [{ type: "text", text: "tool output" }] }));

const CONTEXT_WINDOW = 64_000;
/** A stated trigger, so the window ceiling never enters the measurement. */
const THRESHOLD = "12000";
/** About 700 tokens of prompt per round, so a budget of N keeps roughly N/700 rounds. */
const FILLER = "filler word ".repeat(230);
const ROUNDS = 24;

function textOf(messages: readonly AgentMessage[]): string {
	return messages
		.map(message => {
			const content = (message as { content?: unknown }).content;
			if (typeof content === "string") return content;
			const blocks = Array.isArray(content) ? content : [];
			return blocks.map(block => (block as { text?: string }).text ?? "").join(" ");
		})
		.join("\n");
}

interface CompactedRun {
	/** Round numbers still present in the first request sent after the compaction. */
	keptMarkers: number[];
	/** That request's messages, so a row can judge pairing on the real wire shape. */
	outboundAfter: AgentMessage[];
	/** One per summarization request the compaction issued, in call order. */
	summarizerTexts: string[];
	/** The stored summary of every compaction entry on the branch. */
	entrySummaries: string[];
}

/**
 * Grow a session one marked round at a time until the fixed threshold fires,
 * then send one more prompt and report what that request carried.
 */
async function runUntilCompacted(keepRecentTokens: number): Promise<CompactedRun> {
	const summarizerTexts: string[] = [];
	const outbound: AgentMessage[][] = [];
	sim = await createSimulation({
		model: { contextWindow: CONTEXT_WINDOW },
		settings: {
			"compaction.enabled": true,
			"compaction.threshold": THRESHOLD,
			"compaction.keepRecentTokens": keepRecentTokens,
			"compaction.remote": false,
		},
		tools: [WORK],
		script: turn => {
			if ((turn.context.tools?.length ?? 0) === 0) {
				// Distinct per call: a split turn issues two summarizations and merges
				// them, and an identical text could not tell a merge from a repeat.
				const text = `SUMMARY-PART-${summarizerTexts.length + 1}`;
				summarizerTexts.push(text);
				turn.text(text);
				turn.finish();
				return;
			}
			outbound.push([...turn.context.messages]);
			turn.usage({ input: 400, output: 40 });
			turn.text(`answer ${turn.call}`);
			turn.finish();
		},
	});

	for (let round = 1; round <= ROUNDS; round += 1) {
		await sim.session.prompt(`MARKER-${round}-OPEN ${FILLER}`);
		if (summarizerTexts.length > 0) break;
	}
	if (summarizerTexts.length === 0) {
		throw new Error(`no compaction after ${ROUNDS} rounds: the fixture never reached it`);
	}

	await sim.session.prompt("MARKER-FINAL-QUESTION");
	const outboundAfter = outbound.at(-1) ?? [];
	const body = textOf(outboundAfter);
	const keptMarkers: number[] = [];
	for (let round = 1; round <= ROUNDS; round += 1) {
		if (body.includes(`MARKER-${round}-OPEN`)) keptMarkers.push(round);
	}
	const entrySummaries = sim.sessionManager
		.getEntries()
		.filter(entry => entry.type === "compaction")
		.map(entry => entry.summary);
	return { keptMarkers, outboundAfter, summarizerTexts, entrySummaries };
}

it("keeps more of the conversation the larger the budget is, and never less", async () => {
	const budgets = [1_000, 3_000, 6_000];
	const runs: Array<{ budget: number; kept: number }> = [];
	for (const budget of budgets) {
		const run = await runUntilCompacted(budget);
		runs.push({ budget, kept: run.keptMarkers.length });
		await sim?.dispose();
		sim = undefined;
	}

	// Non-vacuity in both directions: the smallest budget must drop something,
	// or nothing was cut and every comparison below is about an uncompacted
	// session, and the largest must keep something, or the setting buys nothing
	// at any value and the sweep would read as monotonic while being dead.
	expect(runs[0]?.kept).toBeLessThan(ROUNDS);
	expect(runs.at(-1)?.kept).toBeGreaterThan(0);

	// The knob moves the tail: never backwards as the budget grows, and strictly
	// forwards between the ends of the sweep.
	const kept = runs.map(run => run.kept);
	expect(kept).toEqual([...kept].sort((a, b) => a - b));
	expect(kept.at(-1)).toBeGreaterThan(kept[0] ?? 0);
});

it("splits the turn rather than cutting inside it when the budget is smaller than one exchange", async () => {
	// One token is less than any exchange costs, so a budget-obedient cut would
	// land inside the turn that just finished: an answer to a question the model
	// can no longer see, or a result whose call is gone. The engine takes the
	// split-turn path instead, which summarizes the turn prefix alongside the
	// history and merges both into ONE entry.
	const run = await runUntilCompacted(1);

	// Two summarizations, one entry. This is what the split path costs, stated
	// here so a future run that pays twice for an ORDINARY compaction is a
	// change in this row rather than an unremarked bill.
	expect(run.summarizerTexts).toEqual(["SUMMARY-PART-1", "SUMMARY-PART-2"]);
	expect(run.entrySummaries).toHaveLength(1);

	// Both halves survive the merge, and the merged text says it is a split turn.
	// Losing either half loses exactly the span the operator's budget was too
	// small to keep, which is the whole reason the second request was paid for.
	const stored = run.entrySummaries[0] ?? "";
	expect(stored).toContain("SUMMARY-PART-1");
	expect(stored).toContain("SUMMARY-PART-2");
	expect(stored).toContain("split turn");

	// The wire shape is intact: an unpaired call is what a provider rejects
	// outright, which is the failure a too-small budget could produce here.
	const body = textOf(run.outboundAfter);
	expect(body).toContain("MARKER-FINAL-QUESTION");
	expect(
		describeViolations("the request after a split-turn compaction", pairingViolations(run.outboundAfter)),
	).toEqual([]);
});
