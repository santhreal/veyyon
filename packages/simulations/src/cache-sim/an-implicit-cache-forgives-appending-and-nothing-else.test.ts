/**
 * On a Codex-family request there is nothing to place. `prompt_cache_key` is the
 * only anchor the surface accepts, so the entire lever a caller holds is whether
 * the bytes before the newest item are the same bytes as last turn — and whether
 * the key is the same key.
 *
 * WHY THIS FILE EXISTS. The Anthropic half of this family argues about breakpoint
 * depth, and the local corpus says that argument is the small one. Of the cache
 * misses that land less than thirty seconds after a hit — too fast to be expiry —
 * rewritten history accounts for an order of magnitude more lost tokens on the
 * implicit-cache providers than every Anthropic placement effect combined. This is
 * the surface where that loss happens, and the surface where no marker can save it:
 * the builder is not allowed to send a breakpoint at all
 * (`packages/ai/src/providers/openai-codex-responses.ts:2537-2539`), so prefix
 * hygiene is the whole mechanism.
 *
 * REAL here is the wire body: every row drives `buildTransformedCodexRequestBody`,
 * the same function the shipped provider calls, so the item boundaries, the
 * instruction split and the key are the product's own. MODELLED is the cache: a
 * 1024-token floor and 128-token matching increments, credited only up to the last
 * whole shared block. ESTIMATED is the token count, which cancels in a delta.
 *
 * WHAT THIS DOES NOT CATCH.
 *   - The real granularity. If the provider matched more finely than 128 tokens the
 *     rows would understate the append case and nothing here would notice; the
 *     direction of every comparison survives either way, the magnitudes do not.
 *   - Whether a rewrite was legitimate. Compaction rewrites history on purpose and
 *     is supposed to pay once for a shorter prompt. Nothing here can tell that from
 *     an accidental re-serialization, which is precisely why the cost is priced
 *     rather than forbidden.
 *   - The websocket append path (`canAppendBeforeRequest`), which changes what is
 *     re-sent rather than what is cached. It is a separate scenario and not this
 *     one.
 *
 * RED PROOFS, observed rather than predicted.
 *   - the early rewrite pointed at the newest item instead: the forfeiture row reds,
 *     which is what says the row is about position rather than about editing.
 *   - the modelled cache made to compare block COUNTS instead of block content: the
 *     forfeiture row reds while the append row stays green.
 *   - the per-turn key made constant in the fresh-key row: that row reds, so it is
 *     about the anchor and not about the bodies differing.
 */
import { describe, expect, it } from "bun:test";
import {
	captureImplicitBody,
	conversationAfter,
	IMPLICIT,
	implicitBlocksOf,
	PRICE,
	padding,
	runImplicit,
	type Step,
	systemPrompt,
} from "./harness";

/** Tool results large enough that the history, not the instructions, is the prompt. */
const BODY_TOKENS = 3_000;
const TURNS = 5;
const GAP_MS = 15_000;

function body(index: number): string {
	return `step ${index} output\n${padding(BODY_TOKENS)}`;
}

function stepsWith(bodyFor: (index: number) => string, turns = TURNS): Step[] {
	const steps: Step[] = [];
	for (let turn = 1; turn <= turns; turn++) {
		steps.push({
			context: { systemPrompt: systemPrompt(), messages: conversationAfter(turn, bodyFor) },
			gapMs: turn === 1 ? 0 : GAP_MS,
		});
	}
	return steps;
}

/** Every turn appends and preserves every earlier byte: the control. */
function appendOnly(): Step[] {
	return stepsWith(body);
}

/**
 * The same run, except the final turn re-serializes step 2. Byte-length preserving,
 * so the prompt is the same size and only the content of an early item moved.
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

/** And the same edit applied to the newest item instead, which forfeits nothing behind it. */
function rewritesTheNewestStep(): Step[] {
	const steps = appendOnly();
	const rewritten = (index: number) => (index === TURNS ? body(index).replace("pad ", "PAD ") : body(index));
	steps[steps.length - 1] = {
		context: { systemPrompt: systemPrompt(), messages: conversationAfter(TURNS, rewritten) },
		gapMs: GAP_MS,
	};
	return steps;
}

