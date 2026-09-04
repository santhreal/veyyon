/**
 * An aside reaches the model at a boundary, in order, or it is dropped on purpose.
 *
 * WHY THIS FILE EXISTS. Asides are the one channel that puts text in front of the
 * model without the user typing it: a background job that finished, an IRC message
 * from a peer, a mid-run todo nudge, recalled memory, a TTSR reminder. They are
 * injected at two different points in the loop, and the difference between them is
 * the whole contract. Mid-work (tool calls still pending) an aside rides the
 * continuation that was already going to happen, folded in behind live steering.
 * At a stop boundary there is no next request, so a queued aside earns one, batched
 * with any follow-ups so a passive aside cannot jump the queue.
 *
 * Every failure in this class is silent. An aside injected in the wrong place
 * breaks tool-call pairing on the wire and the provider rejects the request; an
 * aside that is never drained is a job completion the model never hears about and
 * an operator who watches the agent sit there; an aside drained during an abort is
 * a message that lands in history while the run is dying, which is the stranding
 * shape that produced the "Working..." stall class. None of it shows up as a wrong
 * answer.
 *
 * The rows drive the real seam. `session.yieldQueue` is the production producer
 * (advisor notes and job completions register exactly this way, with
 * `skipIdleFlush` so only the loop's own injection points drain them), and the
 * assertions read what the provider actually received.
 *
 * WHAT THIS DOES NOT CATCH.
 *   - The idle flush. These rows register `skipIdleFlush: true`, the shape the
 *     advisor channel uses, so the queue is drained only by the loop. A kind
 *     without that flag also reaches the model through `YieldQueue.flush("idle")`,
 *     which is a different owner (the session's idle scheduler) and a different
 *     matrix.
 *   - Which producer built the message. Nothing here asserts todo-nudge or IRC
 *     specifics; the class under test is the injection point and the ordering, and
 *     every producer above shares it.
 *   - The abort guard on the stop-boundary drain. Removing `signal?.aborted ? []`
 *     there changes nothing: on a cancel the loop returns before it reaches that
 *     drain, so what keeps the aside alive is the queue never being drained, not
 *     that guard. The guard is defence in depth for a path these rows do not
 *     reach, and the cancel row measures the survival, not the guard.
 *
 * RED PROOFS, observed rather than predicted.
 *   - Mid-work drain removed (`pendingMessages = steering`): only the mid-work row
 *     reds. The steering-order row survives it, because the steer and the aside
 *     then meet at the stop boundary, where the order is the same.
 *   - Order flipped to `[...asides, ...steering]`: only the steering-order row.
 *   - Stop-boundary drain emptied: the stop-boundary row and the after-cancel
 *     delivery, which is the request that drain creates.
 *   - Staleness ignored in `YieldQueue.#build`: only the batching row.
 *   - `resolveAsides` pushing a null instead of dropping it: five of the seven
 *     rows. The declined-aside row is NOT one of them, and that is worth saying
 *     plainly: a null reaching the batch kills the run before it can spend a turn,
 *     which is a louder failure than the one that row describes.
 */

import { afterEach, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { USER_INTERRUPT_LABEL } from "@veyyon/coding-agent/session/messages";
import { createSimulation, type Simulation, simTool } from "./harness";
import { describeViolations, pairingViolations } from "./invariants";

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

const ASIDE_KIND = "sim-job";

interface JobEntry {
	text: string;
	/** Flipped after enqueue to prove the staleness filter runs at injection time. */
	stale?: boolean;
	/** Every survivor declining makes the whole batch decline. */
	decline?: boolean;
}

/**
 * Register the aside channel a background job would use: one batched hidden
 * custom message per drain, a per-entry staleness filter, and `skipIdleFlush` so
 * the loop's injection points are the only thing that drains it.
 */
function registerJobAsides(simulation: Simulation): void {
	simulation.session.yieldQueue.register<JobEntry>(ASIDE_KIND, {
		isStale: entry => entry.stale === true,
		build: entries => {
			if (entries.length === 0 || entries.every(entry => entry.decline)) return null;
			return {
				role: "custom",
				customType: ASIDE_KIND,
				content: `job update: ${entries.map(entry => entry.text).join(" + ")}`,
				display: false,
				attribution: "agent",
				timestamp: Date.now(),
			};
		},
		skipIdleFlush: true,
	});
}

function messageText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => {
			const text = (part as { text?: unknown }).text;
			return typeof text === "string" ? text : "";
		})
		.join(" ");
}

function indexOfText(messages: AgentMessage[], needle: string): number {
	return messages.findIndex(message => messageText(message).includes(needle));
}

