/**
 * Editing a message the provider has already cached forfeits every prefix behind
 * it. Appending to the end forfeits nothing. On a long agentic run those two
 * outcomes differ by the entire history.
 *
 * WHY THIS FILE EXISTS. This is the shape that costs the most in practice, and it
 * is the one least visible in code review, because the edit that causes it always
 * looks like an improvement: strip the thinking blocks to save tokens, renumber a
 * tool-call id, re-serialize a tool result more compactly, drop an image that is
 * no longer needed, normalize whitespace in replayed output. Every one of those
 * shrinks the prompt and every one of them rewrites bytes the provider is holding,
 * which forfeits the cached prefix from the edit onward and bills it as a write —
 * at 1.25x or 2.0x the base price, against a read price of 0.1x. The saving is
 * measured in the tokens removed; the loss is measured in the tokens that follow
 * them, and on turn 200 of an agentic run there is no comparison.
 *
 * Measured, from local transcripts rather than assumed: of the cache misses that
 * occur less than thirty seconds after a hit — too fast to be expiry — the
 * dominant class is exactly this one. The system-and-tools token count is
 * unchanged, the prompt grew, and the prefix still missed. It accounts for more
 * lost tokens than expiry, compaction and system-prompt churn combined.
 *
 * So the invariant is asserted at the choke point every such edit passes through —
 * "were the bytes under the previous request's deepest marker preserved" — rather
 * than once per plausible edit, because the long tail of edits is what has always
 * survived a per-site test.
 *
 * WHAT THIS DOES NOT CATCH.
 *   - A rewrite that a provider tolerates. None of them do, but the model here
 *     assumes byte-exactness rather than deriving it, so a provider that started
 *     matching fuzzily would make this file pessimistic and nothing would say so.
 *   - Compaction, which rewrites history deliberately and is supposed to pay this
 *     cost once in exchange for a shorter prompt. Telling a legitimate rewrite
 *     from an accidental one is not a wire-level property and is not attempted.
 *
 * RED PROOFS, observed rather than predicted.
 *   - the rewrite made to the LAST message instead of an early one: the forfeiture
 *     row reds, which is what says the row is about position and not about any
 *     edit at all.
 *   - the cache model's key changed from the prefix bytes to the prefix length:
 *     the forfeiture row reds while the append row stays green, so the append row
 *     is not passing because the model is insensitive to content.
 */
import { describe, expect, it } from "bun:test";
import { conversationAfter, PRODUCTION, padding, runArm, type Step, systemPrompt } from "./harness";

/** Tool results big enough that the history, not the system prompt, is the prompt. */
const BODY_TOKENS = 3_000;
const TURNS = 5;
const GAP_MS = 15_000;

function body(index: number): string {
	return `step ${index} output\n${padding(BODY_TOKENS)}`;
}

/**
 * A healthy run: every turn appends, and every earlier byte is preserved. This is
 * the control, and its numbers are what the rewrite is compared against.
 */
function appendOnly(): Step[] {
	const steps: Step[] = [];
	for (let turn = 1; turn <= TURNS; turn++) {
		steps.push({
			context: { systemPrompt: systemPrompt(), messages: conversationAfter(turn, body) },
			gapMs: turn === 1 ? 0 : GAP_MS,
		});
	}
	return steps;
}

/**
 * The same run, except the final turn also rewrites the output of step 2 — deep
 * inside content the provider has been serving from cache for four turns.
 *
 * The edit preserves byte LENGTH (one word re-cased), so the prompt is exactly the
 * size it would have been. That is deliberate: it removes the only innocent
 * explanation for a cost difference, and it is the honest shape of the edits that
 * cause this in practice — a re-serialization or a whitespace normalization, which
 * changes bytes without changing how much there is of them.
 */
function rewritesAnEarlyStep(): Step[] {
	const steps = appendOnly();
	const rewritten = (index: number) => (index === 2 ? body(index).replace("pad ", "PAD ") : body(index));
	steps[steps.length - 1] = {
		context: { systemPrompt: systemPrompt(), messages: conversationAfter(TURNS, rewritten) },
		gapMs: GAP_MS,
	};
	return steps;
}

/**
 * And a rewrite of the NEWEST step, which sits past the previous request's
 * deepest marker and therefore costs nothing. This is the negative control that
 * makes the assertion about position rather than about editing.
 */
function rewritesTheNewestStep(): Step[] {
	const steps = appendOnly();
	const rewritten = (index: number) => (index === TURNS ? body(index).replace("pad ", "PAD ") : body(index));
	steps[steps.length - 1] = {
		context: { systemPrompt: systemPrompt(), messages: conversationAfter(TURNS, rewritten) },
		gapMs: GAP_MS,
	};
	return steps;
}

describe("rewriting content the provider already cached", () => {
	it("forfeits the history behind the edit, on bytes it had been reading for four turns", async () => {
		const healthy = await runArm(PRODUCTION, appendOnly());
		const rewritten = await runArm(PRODUCTION, rewritesAnEarlyStep());

		const healthyLast = healthy.turns[TURNS - 1];
		const rewrittenLast = rewritten.turns[TURNS - 1];

		// The turn reads far less and writes far more, for a prompt of the same size.
		expect(rewrittenLast.promptTokens).toBe(healthyLast.promptTokens);
		expect(rewrittenLast.read).toBeLessThan(healthyLast.read);
		expect(rewrittenLast.write).toBeGreaterThan(healthyLast.write);
		// And the loss is the history, not a rounding error: at least the four steps
		// of output that preceded the edit.
		expect(healthyLast.read - rewrittenLast.read).toBeGreaterThan(3 * BODY_TOKENS);
	});

	it("costs more for one edit than the whole healthy run saved by appending", async () => {
		const healthy = await runArm(PRODUCTION, appendOnly());
		const rewritten = await runArm(PRODUCTION, rewritesAnEarlyStep());

		expect(rewritten.cost).toBeGreaterThan(healthy.cost);
		// The single edited turn is the entire difference: every earlier turn is
		// byte-identical across the two runs.
		const delta = rewritten.cost - healthy.cost;
		const editedTurnDelta = rewritten.turns[TURNS - 1].cost - healthy.turns[TURNS - 1].cost;
		expect(delta).toBeCloseTo(editedTurnDelta, 6);
	});

	it("charges nothing extra for rewriting content past the last marker", async () => {
		const healthy = await runArm(PRODUCTION, appendOnly());
		const newest = await runArm(PRODUCTION, rewritesTheNewestStep());

		expect(newest.turns[TURNS - 1].read).toBe(healthy.turns[TURNS - 1].read);
	});

	/**
	 * The shape guard: if the fixture ever stopped being history-dominant, the rows
	 * above would still pass while measuring almost nothing, because a forfeited
	 * history that is smaller than the system prompt is not the defect class this
	 * file is named for.
	 */
	it("measures a prompt whose bytes are mostly history", async () => {
		const healthy = await runArm(PRODUCTION, appendOnly());
		const last = healthy.turns[TURNS - 1];

		expect(last.promptTokens).toBeGreaterThan(4 * BODY_TOKENS);
		expect(healthy.misses).toBe(0);
	});
});
