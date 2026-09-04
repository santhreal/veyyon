/**
 * A cancel lands at every moment a turn has, and the session still settles.
 *
 * WHY THIS FILE EXISTS. `interjection-settling.test.ts` next door scripts the
 * cancels somebody already debugged: one during retry backoff, one during
 * compaction, one while an interruptible tool is running. Each of those is a
 * scenario, and each was written after a report. The class is wider than the
 * reports: a turn passes through a sequence of states (no event yet, text
 * streaming, a tool-call block half parsed, a call complete but the stream still
 * open, tools executing, one tool of two still running, a retry armed), the
 * cancel can land in any of them, and the state a cancel leaves behind is
 * exactly what the next request replays. A cancel is also the one moment the
 * loop DELETES content it already streamed (`retainCompletedToolCalls` drops a
 * call whose arguments never finished), so it is the likeliest place to leave a
 * `tool_use` nothing answers.
 *
 * So the cancel moment is a generated axis here, crossed with what the operator
 * does next, and every cell is judged by the same invariants a healthy turn is
 * judged by (`invariants.ts`). What is NOT asserted: how much of the partial
 * answer survives, or how many provider calls the cell cost. Those are product
 * decisions. A session that is still streaming, still retrying, holding a
 * queued message forever, or carrying an unpaired tool call is never fine.
 *
 * WHAT THIS DOES NOT CATCH, measured rather than assumed. A stranded sibling is
 * answered by TWO independent mechanisms: the pre-dispatch check that sees an
 * already-aborted signal, and the sweep over unresolved records once the batch
 * settles. Deleting either one alone leaves every cell here green, because the
 * other still pairs the call; both had to be removed before the queued cell went
 * red. So this file proves the PAIRING, not that each mechanism is live, and a
 * change that removes one of them silently is invisible here. That redundancy is
 * a property of the loop worth keeping: it is why an ordinary cancel does not
 * poison a session.
 *
 * Determinism: no wall-clock sleeps. Every cancel fires off a gate the scripted
 * provider or the scripted tool resolves, so the moment is causal rather than
 * timed, and a moment that never arrives fails as a test timeout instead of
 * passing quietly.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { AgentTool } from "@veyyon/agent-core";
import { USER_INTERRUPT_LABEL } from "@veyyon/coding-agent/session/messages";
import {
	createSimulation,
	lastAssistantText,
	type ProviderScript,
	type Simulation,
	scriptTurns,
	simTool,
	whenSessionEvent,
} from "./harness";
import { describeViolations, toolCallsIn, turnViolations } from "./invariants";

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

/** Everything one cancel moment needs: what the provider does, and when to cancel. */
interface StagedCancel {
	readonly script: ProviderScript;
	readonly tools: AgentTool[];
	readonly settings?: Record<string, unknown>;
	/** Resolves once the turn has genuinely reached the moment under test. */
	reached(simulation: Simulation): Promise<void>;
}

interface CancelPoint {
	readonly name: string;
	/** Fresh gates per cell: a promise reused across cells is already resolved. */
	open(): StagedCancel;
}

/**
 * A tool that never returns on its own and takes the abort.
 *
 * `exclusive` is what makes the siblings behind it real: with the default
 * `shared` scheduling every other call in the batch runs to completion while
 * this one hangs, so nothing is ever left unresolved and the pairing invariant
 * has nothing to be right about.
 */
function heldTool(name: string, entered: PromiseWithResolvers<void>): AgentTool {
	return simTool(
		name,
		async (_id, _args, signal) => {
			entered.resolve();
			const held = Promise.withResolvers<never>();
			signal?.addEventListener("abort", () => held.reject(new Error(`${name} aborted`)), { once: true });
			await held.promise;
			return { content: [{ type: "text", text: "never reached" }] };
		},
		{ interruptible: true, concurrency: "exclusive" },
	);
}

function answeringTool(name: string): AgentTool {
	return simTool(name, async () => ({ content: [{ type: "text", text: `${name} ran` }] }));
}

/** The turn every cell's follow-up prompt is served by. */
const answerTurn: ProviderScript = turn => {
	turn.text("answer after the cancel");
	turn.finish();
};

