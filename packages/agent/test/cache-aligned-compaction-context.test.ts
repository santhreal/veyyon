import { describe, expect, it } from "bun:test";
import {
	buildCacheAlignedCompactionContext,
	canUseCacheAlignedCompaction,
	estimateCacheAlignedRequestTokens,
	hasUnansweredToolCall,
	modelServesPrefixCacheHits,
} from "@veyyon/agent-core/compaction/cache-aligned-context";
import { countTokens } from "@veyyon/agent-core/tokenizer";
import type { AssistantMessage, Message, Model, Tool, ToolResultMessage, UserMessage } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";

/**
 * The cache-aligned compaction request replays the live session's provider prefix
 * so the summarization call reads it out of the provider's prompt cache instead of
 * paying fresh input for a re-serialized, truncated copy of the same conversation.
 *
 * Every contract below is one of the two things that can destroy that:
 * the replay is not byte-exact (the provider diverges before its breakpoint and the
 * request misses, costing MORE than the truncated one it replaced), or the request
 * is built when it cannot hit at all: no cached prefix on this host, no session
 * prompt, nothing to replay, or a trailing tool call that makes the appended user
 * turn an invalid request outright.
 */

function anthropicModel(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected the bundled anthropic compaction model");
	return model;
}

/** Same row, with the prompt-cache capability turned off, as an unknown gateway resolves it. */
function nonCachingModel(): Model {
	const model = anthropicModel();
	return { ...model, compat: { ...model.compat, supportsLongCacheRetention: false } } as Model;
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

function assistantToolCalls(ids: string[], timestamp = 3): AssistantMessage {
	return {
		role: "assistant",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		api: "anthropic-messages",
		content: ids.map(id => ({ type: "toolCall" as const, id, name: "read", arguments: { path: id } })),
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
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

function conversation(): Message[] {
	return [
		user("first question"),
		assistantToolCalls(["call-1"]),
		toolResult("call-1", "file contents"),
		assistantText("here is the answer"),
	];
}

const SESSION_PROMPT = ["# Harness\nstable shared prefix", "# Project\nlocal rules"];

const TOOLS: Tool[] = [{ name: "read", description: "read a file", parameters: { type: "object", properties: {} } }];

describe("buildCacheAlignedCompactionContext", () => {
	it("replays the session prefix byte-identically", () => {
		// WHY: the cache hit is a byte comparison the provider performs. Any rewrite of a
		// replayed block moves the divergence point ahead of the trailing breakpoint and
		// the request misses, which costs more than the truncated request it replaced.
		const sessionMessages = conversation();
		const before = JSON.stringify(sessionMessages);

		const context = buildCacheAlignedCompactionContext({
			sessionSystemPrompt: SESSION_PROMPT,
			sessionMessages,
			tools: TOOLS,
			instruction: "summarize",
			timestamp: 99,
		});

		expect(context.systemPrompt).toEqual(SESSION_PROMPT);
		expect(context.tools).toEqual(TOOLS);
		const replayed = context.messages.slice(0, sessionMessages.length);
		expect(replayed).toEqual(sessionMessages);
		expect(JSON.stringify(replayed)).toBe(before);
		// Reference identity is the strongest available statement of "not rewritten":
		// the provider is handed the very objects the live turn was built from.
		for (const [index, message] of sessionMessages.entries()) {
			expect(context.messages[index]).toBe(message);
		}
		// And the caller's array is untouched, so a fallback after this call still sees
		// the live conversation.
		expect(JSON.stringify(sessionMessages)).toBe(before);
		expect(sessionMessages).toHaveLength(4);
	});

	it("appends the instruction as exactly one user turn and nothing else", () => {
		// WHY: a second appended turn, a developer role, or a rewritten tail would each
		// diverge from the cached prefix at a different point; the appended turn is the
		// only block in the request that is allowed to be new.
		const sessionMessages = conversation();

		const context = buildCacheAlignedCompactionContext({
			sessionSystemPrompt: SESSION_PROMPT,
			sessionMessages,
			instruction: "produce the structured summary",
			timestamp: 4242,
		});

		expect(context.messages).toHaveLength(sessionMessages.length + 1);
		const appended = context.messages[context.messages.length - 1];
		expect(appended).toEqual({
			role: "user",
			content: [{ type: "text", text: "produce the structured summary" }],
			timestamp: 4242,
		});
	});

	it("runs the obfuscation seam over the instruction and never over the replay", () => {
		// WHY: the replayed messages already crossed that seam on the live turn. Running
		// the transform again would change bytes the provider has cached, so the seam
		// itself would then be what breaks the cache.
		const secret = "SESSION_SECRET_4f21";
		const sessionMessages = [user(`live turn quoting ${secret}`), assistantText("ack")];

		const context = buildCacheAlignedCompactionContext({
			sessionSystemPrompt: [`prompt holding ${secret}`],
			sessionMessages,
			instruction: `summarize, ${secret}`,
			sanitize: text => text.replaceAll(secret, "#REDACTED#"),
			timestamp: 7,
		});

		const appended = context.messages[context.messages.length - 1];
		expect(appended.content).toEqual([{ type: "text", text: "summarize, #REDACTED#" }]);
		expect(context.messages[0]).toBe(sessionMessages[0]);
		expect(JSON.stringify(context.messages.slice(0, 2))).toContain(secret);
	});
});

describe("hasUnansweredToolCall", () => {
	it("is true for a trailing assistant tool call and for a half-answered parallel batch", () => {
		// WHY: appending a user text turn after an unanswered tool_use is a request
		// Anthropic rejects outright. Compaction can fire on exactly that state, between
		// the assistant turn and the tool execution that answers it.
		expect(hasUnansweredToolCall([user("go"), assistantToolCalls(["call-1"])])).toBe(true);
		expect(
			hasUnansweredToolCall([user("go"), assistantToolCalls(["call-1", "call-2"]), toolResult("call-1", "done")]),
		).toBe(true);
	});

	it("is false once every call is answered, matching by id rather than adjacency", () => {
		expect(hasUnansweredToolCall(conversation())).toBe(false);
		expect(
			hasUnansweredToolCall([
				assistantToolCalls(["call-1", "call-2"]),
				toolResult("call-2", "b"),
				toolResult("call-1", "a"),
			]),
		).toBe(false);
		expect(hasUnansweredToolCall([])).toBe(false);
	});
});

describe("modelServesPrefixCacheHits", () => {
	it("reads the model row rather than the provider name", () => {
		// WHY: support is DATA, the same shape `resolveServerCompactionTransport` uses.
		// A gateway that ignores cache_control must fall back even though its provider
		// id and api say anthropic.
		expect(modelServesPrefixCacheHits(anthropicModel())).toBe(true);
		expect(modelServesPrefixCacheHits(nonCachingModel())).toBe(false);
		const openai = getBundledModel("openai", "gpt-5");
		if (!openai) throw new Error("Expected a bundled openai model");
		expect(modelServesPrefixCacheHits(openai)).toBe(false);
	});
});

describe("canUseCacheAlignedCompaction", () => {
	const eligible = {
		model: anthropicModel(),
		sessionSystemPrompt: SESSION_PROMPT,
		sessionMessages: conversation(),
	};

	it("is true only when every precondition holds", () => {
		expect(canUseCacheAlignedCompaction(eligible)).toBe(true);
	});

	it("is false without a host that serves prefix cache hits", () => {
		expect(canUseCacheAlignedCompaction({ ...eligible, model: nonCachingModel() })).toBe(false);
	});

	it("is false without a session system prompt", () => {
		expect(canUseCacheAlignedCompaction({ ...eligible, sessionSystemPrompt: undefined })).toBe(false);
		expect(canUseCacheAlignedCompaction({ ...eligible, sessionSystemPrompt: [] })).toBe(false);
		expect(canUseCacheAlignedCompaction({ ...eligible, sessionSystemPrompt: [""] })).toBe(false);
	});

	it("is false without messages to replay", () => {
		expect(canUseCacheAlignedCompaction({ ...eligible, sessionMessages: undefined })).toBe(false);
		expect(canUseCacheAlignedCompaction({ ...eligible, sessionMessages: [] })).toBe(false);
	});

	it("is false when the conversation ends on an unanswered tool call", () => {
		expect(
			canUseCacheAlignedCompaction({
				...eligible,
				sessionMessages: [user("go"), assistantToolCalls(["call-1"])],
			}),
		).toBe(false);
	});
});

describe("estimateCacheAlignedRequestTokens", () => {
	it("charges the whole replayed window, not just the instruction", () => {
		// WHY: compaction admission compares this against the candidate's context
		// window. A cache-aligned request is cheap, not small: the replayed window is
		// billed at the cache-read rate but still occupies the window, so an estimate
		// that reported only the new text would admit a request that cannot fit.
		const sessionMessages = [user("x".repeat(8000)), assistantText("y".repeat(8000))];
		const instruction = "summarize";

		const total = estimateCacheAlignedRequestTokens({
			sessionSystemPrompt: SESSION_PROMPT,
			sessionMessages,
			instruction,
		});
		const promptOnly = countTokens([...SESSION_PROMPT, instruction]);

		expect(total).toBeGreaterThan(promptOnly + 3000);
	});
});
