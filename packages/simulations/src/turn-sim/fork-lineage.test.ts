/**
 * A fork takes the conversation with it and leaves the parent where it was.
 *
 * WHY THIS FILE EXISTS. `/fork` is how an operator says "try this from here
 * without spoiling what I have". Two things have to be true for that to be worth
 * anything: the fork starts as the parent's conversation, and the parent keeps
 * only what it had at the fork point no matter what the fork goes on to do. Both
 * are facts about STORED sessions, so neither was reachable in a simulation until
 * the harness could persist: `SessionManager.fork()` returns undefined outright
 * when persistence is off, so every fork in every earlier simulation was a
 * no-op that a scenario could not tell from a working one.
 *
 * There is a third fact, easier to get wrong because nothing fails when it is:
 * a fork mints a NEW session id, and providers key their prefix cache on
 * `promptCacheKey ?? sessionId`. A fork that routed on its own new id would
 * re-read the entire inherited history at full input rate on its first turn, for
 * a conversation whose cache the parent already paid to populate. The fork header
 * carries the parent's id forward as `providerPromptCacheKey` precisely so that
 * cannot happen, and this file is what holds it there.
 *
 * The rows:
 *   - the fork opens on the parent's conversation, message for message, and its
 *     header names the parent it came from;
 *   - the fork is a new session id and a new file, so the row above is not
 *     passing because nothing happened;
 *   - the fork routes on the parent's cache identity, not on its own id;
 *   - work done after the fork is absent from the parent's stored transcript,
 *     read back from the store rather than from the live object;
 *   - a fork inherits a tool pair whole, so the first request from the fork is
 *     one a provider will accept;
 *   - forking costs no provider call.
 *
 * WHAT THIS DOES NOT CATCH. Branch navigation within one session (`/rewind` and
 * the checkpoint tree) is a different mechanism with its own suite. Nothing here
 * covers the interactive picker, the fork's title, or what the TUI shows. The
 * store is in memory, so a fork against a real filesystem, including a name
 * collision between two forks in the same millisecond, is out of scope.
 *
 * RED PROOFS, observed rather than predicted. Each mutation was applied to
 * `SessionManager.fork()`, run, and reverted.
 *   - the fork header carrying no `providerPromptCacheKey`, so it routes on its
 *     own new id: only the cache identity row reds.
 *   - the fork header recording no `parentSession`: only the first row reds.
 *   - the fork keeping the parent's file instead of minting its own: the first
 *     row and the parent row red, and only those, which is the pair that says
 *     the split is real rather than that a copy happened.
 */

