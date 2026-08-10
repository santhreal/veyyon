/**
 * Reasoning the model produced is stored once and sent back under rules, and the
 * rules are not the same as "keep it".
 *
 * WHY THIS FILE EXISTS. A thinking block is the one kind of assistant content the
 * session is not free to replay. Providers hand back a signature that certifies a
 * block is replayable verbatim; a block without one is reasoning that was still
 * streaming, and sending it back is rejected. So three different owners rewrite
 * reasoning on its way out, each for a different reason, and none of them is
 * visible in the store:
 *
 *   - `demoteInterruptedThinking` (coding-agent/session/messages.ts) takes a
 *     trailing UNSIGNED run off the turn for the LLM view when the user
 *     interrupted, and a hidden continuity message carries the text instead.
 *   - `normalizeMessagesForProvider` (agent/agent-loop.ts) drops every thinking
 *     block for one provider that rejects them outright.
 *   - `session-context.ts` clears the signature of any turn it REWRITES, because
 *     signed reasoning replayed out of its original turn shape fails validation.
 *
 * Every one of those is a silent transformation between what the operator sees
 * and what the wire carries, which is exactly the class where a regression is
 * invisible until a provider 400s. So each row here asserts BOTH lists: the
 * stored history the operator reads, and the outbound `Context.messages` the
 * request was shaped from. A row that only checked the store would pass while
 * the wire was broken, and the reverse.
 *
 * WHAT THIS DOES NOT CATCH, measured rather than assumed.
 *   - The summarizer cannot be affected: a compaction request carries ONE user
 *     message holding a rendered transcript, so no reasoning block reaches it in
 *     any shape. Measured, not reasoned: a compacting run here showed the
 *     summarizer call with `user[text]` and nothing else.
 *   - Encrypted reasoning (`redactedThinking`) is out of reach. It rides in
 *     content with no stream event of its own, so a scripted provider has
 *     nothing to push and the block never reaches the store. Its handling is
 *     unit-tested next to the code that strips it.
 *   - An emptied assistant turn still reaches the outbound context (row two
 *     shows `assistant[]`). Dropping it is the per-provider encoder's job
 *     (bedrock skips empty content arrays explicitly), which runs BELOW the seam
 *     this simulation replaces, so nothing here would notice it regressing.
 *   - The signature-clearing rewrite in `session-context.ts` only fires on a turn
 *     whose tool call has no result on the resolved path, which a cancel does not
 *     produce: the loop answers the call with a synthesized aborted result (row
 *     four asserts exactly that). Reaching it needs a branch/rewind, which is a
 *     different lane's axis.
 *
 * RED PROOFS, observed rather than predicted. Each owner was broken in turn and
 * only its own rows failed, which is what says the rows are not passing for some
 * shared accident:
 *   - `normalizeMessagesForProvider` returning early for EVERY provider (the
 *     strip never happens): the cerebras row alone reds.
 *   - the same guard inverted so it strips for every provider: the bedrock row,
 *     the signed-interrupt row and the cancelled-call row red together, which is
 *     what makes the quirk arm a control rather than a second copy of it.
 *   - `convertToLlm` never demoting (`const source = m`): only the interrupt row
 *     reds, on the unsigned block reaching the wire.
 *   - `demoteInterruptedThinking` no longer breaking its run on a signature: only
 *     the signed-interrupt row reds, on the continuity turn being written for
 *     reasoning that was safe to replay.
 */
