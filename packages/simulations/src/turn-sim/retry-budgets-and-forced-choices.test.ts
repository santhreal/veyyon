/**
 * What one settled cycle leaves behind for the next one.
 *
 * WHY THIS FILE EXISTS. The settle tail keeps counters and queues that outlive
 * the turn that spent them: how many empty stops this cycle has retried, how
 * many unexpected stops, and a forced tool choice one reminder queues for a
 * continuation that has not started yet. Every one of them is a way for a turn
 * the user never asked about to inherit state from a turn that is over, and the
 * failure mode is silent in both directions. A counter left above its cap makes
 * the NEXT cycle give up on its first attempt and report attempts it never made.
 * A forced choice left in the queue makes a plain user turn call a tool instead
 * of answering. Neither shows up as an error; both show up as an agent that
 * behaves differently depending on what happened before.
 *
 * Every scenario here drives two cycles through a real `AgentSession` and
 * asserts the second one behaves like the first. A single-cycle test cannot see
 * this class at all, which is why the code carries comments about it and the
 * suite carried nothing.
 *
 * Determinism: counts of scripted provider calls and recorded per-call tool
 * choices, read after `session.prompt()` resolves. No sleeps, no clock reads.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { ToolChoice } from "@veyyon/ai";
import * as unexpectedStopClassifier from "@veyyon/coding-agent/session/unexpected-stop-classifier";
import { TOOL } from "@veyyon/coding-agent/tools/builtin-names";
import { createSimulation, type ProviderScript, type Simulation, simTool } from "./harness";

let sim: Simulation | undefined;
let restoreStub: (() => void) | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
	restoreStub?.();
	restoreStub = undefined;
});

const QUESTION_REPLY = "Which storage backend should this use?";
/** Announces work and stops without doing it: what the classifier answers YES to. */
const ABANDONED_REPLY = "I'll fix that now.";

/** Developer-role messages are how every settle reminder reaches the model. */
function developerMessageCount(simulation: Simulation): number {
	return simulation.session.messages.filter(message => message.role === "developer").length;
}

describe("the empty-stop budget belongs to the cycle that spends it", () => {
	it("retries a second user prompt as far as the first, and reports its own attempts", async () => {
		// A turn with no tool call and no text is not actionable, so the tail discards
		// it and asks again, up to a cap. Two independent mechanisms give the NEXT
		// user prompt its full runway: the cap branch zeroes the counter as the cycle
		// ends, and `#resetPromptMaintenanceState` zeroes it again on the way into any
		// prompt. Either alone is enough here, so removing one does not turn this case
		// red and removing both does. The continuation case below is the one that
		// isolates the cap branch, because it never goes through a prompt at all.
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			script: turn => {
				turn.finish();
			},
		});

		await sim.session.prompt("first cycle");
		const firstCycleCalls = sim.providerCalls();
		const firstEnd = sim.eventsOfType("auto_retry_end");

		await sim.session.prompt("second cycle");
		const secondCycleCalls = sim.providerCalls() - firstCycleCalls;
		const bothEnds = sim.eventsOfType("auto_retry_end");

		expect(firstCycleCalls).toBeGreaterThan(1);
		expect(secondCycleCalls).toBe(firstCycleCalls);
		expect(bothEnds.length).toBe(2);
		expect(bothEnds[1]?.attempt).toBe(firstEnd[0]?.attempt);
		expect(bothEnds[1]?.success).toBe(false);
		// The reminders describe a turn that has been discarded, so the cap drops
		// them rather than leaving them for a later turn to read as current.
		expect(developerMessageCount(sim)).toBe(0);
	});

	it("gives a continuation-driven cycle the same runway, with no prompt to reset it", async () => {
		// The case the cap branch's own reset exists for, and the only one that can
		// see it. A continuation scheduled at a settle re-enters the loop through
		// `agent.continue()`, not through a prompt, so nothing clears the counter on
		// the way in: if the cap left it above the limit, this cycle gives up on its
		// first empty stop and reports attempts for requests it never made.
		//
		// The runway is MEASURED from a control session rather than written down, so
		// the cap can change without touching this test.
		const emptyForever: ProviderScript = turn => {
			turn.finish();
		};
		sim = await createSimulation({ settings: { "retry.enabled": false }, script: emptyForever });
		await sim.session.prompt("cap it");
		const runway = sim.providerCalls();
		expect(runway).toBeGreaterThan(1);
		await sim.dispose();
		sim = undefined;

		// One mutating tool call makes the verification ledger owe a reminder, which
		// is the route that schedules the continuation after the cap. It owes exactly
		// one per user turn, so the chain ends rather than repeating forever.
		let call = 0;
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			tools: [
				simTool("write", async () => ({
					content: [{ type: "text", text: "wrote 1 file" }],
					details: { resolvedPath: "/tmp/simulation/file.ts" },
				})),
			],
			script: turn => {
				call += 1;
				if (call === 1) {
					turn.toolCall("write", { path: "/tmp/simulation/file.ts", content: "x" });
					turn.finish("toolUse");
					return;
				}
				turn.finish();
			},
		});

		await sim.session.prompt("edit, then stop saying nothing");

		// The mutation turn, one full runway to the cap, the verification
		// continuation, and a second full runway to the cap again.
		expect(sim.providerCalls()).toBe(1 + runway + runway);
		expect(sim.eventsOfType("auto_retry_end").length).toBe(2);
		expect(sim.session.isStreaming).toBe(false);
	});
});