/** Stored asides, identified by the custom type the producer stamped. */
function asideMessages(messages: AgentMessage[]): AgentMessage[] {
	return messages.filter(message => (message as { customType?: unknown }).customType === ASIDE_KIND);
}

/**
 * Asides as the PROVIDER sees them. The conversion to the wire drops the custom
 * type, so the batch marker in the text is the only handle left, which is exactly
 * why the producer puts one there.
 */
function asidesOnTheWire(messages: AgentMessage[]): string[] {
	return messages.map(messageText).filter(text => text.includes("job update:"));
}

it("folds a mid-work aside into the continuation, behind the tool result", async () => {
	let secondRequest: AgentMessage[] = [];
	sim = await createSimulation({
		tools: [
			simTool("work", async () => {
				// A background job finishes while the tool runs: the classic aside.
				sim?.session.yieldQueue.enqueue<JobEntry>(ASIDE_KIND, { text: "build finished" });
				return { content: [{ type: "text", text: "tool output" }] };
			}),
		],
		script: turn => {
			if (turn.call === 1) {
				turn.toolCall("work", { step: 1 }, "call-1");
				turn.finish("toolUse");
				return;
			}
			secondRequest = [...turn.context.messages];
			turn.text("acknowledged the job");
			turn.finish();
		},
	});
	registerJobAsides(sim);

	await sim.session.prompt("go");

	// The aside rides the request the tool call already required: no extra turn.
	expect(sim.providerCalls()).toBe(2);
	const asideIndex = indexOfText(secondRequest, "build finished");
	const resultIndex = secondRequest.findIndex(message => message.role === "toolResult");
	expect(asideIndex).toBeGreaterThan(-1);
	// Behind the result, never between the call and its result: a split pair is a
	// provider-side rejection, not a formatting nit.
	expect(resultIndex).toBeGreaterThan(-1);
	expect(asideIndex).toBeGreaterThan(resultIndex);
	expect(describeViolations("mid-work aside request", pairingViolations(secondRequest))).toEqual([]);
	expect(describeViolations("stored history", pairingViolations(sim.session.messages))).toEqual([]);
});

it("earns exactly one more turn for an aside queued at a stop boundary", async () => {
	let sawAside = false;
	sim = await createSimulation({
		script: turn => {
			if (turn.call === 1) {
				// Queued while the final turn streams, so there is no request left to
				// ride: the stop-boundary drain has to create one.
				sim?.session.yieldQueue.enqueue<JobEntry>(ASIDE_KIND, { text: "deploy finished" });
				turn.text("first answer");
				turn.finish();
				return;
			}
			sawAside = indexOfText(turn.context.messages, "deploy finished") > -1;
			turn.text("acknowledged the deploy");
			turn.finish();
		},
	});
	registerJobAsides(sim);

	await sim.session.prompt("go");

	expect(sim.providerCalls()).toBe(2);
	expect(sawAside).toBe(true);
	expect(sim.session.isStreaming).toBe(false);
	// One extra turn, not a loop: the second turn's own drain finds nothing.
	expect(sim.session.messages.at(-1)?.role).toBe("assistant");
});

it("puts live steering ahead of an aside in the same batch", async () => {
	const toolEntered = Promise.withResolvers<void>();
	const releaseTool = Promise.withResolvers<void>();
	let secondRequest: AgentMessage[] = [];
	sim = await createSimulation({
		settings: { "retry.enabled": false },
		tools: [
			simTool("work", async () => {
				sim?.session.yieldQueue.enqueue<JobEntry>(ASIDE_KIND, { text: "index rebuilt" });
				toolEntered.resolve();
				await releaseTool.promise;
				return { content: [{ type: "text", text: "tool output" }] };
			}),
		],
		script: turn => {
			if (turn.call === 1) {
				turn.toolCall("work", { step: 1 }, "call-1");
				turn.finish("toolUse");
				return;
			}
			secondRequest = [...turn.context.messages];
			turn.text("answered the steer");
			turn.finish();
		},
	});
	registerJobAsides(sim);

	const run = sim.session.prompt("go");
	await toolEntered.promise;
	await sim.session.prompt("actually check the other thing", { streamingBehavior: "steer" });
	releaseTool.resolve();
	await run;

	// What the user just typed outranks a background notice. Both arrive in one
	// batch, so the order is the only thing that carries the priority.
	const steerIndex = indexOfText(secondRequest, "actually check the other thing");
	const asideIndex = indexOfText(secondRequest, "index rebuilt");
	expect(steerIndex).toBeGreaterThan(-1);
	expect(asideIndex).toBeGreaterThan(steerIndex);
});

