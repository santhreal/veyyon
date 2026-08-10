/**
 * A tool call's identity, from the provider's bytes to the next request.
 *
 * WHY THIS FILE EXISTS. Three layers rename tool-call ids and each one trusts
 * the others: the provider supplies the id, the loop stores it (renaming a
 * repeat), and `canonicalizeToolCallIds` rewrites every outbound id to a short
 * session-local `tc_<n>` handle so a compound Responses id is not re-sent every
 * turn. The handle map is keyed by the ORIGINAL id and lives for the whole
 * session, which makes the stored id the only thing keeping two different calls
 * apart on the wire. A stored id that repeats therefore does not stay a storage
 * curiosity: it collapses two calls onto one handle, and the request carries two
 * `tool_use` blocks and two `tool_result` blocks all claiming the same id, which
 * every provider that validates the pairing rejects. Since the malformed pair is
 * stored, it replays on every later request, so one glitched stream ends the
 * conversation rather than one turn.
 *
 * Real providers hand out ids a per-message counter produced (`call_0`,
 * `chatcmpl-tool-0`), so a repeat ACROSS turns is not a hypothetical.
 *
 * ASSERTED: distinct calls always reach the wire under distinct handles, whether
 * the repeat came in one message or in two; a result always carries its own
 * call's handle; a handle is stable across later requests (the prompt-cache
 * reason the map exists); and a provider that emits a `tc_<n>`-shaped id of its
 * own does not collide with an allocated handle.
 *
 * NOT asserted: the exact spelling of a renamed stored id. Uniqueness is the
 * contract, `_2` is today's implementation of it, so the cells check that the
 * two ids differ rather than pinning the suffix.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { AgentMessage, AgentTool } from "@veyyon/agent-core";
import type { Context } from "@veyyon/ai";
import { createSimulation, type Simulation, scriptTurns, simTool } from "./harness";
import { describeViolations, pairingViolations, toolCallsIn, toolResultsIn } from "./invariants";

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

function readTool(): AgentTool {
	return simTool("read", async (_id, args) => ({
		content: [{ type: "text", text: `body of ${String(args.path)}` }],
	}));
}

/** Ids of every tool call, in order, from whichever list is passed. */
function callIds(messages: readonly AgentMessage[]): string[] {
	return toolCallsIn(messages).map(call => call.id);
}

/** Ids of every tool result, in order. */
function resultIds(messages: readonly AgentMessage[]): string[] {
	return toolResultsIn(messages).map(result => result.id);
}

