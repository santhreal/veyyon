import { describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import {
	generateBranchSummary,
	generateHandoff,
	generateSummary,
	type SessionEntry,
} from "@veyyon/agent-core/compaction";
import { serializeConversation, serializeConversationForSummary } from "@veyyon/agent-core/compaction/utils";
import type { AssistantMessage, Context, Message, Model } from "@veyyon/ai";
import * as ai from "@veyyon/ai";
import { DIALECTS } from "@veyyon/catalog/identity";
import { getBundledModel } from "@veyyon/catalog/models";

/**
 * WHY: compacting a session that had thinking on came back as
 * `Compaction failed: Summarization failed: Refusal (reasoning_extraction)`
 * and left the history uncompacted, so the session kept growing against a full
 * gauge with no way out. `serializeConversation` rendered every prior thinking
 * block into the transcript it puts inside a user turn — as `<thinking>` tags
 * on the Anthropic dialect, as `[Think]:` without one — and a user turn
 * carrying the model's own chain of thought is what Anthropic's
 * `reasoning_extraction` classifier reads as duplicating model outputs.
 *
 * THE CLASS: any summarization payload that re-serializes reasoning into
 * message text. That is one choke point with four callers (the summary, the
 * turn-prefix summary, the branch summary and the handoff) and twelve dialects,
 * so the sweep below is over `DIALECTS` at run time rather than over the names
 * anyone remembered: a thirteenth dialect that renders thinking goes red here
 * without an edit. Bare prose is not the fix either — `renderDemotedThinking`
 * states the classifier's heat is cumulative in block count, and a compaction
 * payload carries every block in the discarded range at once. The same
 * reasoning also reaches the serializer already demoted to prose, in the
 * developer message a user-interrupted turn leaves behind (tagged
 * `demotedReasoningSource`); that message is dropped from the transcript too.
 *
 * WHAT IT DOES NOT CATCH: the cache-aligned path, which hands the session's own
 * messages back to the provider with their signatures intact. That is native
 * replay of a model's own reasoning to the model that produced it, which is not
 * extraction and is not routed through the serializer this pins. It also cannot
 * see a classifier that starts refusing something else: it proves the reasoning
 * is absent from the payload, not that the payload is accepted.
 */

const REASONING = "SECRET-CHAIN-OF-THOUGHT-NEEDLE the user must never resend";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp: 2,
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

/** A turn that thought, answered, and called a tool: the shape a real range has. */
function conversation(): Message[] {
	return [
		{ role: "user", content: [{ type: "text", text: "make the parser faster" }], timestamp: 1 },
		assistant([
			{ type: "thinking", thinking: REASONING, thinkingSignature: "sig-1" },
			{ type: "text", text: "Profiling the tokenizer first." },
			{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "cargo bench" } },
		]),
		{
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: "tokenize 192ms" }],
			isError: false,
			timestamp: 3,
		},
	];
}

/** The same turn as a branch: the shape `generateBranchSummary` reads. */
function branchEntries(): SessionEntry[] {
	return conversation().map((message, index) => ({
		type: "message",
		id: `e${index}`,
		parentId: index === 0 ? null : `e${index - 1}`,
		timestamp: new Date(index).toISOString(),
		message,
	}));
}

function anthropicModel(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic/claude-sonnet-4-5 to exist");
	return model;
}

/** Every byte a Context would put on the wire, as one string. */
function payloadOf(context: Context): string {
	return JSON.stringify([context.systemPrompt, context.messages]);
}

