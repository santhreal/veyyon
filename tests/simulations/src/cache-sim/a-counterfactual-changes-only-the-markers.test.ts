/**
 * Every arm of a cache counterfactual sends byte-identical content. Only the
 * caching directives differ.
 *
 * WHY THIS FILE EXISTS, and why it is first. A counterfactual that reports "arm B
 * is 40% cheaper" is worthless unless B sent the same prompt as A. The two ways
 * to get that wrong are both easy and both silent: a `remark` that edits a block
 * while re-marking it, and an arm that changes a request OPTION which the
 * production builder then uses to rebuild the body differently (the Claude Code
 * layout does exactly that — it prepends two system blocks). Either one turns a
 * pricing result into a comparison of two different prompts, and the number still
 * looks plausible.
 *
 * So this is the parity gate the other three scenarios rest on: content identity
 * across every arm, marker counts inside the provider's limit, and the production
 * arm passed through unmodified.
 *
 * WHAT THIS DOES NOT CATCH. Content identity is checked on the wire body, so it
 * cannot see a difference in what a real provider would have BILLED for identical
 * bytes (tokenizer boundaries, image blocks). The estimator is shared by every
 * arm, so such a difference cancels in a delta and cannot be observed here at
 * all.
 *
 * RED PROOFS, observed rather than predicted.
 *   - `SIMPLE_PLACEMENT` mutating a block's text while re-marking it: the content
 *     row reds and the marker rows stay green, which is what says the content row
 *     is load-bearing and not decoration.
 *   - dropping the four-marker trim in `applyPromptCaching`: the budget row reds
 *     for the production arm only.
 */
import { describe, expect, it } from "bun:test";
import {
	type Arm,
	armPayloads,
	contentOf,
	deepAnchor,
	growingSession,
	LONG_RETENTION,
	PRODUCTION,
	prefixesOf,
	SHORT_RETENTION,
	SIMPLE_PLACEMENT,
	type WirePayload,
} from "./harness";

/**
 * Anthropic accepts at most four `cache_control` markers on a request and
 * rejects the fifth outright, so an arm that exceeds it is not a cheaper policy,
 * it is a 400.
 */
const MAX_MARKERS = 4;

const STEPS = growingSession({ turns: 5, gapMs: 20_000 });

/**
 * Every arm this family prices, enumerated so a new one cannot be added without
 * passing the parity gate. A retention arm is included because it changes a
 * request option rather than the markers, which is the case most likely to move
 * content by accident.
 */
const ARMS: readonly Arm[] = [PRODUCTION, SIMPLE_PLACEMENT, deepAnchor(1), SHORT_RETENTION, LONG_RETENTION];

describe("parity across the arms of a counterfactual", () => {
	it("sends the same bytes on every arm, marked differently", async () => {
		const baseline = await armPayloads(PRODUCTION, STEPS);
		const divergent: Array<{ arm: string; turn: number }> = [];
		for (const arm of ARMS) {
			const payloads = await armPayloads(arm, STEPS);
			payloads.forEach((payload, turn) => {
				if (contentOf(payload) !== contentOf(baseline[turn])) divergent.push({ arm: arm.name, turn });
			});
		}

		expect(divergent).toEqual([]);
	});

	it("keeps every arm inside the provider's marker budget", async () => {
		const overBudget: Array<{ arm: string; turn: number; markers: number }> = [];
		for (const arm of ARMS) {
			const payloads = await armPayloads(arm, STEPS);
			payloads.forEach((payload, turn) => {
				const markers = prefixesOf(payload).length;
				if (markers > MAX_MARKERS || markers === 0) overBudget.push({ arm: arm.name, turn, markers });
			});
		}

		expect(overBudget).toEqual([]);
	});

	/**
	 * The production arm must be the shipped request itself, not a re-marked copy
	 * of it: it is the baseline every delta is measured against, and a `remark`
	 * hook on it would make the baseline a policy of its own.
	 */
	it("leaves the production arm exactly as the shipped code built it", () => {
		expect(PRODUCTION.remark).toBeUndefined();
		expect(PRODUCTION.cacheRetention).toBeUndefined();
	});

	/**
	 * A prefix under the provider's floor is never stored, so a fixture that sits
	 * below it would measure a cache that does not exist and report every arm as
	 * equal.
	 */
	it("builds a prompt the provider would actually cache", async () => {
		const payloads = await armPayloads(PRODUCTION, STEPS);
		const deepest = payloads.map((payload: WirePayload) => prefixesOf(payload).at(-1)?.tokens ?? 0);

		expect(Math.min(...deepest)).toBeGreaterThan(2048);
	});
});
