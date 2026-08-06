import { describe, expect, it } from "bun:test";
import {
	type CompactionPreparation,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	SUMMARIZATION_SYSTEM_PROMPT,
} from "@veyyon/agent-core/compaction";
import type { AssistantMessage, Context, Message, Model, Tool, ToolResultMessage, UserMessage } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";

/**
 * The positive half of cache-aligned compaction: when every precondition holds, the
 * summarization request that actually leaves `compact()` is the live session's
 * prefix plus one appended instruction, not the historical standalone request.
 *
 * These drive the real engine, so they defend the branch in `generateSummary` as
 * well as the module it calls.
 */

const SESSION_PROMPT = ["# Harness\nstable shared prefix", "# Project\nlocal rules"];
const TOOLS: Tool[] = [{ name: "read", description: "read a file", parameters: { type: "object", properties: {} } }];
const HUGE_TOOL_OUTPUT = "T".repeat(9000);

function anthropicModel(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected the bundled anthropic compaction model");
	return model;
}

function user(text: string, timestamp = 1): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistantText(text: string, timestamp = 2): AssistantMessage {
	return {
		role: "assistant",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		api: "anthropic-messages",
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp,
	} as AssistantMessage;
}

function assistantToolCall(id: string, timestamp = 3): AssistantMessage {
	return {
		role: "assistant",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		api: "anthropic-messages",
		content: [{ type: "toolCall", id, name: "read", arguments: { path: id } }],
		stopReason: "toolUse",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp,
	} as AssistantMessage;
}

function toolResult(toolCallId: string, text: string, timestamp = 4): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp };
}

function liveConversation(): Message[] {
	return [
		user("first question"),
		assistantToolCall("call-1"),
		toolResult("call-1", HUGE_TOOL_OUTPUT),
		assistantText("here is the answer"),
	];
}

function preparation(): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-entry",
		messagesToSummarize: [user("first question"), assistantToolCall("call-1"), toolResult("call-1", HUGE_TOOL_OUTPUT)],
		turnPrefixMessages: [],
		recentMessages: [assistantText("here is the answer")],
		isSplitTurn: false,
		tokensBefore: 100_000,
		previousSummary: undefined,
		previousPreserveData: undefined,
		fileOps: { read: new Set(), edited: new Set(), written: new Set() },
		settings: { ...DEFAULT_COMPACTION_SETTINGS },
	};
}

async function captureCacheAlignedRequest(
	sessionMessages: Message[],
	obfuscateProviderText?: (text: string) => string,
): Promise<Context> {
	const captured: Context[] = [];
	await compact(preparation(), anthropicModel(), "test-key", undefined, undefined, {
		tools: TOOLS,
		sessionSystemPrompt: SESSION_PROMPT,
		sessionMessages,
		obfuscateProviderText,
		completeImpl: async (_model, context) => {
			captured.push(context);
			return assistantText("a summary");
		},
	});
	expect(captured).toHaveLength(1);
	return captured[0];
}

