/**
 * When a later system block changes every turn, the shipped anchor saves the
 * harness and nothing else — and the blocks between it and the change are
 * re-read on every request for the life of the session.
 *
 * WHY THIS FILE EXISTS. `applyPromptCaching` spends one of its four markers on
 * the FIRST of veyyon's own system blocks, deliberately, so that a changing
 * project, assignment or Argot block cannot invalidate the harness shared with
 * subagents (`packages/ai/src/providers/anthropic.ts:3181-3195`). The other
 * system marker goes on the LAST block. Both halves of that are sound in
 * isolation and the pair has a consequence nobody priced: a provider matches
 * prefixes sequentially, so once block N changes, EVERY prefix that contains
 * block N is forfeited — including all four message-level prefixes. What survives
 * is the deepest marker that ends before the change, and production has put that
 * marker as early as a marker can go.
 *
 * The rule this repo was asked to compare itself against marks the first TWO
 * system blocks, which on the same content survives one block deeper. That is the
 * entire mechanism by which a simpler placement can cache more than a more
 * careful one, and it is worth a measured number rather than an argument.
 *
 * The candidate fix is priced beside it: anchor the deepest block a caller knows
 * to be stable rather than the first. It must win on the volatile shape AND cost
 * nothing on the stable one, or it is not a fix.
 *
 * WHAT THIS DOES NOT CATCH.
 *   - Nothing here says which block is stable in production. A request cannot
 *     know that; the simulation is told. Turning this into a patch needs the
 *     builder to learn stability from somewhere, and that is not this file.
 *   - The subagent-sharing argument for anchoring block 0 is real and is NOT
 *     modelled: one session runs here, so the harness prefix has no second reader
 *     to be worth anything to. A deeper anchor keeps the shallow prefix cached
 *     too (a marker closes a prefix; it does not open one), so the sharing
 *     survives — but that claim is argued, not measured, and belongs in a
 *     two-session scenario this family does not yet have.
 *
 * RED PROOFS, observed rather than predicted.
 *   - production re-marked to anchor block 1 instead of block 0: the shortfall row
 *     reds, which is what says the row is about anchor DEPTH and not about the
 *     volatile block existing.
 *   - the volatile suffix held constant across turns: the shortfall row reds and
 *     the stable-shape row stays green, so the two shapes are not measuring the
 *     same thing.
 *   - the anchor moved onto the volatile block itself (`deepAnchor(2)`) is not a
 *     mutation but a measured arm, and it is the reason the candidate is stated as
 *     "anchor a block known to be stable" rather than "anchor deeper": on this
 *     fixture it reads nothing at all and costs more than double production.
 *
 * MEASURED, six turns at twenty-second gaps, in base-input-price equivalents:
 * volatile tail — production 24458 (reads 24055, writes 17642, deepest surviving
 * prefix 4811 tokens); the simpler placement and a one-block-deeper anchor both
 * 13889 (reads 33245, writes 8452, surviving prefix 6649); the anchor moved onto
 * the changing block 52121 (reads 0). Stable system prompt — all four arms 12380
 * to the token, which is what makes the deeper anchor free on the shape production
 * was designed for.
 */
import { describe, expect, it } from "bun:test";
import {
	type Arm,
	armPayloads,
	conversationAfter,
	deepAnchor,
	growingSession,
	PRODUCTION,
	padding,
	prefixesOf,
	runArm,
	type SessionLedger,
	SIMPLE_PLACEMENT,
	type Step,
	systemPrompt,
} from "./harness";

const TURNS = 6;
const GAP_MS = 20_000;

/** The system prompt every arm sends, with a tail that changes on every turn. */
function volatileTailSession(): Step[] {
	const steps: Step[] = [];
	for (let turn = 1; turn <= TURNS; turn++) {
		steps.push({
			context: {
				// Argot's handle table is the shipped block that behaves this way: it
				// is last, and it changes as the session mints handles.
				systemPrompt: systemPrompt({ volatileSuffix: `handle table revision ${turn}` }),
				messages: conversationAfter(turn),
			},
			gapMs: turn === 1 ? 0 : GAP_MS,
		});
	}
	return steps;
}

const STABLE = growingSession({ turns: TURNS, gapMs: GAP_MS });

/** The deepest prefix an arm offers on its last turn, in estimated tokens. */
async function deepestPrefix(arm: Arm, steps: readonly Step[]): Promise<number> {
	const payloads = await armPayloads(arm, steps);
	return prefixesOf(payloads.at(-1) as (typeof payloads)[number]).at(-1)?.tokens ?? 0;
}

