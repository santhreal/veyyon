/**
 * Moving the leaf around the session tree decides what the next request replays,
 * and the same turn is sent differently depending on where the leaf landed.
 *
 * WHY THIS FILE EXISTS. `navigateTree` does not delete anything: it moves the
 * leaf, and the context is rebuilt from the leaf-to-root path. So a turn whose
 * tool results are children of the new leaf is suddenly a turn with a tool call
 * nothing answers, and that shape is the one the transform layer used to fill in
 * with a synthetic "No result provided" result — phantom failed calls that were
 * re-sent to the model and produced the rewind/restore loop
 * (`session-context.ts`, the comment above the dangling-call strip). Two
 * mechanisms handle it, both invisible in the store:
 *
 *   - the unanswered call is stripped from the rebuilt turn, and
 *   - because that turn was REWRITTEN, its signed reasoning is de-signed, since a
 *     signed block replayed out of its original turn shape fails validation.
 *
 * The rows below are the same conversation navigated to different targets. The
 * pair that matters is the assistant turn versus its own tool result: landing on
 * the result keeps the call answered and the signature intact, landing on the
 * assistant strips the call and clears the signature. One navigation apart, two
 * different requests, and nothing in the transcript says so. Every row asserts
 * the stored history AND the outbound `Context.messages` of the next request,
 * because a rebuild that only fixes the display is exactly the bug class here.
 *
 * WHAT THIS DOES NOT CATCH, measured rather than assumed.
 *   - The persisted entries are never rewritten by navigation: only the rebuilt
 *     path is. A row asserting the file would pass whatever the rebuild does.
 *   - The summary row proves a summarizer request happened and that its text
 *     reaches the next prompt as an injected developer turn. It does not judge
 *     the summary's content: that is the summarizer prompt's business, and a
 *     scripted provider answers with whatever the script says.
 *   - Concurrent navigation (a move while a turn is streaming) is not covered
 *     here. The cancel and interjection matrices own what happens when a turn is
 *     interrupted; this file navigates a settled session.
 *
 * RED PROOFS, observed rather than predicted. Four mutations, each in a different
 * owner, and each reds exactly one row:
 *   - `session-context.ts` no longer clearing the signature of a rewritten turn:
 *     the assistant-target row reds on a still-signed block, and the
 *     tool-result-target row stays green, which is what says the two rows are
 *     measuring the rewrite and not navigation in general.
 *   - the same file no longer stripping an unanswered call: the assistant-target
 *     row reds with six tool calls where there should be none, i.e. the
 *     synthesized-result fabrication is back.
 *   - `navigateTree` landing the leaf ON a user turn instead of its parent: the
 *     editor row reds, because the turn it was meant to hand back for editing
 *     stays in history.
 *   - the branch summary never attached: the summary row reds.
 */
import { afterEach, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { createSimulation, type Simulation, simTool } from "./harness";
import { pairingViolations, toolCallsIn, toolResultsIn } from "./invariants";

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

interface Recorded {
	readonly tools: number;
	readonly messages: AgentMessage[];
}

/** Every thinking block of a list, with whether it still carries a signature. */
function thinkingBlocks(messages: readonly AgentMessage[]): Array<{ text: string; signed: boolean }> {
	const blocks: Array<{ text: string; signed: boolean }> = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			const candidate = block as { type: string; thinking?: string; thinkingSignature?: string };
			if (candidate.type !== "thinking") continue;
			blocks.push({
				text: candidate.thinking ?? "",
				signed: typeof candidate.thinkingSignature === "string" && candidate.thinkingSignature.length > 0,
			});
		}
	}
	return blocks;
}

/** All text of the non-assistant messages: what the session injected. */
function injectedText(messages: readonly AgentMessage[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role === "assistant") continue;
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") {
			parts.push(content);
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			const candidate = block as { type: string; text?: string };
			if (candidate.type === "text" && candidate.text) parts.push(candidate.text);
		}
	}
	return parts.join("\n");
}

/**
 * One reasoning turn that calls a tool, then an answer. Every row navigates this
 * same conversation, so the differences between rows are the navigation target
 * and nothing else.
 */
async function reasoningToolConversation(calls: Recorded[]): Promise<Simulation> {
	const simulation = await createSimulation({
		model: { reasoning: true },
		tools: [simTool("work", async () => ({ content: [{ type: "text", text: "tool output" }] }))],
		script: turn => {
			calls.push({ tools: turn.context.tools?.length ?? 0, messages: [...turn.context.messages] });
			if (turn.call === 1) {
				turn.thinking("plan the call", "sig-b");
				turn.toolCall("work", { step: 1 }, "call-1");
				turn.finish();
				return;
			}
			turn.text(`answer ${turn.call}`);
			turn.finish();
		},
	});
	await simulation.session.prompt("go");
	return simulation;
}

function entryOfRole(simulation: Simulation, role: string): string {
	const entry = simulation.sessionManager
		.getEntries()
		.find(candidate => candidate.type === "message" && (candidate.message as { role?: string }).role === role);
	expect(entry).toBeDefined();
	return entry!.id;
}