describe("a summary request never replays the model's reasoning", () => {
	test.each([...DIALECTS])("the %s transcript carries the turn without its reasoning", dialect => {
		const rendered = serializeConversationForSummary(conversation(), dialect);

		expect(rendered).not.toContain(REASONING);
		// Scoped to reasoning: a serializer that returned nothing at all would
		// also drop the needle, and would summarize an empty conversation.
		expect(rendered).toContain("make the parser faster");
		expect(rendered).toContain("Profiling the tokenizer first.");
		expect(rendered).toContain("tokenize 192ms");
	});

	test("the dialect-less transcript drops the reasoning section, not the answer", () => {
		const rendered = serializeConversation(conversation());

		expect(rendered).not.toContain(REASONING);
		expect(rendered).not.toContain("[Think]:");
		expect(rendered).toContain("[Assistant]: Profiling the tokenizer first.");
		expect(rendered).toContain("[Tool Call]:");
	});

	test.each([...DIALECTS])("a %s turn that only thought contributes nothing and breaks nothing", dialect => {
		const messages: Message[] = [
			{ role: "user", content: [{ type: "text", text: "first question" }], timestamp: 1 },
			assistant([{ type: "thinking", thinking: REASONING, thinkingSignature: "sig-1" }]),
			{ role: "user", content: [{ type: "text", text: "second question" }], timestamp: 3 },
		];

		const rendered = serializeConversationForSummary(messages, dialect);

		expect(rendered).not.toContain(REASONING);
		expect(rendered).toContain("first question");
		expect(rendered).toContain("second question");
	});

	test.each([...DIALECTS])("a %s transcript drops reasoning that arrives already demoted to prose", dialect => {
		const messages: Message[] = [
			{ role: "user", content: [{ type: "text", text: "first question" }], timestamp: 1 },
			assistant([{ type: "text", text: "[Interrupted by user]" }]),
			{
				role: "developer",
				content: [{ type: "text", text: `The user interrupted. Prior reasoning:\n${REASONING}` }],
				demotedReasoningSource: { provider: "anthropic", model: "claude-sonnet-4-5" },
				timestamp: 2,
			},
			{ role: "user", content: [{ type: "text", text: "second question" }], timestamp: 3 },
		];

		const rendered = serializeConversationForSummary(messages, dialect);

		expect(rendered).not.toContain(REASONING);
		expect(rendered).toContain("first question");
		expect(rendered).toContain("second question");
	});

	test("generateSummary sends a payload with no reasoning in it", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(assistant([{ type: "text", text: "the session profiled the tokenizer" }]));
		try {
			const messages = conversation() as AgentMessage[];
			await generateSummary(messages, anthropicModel(), 8000, "test-key");

			const call = spy.mock.calls[0];
			if (!call) throw new Error("expected completeSimple call");
			const payload = payloadOf(call[1]);
			expect(payload).not.toContain(REASONING);
			expect(payload).toContain("make the parser faster");
		} finally {
			vi.restoreAllMocks();
		}
	});

	test("generateBranchSummary sends a payload with no reasoning in it", async () => {
		const spy = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(assistant([{ type: "text", text: "branch summary" }]));
		try {
			await generateBranchSummary(branchEntries(), {
				model: anthropicModel(),
				apiKey: "test-key",
				signal: new AbortController().signal,
			});

			const call = spy.mock.calls[0];
			if (!call) throw new Error("expected completeSimple call");
			const payload = payloadOf(call[1]);
			expect(payload).not.toContain(REASONING);
			expect(payload).toContain("make the parser faster");
		} finally {
			vi.restoreAllMocks();
		}
	});

	/**
	 * The boundary, pinned so nobody widens the fix into it: a handoff hands the
	 * session's own messages back as messages, signature and all. That is native
	 * replay to the model that produced the reasoning, which the provider
	 * transform governs per target — stripping it here would throw away context
	 * the summarizer is entitled to and break signed replay.
	 */
	test("a natively replayed handoff keeps the structured thinking block", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(assistant([{ type: "text", text: "handoff" }]));
		try {
			const messages = conversation() as AgentMessage[];
			await generateHandoff(messages, anthropicModel(), "test-key", { systemPrompt: ["sp"], tools: [] });

			const call = spy.mock.calls[0];
			if (!call) throw new Error("expected completeSimple call");
			const replayed = call[1].messages.find(message => message.role === "assistant");
			expect(replayed?.role === "assistant" && replayed.content).toContainEqual({
				type: "thinking",
				thinking: REASONING,
				thinkingSignature: "sig-1",
			});
		} finally {
			vi.restoreAllMocks();
		}
	});
});
