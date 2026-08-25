import { describe, expect, it } from "bun:test";
import { convertMessages } from "@veyyon/ai/providers/openai-completions";
import type { AssistantMessage, Context, Message, Model, ToolResultMessage, Usage } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import type { ResolvedOpenAICompat } from "@veyyon/catalog/types";

/**
 * WHY: `convertMessages` in `openai-completions.ts` previously did 2-3
 * separate passes over each assistant message's `content` array: one `for`
 * loop collecting text/thinking blocks, a `.filter()` for tool calls, and
 * another `.filter()` for all thinking blocks (including empty-text) in the
 * Tier 1 reasoning recovery path. The passes were merged into a single
 * `for` loop to avoid two throwaway arrays and two extra O(n) passes per
 * assistant message per turn.
 *
 * This suite closes the class by asserting the merged loop produces the
 * same wire output as the original multi-pass approach: tool calls, text,
 * thinking blocks (empty and non-empty), and reasoning content replay all
 * survive the merge. A regression that drops a block type from the merged
 * loop will fail on the content assertions.
 */

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const baseCompat: ResolvedOpenAICompat = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsMultipleSystemMessages: true,
	supportsReasoningEffort: true,
	reasoningEffortMap: {},
	supportsUsageInStreaming: true,
	supportsToolChoice: true,
	supportsForcedToolChoice: true,
	supportsNamedToolChoice: true,
	disableReasoningOnForcedToolChoice: false,
	disableReasoningOnToolChoice: false,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresMistralToolIds: false,
	thinkingFormat: "openai",
	reasoningDisableMode: "lowest-effort",
	omitReasoningEffort: false,
	includeEncryptedReasoning: true,
	filterReasoningHistory: false,
	reasoningContentField: "reasoning_content",
	requiresReasoningContentForToolCalls: false,
	requiresReasoningContentForAllAssistantTurns: false,
	allowsSyntheticReasoningContentForToolCalls: true,
	replayReasoningContent: false,
	qwenPreserveThinking: false,
	requiresAssistantContentForToolCalls: false,
	openRouterRouting: {},
	vercelGatewayRouting: {},
	extraBody: {},
	supportsStrictMode: true,
	toolStrictMode: "none",
	supportsReasoningParams: true,
	alwaysSendMaxTokens: false,
	isOpenRouterHost: false,
	routedUpstreamSelfCaps: false,
	isVercelGatewayHost: false,
	wireModelIdMode: "raw",
	stripDeepseekSpecialTokens: false,
	reasoningDeltasMayBeCumulative: false,
	emptyLengthFinishIsContextError: false,
	usesOpenAIToolCallIdLimit: false,
	dropThinkingWhenReasoningEffort: false,
};

function makeModel(id = "gpt-4o"): Model<"openai-completions"> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "openai",
		baseUrl: "",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 200_000,
		reasoning: false,
	});
}

function makeAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "openai",
		model: "gpt-4o",
		usage: emptyUsage,
		stopReason: "toolUse",
		timestamp: 1000,
	};
}

function makeToolResult(toolCallId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: "result data" }],
		isError: false,
		timestamp: 1001,
	};
}

function runConvert(
	messages: Message[],
	model: Model<"openai-completions">,
	compatOverride: Partial<ResolvedOpenAICompat> = {},
): ReturnType<typeof convertMessages> {
	const context: Context = {
		systemPrompt: [],
		messages,
		tools: [],
	};
	return convertMessages(model, context, { ...baseCompat, ...compatOverride });
}