/**
 * The moments a turn passes through, each staged so the cancel is causal.
 *
 * A stream that is deliberately left open trips the harness's own idle
 * watchdog after 0.3s, so a cell whose gate resolves before that sees the
 * cancel land on a live stream, and one that races it sees the cancel land on a
 * turn the watchdog already ended. Both are real, both must settle, and neither
 * is allowed to leave an unpaired call behind.
 */
const CANCEL_POINTS: readonly CancelPoint[] = [
	{
		name: "before the provider emits anything",
		open: () => {
			const entered = Promise.withResolvers<void>();
			return {
				tools: [answeringTool("probe")],
				script: scriptTurns(async () => {
					entered.resolve();
					await Promise.withResolvers<never>().promise;
				}, answerTurn),
				reached: async () => {
					await entered.promise;
				},
			};
		},
	},
	{
		name: "while assistant text is streaming",
		open: () => ({
			tools: [answeringTool("probe")],
			script: scriptTurns(async turn => {
				turn.text("partial answer");
				await Promise.withResolvers<never>().promise;
			}, answerTurn),
			reached: async simulation => {
				await whenSessionEvent(simulation.session, event => event.type === "message_update");
			},
		}),
	},
	{
		name: "while a tool call's arguments are still arriving",
		open: () => ({
			tools: [answeringTool("probe")],
			script: scriptTurns(async turn => {
				turn.openToolCall("probe", '{"key": "unfin');
				await Promise.withResolvers<never>().promise;
			}, answerTurn),
			reached: async simulation => {
				await whenSessionEvent(simulation.session, event => event.type === "message_update");
			},
		}),
	},
	{
		name: "after a complete tool call, with the stream still open",
		open: () => ({
			tools: [answeringTool("probe")],
			script: scriptTurns(async turn => {
				turn.toolCall("probe", { key: "value" }, "call-open");
				await Promise.withResolvers<never>().promise;
			}, answerTurn),
			reached: async simulation => {
				await whenSessionEvent(simulation.session, event => event.type === "message_update");
			},
		}),
	},
	{
		name: "while the only tool is executing",
		open: () => {
			const entered = Promise.withResolvers<void>();
			return {
				tools: [heldTool("hold", entered)],
				script: scriptTurns(turn => {
					turn.toolCall("hold", {}, "call-hold");
					turn.finish("toolUse");
				}, answerTurn),
				reached: async () => {
					await entered.promise;
				},
			};
		},
	},
	{
		name: "while the second of two tools is executing",
		open: () => {
			const entered = Promise.withResolvers<void>();
			return {
				tools: [answeringTool("probe"), heldTool("hold", entered)],
				script: scriptTurns(turn => {
					turn.toolCall("probe", { key: "value" }, "call-fast");
					turn.toolCall("hold", {}, "call-slow");
					turn.finish("toolUse");
				}, answerTurn),
				reached: async () => {
					await entered.promise;
				},
			};
		},
	},
	{
		name: "while two more calls are queued behind the one that is running",
		open: () => {
			const entered = Promise.withResolvers<void>();
			return {
				// The held tool is dispatched FIRST, so the two behind it never enter
				// their own bodies and cannot answer themselves. Nothing but the
				// loop's own sweep over unresolved calls can pair them, which is the
				// state a cancel mid-batch actually leaves and the one an off-by-one
				// in that sweep survives.
				tools: [heldTool("hold", entered), answeringTool("probe")],
				script: scriptTurns(turn => {
					turn.toolCall("hold", {}, "call-blocking");
					turn.toolCall("probe", { key: "one" }, "call-queued-1");
					turn.toolCall("probe", { key: "two" }, "call-queued-2");
					turn.finish("toolUse");
				}, answerTurn),
				reached: async () => {
					await entered.promise;
				},
			};
		},
	},
	{
		name: "while a retry backoff is armed",
		open: () => ({
			tools: [answeringTool("probe")],
			settings: { "retry.enabled": true, "retry.baseDelayMs": 60_000, "retry.maxDelayMs": 120_000 },
			script: scriptTurns(turn => {
				turn.fail("503 Service Unavailable: upstream overloaded");
			}, answerTurn),
			reached: async simulation => {
				await whenSessionEvent(simulation.session, event => event.type === "auto_retry_start");
			},
		}),
	},
];