describe("a deferral spends nothing", () => {
	/**
	 * The policy's own claim about every route that holds for a user answer:
	 * deferring is not dropping. The nudge is still owed after the user replies,
	 * so the budget must be intact and the route must still fire.
	 */
	function alwaysReadsTheReplyAsAbandoned(): void {
		const spy = spyOn(unexpectedStopClassifier, "classifyUnexpectedStop").mockResolvedValue(true);
		restoreStub = () => spy.mockRestore();
	}

	it("holds an unexpected-stop retry over a question, then fires on the next cycle", async () => {
		alwaysReadsTheReplyAsAbandoned();
		const replies = [QUESTION_REPLY, ABANDONED_REPLY, QUESTION_REPLY];
		let index = 0;
		const script: ProviderScript = turn => {
			turn.text(replies[Math.min(index++, replies.length - 1)] ?? QUESTION_REPLY);
			turn.finish();
		};
		sim = await createSimulation({
			settings: {
				"retry.enabled": false,
				"features.unexpectedStopDetection": true,
				"providers.unexpectedStopModel": "online",
			},
			script,
		});

		await sim.session.prompt("first cycle");
		// The reply asks the user something, so the route defers: one call, and
		// nothing appended to the model's context.
		expect(sim.providerCalls()).toBe(1);
		expect(developerMessageCount(sim)).toBe(0);

		await sim.session.prompt("second cycle");
		// Same route, same session, a reply that does announce work and stop. The
		// deferral cost it nothing: it nudges and re-wakes, and the question that
		// comes back ends the chain.
		expect(sim.providerCalls()).toBe(3);
		expect(developerMessageCount(sim)).toBe(1);
		expect(sim.session.isStreaming).toBe(false);
	});

	it("gives the cycle after a hold the same runway as one that never held", async () => {
		// The strong form of "deferring is not dropping": a route that already spent
		// part of its retry budget, then deferred to a question, must not carry that
		// spend into the next cycle. The owner is `#resetPromptMaintenanceState`,
		// which runs on the way into every prompt; the reset inside the hold itself
		// is the same invariant stated locally, and no route continues past a hold,
		// so nothing can reach this cycle without going through a prompt. The
		// expected count is MEASURED rather than written down, by driving a session
		// that never defers to its cap first, so the cap can change without touching
		// this test and the comparison still means what it says.
		alwaysReadsTheReplyAsAbandoned();
		const abandonedForever: ProviderScript = turn => {
			turn.text(ABANDONED_REPLY);
			turn.finish();
		};
		const settings = {
			"retry.enabled": false,
			"features.unexpectedStopDetection": true,
			"providers.unexpectedStopModel": "online",
		};

		sim = await createSimulation({ settings, script: abandonedForever });
		await sim.session.prompt("cap it");
		const fullRunway = sim.providerCalls();
		await sim.dispose();
		sim = undefined;
		expect(fullRunway).toBeGreaterThan(1);

		// Cycle 1 spends one retry and then hands the turn back with a question;
		// cycle 2 runs to the cap. It must take exactly as many calls as the session
		// above, which never held anything.
		const replies = [ABANDONED_REPLY, QUESTION_REPLY];
		let index = 0;
		sim = await createSimulation({
			settings,
			script: turn => {
				turn.text(replies[index] ?? ABANDONED_REPLY);
				index = Math.min(index + 1, replies.length);
				turn.finish();
			},
		});
		await sim.session.prompt("spend one, then ask");
		const spentThenHeld = sim.providerCalls();
		expect(spentThenHeld).toBe(2);

		index = replies.length;
		await sim.session.prompt("cap it after the hold");
		expect(sim.providerCalls() - spentThenHeld).toBe(fullRunway);
		expect(sim.session.isStreaming).toBe(false);
	});
});

describe("a forced tool choice belongs to the turn it was queued for", () => {
	it("reaches the continuation that owes the decision, and no user turn after it", async () => {
		// Plan-mode convergence answers a text-only turn by demanding a decision
		// tool on the next one. That demand is queued state: it is pushed at one
		// settle and spent by a turn that has not started yet, so a demand that
		// outlives its continuation would force a tool call on a plain user turn,
		// and the user's next question would be answered with a tool instead of a
		// sentence.
		const observed: Array<ToolChoice | undefined> = [];
		const replies = [ABANDONED_REPLY, QUESTION_REPLY, QUESTION_REPLY];
		let index = 0;
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			tools: [
				simTool(TOOL.ask, async () => ({ content: [{ type: "text", text: "asked" }] })),
				simTool(TOOL.resolve, async () => ({ content: [{ type: "text", text: "resolved" }] })),
			],
			script: turn => {
				observed.push(turn.toolChoice);
				turn.text(replies[Math.min(index++, replies.length - 1)] ?? QUESTION_REPLY);
				turn.finish();
			},
		});
		sim.session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md", workflow: "parallel" });

		await sim.session.prompt("first cycle");
		await sim.session.prompt("second cycle");

		// Call 1: a plain user turn, unforced. Call 2: the plan-mode continuation,
		// which is the one that owes a decision. Call 3: the next user turn, which
		// owes nothing and must be unforced again.
		//
		// `any` rather than `required`: the session queues the word `required`, and
		// pi-ai normalizes it per API family before the request leaves the process
		// (anthropic-shaped APIs, which the simulated model is, take `any`). The
		// assertion pins the value the provider actually receives, because a demand
		// that is dropped in that translation is dropped for real.
		expect(observed.length).toBe(3);
		expect(observed[0]).toBeUndefined();
		expect(observed[1]).toBe("any");
		expect(observed[2]).toBeUndefined();
		expect(sim.session.isStreaming).toBe(false);
	});
});