import { afterEach, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { createSimulation, type ProviderScript, type Simulation, simTool } from "./harness";
import { describeViolations, pairingViolations, toolCallsIn, toolResultsIn } from "./invariants";

let sim: Simulation | undefined;
let reopened: Simulation | undefined;

afterEach(async () => {
	await reopened?.dispose();
	await sim?.dispose();
	reopened = undefined;
	sim = undefined;
});

/** Role plus first text, which is the level a fork has to reproduce exactly. */
function shape(messages: readonly AgentMessage[]): string[] {
	return messages.map(message => {
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") return `${message.role}:${content}`;
		const blocks = Array.isArray(content) ? content : [];
		const text = blocks
			.map(block => {
				const part = block as { type?: string; text?: string; name?: string };
				if (part.type === "text") return part.text ?? "";
				if (part.type === "toolCall") return `call:${part.name ?? ""}`;
				return part.type ?? "";
			})
			.join("+");
		return `${message.role}:${text}`;
	});
}

const TOOL = simTool("work", async () => ({ content: [{ type: "text", text: "tool output" }] }));

/** One prompt that runs a tool, so every fork below inherits a pair rather than plain text. */
function toolThenAnswer(): ProviderScript {
	return turn => {
		turn.usage({ input: 300, output: 30 });
		if (turn.call === 1) {
			turn.toolCall("work", { step: 1 }, "call-1");
			turn.finish("toolUse");
			return;
		}
		turn.text(`answer ${turn.call}`);
		turn.finish();
	};
}

it("opens the fork on the parent's conversation, under a new identity", async () => {
	sim = await createSimulation({ persist: true, tools: [TOOL], script: toolThenAnswer() });

	await sim.session.prompt("the shared question");
	const parentFile = sim.sessionFile();
	const parentId = sim.session.sessionId;
	const before = shape(sim.session.messages);
	const callsBeforeFork = sim.providerCalls();

	expect(await sim.session.fork()).toBe(true);

	// The conversation came along.
	expect(shape(sim.session.messages)).toEqual(before);
	expect(before.some(entry => entry.includes("the shared question"))).toBe(true);
	expect(before.some(entry => entry.includes("call:work"))).toBe(true);
	// And it is genuinely a new session, so the row above is a claim about copying
	// rather than about nothing having happened.
	expect(sim.sessionFile()).not.toBe(parentFile);
	expect(sim.session.sessionId).not.toBe(parentId);
	expect(sim.sessionManager.getHeader()?.parentSession).toBe(parentId);
	// A fork is a copy, not a request.
	expect(sim.providerCalls()).toBe(callsBeforeFork);
	// The inherited pair is whole, which is what the fork's first request depends on.
	expect(toolCallsIn(sim.session.messages).map(call => call.id)).toEqual(["call-1"]);
	expect(toolResultsIn(sim.session.messages).map(result => result.id)).toEqual(["call-1"]);
	expect(describeViolations("fork", pairingViolations(sim.session.messages))).toEqual([]);
});

it("routes the fork on the parent's cache identity", async () => {
	const routed: Array<{ sessionId: string | undefined; promptCacheKey: string | undefined }> = [];
	sim = await createSimulation({
		persist: true,
		script: turn => {
			routed.push({ ...turn.cacheRouting });
			turn.text(`answer ${turn.call}`);
			turn.finish();
		},
	});

	await sim.session.prompt("the shared question");
	const parentId = sim.session.sessionId;
	const parentKey = routed.at(-1)?.promptCacheKey ?? routed.at(-1)?.sessionId;

	expect(await sim.session.fork()).toBe(true);
	await sim.session.prompt("only on the fork");

	const afterFork = routed.at(-1);
	expect(afterFork).toBeDefined();
	// The id changed and the routing did not: that is the whole mechanism. The
	// fork's first turn re-sends the inherited history, and it must read the prefix
	// the parent's turns already populated instead of paying for it again.
	expect(sim.session.sessionId).not.toBe(parentId);
	expect(afterFork?.promptCacheKey ?? afterFork?.sessionId).toBe(parentKey);
	expect(new Set(routed.map(entry => entry.promptCacheKey ?? entry.sessionId)).size).toBe(1);
});

it("leaves the parent holding only what it had at the fork point", async () => {
	sim = await createSimulation({
		persist: true,
		tools: [TOOL],
		script: turn => {
			turn.usage({ input: 300, output: 30 });
			turn.text(`answer ${turn.call}`);
			turn.finish();
		},
	});

	await sim.session.prompt("the shared question");
	const parentFile = sim.sessionFile();
	const parentShape = shape(sim.session.messages);
	expect(parentFile).toBeDefined();

	expect(await sim.session.fork()).toBe(true);
	await sim.session.prompt("only on the fork");
	expect(shape(sim.session.messages).some(entry => entry.includes("only on the fork"))).toBe(true);

	// Read the parent back out of the store, not off the live object: the point of
	// a fork is what the operator finds when they go back, and a fork that had
	// appended to the parent's file would still look right in memory.
	reopened = await sim.reopen(parentFile);

	expect(shape(reopened.session.messages)).toEqual(parentShape);
	expect(shape(reopened.session.messages).some(entry => entry.includes("only on the fork"))).toBe(false);
	expect(reopened.session.sessionId).not.toBe(sim.session.sessionId);
});

it("keeps the fork's own work on the fork", async () => {
	sim = await createSimulation({
		persist: true,
		script: turn => {
			turn.usage({ input: 300, output: 30 });
			turn.text(`answer ${turn.call}`);
			turn.finish();
		},
	});

	await sim.session.prompt("the shared question");
	expect(await sim.session.fork()).toBe(true);
	await sim.session.prompt("only on the fork");
	const forkFile = sim.sessionFile();

	reopened = await sim.reopen(forkFile);

	// The other half of the split: the fork's file carries the inherited history
	// AND its own turn, so a fork that wrote only its new work would be a session
	// starting mid-conversation.
	const stored = shape(reopened.session.messages);
	expect(stored.some(entry => entry.includes("the shared question"))).toBe(true);
	expect(stored.some(entry => entry.includes("only on the fork"))).toBe(true);
	expect(describeViolations("stored fork", pairingViolations(reopened.session.messages))).toEqual([]);
});