describe("two different tool calls never share an id, in the store or on the wire", () => {
	it("gives distinct ids in one turn their own handles, in first-sight order", async () => {
		const contexts: Context[] = [];
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			tools: [readTool()],
			script: scriptTurns(
				turn => {
					contexts.push(turn.context);
					turn.toolCall("read", { path: "src/a.ts" }, "call_0");
					turn.toolCall("read", { path: "src/b.ts" }, "call_1");
					turn.finish("toolUse");
				},
				turn => {
					contexts.push(turn.context);
					turn.text("done");
					turn.finish();
				},
			),
		});

		await sim.session.prompt("read both");

		expect(callIds(sim.session.messages)).toEqual(["call_0", "call_1"]);
		const wire = contexts.at(-1)?.messages ?? [];
		// The handles are allocated in the order the ids are first seen, which is
		// what keeps prior-history bytes stable for the prompt cache.
		expect(callIds(wire)).toEqual(["tc_1", "tc_2"]);
		expect(resultIds(wire)).toEqual(["tc_1", "tc_2"]);
		expect(describeViolations("one turn", pairingViolations(wire))).toEqual([]);
	});

	it("keeps two calls apart when one message repeats an id", async () => {
		const contexts: Context[] = [];
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			tools: [readTool()],
			script: scriptTurns(
				turn => {
					contexts.push(turn.context);
					turn.toolCall("read", { path: "src/a.ts" }, "call_0");
					turn.toolCall("read", { path: "src/b.ts" }, "call_0");
					turn.finish("toolUse");
				},
				turn => {
					contexts.push(turn.context);
					turn.text("done");
					turn.finish();
				},
			),
		});

		await sim.session.prompt("read both");

		const stored = callIds(sim.session.messages);
		expect(stored.length).toBe(2);
		expect(new Set(stored).size).toBe(2);
		const wire = contexts.at(-1)?.messages ?? [];
		expect(new Set(callIds(wire)).size).toBe(2);
		expect(resultIds(wire)).toEqual(callIds(wire));
		expect(describeViolations("repeat in one message", pairingViolations(sim.session.messages))).toEqual([]);
		expect(describeViolations("repeat in one message", pairingViolations(wire))).toEqual([]);
	});

	it("keeps two calls apart when a later turn repeats an earlier id", async () => {
		// The shape a per-message counter produces: the provider restarts at
		// `call_0` on the next turn. Both calls are real, both were answered, and
		// they are NOT the same call, so they must not share a handle.
		const contexts: Context[] = [];
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			tools: [readTool()],
			script: scriptTurns(
				turn => {
					contexts.push(turn.context);
					turn.toolCall("read", { path: "src/a.ts" }, "call_0");
					turn.finish("toolUse");
				},
				turn => {
					contexts.push(turn.context);
					turn.text("first done");
					turn.finish();
				},
				turn => {
					contexts.push(turn.context);
					turn.toolCall("read", { path: "src/b.ts" }, "call_0");
					turn.finish("toolUse");
				},
				turn => {
					contexts.push(turn.context);
					turn.text("second done");
					turn.finish();
				},
				turn => {
					contexts.push(turn.context);
					turn.text("third done");
					turn.finish();
				},
			),
		});

		await sim.session.prompt("read the first");
		await sim.session.prompt("read the second");
		await sim.session.prompt("now answer");

		const stored = callIds(sim.session.messages);
		expect(stored.length).toBe(2);
		expect(new Set(stored).size).toBe(2);
		expect(describeViolations("repeat across turns", pairingViolations(sim.session.messages))).toEqual([]);

		const wire = contexts.at(-1)?.messages ?? [];
		expect(new Set(callIds(wire)).size).toBe(2);
		expect(resultIds(wire)).toEqual(callIds(wire));
		expect(describeViolations("repeat across turns", pairingViolations(wire))).toEqual([]);
	});

	it("does not let a provider-emitted tc_1 collide with an allocated handle", async () => {
		const contexts: Context[] = [];
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			tools: [readTool()],
			script: scriptTurns(
				turn => {
					contexts.push(turn.context);
					turn.toolCall("read", { path: "src/a.ts" }, "tc_1");
					turn.toolCall("read", { path: "src/b.ts" }, "call_0");
					turn.finish("toolUse");
				},
				turn => {
					contexts.push(turn.context);
					turn.text("done");
					turn.finish();
				},
			),
		});

		await sim.session.prompt("read both");

		const wire = contexts.at(-1)?.messages ?? [];
		expect(new Set(callIds(wire)).size).toBe(2);
		expect(resultIds(wire)).toEqual(callIds(wire));
		expect(describeViolations("provider handle lookalike", pairingViolations(wire))).toEqual([]);
	});

	it("gives a call the same handle in every later request", async () => {
		// The map exists to keep already-sent bytes identical; a handle that drifted
		// between turns would cold-miss the provider prompt cache on every request.
		const contexts: Context[] = [];
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			tools: [readTool()],
			script: scriptTurns(
				turn => {
					contexts.push(turn.context);
					turn.toolCall("read", { path: "src/a.ts" }, "call_0");
					turn.finish("toolUse");
				},
				turn => {
					contexts.push(turn.context);
					turn.text("first done");
					turn.finish();
				},
				turn => {
					contexts.push(turn.context);
					turn.text("second done");
					turn.finish();
				},
			),
		});

		await sim.session.prompt("read one");
		await sim.session.prompt("say something");

		const requests = contexts.filter(context => callIds(context.messages).length > 0);
		expect(requests.length).toBeGreaterThanOrEqual(2);
		const handles = requests.map(context => callIds(context.messages)[0]);
		expect(new Set(handles).size).toBe(1);
	});
});