describe("an implicit prefix cache", () => {
	it("charges an append-only run for the new items and reads the rest", async () => {
		const healthy = await runImplicit(appendOnly());
		const last = healthy.turns[TURNS - 1];

		// The read has to be most of the prompt, or the row is not describing a
		// working cache. Derived from the run: everything but the newest turn's own
		// items plus one matching block of slack.
		expect(last.read).toBeGreaterThan(last.promptTokens * 0.7);
		expect(last.input).toBeLessThan(BODY_TOKENS + IMPLICIT.blockTokens * 2);
		// And the first turn can read nothing, so a cached fraction of one would mean
		// the model is crediting a read it never wrote.
		expect(healthy.turns[0].read).toBe(0);
	});

	it("forfeits everything behind a rewritten early item, on a prompt of the same size", async () => {
		const healthy = await runImplicit(appendOnly());
		const rewritten = await runImplicit(rewritesAnEarlyStep());

		const healthyLast = healthy.turns[TURNS - 1];
		const rewrittenLast = rewritten.turns[TURNS - 1];

		// Same bytes on the wire, so this is not a comparison of two prompt sizes.
		expect(rewrittenLast.promptTokens).toBe(healthyLast.promptTokens);
		expect(rewrittenLast.read).toBeLessThan(healthyLast.read);
		// The forfeiture is the whole history from the edit onward, not a block or
		// two: at least the size of the items that follow it.
		expect(healthyLast.read - rewrittenLast.read).toBeGreaterThan(BODY_TOKENS * 2);
		// And it is charged at the difference between reading and not reading.
		const excess = rewrittenLast.cost - healthyLast.cost;
		expect(excess).toBeGreaterThan((healthyLast.read - rewrittenLast.read) * (PRICE.input - PRICE.read) * 0.99);
	});

	it("charges almost nothing for rewriting the newest item", async () => {
		const healthy = await runImplicit(appendOnly());
		const newest = await runImplicit(rewritesTheNewestStep());
		const early = await runImplicit(rewritesAnEarlyStep());

		// Editing the newest item cannot forfeit anything behind it, so it stays
		// within one matching block of the healthy run.
		expect(Math.abs(newest.turns[TURNS - 1].read - healthy.turns[TURNS - 1].read)).toBeLessThanOrEqual(
			IMPLICIT.blockTokens,
		);
		expect(newest.cost).toBeLessThan(early.cost);
	});

	it("forfeits everything when the key changes, however identical the bytes are", async () => {
		const sameKey = await runImplicit(appendOnly());
		const freshKeyEachTurn = await runImplicit(appendOnly(), { sessionIdFor: turn => `sim-session-${turn}` });
		const noKeyAtAll = await runImplicit(appendOnly(), { sessionIdFor: () => undefined });

		// Identical requests, and the only thing that moved is the anchor.
		expect(freshKeyEachTurn.read).toBe(0);
		expect(noKeyAtAll.read).toBe(0);
		expect(freshKeyEachTurn.cost).toBeGreaterThan(sameKey.cost);
		expect(noKeyAtAll.cost).toBeGreaterThan(sameKey.cost);
	});

	/**
	 * A guard on the surface rather than the model: if a breakpoint ever appears in
	 * this body, the premise of the file changes and every row above is arguing
	 * about the wrong lever.
	 */
	it("carries a key and no breakpoint of any kind", async () => {
		const step = appendOnly().at(-1) as Step;
		const wire = await captureImplicitBody(step.context);
		const serialized = JSON.stringify(wire);

		expect(typeof wire.prompt_cache_key).toBe("string");
		expect(serialized).not.toContain("prompt_cache_breakpoint");
		expect(serialized).not.toContain("cache_control");
		// And the blocks the model matches on are the request's own items, so a
		// change in one item cannot be credited as a partial match of another.
		expect(implicitBlocksOf(wire).length).toBeGreaterThan(TURNS);
	});
});
