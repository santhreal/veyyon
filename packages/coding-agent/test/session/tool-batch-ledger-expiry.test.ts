/**
 * A batch ledger stops being sent once the model has answered the batch.
 *
 * WHAT THIS CLOSES. The ledger is a standing INSTRUCTION, not a record: "only
 * the calls marked never ran need retrying", attached to one placeholder result
 * per cut-short batch. It has an expiry its own text cannot express. Once an
 * assistant turn has responded to that batch the orders have been carried out,
 * and every later request re-sent them anyway. A retried turn never showed this
 * because the whole dead turn is dropped from a retried context; a turn the
 * session CONTINUED stays in history on purpose, so on the reported 75-call
 * batch roughly eighty lines of orders about calls the model had already
 * reissued travelled on every request for the rest of the session, and again
 * after a resume, pointing at results sitting in the same context.
 *
 * THE ROWS ARE THE SPEC.
 *  1. Unanswered (the placeholder is the last message): the ledger is sent. This
 *     is the row that stops the fix from becoming a deletion.
 *  2. A user message after it is not an answer: still sent. The operator typing
 *     does not discharge an instruction addressed to the model.
 *  3. An assistant message after it: the ledger is gone and the placeholder's
 *     own sentence, which is a record rather than an instruction, stays.
 *  4. The stored message is untouched, by identity: the transcript renders the
 *     full ledger from the same object.
 *  5. A result with no ledger is passed through by identity, so the rule cannot
 *     perform text surgery on a result it was never about.
 *  6. The details claim a ledger the text does not hold: the text comes back
 *     byte-identical, which is what stops a not-found search from trimming the
 *     end off a result.
 *  7. Non-text content in an expired result survives.
 *  8. The other core roles still convert (the case was split out of the shared
 *     group, and a compaction summary's image blocks are what fell off the
 *     request the last time that group was disturbed).
 *  9-11. The TURN-LEVEL form of the same ledger. A batch that left no placeholder
 *     to hang it on (every call exec-resolved, or its arguments never finished)
 *     carries the whole ledger as a synthetic user message, which stores no
 *     ledger data to re-render from. It is recognized by the headline prefix its
 *     own renderer writes and dropped whole once answered, kept while unanswered,
 *     and a user message that is not synthetic keeps it even when it quotes one.
 *
 * WHAT IT DOES NOT CATCH. Two of the eleven mutants this suite was gated with
 * survive, and both survive because the site cannot change behavior rather than
 * because a row is missing: the `changed` guard that returns the original object
 * when no block held the ledger is an allocation choice with no observable
 * effect, and starting the forward scan at the placeholder's own index instead
 * of one past it reaches a message whose role is `toolResult` by construction.
 * The other nine are killed, including every arm of the slice. And that the rule
 * matches the loop's REAL bytes is proved in
 * `packages/simulations/src/turn-sim/unreplayable-batch-continue.test.ts`,
 * whose resume row reads a placeholder the agent loop actually wrote.
 */
import { expect, it } from "bun:test";
import { type AgentMessage, buildToolBatchLedger, renderToolBatchLedger } from "@veyyon/agent-core";
import type { ImageContent, Message, ToolResultMessage } from "@veyyon/ai";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";

const LEDGER = buildToolBatchLedger("stream_error", [
	{ toolCallId: "call-a", toolName: "bash", outcome: "dropped" },
	{ toolCallId: "call-b", toolName: "read", outcome: "interrupted" },
]);
const RENDERED = renderToolBatchLedger(LEDGER);
const HEADLINE =
	"Tool call was not executed because the provider stream ended with an error before the tool could run.";

function placeholder(options?: { ledger?: boolean; extra?: ImageContent }): ToolResultMessage {
	const withLedger = options?.ledger !== false;
	return {
		role: "toolResult",
		toolCallId: "call-a",
		toolName: "bash",
		content: [
			{ type: "text", text: withLedger ? `${HEADLINE}\n\n${RENDERED}` : HEADLINE },
			...(options?.extra ? [options.extra] : []),
		],
		isError: true,
		details: {
			__synthetic: true,
			source: "assistant_stop_error",
			executed: false,
			...(withLedger ? { batchLedger: LEDGER } : {}),
		},
		timestamp: 1,
	} as ToolResultMessage;
}

