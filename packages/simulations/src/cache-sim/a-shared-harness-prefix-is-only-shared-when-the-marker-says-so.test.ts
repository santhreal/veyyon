/**
 * The shipped anchor on the first system block is there so a subagent can read
 * the harness its parent already cached. Two sessions sharing one modelled cache
 * are what price that, and the first thing they show is that the sharing does not
 * happen: an entry is keyed by session unless the marker asks otherwise, and
 * nothing in this product asks.
 *
 * WHY THIS FILE EXISTS. The placement scenario beside this one measures the cost
 * of anchoring `system[0]` — every block between the anchor and a changing tail is
 * re-read forever — and then refuses to recommend moving the marker, because the
 * justification for its depth is cross-session sharing that a single-session
 * simulation cannot see. This file is that missing half. It answers the only
 * question that decides the patch: how many subagent sessions must share a parent's
 * harness before the shallow anchor pays for the parent's loss?
 *
 * The answer turns out to depend on a field that is not set. `scope: "global"` is
 * the prompt-caching-scope beta; this repo sends the beta header on both Anthropic
 * layouts and the field is first-class on the wire type, but no code path assigns
 * it. So today every breakpoint is session-scoped, a subagent reads nothing its
 * parent wrote, and the depth of the anchor buys exactly zero of what it was
 * chosen for. The fleet is run both ways, and the crossover only exists in the arm
 * where the flag is set.
 *
 * WHAT THIS DOES NOT CATCH.
 *   - Whether the provider is session-scoped by default at all. That is modelled
 *     from this repo's own wire documentation ("shares the breakpoint across
 *     sessions"), not derived from traffic: a provider that shared everything by
 *     default would make the session-keyed rows here pessimistic, and nothing in
 *     the file would notice.
 *   - Real subagent fan-out. The crossover is reported as a count, and which side
 *     of it a given workload sits on is a question about that workload. Nothing
 *     here claims a typical fan-out.
 *   - The write the parent pays to publish a shared prefix is modelled as the same
 *     write it pays anyway, because it marks that prefix either way. A provider
 *     charging a premium for a globally scoped write would change the crossover
 *     and is not modelled.
 *
 * RED PROOFS, observed rather than predicted.
 *   - the global-scope decorator made a no-op (marker returned unchanged): the
 *     sharing row reds, which is what says the row is about the field and not
 *     about the two sessions sending identical harness bytes.
 *   - the subagent's project block made identical to the parent's: the crossover
 *     row reds, since a deeper anchor then shares too and the trade disappears.
 *   - the modelled cache made to ignore which session owns an entry: the
 *     session-scoped row reds, so that row is about the key and not about the
 *     interleaving. This is also the mistake the model shipped with for one run —
 *     it made a session-scoped cache look account-wide and credited the shipped
 *     anchor with a saving it does not collect.
 *
 * MEASURED, one six-turn parent with a changing system tail plus N three-turn
 * subagents that share its harness block and differ from block 1 on, in
 * base-input-price equivalents. Session-scoped, as the product ships: the shipped
 * anchor costs 24472 against 13892 at N=0 and 111882 against 75897 at N=6, so the
 * gap WIDENS by about 4234 per subagent and the shallow anchor never breaks even.
 * With `scope: "global"` set, a subagent's first request reads the 4811-token
 * harness prefix its parent wrote thirty seconds earlier, the gap NARROWS by about
 * 1298 per subagent (10580 at N=0, 2790 at N=6), and the crossover lands near nine
 * simultaneously sharing subagents. Below that fan-out the deeper anchor is
 * cheaper even with sharing switched on.
 */
import { describe, expect, it } from "bun:test";
import {
	type Arm,
	armPayloads,
	conversationAfter,
	deepAnchor,
	PRODUCTION,
	prefixesOf,
	runFleet,
	type Step,
	sharedGlobally,
	systemPrompt,
} from "./harness";

const PARENT_TURNS = 6;
const SUBAGENT_TURNS = 3;
const GAP_MS = 20_000;
/** The parent is already running when a subagent starts; that is what sharing means. */
const SUBAGENT_START_MS = 30_000;

/** A system prompt sharing the harness block and differing from block 1 onward. */
function systemFor(project: string, volatileSuffix: string): string[] {
	const blocks = systemPrompt({ volatileSuffix });
	blocks[1] = `PROJECT ${project}\n${"repository conventions that change when the project changes. ".repeat(120)}`;
	return blocks;
}

/** The parent: a long session whose trailing system block changes every turn. */
function parentSession(): Step[] {
	const steps: Step[] = [];
	for (let turn = 1; turn <= PARENT_TURNS; turn++) {
		steps.push({
			context: {
				systemPrompt: systemFor("parent", `handle table revision ${turn}`),
				messages: conversationAfter(turn),
			},
			gapMs: turn === 1 ? 0 : GAP_MS,
		});
	}
	return steps;
}