/** What the operator does after the cancel. Both are ordinary; both must hold. */
const FOLLOW_UPS = ["stops there", "prompts again"] as const;

describe("a cancel at any moment in a turn leaves a session that settles", () => {
	it("stages a cancel moment for every state a turn passes through", () => {
		// Non-vacuity floor. A refactor that empties the table would otherwise
		// turn this whole file into a suite that asserts nothing.
		expect(CANCEL_POINTS.length).toBeGreaterThanOrEqual(8);
		expect(new Set(CANCEL_POINTS.map(point => point.name)).size).toBe(CANCEL_POINTS.length);
		expect(FOLLOW_UPS.length).toBe(2);
	});

	for (const point of CANCEL_POINTS) {
		for (const followUp of FOLLOW_UPS) {
			it(`cancel ${point.name}, then the operator ${followUp}`, async () => {
				const staged = point.open();
				const cell = `cancel ${point.name} / ${followUp}`;
				sim = await createSimulation({
					settings: { "retry.enabled": false, ...staged.settings },
					tools: staged.tools,
					script: staged.script,
				});

				const cancelled = sim.session.prompt("go");
				await staged.reached(sim);
				await sim.session.abort({ reason: USER_INTERRUPT_LABEL });
				await cancelled;

				if (followUp === "prompts again") {
					await sim.session.prompt("again");
					// The follow-up is what proves the cancel released the session
					// rather than merely stopping the spinner: a leaked abort signal,
					// a held semaphore slot, or a stranded queue all show up here as
					// a prompt that never answers.
					expect(lastAssistantText(sim.session)).toBe("answer after the cancel");
				}

				const violations = turnViolations(sim);
				expect(describeViolations(cell, violations)).toEqual([]);
			});
		}
	}

	it("really did cancel a tool mid-execution rather than skipping the tool", async () => {
		// The invariant set is a list of absences, and a matrix of absences reads
		// the same whether it caught everything or ran nothing. This cell states
		// positively what the interesting moment produced: the tool was entered,
		// the call is in the transcript, and it carries an answer.
		const entered = Promise.withResolvers<void>();
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			tools: [heldTool("hold", entered)],
			script: scriptTurns(turn => {
				turn.toolCall("hold", {}, "call-hold");
				turn.finish("toolUse");
			}, answerTurn),
		});

		const cancelled = sim.session.prompt("go");
		await entered.promise;
		await sim.session.abort({ reason: USER_INTERRUPT_LABEL });
		await cancelled;

		expect(toolCallsIn(sim.session.messages).map(call => call.id)).toEqual(["call-hold"]);
		const results = sim.session.messages.filter(message => message.role === "toolResult");
		expect(results.length).toBe(1);
		expect(turnViolations(sim)).toEqual([]);
	});

	it("answers every call the cancel stranded behind the running one", async () => {
		// The pairing invariant is only load-bearing where a call CANNOT answer
		// itself. Here two calls are queued behind a held tool when the cancel
		// lands, so their results exist only if the loop sweeps its unresolved
		// records; an off-by-one in that sweep leaves a `tool_use` the next
		// request replays forever, and this is the cell that sees it.
		const entered = Promise.withResolvers<void>();
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			tools: [heldTool("hold", entered), answeringTool("probe")],
			script: scriptTurns(turn => {
				turn.toolCall("hold", {}, "call-blocking");
				turn.toolCall("probe", { key: "one" }, "call-queued-1");
				turn.toolCall("probe", { key: "two" }, "call-queued-2");
				turn.finish("toolUse");
			}, answerTurn),
		});

		const cancelled = sim.session.prompt("go");
		await entered.promise;
		await sim.session.abort({ reason: USER_INTERRUPT_LABEL });
		await cancelled;

		expect(toolCallsIn(sim.session.messages).map(call => call.id)).toEqual([
			"call-blocking",
			"call-queued-1",
			"call-queued-2",
		]);
		const answered = sim.session.messages
			.filter(message => message.role === "toolResult")
			.map(message => message.toolCallId);
		expect(answered.toSorted()).toEqual(["call-blocking", "call-queued-1", "call-queued-2"]);
		expect(turnViolations(sim)).toEqual([]);
	});
});