it("strips the unanswered call and clears its signature when the leaf lands on the assistant turn", async () => {
	const calls: Recorded[] = [];
	sim = await reasoningToolConversation(calls);
	const assistantId = entryOfRole(sim, "assistant");

	await sim.session.navigateTree(assistantId);

	// The tool result is now a child of the leaf, i.e. off the path. The rebuilt
	// turn keeps its reasoning as plain text and loses both the call and the
	// signature, which is what makes it legal to send.
	expect(toolCallsIn(sim.session.messages)).toEqual([]);
	expect(toolResultsIn(sim.session.messages)).toEqual([]);
	expect(thinkingBlocks(sim.session.messages)).toEqual([{ text: "plan the call", signed: false }]);

	const before = calls.length;
	await sim.session.prompt("continue");
	const sent = calls[before];
	expect(sent).toBeDefined();
	// The wire agrees with the rebuild: no phantom call, no synthesized result.
	expect(toolCallsIn(sent!.messages)).toEqual([]);
	expect(toolResultsIn(sent!.messages)).toEqual([]);
	expect(thinkingBlocks(sent!.messages)).toEqual([{ text: "plan the call", signed: false }]);
	expect(pairingViolations(sent!.messages)).toEqual([]);
	expect(injectedText(sent!.messages)).toContain("continue");
});

it("keeps the call and the signature when the leaf lands on the tool result", async () => {
	const calls: Recorded[] = [];
	sim = await reasoningToolConversation(calls);
	const resultId = entryOfRole(sim, "toolResult");

	await sim.session.navigateTree(resultId);

	// One navigation target away from the row above, and the answer is opposite:
	// the pair is on the path, so the turn is not rewritten and its signature is
	// still the provider's own.
	expect(toolCallsIn(sim.session.messages).map(call => call.id)).toEqual(["call-1"]);
	expect(thinkingBlocks(sim.session.messages)).toEqual([{ text: "plan the call", signed: true }]);

	const before = calls.length;
	await sim.session.prompt("continue");
	const sent = calls[before];
	expect(sent).toBeDefined();
	expect(thinkingBlocks(sent!.messages)).toEqual([{ text: "plan the call", signed: true }]);
	expect(pairingViolations(sent!.messages)).toEqual([]);
});

it("hands a user turn back to the editor and drops everything below it", async () => {
	const calls: Recorded[] = [];
	sim = await createSimulation({
		script: turn => {
			calls.push({ tools: turn.context.tools?.length ?? 0, messages: [...turn.context.messages] });
			turn.text(`answer ${turn.call}`);
			turn.finish();
		},
	});
	await sim.session.prompt("first");
	await sim.session.prompt("second");

	const users = sim.sessionManager
		.getEntries()
		.filter(entry => entry.type === "message" && (entry.message as { role?: string }).role === "user");
	expect(users.length).toBe(2);

	const nav = await sim.session.navigateTree(users[1]!.id);

	// A user turn is re-editable, so the leaf moves to its PARENT and the text
	// comes back for the editor rather than staying in history.
	expect(nav.editorText).toBe("second");
	expect(injectedText(sim.session.messages)).not.toContain("second");
	expect(injectedText(sim.session.messages)).toContain("first");

	const before = calls.length;
	await sim.session.prompt("third");
	const sent = calls[before];
	expect(sent).toBeDefined();
	expect(injectedText(sent!.messages)).toContain("first");
	expect(injectedText(sent!.messages)).toContain("third");
	expect(injectedText(sent!.messages)).not.toContain("second");

	// Back to the very first user turn: the leaf is root, so the next request
	// carries the new prompt and nothing else.
	const navRoot = await sim.session.navigateTree(users[0]!.id);
	expect(navRoot.editorText).toBe("first");
	expect(sim.session.messages).toEqual([]);

	const beforeRoot = calls.length;
	await sim.session.prompt("fourth");
	const fromRoot = calls[beforeRoot];
	expect(fromRoot).toBeDefined();
	expect(injectedText(fromRoot!.messages)).toContain("fourth");
	expect(injectedText(fromRoot!.messages)).not.toContain("first");
	expect(injectedText(fromRoot!.messages)).not.toContain("third");
});

it("summarizes the abandoned branch and injects the summary into the next request", async () => {
	const calls: Recorded[] = [];
	sim = await reasoningToolConversation(calls);
	const userId = entryOfRole(sim, "user");

	const before = calls.length;
	const nav = await sim.session.navigateTree(userId, { summarize: true });

	// The summarizer is identified by what the loop asks for: a request with no
	// tools. It is a real provider call, so a build that silently skipped
	// summarizing would leave this at zero.
	const summarizerCalls = calls.slice(before).filter(call => call.tools === 0);
	expect(summarizerCalls.length).toBe(1);
	expect(nav.summaryEntry?.summary).toContain("answer");
	expect(sim.session.messages.some(message => message.role === "branchSummary")).toBe(true);

	const afterSummary = calls.length;
	await sim.session.prompt("continue");
	const sent = calls[afterSummary];
	expect(sent).toBeDefined();
	// The abandoned turns are gone from the wire and their summary arrives as
	// injected text instead, so the next turn knows the branch happened.
	expect(toolCallsIn(sent!.messages)).toEqual([]);
	expect(toolResultsIn(sent!.messages)).toEqual([]);
	expect(injectedText(sent!.messages)).toContain(nav.summaryEntry!.summary);
	expect(injectedText(sent!.messages)).toContain("continue");
});
