/**
 * A session that changes models mid-flight.
 *
 * Switching model is not a settings write: it re-points the live agent, resets
 * the provider session id and prompt cache key, appends a `model_change` entry,
 * and leaves every message already in history where it is. The hazard is that
 * one turn's work then straddles two models, and the shapes below are the ones
 * a user actually produces: a switch between turns, a switch while a tool is
 * still running (so the results of model A's call are sent to model B), a
 * switch to a model with a much smaller window, and a switch right after a
 * cancel.
 *
 * WHAT IS ASSERTED. Which model actually served each request, that history
 * still names the model that produced each assistant message, that stored
 * history and the outbound context both stay well paired across the switch,
 * and that a switch to a smaller window makes the very next prompt compact
 * INTO that window. Nothing here configures a token count: the trigger is left
 * at its shipped `auto` value precisely so the suite fails if the trigger ever
 * freezes to the window the session started on.
 *
 * NOT asserted: what a provider does with a foreign model's tool-call id, or
 * cross-provider routing. The scripted transport is one API by construction,
 * and a second provider would only rename the seam.
 *
 * RED PROOFS. (a) Dropping the `#setModelWithProviderSessionReset(targetModel)`
 * call in `AgentSession.setModel` leaves every later request on the old model and
 * reds four of the six rows, leaving the temporary-switch row (a different owner)
 * and the credential refusal green. (b) Resolving the compaction threshold from a
 * frozen 200k window instead of the model's own reds only the smaller-window row,
 * with `worst post-switch request 30012 fits 16000: false`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { USER_INTERRUPT_LABEL } from "@veyyon/coding-agent/session/messages";
import { createSimulation, type Simulation, simTool, simulatedModel, whenSessionEvent } from "./harness";
import { describeViolations, pairingViolations, turnViolations } from "./invariants";

/**
 * Coarse token estimate for an outbound request, in the one unit both sides of
 * this file can agree on without importing a tokenizer: four characters per
 * token. It is only ever compared against a window an order of magnitude away
 * from the boundary, so the slop cannot decide a row.
 */
function estimatedTokens(messages: readonly unknown[]): number {
	return Math.ceil(JSON.stringify(messages).length / 4);
}

interface Serving {
	readonly call: number;
	readonly model: string;
	readonly tokens: number;
}

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

function assistantModels(simulation: Simulation): string[] {
	return simulation.session.messages
		.filter(message => message.role === "assistant")
		.map(message => (message as { model?: string }).model ?? "none");
}

function modelChanges(simulation: Simulation): Array<{ model: string; role: string }> {
	return simulation.sessionManager
		.getEntries()
		.filter(entry => entry.type === "model_change")
		.map(entry => {
			const change = entry as { model?: string; role?: string };
			return { model: change.model ?? "none", role: change.role ?? "none" };
		});
}

function wellPaired(simulation: Simulation, where: string, outbound: readonly unknown[]): void {
	expect(describeViolations(where, turnViolations(simulation))).toEqual([]);
	expect(describeViolations(`${where} store`, pairingViolations(simulation.session.messages))).toEqual([]);
	expect(
		describeViolations(`${where} wire`, pairingViolations(outbound as Parameters<typeof pairingViolations>[0])),
	).toEqual([]);
}

