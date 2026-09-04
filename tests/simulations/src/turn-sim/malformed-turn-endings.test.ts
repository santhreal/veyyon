/**
 * Simulations for turns that end in a shape the happy path never produces:
 * tool calls whose arguments were still streaming, a model that will not stop
 * talking, and two turns run back to back over the same session.
 *
 * All three are hang-class: the first can strand a tool call that is never
 * answered, the second can burn a turn forever, and the third is how state
 * from an aborted turn latches into the next one.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { createSimulation, lastAssistantText, type Simulation, scriptTurns, simTool, toolResultTexts } from "./harness";

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

function lastAssistant(simulation: Simulation): AssistantMessage {
	const message = simulation.session.messages.at(-1);
	if (message?.role !== "assistant") throw new Error(`expected assistant tail, got ${message?.role}`);
	return message;
}

describe("a stream that ends mid-tool-call", () => {
	it("terminates the turn when the arguments were still streaming", async () => {
		// The provider announced a tool call, streamed half its JSON, and then
		// declared the turn done. Nothing ever closed the call. The danger is a
		// tool_use with no tool_result: the next request is malformed, and the
		// session sits waiting for a result that cannot arrive.
		let toolRuns = 0;
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			tools: [
				simTool("edit", async () => {
					toolRuns += 1;
					return { content: [{ type: "text", text: "edit ok" }] };
				}),
			],
			script: scriptTurns(
				turn => {
					turn.openToolCall("edit", '{"path":"/tmp/a.ts","content":"half a str');
					turn.finish();
				},
				turn => {
					turn.text("recovered from the truncated call");
					turn.finish();
				},
			),
		});

		await sim.session.prompt("edit the file");

		expect(sim.session.isStreaming).toBe(false);
		// Whether the truncated call is dispatched or refused, it must be
		// ANSWERED: an unanswered tool_use is what wedges the next request.
		const assistantWithCall = sim.session.messages.find(
			message => message.role === "assistant" && message.content.some(block => block.type === "toolCall"),
		);
		if (assistantWithCall) {
			expect(toolResultTexts(sim.session).length).toBeGreaterThan(0);
		}
		expect(toolRuns).toBeLessThanOrEqual(1);
	});

	it("terminates the turn when the provider dies with the call still open", async () => {
		// Same shape, worse ending: the socket goes quiet with the arguments
		// half-streamed, so the watchdog is the only thing that can end it.
		const stalled = Promise.withResolvers<never>();
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			tools: [simTool("edit", async () => ({ content: [{ type: "text", text: "edit ok" }] }))],
			script: async turn => {
				turn.openToolCall("edit", '{"path":"/tmp/a.ts"');
				await stalled.promise;
			},
		});

		await sim.session.prompt("edit the file");

		expect(sim.session.isStreaming).toBe(false);
		const errored = sim.session.messages.find(
			message => message.role === "assistant" && message.stopReason === "error",
		) as AssistantMessage | undefined;
		expect(errored?.errorMessage).toContain("stalled");
		// The call that was cut off mid-arguments must be named, not silently
		// dropped: the model has to know the arguments never finished, or it
		// copies a half-written call back verbatim on the retry.
		expect(errored?.incompleteToolCalls?.map(call => call.name)).toEqual(["edit"]);
		const ledger = sim.session.messages.at(-1);
		expect(ledger?.role).toBe("user");
		const ledgerContent = ledger?.role === "user" ? ledger.content : "";
		const ledgerText = typeof ledgerContent === "string" ? ledgerContent : JSON.stringify(ledgerContent);
		expect(ledgerText).toContain("arguments never finished");
	});
});

describe("a model that will not stop", () => {
	it("cuts a runaway text loop off instead of letting it run the turn out", async () => {
		// A provider that keeps emitting progress forever never trips the idle
		// watchdog: the bytes ARE arriving. The loop guard is the only thing
		// standing between that and a turn that burns its whole budget saying
		// nothing, so the guard is what this asserts, on a model the product
		// actually guards.
		//
		// The runaway is bounded at 400 deltas so a REMOVED guard fails on an
		// assertion rather than hanging the suite; the contract is that the guard
		// fires long before the provider runs out of things to say. Each delta
		// yields a microtask so the guard's consumer keeps pace, which is the
		// only "waiting" here: no clock is involved.
		const RUNAWAY_DELTAS = 400;
		let emitted = 0;
		sim = await createSimulation({
			modelId: "deepseek-sim-v1",
			script: scriptTurns(
				async turn => {
					for (let index = 0; index < RUNAWAY_DELTAS; index++) {
						if (turn.signal?.aborted || turn.stream.done) break;
						emitted += 1;
						turn.text("Confirming the plan, maintaining momentum, pushing ahead. ");
						await Promise.resolve();
					}
					turn.finish();
				},
				turn => {
					turn.text("stopped looping");
					turn.finish();
				},
			),
		});

		await sim.session.prompt("go");

		expect(sim.session.isStreaming).toBe(false);
		expect(emitted).toBeLessThan(RUNAWAY_DELTAS);
		// The turn is not merely cut: the model is told WHY, so the re-sample has
		// a chance of going somewhere different.
		const redirect = sim.session.messages.find(
			message => message.role === "custom" && message.customType === "thinking-loop-redirect",
		);
		expect(redirect).toBeDefined();
		expect(lastAssistantText(sim.session)).toContain("stopped looping");
	});
});

describe("back to back turns", () => {
	it("carries no state from an aborted turn into the next one", async () => {
		// The reported shape: a turn is cancelled, the next prompt runs, and it
		// behaves as if the cancelled turn were still in flight. Three ways that
		// shows up are checked here: the second turn must actually reach the
		// provider, it must not inherit the abort, and it must produce its own
		// answer rather than replaying the cancelled one.
		const toolEntered = Promise.withResolvers<void>();
		const observed: Array<{ call: number; aborted: boolean | undefined }> = [];

		sim = await createSimulation({
			settings: { "retry.enabled": false },
			tools: [
				simTool("wedge", async (_id, _args, signal) => {
					toolEntered.resolve();
					const held = Promise.withResolvers<never>();
					signal?.addEventListener("abort", () => held.reject(new Error("tool aborted")), { once: true });
					await held.promise;
					return { content: [{ type: "text", text: "never reached" }] };
				}),
			],
			script: async turn => {
				observed.push({ call: turn.call, aborted: turn.signal?.aborted });
				if (turn.call === 1) {
					turn.toolCall("wedge", {});
					turn.finish();
					return;
				}
				turn.text(`answer from call ${turn.call}`);
				turn.finish();
			},
		});

		const first = sim.session.prompt("first");
		await toolEntered.promise;
		await sim.session.abort({ reason: "user interrupt" });
		await first;

		const callsDuringAbort = observed.length;
		await sim.session.prompt("second");

		// The follow-up turn is a NEW request with a clean signal. The cancelled
		// turn's abort must not ride into it, which is the latch this is
		// guarding: an inherited aborted signal makes the next prompt look like
		// it ran and answered nothing.
		const followUp = observed.at(-1);
		expect(followUp?.call).toBeGreaterThan(callsDuringAbort);
		expect(followUp?.aborted).toBe(false);
		expect(lastAssistantText(sim.session)).toBe(`answer from call ${followUp?.call}`);
		expect(sim.session.isStreaming).toBe(false);
		expect(sim.session.isAborting).toBe(false);
	});

	it("runs a clean turn after a turn the watchdog killed", async () => {
		// A stalled turn leaves an errored assistant message behind. The next
		// prompt must still start a normal turn against that transcript rather
		// than inheriting the failure.
		const stalled = Promise.withResolvers<never>();
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			script: scriptTurns(
				async turn => {
					turn.text("dying");
					await stalled.promise;
				},
				turn => {
					turn.text("healthy again");
					turn.finish();
				},
			),
		});

		await sim.session.prompt("first");
		expect(lastAssistant(sim).stopReason).toBe("error");

		await sim.session.prompt("second");

		expect(sim.session.isStreaming).toBe(false);
		expect(lastAssistant(sim).stopReason).toBe("stop");
		expect(lastAssistantText(sim.session)).toContain("healthy again");
	});
});