import { afterEach, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { USER_INTERRUPT_LABEL } from "@veyyon/coding-agent/session/messages";
import { createSimulation, type Simulation, scriptTurns, simTool, whenSessionEvent } from "./harness";
import { describeViolations, pairingViolations } from "./invariants";

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

interface ThinkingBlock {
	readonly text: string;
	readonly signed: boolean;
}

/** Every thinking block on every assistant message of a list, in order. */
function thinkingBlocks(messages: readonly AgentMessage[]): ThinkingBlock[] {
	const blocks: ThinkingBlock[] = [];
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

/** Concatenated text of every non-assistant message, i.e. what was injected. */
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
 * One provider quirk, and the provider that does not have it. `cerebras` is the
 * only id `normalizeMessagesForProvider` names, so the pair is the whole space:
 * one arm proves the strip happens, the other proves it is not happening to
 * everybody (a strip applied unconditionally would leave the quirk arm green).
 */
const PROVIDERS = [
	{ provider: "amazon-bedrock", reasoningOnTheWire: true },
	{ provider: "cerebras", reasoningOnTheWire: false },
] as const;

for (const arm of PROVIDERS) {
	it(`replays a signed reasoning block to ${arm.provider}: ${arm.reasoningOnTheWire}`, async () => {
		const wire: AgentMessage[][] = [];
		sim = await createSimulation({
			model: { reasoning: true, provider: arm.provider },
			script: scriptTurns(
				turn => {
					turn.thinking("weighed the two options", "sig-1");
					turn.text("picked the second");
					turn.finish();
				},
				turn => {
					wire.push([...turn.context.messages]);
					turn.text("still here");
					turn.finish();
				},
			),
		});

		await sim.session.prompt("go");
		await sim.session.prompt("more");

		// The store is the operator's copy and never loses reasoning, whatever the
		// provider tolerates.
		expect(thinkingBlocks(sim.session.messages)).toEqual([{ text: "weighed the two options", signed: true }]);

		const sent = wire[0];
		expect(sent).toBeDefined();
		expect(thinkingBlocks(sent!)).toEqual(
			arm.reasoningOnTheWire ? [{ text: "weighed the two options", signed: true }] : [],
		);
		// The answer text is not reasoning and survives either way, so a strip that
		// took the whole turn with it would fail here rather than pass quietly.
		expect(injectedText(sent!)).toContain("go");
		expect(
			sent!.some(message => {
				if (message.role !== "assistant") return false;
				const content = (message as { content?: unknown }).content;
				return (
					Array.isArray(content) &&
					content.some(block => (block as { type: string; text?: string }).text === "picked the second")
				);
			}),
		).toBe(true);
	});
}

it("demotes an unsigned run the user interrupted and injects its text instead", async () => {
	const wire: AgentMessage[][] = [];
	sim = await createSimulation({
		model: { reasoning: true },
		script: scriptTurns(
			turn => {
				turn.openThinking("halfway through a thought");
			},
			turn => {
				wire.push([...turn.context.messages]);
				turn.text("carrying on");
				turn.finish();
			},
		),
	});

	const cancelled = sim.session.prompt("go");
	await whenSessionEvent(sim.session, event => event.type === "message_update");
	await sim.session.abort({ reason: USER_INTERRUPT_LABEL });
	await cancelled;

	// Stored: the run is still there for the operator, followed by the hidden
	// continuity turn that is the only reason dropping it from the wire is safe.
	expect(thinkingBlocks(sim.session.messages)).toEqual([{ text: "halfway through a thought", signed: false }]);
	expect(
		sim.session.messages.some(
			message =>
				message.role === "custom" && (message as { customType?: string }).customType === "interrupted-thinking",
		),
	).toBe(true);

	await sim.session.prompt("more");

	const sent = wire[0];
	expect(sent).toBeDefined();
	// On the wire the unsigned run is gone and the reasoning arrives as injected
	// text, so the next turn still knows what the interrupted one was thinking.
	expect(thinkingBlocks(sent!)).toEqual([]);
	expect(injectedText(sent!)).toContain("halfway through a thought");
});

it("keeps a signed run through the same interrupt", async () => {
	const wire: AgentMessage[][] = [];
	sim = await createSimulation({
		model: { reasoning: true },
		script: scriptTurns(
			turn => {
				turn.thinking("a complete signed thought", "sig-s");
			},
			turn => {
				wire.push([...turn.context.messages]);
				turn.text("carrying on");
				turn.finish();
			},
		),
	});

	const cancelled = sim.session.prompt("go");
	await whenSessionEvent(sim.session, event => event.type === "message_update");
	await sim.session.abort({ reason: USER_INTERRUPT_LABEL });
	await cancelled;

	// The interrupt is identical to the row above. The signature is the only
	// difference, and it is what decides: a signed block is replayable, so there
	// is nothing to demote and no continuity turn to write.
	expect(
		sim.session.messages.some(
			message =>
				message.role === "custom" && (message as { customType?: string }).customType === "interrupted-thinking",
		),
	).toBe(false);

	await sim.session.prompt("more");

	const sent = wire[0];
	expect(sent).toBeDefined();
	expect(thinkingBlocks(sent!)).toEqual([{ text: "a complete signed thought", signed: true }]);
});

it("answers a cancelled tool call, so its signed reasoning is replayed unrewritten", async () => {
	const entered = Promise.withResolvers<void>();
	const wire: AgentMessage[][] = [];
	sim = await createSimulation({
		model: { reasoning: true },
		tools: [
			simTool(
				"hold",
				async (_id, _args, signal) => {
					entered.resolve();
					const held = Promise.withResolvers<never>();
					signal?.addEventListener("abort", () => held.reject(new Error("hold aborted")), { once: true });
					await held.promise;
					return { content: [{ type: "text", text: "never reached" }] };
				},
				{ interruptible: true },
			),
		],
		script: turn => {
			if (turn.call === 1) {
				turn.thinking("plan the call", "sig-c");
				turn.toolCall("hold", {}, "call-hold");
				turn.finish();
				return;
			}
			wire.push([...turn.context.messages]);
			turn.text("carrying on");
			turn.finish();
		},
	});

	const cancelled = sim.session.prompt("go");
	await entered.promise;
	await sim.session.abort({ reason: USER_INTERRUPT_LABEL });
	await cancelled;

	// The cancel leaves the call paired: that is what keeps the turn off the
	// rewrite path, and therefore what keeps its signature intact.
	const violations = pairingViolations(sim.session.messages);
	expect(describeViolations("signed reasoning beside a cancelled call", violations)).toEqual([]);

	await sim.session.prompt("more");

	const sent = wire.at(-1);
	expect(sent).toBeDefined();
	expect(thinkingBlocks(sent!)).toEqual([{ text: "plan the call", signed: true }]);
	expect(pairingViolations(sent!)).toEqual([]);
});
