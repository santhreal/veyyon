/**
 * What a reload keeps, and what it must not invent.
 *
 * WHY THIS FILE EXISTS. Every simulation beside this one runs a session from
 * empty to settled inside one process, so all of them assert the LIVE state of
 * one object. An operator does not work that way: they close the terminal and
 * come back with `--continue`, and everything the conversation is made of has to
 * survive a round trip through the writer and the reader to get there. That path
 * has no simulation at all, and it is the path where a loss is invisible: the
 * transcript still renders, the session still answers, and what is missing is a
 * tool result nobody notices until the next request is refused, or a bill that
 * quietly resets to zero, or a cache prefix the conversation already paid for.
 *
 * The reopen is a real one. A second agent, a second session and a second
 * manager, reading the same store through `switchSession`, which is the same
 * transition `/resume` runs. Nothing is copied from the first session's memory.
 *
 * The rows fix what a reload owes the conversation:
 *   - the message list comes back in order, with the tool pair intact;
 *   - the reasoning a provider signed comes back, because the store and the wire
 *     disagree about reasoning on purpose and a reload must not settle that by
 *     dropping it;
 *   - each assistant turn keeps the model that served it, not the model the
 *     reopened session happens to hold;
 *   - the spend comes back, because a reset counter reads as free work;
 *   - a turn the user cancelled mid-tool comes back answered, since a stored
 *     `tool_use` with no `tool_result` is a conversation no provider will accept;
 *   - the reopened session continues that same conversation, sending the stored
 *     history to the provider rather than starting from the new prompt;
 *   - the reload itself costs no provider call, so a reopen cannot be paying to
 *     rebuild what it should have read;
 *   - the cache identity comes back, or every turn after a resume cold-misses a
 *     prefix the operator already paid to populate.
 *
 * WHAT THIS DOES NOT CATCH. The store is `MemorySessionStorage`, so this says
 * nothing about a truncated file, a partial line, or a crash between two
 * appends: those are the reader's own failure modes and belong to its tests.
 * Nothing here asserts the transcript's rendering, only the conversation the
 * agent gets back. Compaction is off, so a reload of a session whose history was
 * already summarized is not covered.
 *
 * RED PROOFS, observed rather than predicted. Every mutation below was applied to
 * production code, run, and reverted.
 *   - `buildSessionContext` dropping `toolResult` messages on rebuild: the
 *     round-trip, the cancelled-turn and the continuation rows red, and only
 *     those. That is the loss this file was written for.
 *   - the rebuilt assistant message stripped of its usage: the spend row reds. It
 *     also reds the continuation and cache rows, because that mutation has to
 *     CLONE the message and the store and the wire hold the same references, so
 *     it is a proof about the spend row and not a single-row proof.
 *   - the rebuilt assistant message stripped of its model: only the model row
 *     reds.
 *   - the resume transition skipping `#syncAgentSessionId()`: only the cache
 *     identity row reds, which is what that row is a guard on.
 *   - `#adoptInheritedProviderPromptCacheKey` neutered: NOTHING reds. In a
 *     simulation the identity travels on the session id and `promptCacheKey` is
 *     unset, so the cache row says nothing about the inherited-key path. Reading
 *     it as a guard on that path would be wrong, which is why both halves of the
 *     routing pair are asserted separately in it.
 */

