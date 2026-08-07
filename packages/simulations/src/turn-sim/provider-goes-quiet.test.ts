/**
 * Simulations for a provider that stops talking.
 *
 * The failure mode under test is a HANG, not a wrong value: if the watchdog
 * layer is removed or mis-budgeted, `session.prompt()` never resolves and
 * these tests time out. No assertion here can be satisfied by a stuck session.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { createSimulation, lastAssistantText, type Simulation, scriptTurns } from "./harness";

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

describe("a provider that goes quiet", () => {
	it("ends the turn when the stream dies mid-answer and never sends another byte", async () => {
		// The provider emits real content, then the socket goes dead. Nothing
		// closes it, nothing errors: bytes simply stop. This is the shape that
		// used to sit at "Working…" until the operator gave up.
		const stalled = Promise.withResolvers<never>();
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			script: async turn => {
				turn.text("starting the answer");
				await stalled.promise;
			},
		});

		await sim.session.prompt("go");

		expect(sim.session.isStreaming).toBe(false);
		const tail = lastAssistant(sim);
		expect(tail.stopReason).toBe("error");
		expect(tail.errorMessage).toContain("stalled");
		// The partial answer is not thrown away: whatever streamed is still in
		// the transcript, so a follow-up turn has the context.
		expect(sim.events.some(event => event.type === "message_end")).toBe(true);
	});

	it("ends the turn when the provider never sends a first event at all", async () => {
		// Distinct budget from the idle one: `firstItemTimeoutMs` guards the
		// window before any content exists. A provider that accepts the request
		// and then never answers is the commonest cold-proxy failure.
		const never = Promise.withResolvers<never>();
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			script: async turn => {
				// Not even the synthetic `start` counts as progress here: the
				// watchdog's `isProgressItem` excludes it on purpose.
				void turn;
				await never.promise;
			},
		});

		await sim.session.prompt("go");

		expect(sim.session.isStreaming).toBe(false);
		expect(lastAssistant(sim).stopReason).toBe("error");
	});

	it("recovers on the next attempt instead of surfacing the stall to the user", async () => {
		// Same stall, retries on. The contract is that the chain SETTLES: one
		// stall, one retry, a real answer, and no further provider calls.
		const stalled = Promise.withResolvers<never>();
		sim = await createSimulation({
			script: scriptTurns(
				async turn => {
					turn.text("first attempt");
					await stalled.promise;
				},
				turn => {
					turn.text("recovered");
					turn.finish();
				},
			),
		});

		await sim.session.prompt("go");

		expect(sim.session.isStreaming).toBe(false);
		expect(lastAssistantText(sim.session)).toContain("recovered");
		expect(sim.providerCalls()).toBe(2);
	});

	it("stops re-sampling a provider that stalls on every attempt", async () => {
		// The alternative to a hang is an infinite retry loop, which reads the
		// same way to the operator. Two retries are configured, so exactly three
		// provider calls may happen and the turn must then end.
		const stalled = Promise.withResolvers<never>();
		sim = await createSimulation({
			script: async turn => {
				turn.text(`attempt ${turn.call}`);
				await stalled.promise;
			},
		});

		await sim.session.prompt("go");

		expect(sim.session.isStreaming).toBe(false);
		expect(sim.providerCalls()).toBe(3);
		expect(lastAssistant(sim).stopReason).toBe("error");
	});

	it("settles a retryable provider error instead of alternating between failure and resample", async () => {
		// A stall is silence; this is the loud version. The classifier sees a
		// transient upstream fault, so retries apply, and the same bound has to
		// hold: the turn ends after a countable number of attempts.
		sim = await createSimulation({
			script: async turn => {
				turn.fail(`503 Service Unavailable: upstream refused attempt ${turn.call}`);
			},
		});

		await sim.session.prompt("go");

		expect(sim.session.isStreaming).toBe(false);
		expect(sim.providerCalls()).toBe(3);
		const tail = lastAssistant(sim);
		expect(tail.stopReason).toBe("error");
		// The operator is told what upstream said, not a generic failure.
		expect(tail.errorMessage).toContain("upstream refused");
	});

	it("answers from a later attempt when only the first one errors", async () => {
		// The bound must not be a blunt one: a transient error still has to be
		// survivable, or the retry budget is decoration.
		sim = await createSimulation({
			script: scriptTurns(
				async turn => {
					turn.fail("503 Service Unavailable: upstream hiccup");
				},
				turn => {
					turn.text("second attempt answered");
					turn.finish();
				},
			),
		});

		await sim.session.prompt("go");

		expect(sim.providerCalls()).toBe(2);
		expect(lastAssistantText(sim.session)).toContain("second attempt answered");
		expect(lastAssistant(sim).stopReason).toBe("stop");
	});

	it("does not resample a provider error that retrying cannot fix", async () => {
		// The other half of the bound. An error carrying no transient signal must
		// cost one call, not the whole retry budget: burning three attempts on a
		// rejected request triples the wait before the operator learns anything.
		sim = await createSimulation({
			script: async turn => {
				turn.fail(`model does not accept this input (attempt ${turn.call})`);
			},
		});

		await sim.session.prompt("go");

		expect(sim.session.isStreaming).toBe(false);
		expect(sim.providerCalls()).toBe(1);
		expect(lastAssistant(sim).errorMessage).toContain("does not accept this input");
	});

	it("keeps the watchdog off while local bridge work is pending, then re-arms it", async () => {
		// Issue #4593 end to end, through the real session and the real lazy
		// stream. A server-driven local tool bridge marks the stream busy; the
		// silence is ours, not the provider's, so the idle budget must slide.
		//
		// The bridge work outlives the budget BY CONSTRUCTION rather than by a
		// guessed duration: the only thing that can settle it is the watchdog
		// consulting the local-work probe, and the watchdog only does that at an
		// already-expired deadline. Two probes therefore prove the idle budget
		// was exceeded twice and deferred twice.
		const bridgeWork = Promise.withResolvers<void>();
		let probes = 0;
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			script: async turn => {
				turn.onLocalWorkProbe(count => {
					probes = count;
					if (count >= 2) bridgeWork.resolve();
				});
				turn.text("running a local tool");
				await turn.trackLocalWork(bridgeWork.promise);
				turn.text("bridge finished");
				turn.finish();
			},
		});

		await sim.session.prompt("go");

		expect(sim.session.isStreaming).toBe(false);
		expect(lastAssistantText(sim.session)).toContain("bridge finished");
		expect(lastAssistant(sim).stopReason).toBe("stop");
		expect(probes).toBeGreaterThanOrEqual(2);
	});

	it("still kills the stream when the provider stalls after the bridge work drains", async () => {
		// The negative control on the stand-down. Once local work completes the
		// watchdog must re-arm with a full budget, or #4593's fix would mean any
		// stream that ever ran a local tool is unguarded for the rest of the turn.
		const bridgeWork = Promise.withResolvers<void>();
		const providerStall = Promise.withResolvers<never>();
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			script: async turn => {
				turn.onLocalWorkProbe(() => bridgeWork.resolve());
				turn.text("running a local tool");
				await turn.trackLocalWork(bridgeWork.promise);
				// Bridge done, provider owns the silence from here.
				await providerStall.promise;
			},
		});

		await sim.session.prompt("go");

		expect(sim.session.isStreaming).toBe(false);
		const tail = lastAssistant(sim);
		expect(tail.stopReason).toBe("error");
		expect(tail.errorMessage).toContain("stalled");
	});
});
