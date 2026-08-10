/**
 * A turn the provider refuses because the context is too long, and the turn a
 * provider truncates because the output budget ran out.
 *
 * Both are handled by one owner, `AgentSession.#checkCompaction`, and both take
 * the same ladder: promote to a larger model, else compact in place and retry,
 * else stop. The ladder pulls the failed assistant turn out of active context
 * before it climbs, so a retry cannot replay it, and that is where the class of
 * defects lives: every rung that does NOT schedule a retry has to put the turn
 * back, or the user's question resolves with no answer, no error and no reason.
 *
 * ROWS. Overflow and a `length` stop, each with compaction available and with
 * compaction off, plus an overflow stamped with a model the user switched away
 * from mid-failure (which must recover nothing and must not compact the new
 * model's history), plus a plain 400 as the control: it never enters the ladder,
 * so it is what "an error the user can see" looks like when nothing intervenes.
 *
 * WHAT IS ASSERTED. Whether a summarization request was made at all (a request
 * carrying no tools is the summarizer, which is how the loop identifies it),
 * whether the turn was retried, that the retried turn answers, and that a dead
 * end leaves the failure visible in context with its stop reason intact. Store
 * and wire pairing are checked on every row, because a recovery rewrites both.
 *
 * DEFECT THIS SUITE FIXES. With compaction disabled, an overflow was removed
 * from active context and never restored: `prompt` resolved, no assistant
 * message existed, no error event fired, and the branch held nothing, so the
 * one failure that most needs an explanation ("your context is too long") was
 * the only one that produced total silence. The same hole sat on the `length`
 * rung, whose comment claimed it surfaced the dead end while the message was
 * already gone. Both dead ends now restore into active context only, because
 * the branch entry was never dropped there and re-appending would duplicate it.
 *
 * RED PROOFS. Reverting either dead-end restore (dropping
 * `#restoreFailedAssistantTurnToActiveContext`) reds that rung's row with
 * `overflow, compaction off surfaced=user stop=none` instead of
 * `surfaced=assistant stop=error`, and the `length` row the same way, leaving the
 * other five green. Dropping the rollback restore inside
 * `#runRecoveryCompactionWithRollback` reds only the failing-summarizer row, so
 * that row covers the rollback rather than restating the dead ends.
 *
 * NOT asserted: promotion to a larger model. A promotion target is resolved from
 * `contextPromotionTarget` against the registry's available models, which a
 * simulated model is not in, so that rung is unreachable here and is left to the
 * unit tests that own the resolver.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createSimulation, type Simulation, simTool, simulatedModel } from "./harness";
import { describeViolations, pairingViolations, turnViolations } from "./invariants";

/** Bedrock's wording. The classifier flags it as a context overflow. */
const OVERFLOW_MESSAGE = "input is too long for requested model";
/** Big enough that four rounds of it exceed the recent-keep budget. */
const BULK = `worked. ${"tool output line. ".repeat(900)}`;

interface Call {
	readonly index: number;
	readonly tools: number;
	readonly model: string;
	/**
	 * Coarse size of the request, four characters per token. Only ever compared
	 * against another request from the same row, so the slop cancels.
	 */
	readonly tokens: number;
}

function estimatedTokens(messages: readonly unknown[]): number {
	return Math.ceil(JSON.stringify(messages).length / 4);
}

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

/**
 * Serve nine ordinary calls, fail the ninth in the requested way, then answer.
 * A request with no tools is the summarizer; it gets a summary and nothing else.
 */
function serve(
	calls: Call[],
	failure: "overflow" | "length" | "plain",
): Parameters<typeof createSimulation>[0]["script"] {
	return async turn => {
		const tools = turn.context.tools?.length ?? 0;
		calls.push({ index: turn.call, tools, model: turn.model.id, tokens: estimatedTokens(turn.context.messages) });
		if (tools === 0) {
			turn.text("SUMMARY: the user asked four things and a tool ran each time.");
			turn.finish();
			return;
		}
		if (turn.call === 9) {
			if (failure === "overflow") {
				turn.fail(OVERFLOW_MESSAGE);
				return;
			}
			if (failure === "plain") {
				turn.fail("400 Bad Request: the model refused");
				return;
			}
			turn.text("half an answer");
			turn.finish("length");
			return;
		}
		if (turn.call % 2 === 1) {
			turn.toolCall("work", {}, "call_0");
			turn.finish("toolUse");
			return;
		}
		turn.text(`answer ${turn.call}`);
		turn.finish();
	};
}

/** Four prompts of tool work, so the history is worth compacting. */
async function fourRounds(simulation: Simulation): Promise<void> {
	for (const text of ["one", "two", "three", "four"]) await simulation.session.prompt(text);
}

/**
 * The recovery continuation is scheduled with a delay, so the fifth prompt
 * resolving is not the end of the story. Wait for the session to go quiet.
 */