import { afterEach, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { createSimulation, type Simulation, simTool, simulatedModel, whenSessionEvent } from "./harness";
import { describeViolations, pairingViolations, toolCallsIn, toolResultsIn } from "./invariants";

let sim: Simulation | undefined;
let reopened: Simulation | undefined;

afterEach(async () => {
	// The reopened session shares the first one's store and credentials, so it is
	// disposed first: the owner's dispose is what closes them.
	await reopened?.dispose();
	await sim?.dispose();
	reopened = undefined;
	sim = undefined;
});

/** The conversation as roles plus their first text, which is what a reader has to rebuild. */
function shape(messages: readonly AgentMessage[]): string[] {
	return messages.map(message => {
		// A tool result is its own MESSAGE and carries the id it answers on the
		// message rather than in a content block, so the id is read from there. That
		// id is the whole point of the row: it is what pairs the result to its call.
		const answers = message.role === "toolResult" ? `(${(message as { toolCallId?: string }).toolCallId ?? ""})` : "";
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") return `${message.role}${answers}:${content}`;
		const blocks = Array.isArray(content) ? content : [];
		const summary = blocks
			.map(block => {
				const part = block as { type?: string; text?: string; name?: string };
				if (part.type === "text") return `text(${part.text ?? ""})`;
				if (part.type === "thinking") return "thinking";
				if (part.type === "toolCall") return `call(${part.name ?? ""})`;
				return part.type ?? "unknown";
			})
			.join("+");
		return `${message.role}${answers}:${summary}`;
	});
}

function assistantModels(simulation: Simulation): string[] {
	return simulation.session.messages
		.filter(message => message.role === "assistant")
		.map(message => (message as { model?: string }).model ?? "none");
}

it("brings a settled conversation back message for message", async () => {
	sim = await createSimulation({
		persist: true,
		tools: [simTool("work", async () => ({ content: [{ type: "text", text: "tool output" }] }))],
		script: turn => {
			turn.usage({ input: 100 * turn.call, output: 10 });
			if (turn.call === 1) {
				turn.thinking("weighing it up", "signature-1");
				turn.toolCall("work", { step: 1 }, "call-1");
				turn.finish("toolUse");
				return;
			}
			turn.text("done");
			turn.finish();
		},
	});

	await sim.session.prompt("do the work");
	const before = shape(sim.session.messages);

	reopened = await sim.reopen();

	expect(shape(reopened.session.messages)).toEqual(before);
	// Not a tautology against the helper: the pair and the signed reasoning are
	// named, so a reader that returned an empty list would not satisfy this.
	expect(before.some(entry => entry.includes("call(work)"))).toBe(true);
	expect(before.some(entry => entry.startsWith("toolResult(call-1)"))).toBe(true);
	expect(before.some(entry => entry.includes("thinking"))).toBe(true);
	expect(toolCallsIn(reopened.session.messages).map(call => call.id)).toEqual(["call-1"]);
	expect(toolResultsIn(reopened.session.messages).map(result => result.id)).toEqual(["call-1"]);
	expect(describeViolations("reloaded store", pairingViolations(reopened.session.messages))).toEqual([]);
});

it("keeps the model that served each turn, not the one the reopened session holds", async () => {
	sim = await createSimulation({
		persist: true,
		modelId: "sim-model-a",
		settings: { "retry.enabled": false },
		script: turn => {
			turn.text(`answer ${turn.call}`);
			turn.finish();
		},
	});

	await sim.session.prompt("first");
	await sim.session.setModel(simulatedModel("sim-model-b"));
	await sim.session.prompt("second");
	expect(assistantModels(sim)).toEqual(["sim-model-a", "sim-model-b"]);

	reopened = await sim.reopen();

	// The reopened session was built holding the default model, so a rebuild that
	// stamped the current model onto every turn would answer b,b here. Which model
	// answered which question is a fact about the past.
	expect(assistantModels(reopened)).toEqual(["sim-model-a", "sim-model-b"]);
});

it("brings the spend back with the conversation", async () => {
	sim = await createSimulation({
		persist: true,
		script: turn => {
			turn.usage({ input: 1000, output: 100, cacheRead: 20, cacheWrite: 10 });
			turn.text(`answer ${turn.call}`);
			turn.finish();
		},
	});

	await sim.session.prompt("first");
	await sim.session.prompt("second");
	const before = sim.session.getSessionStats();
	expect(before.tokens.input).toBe(2000);
	expect(before.tokens.cacheWrite).toBe(20);
	expect(before.cost).toBeGreaterThan(0);

	reopened = await sim.reopen();

	const after = reopened.session.getSessionStats();
	expect(after.tokens).toEqual(before.tokens);
	expect(after.cost).toBe(before.cost);
	expect(after.assistantMessages).toBe(before.assistantMessages);
});

it("brings a cancelled turn back as an answered one", async () => {
	const released = Promise.withResolvers<void>();
	sim = await createSimulation({
		persist: true,
		settings: { "retry.enabled": false },
		tools: [
			simTool("work", async () => {
				await released.promise;
				return { content: [{ type: "text", text: "never seen" }] };
			}),
		],
		script: turn => {
			turn.usage({ input: 500, output: 20 });
			if (turn.call === 1) {
				turn.toolCall("work", {}, "call-1");
				turn.finish("toolUse");
				return;
			}
			turn.text("after the cancel");
			turn.finish();
		},
	});

	const pending = sim.session.prompt("start the work");
	await whenSessionEvent(sim.session, event => event.type === "tool_execution_start");
	sim.session.abort();
	released.resolve();
	await pending;

	expect(describeViolations("live store", pairingViolations(sim.session.messages))).toEqual([]);

	reopened = await sim.reopen();

	// A stored `tool_use` whose answer was synthesized at cancel time has to be
	// stored WITH that answer: the next request after the resume is what a lost
	// result poisons, and it is refused by the provider, not by us.
	expect(toolCallsIn(reopened.session.messages).map(call => call.id)).toEqual(["call-1"]);
	expect(toolResultsIn(reopened.session.messages).map(result => result.id)).toEqual(["call-1"]);
	expect(describeViolations("reloaded store", pairingViolations(reopened.session.messages))).toEqual([]);
});

it("continues the same conversation, and pays nothing to reload it", async () => {
	const outbound: AgentMessage[][] = [];
	sim = await createSimulation({
		persist: true,
		tools: [simTool("work", async () => ({ content: [{ type: "text", text: "tool output" }] }))],
		script: turn => {
			outbound.push([...turn.context.messages]);
			turn.usage({ input: 200, output: 20 });
			if (turn.call === 1) {
				turn.toolCall("work", { step: 1 }, "call-1");
				turn.finish("toolUse");
				return;
			}
			turn.text(`answer ${turn.call}`);
			turn.finish();
		},
	});

	await sim.session.prompt("the first question");
	const callsBeforeReload = sim.providerCalls();

	reopened = await sim.reopen();

	// A reload is a read. A session that summarized, re-prompted or re-ran a tool
	// to rebuild itself would show up here as a provider call nobody asked for.
	expect(reopened.providerCalls()).toBe(callsBeforeReload);

	await reopened.session.prompt("the second question");

	const last = outbound.at(-1) ?? [];
	const texts = shape(last);
	expect(texts.some(entry => entry.includes("the first question"))).toBe(true);
	expect(texts.some(entry => entry.includes("the second question"))).toBe(true);
	// The pair from before the reload is still in what goes out, which is the half
	// a provider rejects when a reader drops one side of it.
	expect(describeViolations("outbound after reload", pairingViolations(last))).toEqual([]);
	expect(toolCallsIn(last).length).toBe(1);
	expect(toolResultsIn(last).length).toBe(1);
});

it("keeps the cache identity the conversation already paid for", async () => {
	const routed: Array<{ sessionId: string | undefined; promptCacheKey: string | undefined }> = [];
	sim = await createSimulation({
		persist: true,
		script: turn => {
			routed.push({ ...turn.cacheRouting });
			turn.text(`answer ${turn.call}`);
			turn.finish();
		},
	});

	await sim.session.prompt("first");
	const before = routed.at(-1);
	expect(before?.sessionId).toBeDefined();

	reopened = await sim.reopen();
	await reopened.session.prompt("after the reload");

	// Providers key their prefix cache on `promptCacheKey ?? sessionId`. A resumed
	// conversation that routes on a fresh identity re-reads its whole history at
	// full input rate on the first turn back, which is a bill rather than an error.
	// Both halves are named because only one of them is doing the work here (the
	// reopened session adopts the stored session id), and a row that folded them
	// into one effective value could not say which.
	expect(routed.at(-1)).toEqual(before);
	expect(new Set(routed.map(entry => entry.promptCacheKey ?? entry.sessionId)).size).toBe(1);
	expect(reopened.session.sessionId).toBe(sim.session.sessionId);
});