describe("compact() sends the cache-aligned request when it can hit", () => {
	it("replays the session prefix and appends exactly one instruction turn", async () => {
		// WHY: the whole economic case is that the summarization request shares the
		// live session's cached prefix: session tools, session system prompt, the live
		// message array byte-for-byte, one new user turn.
		const sessionMessages = liveConversation();

		const context = await captureCacheAlignedRequest(sessionMessages);

		expect(context.systemPrompt).toEqual(SESSION_PROMPT);
		expect(context.tools).toEqual(TOOLS);
		expect(context.messages).toHaveLength(sessionMessages.length + 1);
		for (const [index, message] of sessionMessages.entries()) {
			expect(context.messages[index]).toBe(message);
		}
	});

	it("carries the untruncated tool result the fallback would have cut", async () => {
		// WHY: cache alignment is not only cheaper, it is higher fidelity. The replayed
		// history is the real conversation, so `TOOL_RESULT_MAX_CHARS` never applies.
		const context = await captureCacheAlignedRequest(liveConversation());
		const wire = JSON.stringify(context.messages);

		expect(wire).toContain(HUGE_TOOL_OUTPUT);
		expect(wire).not.toContain("middle omitted; tail preserved");
	});

	it("puts the summarizer framing in the appended turn, since the system slot is the session's", async () => {
		// WHY: the request no longer carries SUMMARIZATION_SYSTEM_PROMPT in the system
		// slot. Losing that framing would leave the model continuing the conversation
		// instead of summarizing it.
		const context = await captureCacheAlignedRequest(liveConversation());
		const appended = context.messages[context.messages.length - 1];
		const text = typeof appended.content === "string" ? appended.content : JSON.stringify(appended.content);

		expect(appended.role).toBe("user");
		expect(text).toContain("NEVER continue the conversation");
		// The conversation is replayed, never re-serialized into the instruction.
		expect(text).not.toContain("<conversation>");
	});

	it("sanitizes the appended instruction without touching the replayed history", async () => {
		// WHY: the seam must stay on the new text only; re-running it over replayed
		// messages would rewrite bytes the provider has cached.
		const secret = "SESSION_SECRET_9c02";
		const sessionMessages = [user(`live turn quoting ${secret}`), assistantText("ack")];

		const context = await captureCacheAlignedRequest(sessionMessages, text =>
			text.replaceAll(secret, "#REDACTED#"),
		);

		expect(context.messages[0]).toBe(sessionMessages[0]);
		expect(JSON.stringify(context.messages.slice(0, 2))).toContain(secret);
		const appended = context.messages[context.messages.length - 1];
		expect(JSON.stringify(appended)).not.toContain(secret);
	});
});

/**
 * The guard matters more than the feature. Every disqualifier must leave the
 * historical request shape running: `SUMMARIZATION_SYSTEM_PROMPT` in the system
 * slot, one synthesized user message holding the serialized (and tool-result
 * truncated) conversation, and no tools. A cache-aligned request that cannot hit
 * is roughly three times WORSE than the truncated one, so these drive the real
 * engine and prove the fallback EXECUTES rather than that a predicate said false.
 */
describe("the truncated fallback still runs when cache alignment is unavailable", () => {
	/** The same row with the prompt-cache capability off, as an unknown gateway resolves it. */
	function nonCachingModel(): Model {
		const model = anthropicModel();
		return { ...model, compat: { ...model.compat, supportsLongCacheRetention: false } } as Model;
	}

	async function captureRequest(overrides: {
		sessionSystemPrompt?: string[];
		sessionMessages?: Message[];
		model?: Model;
	}): Promise<Context> {
		const captured: Context[] = [];
		await compact(preparation(), overrides.model ?? anthropicModel(), "test-key", undefined, undefined, {
			tools: TOOLS,
			sessionSystemPrompt: overrides.sessionSystemPrompt,
			sessionMessages: overrides.sessionMessages,
			completeImpl: async (_model, context) => {
				captured.push(context);
				return assistantText("a summary");
			},
		});
		expect(captured).toHaveLength(1);
		return captured[0];
	}

	function expectTruncatedRequest(context: Context): void {
		expect(context.systemPrompt).toEqual([SUMMARIZATION_SYSTEM_PROMPT]);
		expect(context.tools).toBeUndefined();
		expect(context.messages).toHaveLength(1);
		const only = context.messages[0];
		expect(only.role).toBe("user");
		const text = typeof only.content === "string" ? only.content : JSON.stringify(only.content);
		expect(text).toContain("<conversation>");
		// The truncation this path depends on is still in force.
		expect(text).toContain("middle omitted; tail preserved");
		expect(text).not.toContain(HUGE_TOOL_OUTPUT);
	}

	it("falls back with no session system prompt", async () => {
		expectTruncatedRequest(await captureRequest({ sessionMessages: liveConversation() }));
	});

	it("falls back with no session messages", async () => {
		expectTruncatedRequest(await captureRequest({ sessionSystemPrompt: SESSION_PROMPT }));
	});

	it("falls back on a host that does not serve prefix cache hits", async () => {
		expectTruncatedRequest(
			await captureRequest({
				model: nonCachingModel(),
				sessionSystemPrompt: SESSION_PROMPT,
				sessionMessages: liveConversation(),
			}),
		);
	});

	it("falls back when the live conversation ends on an unanswered tool call", async () => {
		expectTruncatedRequest(
			await captureRequest({
				sessionSystemPrompt: SESSION_PROMPT,
				sessionMessages: [user("go"), assistantToolCall("call-1")],
			}),
		);
	});
});