/** Tokens an arm read across every turn but the first, which can read nothing. */
function readAfterFirstTurn(ledger: SessionLedger): number {
	return ledger.turns.slice(1).reduce((sum, turn) => sum + turn.read, 0);
}

describe("a system block that changes every turn", () => {
	it("costs production more than the simpler placement it was compared against", async () => {
		const volatile = volatileTailSession();
		const production = await runArm(PRODUCTION, volatile);
		const simple = await runArm(SIMPLE_PLACEMENT, volatile);

		// Direction first: the simpler rule reads MORE of the prompt, on identical
		// bytes, because its shallowest-surviving marker sits one block deeper.
		expect(readAfterFirstTurn(production)).toBeLessThan(readAfterFirstTurn(simple));
		// Magnitude, so the row cannot pass on a one-token difference. Derived from
		// the run rather than written down: the shortfall is at least the size of
		// the block production re-reads and the others do not.
		const shortfall = readAfterFirstTurn(simple) - readAfterFirstTurn(production);
		expect(shortfall).toBeGreaterThan((TURNS - 1) * 1000);
		expect(production.cost).toBeGreaterThan(simple.cost);
	});

	it("leaves production reading only the harness, while the others reach the project block", async () => {
		const volatile = volatileTailSession();
		const production = await runArm(PRODUCTION, volatile);
		const deeper = await runArm(deepAnchor(1), volatile);

		// Both arms mark the same COUNT; what differs is how much survives a change
		// in the tail. Per-turn reads are flat in a volatile session (every turn
		// falls back to its deepest stable marker), so the per-turn figure is the
		// depth of that marker and can be compared directly.
		const productionPerTurn = production.turns[TURNS - 1].read;
		const deeperPerTurn = deeper.turns[TURNS - 1].read;

		expect(deeperPerTurn).toBeGreaterThan(productionPerTurn);
		expect(deeperPerTurn / productionPerTurn).toBeGreaterThan(1.2);
	});

	/**
	 * The candidate has to be free on the shape production was designed for, or it
	 * trades one regression for another.
	 */
	it("is fixed by a deeper anchor that costs nothing when the system prompt is stable", async () => {
		const volatile = volatileTailSession();
		const productionVolatile = await runArm(PRODUCTION, volatile);
		const deeperVolatile = await runArm(deepAnchor(1), volatile);
		const productionStable = await runArm(PRODUCTION, STABLE);
		const deeperStable = await runArm(deepAnchor(1), STABLE);

		expect(deeperVolatile.cost).toBeLessThan(productionVolatile.cost);
		expect(deeperStable.cost).toBeLessThanOrEqual(productionStable.cost);
	});

	/**
	 * And the candidate is not "mark deeper". Anchoring the block that CHANGES
	 * spends the stable marker on a prefix nothing can ever match again, which is
	 * worse than the shallow anchor it replaced — measured at more than double.
	 * Any patch that moves this marker has to know which block is stable; moving
	 * it by one and hoping is the expensive mistake.
	 */
	it("is made worse, not better, by anchoring the block that changes", async () => {
		const volatile = volatileTailSession();
		const production = await runArm(PRODUCTION, volatile);
		const ontoTheChange = await runArm(deepAnchor(2), volatile);

		expect(readAfterFirstTurn(ontoTheChange)).toBe(0);
		expect(ontoTheChange.cost).toBeGreaterThan(production.cost * 2);
	});

	/**
	 * And the reason the whole file is about the SYSTEM prompt: on a stable system
	 * prompt the shipped placement is already the best of the three, so this is not
	 * an argument for adopting the simpler rule.
	 */
	it("does not indict the shipped placement on a stable system prompt", async () => {
		const production = await runArm(PRODUCTION, STABLE);
		const simple = await runArm(SIMPLE_PLACEMENT, STABLE);

		expect(production.cost).toBeLessThanOrEqual(simple.cost);
	});

	/**
	 * A guard on the fixture rather than the product: if the volatile block ever
	 * stops being deep enough to matter, every row above would pass by measuring
	 * nothing.
	 */
	it("keeps the volatile block behind a prefix worth caching", async () => {
		const deepest = await deepestPrefix(PRODUCTION, volatileTailSession());

		expect(deepest).toBeGreaterThan(2048);
		expect(padding(1).length).toBe(4);
	});
});