it("drops a declined aside without spending a turn on it", async () => {
	sim = await createSimulation({
		script: turn => {
			if (turn.call === 1) {
				// The producer decides at injection time that this is no longer worth
				// saying: a late diagnostic a newer edit superseded.
				sim?.session.yieldQueue.enqueue<JobEntry>(ASIDE_KIND, { text: "superseded", decline: true });
			}
			turn.text("only answer");
			turn.finish();
		},
	});
	registerJobAsides(sim);

	await sim.session.prompt("go");

	// A thunk returning null must not be indistinguishable from a message: it
	// costs no request and leaves no history.
	expect(sim.providerCalls()).toBe(1);
	expect(asideMessages(sim.session.messages)).toEqual([]);
	expect(sim.session.isStreaming).toBe(false);
});

it("batches a turn's entries into one aside and filters the stale one", async () => {
	let secondRequest: AgentMessage[] = [];
	sim = await createSimulation({
		tools: [
			simTool("work", async () => {
				const superseded: JobEntry = { text: "first attempt" };
				sim?.session.yieldQueue.enqueue<JobEntry>(ASIDE_KIND, superseded);
				sim?.session.yieldQueue.enqueue<JobEntry>(ASIDE_KIND, { text: "second attempt" });
				sim?.session.yieldQueue.enqueue<JobEntry>(ASIDE_KIND, { text: "third attempt" });
				// Marked stale AFTER it was queued. The filter runs when the loop
				// injects, so this entry must not reach the model.
				superseded.stale = true;
				return { content: [{ type: "text", text: "tool output" }] };
			}),
		],
		script: turn => {
			if (turn.call === 1) {
				turn.toolCall("work", { step: 1 }, "call-1");
				turn.finish("toolUse");
				return;
			}
			secondRequest = [...turn.context.messages];
			turn.text("acknowledged both");
			turn.finish();
		},
	});
	registerJobAsides(sim);

	await sim.session.prompt("go");

	// Three enqueues, one message: a batching channel that injected one message
	// per entry would flood the context on a busy job queue.
	const asides = asidesOnTheWire(secondRequest);
	expect(asides.length).toBe(1);
	const text = asides[0]!;
	expect(text).toContain("second attempt");
	expect(text).toContain("third attempt");
	expect(text).not.toContain("first attempt");
});

it("keeps an aside queued when the run is cancelled, and delivers it on the next run", async () => {
	const toolEntered = Promise.withResolvers<void>();
	const requests: AgentMessage[][] = [];
	sim = await createSimulation({
		settings: { "retry.enabled": false },
		tools: [
			simTool("work", async (_id, _args, signal) => {
				sim?.session.yieldQueue.enqueue<JobEntry>(ASIDE_KIND, { text: "backup finished" });
				toolEntered.resolve();
				await new Promise<void>(resolve => {
					if (signal?.aborted) return resolve();
					signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return { content: [{ type: "text", text: "tool output" }] };
			}),
		],
		script: turn => {
			requests.push([...turn.context.messages]);
			if (turn.call === 1) {
				turn.toolCall("work", { step: 1 }, "call-1");
				turn.finish("toolUse");
				return;
			}
			turn.text("answer after the cancel");
			turn.finish();
		},
	});
	registerJobAsides(sim);

	const cancelled = sim.session.prompt("go");
	await toolEntered.promise;
	await sim.session.abort({ reason: USER_INTERRUPT_LABEL });
	await cancelled;

	// Draining into a dying run is how an aside gets stranded: the message lands
	// in history right before a request that instantly aborts, and no turn ever
	// answers it. The queue keeps it instead.
	expect(asideMessages(sim.session.messages)).toEqual([]);

	await sim.session.prompt("what happened?");

	const delivered = requests.at(-1) ?? [];
	expect(indexOfText(delivered, "backup finished")).toBeGreaterThan(-1);
	expect(sim.session.isStreaming).toBe(false);
});

it("does not poll the aside channel while the session is idle", async () => {
	sim = await createSimulation({
		script: turn => {
			turn.text("answer");
			turn.finish();
		},
	});
	registerJobAsides(sim);

	await sim.session.prompt("go");
	// Queued with nothing running. `skipIdleFlush` means no idle scheduler picks
	// it up, so it waits for the next run rather than waking the agent.
	sim.session.yieldQueue.enqueue<JobEntry>(ASIDE_KIND, { text: "queued while idle" });
	// A negative needs a window in which the flush could have happened.
	await new Promise<void>(resolve => setTimeout(resolve, 50));

	expect(sim.providerCalls()).toBe(1);
	expect(sim.session.isStreaming).toBe(false);
	expect(sim.session.yieldQueue.has(ASIDE_KIND)).toBe(true);
});