async function quiet(simulation: Simulation): Promise<void> {
	const deadline = Date.now() + 4_000;
	while (Date.now() < deadline) {
		await new Promise(resolve => setTimeout(resolve, 25));
		if (!simulation.session.isStreaming && !simulation.session.agent.hasQueuedMessages()) {
			// Two quiet checks in a row: a scheduled continuation has a gap before it
			// starts, and one look could land inside it.
			await new Promise(resolve => setTimeout(resolve, 150));
			if (!simulation.session.isStreaming && !simulation.session.agent.hasQueuedMessages()) return;
		}
	}
	throw new Error("session never settled");
}

/** What the user is left looking at: the last message and its stop reason. */
function surfaced(simulation: Simulation): string {
	const last = simulation.session.messages.at(-1);
	if (!last) return "surfaced=none stop=none";
	const stop = (last as { stopReason?: string }).stopReason ?? "none";
	return `surfaced=${last.role} stop=${stop}`;
}

function texts(simulation: Simulation): string {
	return simulation.session.messages
		.flatMap(message => (Array.isArray(message.content) ? message.content : []))
		.map(block => block as { type?: string; text?: string })
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join(" | ");
}

describe("a turn the provider refuses for size", () => {
	it("compacts and retries an overflow when compaction is available", async () => {
		const calls: Call[] = [];
		sim = await createSimulation({
			settings: { "retry.enabled": false, "compaction.enabled": true },
			tools: [simTool("work", async () => ({ content: [{ type: "text", text: BULK }] }))],
			script: serve(calls, "overflow"),
		});

		await fourRounds(sim);
		await sim.session.prompt("five");
		await quiet(sim);

		// A summarizer request was made, and a turn ran after it: that pair is the
		// recovery. Neither alone proves it.
		expect(calls.some(call => call.tools === 0)).toBe(true);
		expect(calls.at(-1)?.tools).toBeGreaterThan(0);
		expect(calls.at(-1)?.index).toBeGreaterThan(9);
		const finished = sim.eventsOfType("auto_compaction_end");
		expect(finished.length).toBeGreaterThan(0);
		expect(finished.every(event => !event.aborted)).toBe(true);
		// The recovery has to make the request smaller, whichever rung did it: this
		// ladder can summarize the old turns or elide bulk tool output in place, and
		// pinning either spelling would pass on a build that shrank nothing.
		const refused = calls.find(call => call.index === 9)?.tokens ?? 0;
		const retried = calls.at(-1)?.tokens ?? 0;
		expect(`retry ${retried} smaller than refused ${refused}: ${retried < refused}`).toBe(
			`retry ${retried} smaller than refused ${refused}: true`,
		);
		expect(surfaced(sim)).toBe("surfaced=assistant stop=stop");
		expect(describeViolations("overflow recovered", turnViolations(sim))).toEqual([]);
		expect(describeViolations("overflow recovered store", pairingViolations(sim.session.messages))).toEqual([]);
	});

	it("leaves an overflow visible when compaction cannot run", async () => {
		const calls: Call[] = [];
		sim = await createSimulation({
			// Compaction off is the operator's choice, and it removes the only rung
			// this ladder has left once promotion is unavailable.
			settings: { "retry.enabled": false },
			tools: [simTool("work", async () => ({ content: [{ type: "text", text: BULK }] }))],
			script: serve(calls, "overflow"),
		});

		await fourRounds(sim);
		await sim.session.prompt("five");
		await quiet(sim);

		expect(calls.some(call => call.tools === 0)).toBe(false);
		expect(calls.at(-1)?.index).toBe(9);
		expect(sim.eventsOfType("auto_compaction_end")).toEqual([]);
		// The whole point: the refused turn is what tells the user why nothing came
		// back, so it must be the message they are left with.
		expect(`overflow, compaction off ${surfaced(sim)}`).toBe(
			"overflow, compaction off surfaced=assistant stop=error",
		);
		expect(describeViolations("overflow dead end store", pairingViolations(sim.session.messages))).toEqual([]);
	});

	it("compacts and retries a truncated turn when compaction is available", async () => {
		const calls: Call[] = [];
		sim = await createSimulation({
			settings: { "retry.enabled": false, "compaction.enabled": true },
			tools: [simTool("work", async () => ({ content: [{ type: "text", text: BULK }] }))],
			script: serve(calls, "length"),
		});

		await fourRounds(sim);
		await sim.session.prompt("five");
		await quiet(sim);

		expect(calls.some(call => call.tools === 0)).toBe(true);
		expect(calls.at(-1)?.index).toBeGreaterThan(9);
		expect(sim.eventsOfType("auto_compaction_end").length).toBeGreaterThan(0);
		expect(surfaced(sim)).toBe("surfaced=assistant stop=stop");
		expect(describeViolations("length recovered store", pairingViolations(sim.session.messages))).toEqual([]);
	});

	it("leaves a truncated turn visible when compaction cannot run", async () => {
		const calls: Call[] = [];
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			tools: [simTool("work", async () => ({ content: [{ type: "text", text: BULK }] }))],
			script: serve(calls, "length"),
		});

		await fourRounds(sim);
		await sim.session.prompt("five");
		await quiet(sim);

		expect(calls.some(call => call.tools === 0)).toBe(false);
		// The half answer the provider did manage is the user's only evidence that
		// the model ran out of room, so it stays, stop reason included.
		expect(`length, compaction off ${surfaced(sim)}`).toBe("length, compaction off surfaced=assistant stop=length");
		expect(texts(sim)).toContain("half an answer");
		expect(describeViolations("length dead end store", pairingViolations(sim.session.messages))).toEqual([]);
	});

	it("does not compact the new model's history for an overflow the old model reported", async () => {
		const calls: Call[] = [];
		const failing = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		sim = await createSimulation({
			modelId: "sim-model-a",
			settings: { "retry.enabled": false, "compaction.enabled": true },
			tools: [simTool("work", async () => ({ content: [{ type: "text", text: BULK }] }))],
			script: async turn => {
				const tools = turn.context.tools?.length ?? 0;
				calls.push({ index: turn.call, tools, model: turn.model.id });
				if (tools === 0) {
					turn.text("SUMMARY: should not happen on this row.");
					turn.finish();
					return;
				}
				if (turn.call === 9) {
					failing.resolve();
					await release.promise;
					turn.fail(OVERFLOW_MESSAGE);
					return;
				}
				if (turn.call % 2 === 1) {
					turn.toolCall("work", {}, "call_0");
					turn.finish("toolUse");
					return;
				}
				turn.text(`answer ${turn.call}`);
				turn.finish();
			},
		});

		await fourRounds(sim);
		const pending = sim.session.prompt("five");
		await failing.promise;
		// The user switches away while the doomed call is still open, so the error
		// arrives stamped with a model the session no longer holds.
		await sim.session.setModel(simulatedModel("sim-model-b"));
		release.resolve();
		await pending;
		await quiet(sim);

		// A foreign model's size complaint says nothing about what fits the model
		// now in use, so nothing may be summarized away on its word.
		expect(sim.eventsOfType("auto_compaction_end")).toEqual([]);
		expect(calls.some(call => call.tools === 0)).toBe(false);
		expect(`foreign overflow ${surfaced(sim)}`).toBe("foreign overflow surfaced=assistant stop=error");
		expect(describeViolations("foreign overflow store", pairingViolations(sim.session.messages))).toEqual([]);

		// And the session still works on the new model.
		await sim.session.prompt("six");
		await quiet(sim);
		expect(calls.at(-1)?.model).toBe("sim-model-b");
		expect(describeViolations("foreign overflow after", pairingViolations(sim.session.messages))).toEqual([]);
	});

	it("keeps the refusal visible when the summarizer itself fails", async () => {
		const calls: Call[] = [];
		sim = await createSimulation({
			settings: { "retry.enabled": false, "compaction.enabled": true },
			tools: [simTool("work", async () => ({ content: [{ type: "text", text: BULK }] }))],
			script: async turn => {
				const tools = turn.context.tools?.length ?? 0;
				calls.push({
					index: turn.call,
					tools,
					model: turn.model.id,
					tokens: estimatedTokens(turn.context.messages),
				});
				// The recovery's own request is the one that dies here, which is the
				// case the rollback exists for: history was never rewritten, so the
				// refusal has to come back rather than leaving an empty turn behind.
				if (tools === 0) {
					turn.fail("500 Internal Server Error: summarizer unavailable");
					return;
				}
				if (turn.call === 9) {
					turn.fail(OVERFLOW_MESSAGE);
					return;
				}
				if (turn.call % 2 === 1) {
					turn.toolCall("work", {}, "call_0");
					turn.finish("toolUse");
					return;
				}
				turn.text(`answer ${turn.call}`);
				turn.finish();
			},
		});

		await fourRounds(sim);
		await sim.session.prompt("five");
		await quiet(sim);

		// The summarizer was asked and refused, so no summary exists.
		expect(calls.some(call => call.tools === 0)).toBe(true);
		expect(sim.session.messages.some(message => message.role === "compactionSummary")).toBe(false);
		expect(`summarizer failed ${surfaced(sim)}`).toBe("summarizer failed surfaced=assistant stop=error");
		expect(describeViolations("summarizer failed store", pairingViolations(sim.session.messages))).toEqual([]);
		expect(sim.session.isStreaming).toBe(false);
	});

	it("leaves a plain provider error visible without entering the ladder", async () => {
		const calls: Call[] = [];
		sim = await createSimulation({
			settings: { "retry.enabled": false, "compaction.enabled": true },
			tools: [simTool("work", async () => ({ content: [{ type: "text", text: BULK }] }))],
			script: serve(calls, "plain"),
		});

		await fourRounds(sim);
		await sim.session.prompt("five");
		await quiet(sim);

		// The control for the two dead-end rows: an error that never touches the
		// size ladder is left in context, which is the behaviour they must match.
		expect(sim.eventsOfType("auto_compaction_end")).toEqual([]);
		expect(calls.some(call => call.tools === 0)).toBe(false);
		expect(`plain 400 ${surfaced(sim)}`).toBe("plain 400 surfaced=assistant stop=error");
	});
});