describe("a session that switches models keeps history sendable", () => {
	it("routes the next turn to the new model and leaves earlier messages naming the old one", async () => {
		const served: Serving[] = [];
		let outbound: readonly unknown[] = [];
		sim = await createSimulation({
			modelId: "sim-model-a",
			settings: { "retry.enabled": false },
			tools: [simTool("work", async () => ({ content: [{ type: "text", text: "worked" }] }))],
			script: async turn => {
				served.push({ call: turn.call, model: turn.model.id, tokens: estimatedTokens(turn.context.messages) });
				outbound = turn.context.messages;
				if (turn.call === 1) {
					turn.toolCall("work", { step: turn.call }, "call_0");
					turn.finish("toolUse");
					return;
				}
				turn.text(`answer ${turn.call}`);
				turn.finish();
			},
		});

		await sim.session.prompt("one");
		const switched = await sim.session.setModel(simulatedModel("sim-model-b"));
		await sim.session.prompt("two");

		expect(switched).toEqual({ switched: true });
		// The tool continuation of the first turn is still model A's; only the turn
		// after the switch is model B's.
		expect(served.map(entry => `${entry.call}:${entry.model}`)).toEqual([
			"1:sim-model-a",
			"2:sim-model-a",
			"3:sim-model-b",
		]);
		// History is not rewritten: a transcript that renamed old turns after a
		// switch would attribute model A's answers to model B.
		expect(assistantModels(sim)).toEqual(["sim-model-a", "sim-model-a", "sim-model-b"]);
		expect(modelChanges(sim)).toEqual([{ model: "amazon-bedrock/sim-model-b", role: "default" }]);
		expect(sim.session.model?.id).toBe("sim-model-b");
		wellPaired(sim, "switch between turns", outbound);
	});

	it("hands the results of the old model's tool call to the new model, still paired", async () => {
		const served: Serving[] = [];
		let outbound: readonly unknown[] = [];
		const running = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		sim = await createSimulation({
			modelId: "sim-model-a",
			settings: { "retry.enabled": false },
			tools: [
				simTool("work", async () => {
					running.resolve();
					await release.promise;
					return { content: [{ type: "text", text: "worked" }] };
				}),
			],
			script: async turn => {
				served.push({ call: turn.call, model: turn.model.id, tokens: estimatedTokens(turn.context.messages) });
				outbound = turn.context.messages;
				if (turn.call === 1) {
					turn.toolCall("work", {}, "call_0");
					turn.finish("toolUse");
					return;
				}
				turn.text(`answer ${turn.call}`);
				turn.finish();
			},
		});

		const pending = sim.session.prompt("one");
		await running.promise;
		await sim.session.setModel(simulatedModel("sim-model-b"));
		release.resolve();
		await pending;

		// The switch lands inside an open turn, so the continuation that carries
		// model A's tool result is served by model B. That is the point of the row:
		// the pair must survive crossing models, not be split across them.
		expect(served.map(entry => `${entry.call}:${entry.model}`)).toEqual(["1:sim-model-a", "2:sim-model-b"]);
		expect(assistantModels(sim)).toEqual(["sim-model-a", "sim-model-b"]);
		wellPaired(sim, "switch during tool execution", outbound);
		expect(sim.session.isStreaming).toBe(false);
	});

	it("compacts into the new window when the switch shrinks it", async () => {
		const served: Serving[] = [];
		const bulk = `worked. ${"tool output line. ".repeat(900)}`;
		sim = await createSimulation({
			modelId: "sim-model-a",
			// `compaction.threshold` is left at its shipped `auto` value: the model's
			// window minus the reserve. A row that named a token count would pass on
			// a build whose trigger ignored the window entirely.
			settings: { "retry.enabled": false, "compaction.enabled": true },
			tools: [simTool("work", async () => ({ content: [{ type: "text", text: bulk }] }))],
			script: async turn => {
				served.push({ call: turn.call, model: turn.model.id, tokens: estimatedTokens(turn.context.messages) });
				if (turn.call % 2 === 1) {
					turn.toolCall("work", {}, "call_0");
					turn.finish("toolUse");
					return;
				}
				turn.text(`answer ${turn.call}`);
				turn.finish();
			},
		});

		for (const text of ["one", "two", "three", "four", "five"]) await sim.session.prompt(text);
		const grewOn200k = Math.max(...served.map(entry => entry.tokens));
		const summariesBefore = sim.eventsOfType("auto_compaction_end").length;

		const smallWindow = 16_000;
		await sim.session.setModel(simulatedModel("sim-model-b", { contextWindow: smallWindow }));
		await sim.session.prompt("six");
		await sim.session.prompt("seven");

		const afterSwitch = served.filter(entry => entry.model === "sim-model-b");
		expect(afterSwitch.length).toBeGreaterThan(0);
		// The history that model A was sending would not fit model B at all, so the
		// switch is only survivable if the trigger followed the window down.
		expect(`grew past the new window on the old model: ${grewOn200k > smallWindow}`).toBe(
			"grew past the new window on the old model: true",
		);
		const worstAfter = Math.max(...afterSwitch.map(entry => entry.tokens));
		expect(`worst post-switch request ${worstAfter} fits ${smallWindow}: ${worstAfter < smallWindow}`).toBe(
			`worst post-switch request ${worstAfter} fits ${smallWindow}: true`,
		);
		const summaries = sim.eventsOfType("auto_compaction_end");
		expect(summaries.length).toBeGreaterThan(summariesBefore);
		expect(summaries.every(event => !event.aborted)).toBe(true);
		expect(describeViolations("shrunk window", turnViolations(sim))).toEqual([]);
		expect(describeViolations("shrunk window store", pairingViolations(sim.session.messages))).toEqual([]);
	});

	it("records a temporary switch as temporary and still routes to it", async () => {
		const served: Serving[] = [];
		sim = await createSimulation({
			modelId: "sim-model-a",
			settings: { "retry.enabled": false },
			script: async turn => {
				served.push({ call: turn.call, model: turn.model.id, tokens: estimatedTokens(turn.context.messages) });
				turn.text(`answer ${turn.call}`);
				turn.finish();
			},
		});

		await sim.session.prompt("one");
		await sim.session.setModelTemporary(simulatedModel("sim-model-b"));
		await sim.session.prompt("two");

		expect(served.map(entry => entry.model)).toEqual(["sim-model-a", "sim-model-b"]);
		// The slot in the entry is what a resumed session replays, and a temporary
		// switch must not read back as the configured default.
		expect(modelChanges(sim)).toEqual([{ model: "amazon-bedrock/sim-model-b", role: "temporary" }]);
	});

	it("switches cleanly right after a cancel", async () => {
		const served: Serving[] = [];
		let outbound: readonly unknown[] = [];
		sim = await createSimulation({
			modelId: "sim-model-a",
			settings: { "retry.enabled": false },
			tools: [simTool("work", async () => ({ content: [{ type: "text", text: "worked" }] }))],
			script: async turn => {
				served.push({ call: turn.call, model: turn.model.id, tokens: estimatedTokens(turn.context.messages) });
				outbound = turn.context.messages;
				if (turn.call === 1) {
					turn.text("starting");
					// Left open: the cancel is what ends this stream.
					return;
				}
				turn.text(`answer ${turn.call}`);
				turn.finish();
			},
		});

		const cancelled = sim.session.prompt("one").catch(() => undefined);
		await whenSessionEvent(sim.session, event => event.type === "agent_start");
		await sim.session.abort({ reason: USER_INTERRUPT_LABEL });
		await cancelled;

		await sim.session.setModel(simulatedModel("sim-model-b"));
		await sim.session.prompt("two");

		expect(served.map(entry => entry.model)).toEqual(["sim-model-a", "sim-model-b"]);
		wellPaired(sim, "switch after cancel", outbound);
		expect(sim.session.isStreaming).toBe(false);
	});

	it("refuses a model whose provider has no credential", async () => {
		sim = await createSimulation({
			modelId: "sim-model-a",
			settings: { "retry.enabled": false },
			script: async turn => {
				turn.text("answer");
				turn.finish();
			},
		});

		// Fail closed: the simulation registers a key for the scripted provider
		// only, so another provider is exactly the unconfigured case a user hits
		// picking a model they have never authenticated.
		await expect(sim.session.setModel(simulatedModel("sim-model-c", { provider: "openai" }))).rejects.toThrow(
			/openai/,
		);
		expect(sim.session.model?.id).toBe("sim-model-a");
	});
});