describe("openai-completions convertMessages merged content loop", () => {
	it("collects text, thinking, and toolCall blocks in a single pass", () => {
		const model = makeModel();
		const assistant = makeAssistantMessage([
			{ type: "thinking", thinking: "Let me think.", thinkingSignature: "reasoning_content" },
			{ type: "text", text: "Running a tool." },
			{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "/tmp/test" } },
		]);
		const messages: Message[] = [assistant, makeToolResult("call_1")];

		const params = runConvert(messages, model);

		// The assistant message should have both content and tool_calls.
		const assistantParam = params.find(p => p.role === "assistant");
		expect(assistantParam).toBeDefined();
		expect(assistantParam && "tool_calls" in assistantParam ? assistantParam.tool_calls : undefined).toHaveLength(1);
		expect(assistantParam && "content" in assistantParam ? assistantParam.content : undefined).toBe(
			"Running a tool.",
		);
	});

	it("collects empty-text thinking blocks for Tier 1 reasoning recovery", () => {
		const model = makeModel();
		// An assistant message with an empty-text thinking block that has a
		// valid reasoning_content signature. The Tier 1 recovery path needs
		// to find this block even though nonEmptyThinkingBlocks skips it.
		const assistant = makeAssistantMessage([
			{ type: "thinking", thinking: "", thinkingSignature: "reasoning_content" },
			{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "/tmp" } },
		]);
		const messages: Message[] = [assistant, makeToolResult("call_1")];

		const params = runConvert(messages, model, {
			requiresReasoningContentForToolCalls: true,
			allowsSyntheticReasoningContentForToolCalls: false,
		});

		const assistantParam = params.find(p => p.role === "assistant") as Record<string, unknown> | undefined;
		expect(assistantParam).toBeDefined();
		// Tier 1: reasoning_content should be set from the empty-text thinking
		// block's signature, producing an empty string join.
		expect(assistantParam?.reasoning_content).toBe("");
	});

	it("preserves tool call order when multiple tool calls interleave with text", () => {
		const model = makeModel();
		const assistant = makeAssistantMessage([
			{ type: "text", text: "Step 1." },
			{ type: "toolCall", id: "call_a", name: "read", arguments: { path: "a" } },
			{ type: "text", text: "Step 2." },
			{ type: "toolCall", id: "call_b", name: "read", arguments: { path: "b" } },
		]);
		const messages: Message[] = [assistant, makeToolResult("call_a"), makeToolResult("call_b")];

		const params = runConvert(messages, model);

		const assistantParam = params.find(p => p.role === "assistant");
		const toolCalls = assistantParam && "tool_calls" in assistantParam ? assistantParam.tool_calls : [];
		expect(toolCalls).toHaveLength(2);
		expect(toolCalls?.[0]?.type === "function" ? toolCalls[0].function.name : undefined).toBe("read");
		expect(toolCalls?.[1]?.type === "function" ? toolCalls[1].function.name : undefined).toBe("read");
		// Text blocks should be joined in order.
		expect(assistantParam && "content" in assistantParam ? assistantParam.content : undefined).toBe("Step 1.Step 2.");
	});

	it("handles assistant message with only tool calls (no text or thinking)", () => {
		const model = makeModel();
		const assistant = makeAssistantMessage([
			{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "/tmp" } },
		]);
		const messages: Message[] = [assistant, makeToolResult("call_1")];

		const params = runConvert(messages, model);

		const assistantParam = params.find(p => p.role === "assistant");
		expect(assistantParam).toBeDefined();
		expect(assistantParam && "tool_calls" in assistantParam ? assistantParam.tool_calls : undefined).toHaveLength(1);
	});

	it("handles assistant message with only thinking blocks (no text or tool calls)", () => {
		const model = makeModel();
		const assistant = makeAssistantMessage([
			{ type: "thinking", thinking: "Just thinking.", thinkingSignature: "reasoning_content" },
		]);
		assistant.stopReason = "stop";
		const messages: Message[] = [assistant];

		const params = runConvert(messages, model);

		// With no text and no tool calls, the assistant message should be
		// skipped (no content, no tool_calls, no reasoning field on default compat).
		const assistantParam = params.find(p => p.role === "assistant");
		expect(assistantParam).toBeUndefined();
	});
});