/** A subagent: its own project block, its own short history, starting mid-parent. */
function subagentSession(id: number): Step[] {
	const steps: Step[] = [];
	for (let turn = 1; turn <= SUBAGENT_TURNS; turn++) {
		steps.push({
			context: {
				systemPrompt: systemFor(`subagent-${id}`, `handle table revision ${turn}`),
				messages: conversationAfter(turn),
			},
			gapMs: turn === 1 ? SUBAGENT_START_MS : GAP_MS,
		});
	}
	return steps;
}

/** A fleet of one parent and `fanOut` subagents. */
function fleetOf(fanOut: number): Record<string, Step[]> {
	const fleet: Record<string, Step[]> = { parent: parentSession() };
	for (let id = 1; id <= fanOut; id++) fleet[`subagent-${id}`] = subagentSession(id);
	return fleet;
}

/** What an arm costs across the whole fleet at one fan-out. */
async function fleetCost(arm: Arm, fanOut: number): Promise<number> {
	return (await runFleet(arm, fleetOf(fanOut))).cost;
}

/** Wide enough to contain the crossover this fixture produces, with room above it. */
const MAX_FAN_OUT = 14;

/**
 * How much more the shipped anchor costs than a one-block-deeper one, at each
 * fan-out from zero. Positive means the shipped anchor is the expensive one.
 */
async function deltasAcrossFanOut(shipped: Arm, deeper: Arm): Promise<number[]> {
	const deltas: number[] = [];
	for (let fanOut = 0; fanOut <= MAX_FAN_OUT; fanOut++) {
		deltas.push((await fleetCost(shipped, fanOut)) - (await fleetCost(deeper, fanOut)));
	}
	return deltas;
}

describe("a harness prefix shared between a parent and its subagents", () => {
	it("is not shared at all while the marker leaves the scope unset", async () => {
		const sessionScoped = await runFleet(PRODUCTION, fleetOf(1));
		const globallyScoped = await runFleet(sharedGlobally(PRODUCTION), fleetOf(1));

		// The subagent's first request carries a harness prefix the parent cached
		// thirty seconds earlier, byte for byte. Session-keyed, it reads none of it.
		expect(sessionScoped.sessions["subagent-1"].turns[0].read).toBe(0);
		expect(globallyScoped.sessions["subagent-1"].turns[0].read).toBeGreaterThan(0);
		// And what it reads is the harness prefix, not something deeper: the parent's
		// project block differs, so nothing past block 0 can match.
		const harness = await harnessPrefixTokens();
		expect(globallyScoped.sessions["subagent-1"].turns[0].read).toBe(harness);
		expect(globallyScoped.cost).toBeLessThan(sessionScoped.cost);
	});

	it("leaves the shallow anchor buying nothing, at every fan-out, as the product ships today", async () => {
		const deltas = await deltasAcrossFanOut(PRODUCTION, deepAnchor(1));

		// Every fan-out, not most of them: with no sharing the extra depth is free
		// money and more subagents only widen the gap, which is the whole finding.
		expect(deltas.every(delta => delta > 0)).toBe(true);
		const widening = deltas.slice(1).every((delta, index) => delta > deltas[index]);
		expect(widening).toBe(true);
	});

	it("pays for its depth only once the scope is set, and only above a fan-out this run reports", async () => {
		const deltas = await deltasAcrossFanOut(sharedGlobally(PRODUCTION), sharedGlobally(deepAnchor(1)));

		// The trade is one parent penalty against one saving per sharing subagent, so
		// the delta shrinks by a constant per subagent and crosses zero exactly once.
		// Anything else means the fixture is measuring something other than the trade.
		const narrowing = deltas.slice(1).every((delta, index) => delta < deltas[index]);
		expect(narrowing).toBe(true);
		const crossover = deltas.findIndex(delta => delta <= 0);
		expect(crossover).toBeGreaterThan(0);
		expect(crossover).toBeLessThanOrEqual(MAX_FAN_OUT);

		// The number is the point: the anchor is not justified by "subagents exist",
		// it is justified by a fan-out this large sharing that exact harness at once.
		// Below the crossover the deeper anchor is cheaper even with sharing on.
		expect(deltas[crossover - 1]).toBeGreaterThan(0);
		expect(crossover).toBeGreaterThan(2);
	});

	/**
	 * A guard on the fixture: the two sessions must actually share the harness
	 * block and actually differ after it, or every row above passes by measuring
	 * two unrelated prompts.
	 */
	it("keeps the parent and the subagent sharing the harness and nothing past it", async () => {
		const [parent] = await armPayloads(PRODUCTION, [parentSession()[0]]);
		const [child] = await armPayloads(PRODUCTION, [subagentSession(1)[0]]);

		const parentBlocks = (parent.system ?? []).map(block => block.text);
		const childBlocks = (child.system ?? []).map(block => block.text);
		expect(childBlocks[0]).toBe(parentBlocks[0]);
		expect(childBlocks[1]).not.toBe(parentBlocks[1]);
		expect(await harnessPrefixTokens()).toBeGreaterThan(2048);
	});
});

/** The size of the prefix the shipped anchor closes: block 0 and nothing else. */
async function harnessPrefixTokens(): Promise<number> {
	const [first] = await armPayloads(PRODUCTION, [parentSession()[0]]);
	return prefixesOf(first)[0]?.tokens ?? 0;
}
