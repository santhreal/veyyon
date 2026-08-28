/**
 * Every request that billed is counted once, on the turn that spent it.
 *
 * WHY THIS FILE EXISTS. `getSessionStats()` sums usage over the ACTIVE context,
 * and three different things feed off that sum: the `/session` spend line the
 * operator reads, the goal-mode token budget, and the context gauge. So an error
 * in it is either money the operator cannot see or a budget that stops the wrong
 * turn, and neither shows up as a wrong answer. The arithmetic has exactly the
 * edges you would expect and they were all unobservable in a simulation until
 * now, because a scripted provider reported no usage at all: every count was zero
 * and every assertion about spend was vacuously true.
 *
 * The rows fix the countable facts:
 *   - a turn's usage lands on the assistant message that turn produced, so the
 *     sum over a settled session equals the sum of what the provider reported;
 *   - one prompt that runs a tool is TWO billed requests, and both count;
 *   - a cancelled turn still counts, because the provider already billed for the
 *     tokens it streamed before the abort;
 *   - a failed attempt that was retried counts once, because the failed attempt
 *     leaves no turn behind.
 *
 * WHAT THIS DOES NOT CATCH, measured rather than assumed.
 *   - Side requests are not in this sum at all. A compaction summarization is a
 *     real billed call and `getSessionStats` never sees it: measured directly, a
 *     session whose three live turns reported 1000/2000/4000 input reports 7000
 *     while the summarizer's own 3000 appears nowhere. Provider-level spend is
 *     recorded through telemetry instead, which is a different owner; what this
 *     file pins is that the CONTEXT-scoped sum is internally consistent.
 *   - Cost here is a flat rate per token (`SIM_COST_PER_TOKEN`). Real per-model
 *     pricing lives in the catalog and is not exercised.
 *   - Nothing here bounds what happens to the sum when compaction drops turns out
 *     of the active context: it shrinks, by construction. Whether the budget
 *     owner should be reading a context-scoped number is a design question, not
 *     an arithmetic one, and a row asserting today's shape would just freeze it.
 *
 * RED PROOFS, observed rather than predicted.
 *   - `getSessionStats` skipping aborted assistant turns: only the cancelled row
 *     reds, which is the whole reason that row exists.
 *   - the cache-write component dropped from the sum: only the arithmetic row
 *     reds, and it reds on both the token total and the cost.
 *   - The retry row has NO mutation that reds it, and that is measured too:
 *     making the agent store even an empty failed attempt left all four rows
 *     green, because a transient retry happens BELOW the message layer (inside
 *     the stream function, under `retry.maxRetries`) and the failed attempt never
 *     becomes a turn. The row is a lock rather than a live guard: it fires if a
 *     retry is ever moved above the message layer, and it is honest to say it
 *     catches nothing today.
 */
import { afterEach, expect, it } from "bun:test";
import { USER_INTERRUPT_LABEL } from "@veyyon/coding-agent/session/messages";
import { createSimulation, SIM_COST_PER_TOKEN, type Simulation, simTool, whenSessionEvent } from "./harness";

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

it("sums what the provider reported, and prices it per token", async () => {
	sim = await createSimulation({
		script: turn => {
			turn.usage({ input: 1000 * turn.call, output: 100, cacheRead: 20, cacheWrite: 10 });
			turn.text(`answer ${turn.call}`);
			turn.finish();
		},
	});

	await sim.session.prompt("first");
	await sim.session.prompt("second");

	const stats = sim.session.getSessionStats();
	expect(stats.tokens.input).toBe(3000);
	expect(stats.tokens.output).toBe(200);
	expect(stats.tokens.cacheRead).toBe(40);
	expect(stats.tokens.cacheWrite).toBe(20);
	expect(stats.tokens.total).toBe(3260);
	// The cost is the provider's, not a recomputation from a local price table:
	// summing the reported per-message cost is what keeps the spend line honest
	// when a model's price changes mid-session.
	expect(stats.cost).toBeCloseTo(3260 * SIM_COST_PER_TOKEN, 6);
	expect(stats.assistantMessages).toBe(2);
});

it("counts both requests of a prompt that ran a tool", async () => {
	sim = await createSimulation({
		tools: [simTool("work", async () => ({ content: [{ type: "text", text: "tool output" }] }))],
		script: turn => {
			turn.usage({ input: 500, output: 50 });
			if (turn.call === 1) {
				turn.toolCall("work", { step: 1 }, "call-1");
				turn.finish();
				return;
			}
			turn.text("done");
			turn.finish();
		},
	});

	await sim.session.prompt("go");

	// One prompt, two provider calls, two assistant turns, two bills.
	const stats = sim.session.getSessionStats();
	expect(sim.providerCalls()).toBe(2);
	expect(stats.tokens.input).toBe(1000);
	expect(stats.tokens.output).toBe(100);
	expect(stats.toolCalls).toBe(1);
	expect(stats.toolResults).toBe(1);
});

it("counts a cancelled turn, because the provider billed what it streamed", async () => {
	sim = await createSimulation({
		script: turn => {
			// Usage arrives with the stream, before the user reaches for Esc.
			turn.usage({ input: 800, output: 40 });
			turn.text("starting to answer");
			// No finish: the turn is still open when the cancel lands.
		},
	});

	const cancelled = sim.session.prompt("go");
	await whenSessionEvent(sim.session, event => event.type === "message_update");
	await sim.session.abort({ reason: USER_INTERRUPT_LABEL });
	await cancelled;

	// A turn that spent tokens and was then interrupted is not free. Dropping
	// aborted turns from the sum would silently discount every Esc.
	const stats = sim.session.getSessionStats();
	expect(stats.tokens.input).toBe(800);
	expect(stats.tokens.output).toBe(40);
});

it("counts one bill for an attempt that failed and was retried", async () => {
	sim = await createSimulation({
		script: turn => {
			if (turn.call === 1) {
				// A retryable transport failure. The attempt leaves no assistant turn
				// behind, so there is nothing for the sum to double-count.
				turn.fail("network error: socket hang up");
				return;
			}
			turn.usage({ input: 700, output: 30 });
			turn.text("answer after the retry");
			turn.finish();
		},
	});

	await sim.session.prompt("go");

	expect(sim.providerCalls()).toBe(2);
	const stats = sim.session.getSessionStats();
	expect(stats.tokens.input).toBe(700);
	expect(stats.tokens.output).toBe(30);
	expect(stats.assistantMessages).toBe(1);
});