const USER: AgentMessage = { role: "user", content: "and now this", timestamp: 2 };
const ASSISTANT: AgentMessage = {
	role: "assistant",
	content: [{ type: "text", text: "picking the batch back up" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 3,
} as AgentMessage;

function toolResultText(messages: Message[]): string {
	const converted = messages.find(message => message.role === "toolResult");
	if (!converted) return "";
	const content = converted.content;
	if (typeof content === "string") return content;
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

it("sends the ledger while the batch is still unanswered", async () => {
	const text = toolResultText(await convertToLlm([USER, placeholder()]));

	expect(text).toContain(RENDERED);
	expect(text).toContain(HEADLINE);
});

it("keeps sending it when only the operator has spoken since", async () => {
	const text = toolResultText(await convertToLlm([placeholder(), USER]));

	expect(text).toContain(RENDERED);
});

it("stops sending it once an assistant turn has answered the batch", async () => {
	const text = toolResultText(await convertToLlm([placeholder(), ASSISTANT, USER]));

	expect(text).not.toContain("Partial completion ledger");
	// The placeholder's own sentence is a record of what happened, not an order,
	// so it stays: the model still learns this call produced nothing.
	expect(text).toBe(HEADLINE);
});

it("leaves the stored message alone so the transcript still renders the ledger", async () => {
	const stored = placeholder();
	const before = stored.content[0];

	await convertToLlm([stored, ASSISTANT]);

	expect(stored.content[0]).toBe(before);
	expect((before as { text: string }).text).toContain(RENDERED);
});

it("passes a result carrying no ledger through untouched", async () => {
	// By identity: a rule that rebuilt every tool result would be doing text
	// surgery on results it was never about.
	const plain = placeholder({ ledger: false });
	const text = toolResultText(await convertToLlm([plain, ASSISTANT]));

	expect(text).toBe(HEADLINE);
	expect(plain.content).toHaveLength(1);
});
it("changes nothing when the text does not carry the rendered ledger", async () => {
	// The details say a ledger exists, the text does not hold it: a stale-shaped
	// result, or one already expired. The text must come back byte-identical,
	// which is what stops a not-found search from trimming the end off it.
	const odd = placeholder({ ledger: false });
	(odd.details as { batchLedger?: unknown }).batchLedger = LEDGER;
	const text = toolResultText(await convertToLlm([odd, ASSISTANT]));

	expect(text).toBe(HEADLINE);
});

it("keeps non-text content in an expired result", async () => {
	const image: ImageContent = { type: "image", data: "AAAA", mimeType: "image/png" };
	const converted = await convertToLlm([placeholder({ extra: image }), ASSISTANT]);
	const result = converted.find(message => message.role === "toolResult");

	expect(result).toBeDefined();
	const content = result?.content;
	expect(Array.isArray(content)).toBe(true);
	expect(Array.isArray(content) ? content.filter(block => block.type === "image") : []).toEqual([image]);
});
function ledgerNotice(extra?: Partial<AgentMessage>): AgentMessage {
	return { role: "user", content: RENDERED, synthetic: true, timestamp: 5, ...extra } as AgentMessage;
}

it("sends the turn-level notice while the batch is unanswered", async () => {
	// A batch that left no placeholder to hang the ledger on carries the whole
	// ledger as a synthetic user message instead. Same instruction, same expiry.
	const converted = await convertToLlm([ledgerNotice()]);

	expect(converted).toHaveLength(1);
});

it("drops the turn-level notice once an assistant turn has answered it", async () => {
	const converted = await convertToLlm([ledgerNotice(), ASSISTANT, USER]);

	expect(converted.some(message => JSON.stringify(message.content).includes("Partial completion ledger"))).toBe(false);
	// The turns either side survive: the notice is dropped, not the range.
	expect(converted).toHaveLength(2);
});

it("keeps a real user message that quotes a ledger", async () => {
	// THE NEGATIVE CONTROL. Recognition is by the synthetic flag as well as the
	// headline, so an operator pasting a ledger back to ask about it is content,
	// not an expired instruction, and is never removed from their own request.
	const converted = await convertToLlm([ledgerNotice({ synthetic: false }), ASSISTANT]);

	expect(converted.some(message => JSON.stringify(message.content).includes("Partial completion ledger"))).toBe(true);
});

it("still converts the core roles the ledger case was split out of", async () => {
	// The one regression the split could cause, and the one that has happened
	// before to this group: a compaction summary's image blocks falling off.
	const image: ImageContent = { type: "image", data: "BBBB", mimeType: "image/png" };
	const summary: AgentMessage = {
		role: "compactionSummary",
		summary: "what happened earlier",
		images: [image],
		timestamp: 4,
	} as AgentMessage;

	const converted = await convertToLlm([summary, USER]);

	const found = converted.find(message => {
		const content = message.content;
		return Array.isArray(content) && content.some(block => block.type === "image");
	});
	expect(found).toBeDefined();
});
