/**
 * WHY: Cursor and Devin thread turns by conversation id and cache per-conversation
 * state under it, falling back to `sessionId`. A compaction oneshot that reused
 * the live session id therefore arrived as a one-message conversation under the
 * live conversation's identity, clobbered the cached state the next turn would
 * have resumed from, and — on a split-turn pass — collided with the concurrent
 * turn-prefix summary on that same id. Cursor answered the second arm with
 * `Connect error invalid_argument`, so every compaction attempt failed while
 * the context stayed full.
 *
 * `instrumentedCompleteSimple` is the choke point for every agent-package
 * oneshot. These tests lock the derived conversation identity there and through
 * the real `compact()` path, so a regression that sends the live session id
 * (or that lets the two split-turn arms share an id) fails loudly.
 */
import { describe, expect, it } from "bun:test";
import { instrumentedCompleteSimple } from "@veyyon/agent-core";
import { type CompactionPreparation, compact, DEFAULT_COMPACTION_SETTINGS } from "@veyyon/agent-core/compaction";
import type {
	AssistantMessage,
	Message,
	Model,
	SimpleStreamOptions,
	Tool,
	ToolResultMessage,
	UserMessage,
} from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";

const SESSION_ID = "live-session-id";
const SESSION_PROMPT = ["# Harness\nstable shared prefix"];
const TOOLS: Tool[] = [{ name: "read", description: "read a file", parameters: { type: "object", properties: {} } }];

function anthropicModel(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("expected bundled anthropic/claude-sonnet-4-5");
	return model;
}

function user(text: string, timestamp = 1): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistantText(text: string, timestamp = 2): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp,
	};
}

function assistantToolCall(id: string, timestamp = 3): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: { path: "x.txt" } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "toolUse",
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp,
	};
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

function capturedAssistant(): AssistantMessage {
	return assistantText("a summary");
}

describe("a side request never joins the live conversation", () => {
	it("derives a sessionId#kind conversation ID for a compaction summary", async () => {
		let seen: SimpleStreamOptions | undefined;
		await instrumentedCompleteSimple(
			anthropicModel(),
			{ systemPrompt: ["s"], messages: [], tools: [] },
			{ sessionId: SESSION_ID },
			{
				telemetry: undefined,
				oneshotKind: "compaction_summary",
				completeImpl: async (_model, _ctx, options) => {
					seen = options;
					return capturedAssistant();
				},
			},
		);
		expect(seen?.conversationId).toBe(`${SESSION_ID}#compaction_summary`);
		expect(seen?.sessionId).toBe(SESSION_ID);
	});

	it("honors an explicit conversationId instead of deriving one", async () => {
		let seen: SimpleStreamOptions | undefined;
		await instrumentedCompleteSimple(
			anthropicModel(),
			{ systemPrompt: ["s"], messages: [], tools: [] },
			{ sessionId: SESSION_ID, conversationId: "explicit-side" },
			{
				telemetry: undefined,
				oneshotKind: "handoff",
				completeImpl: async (_model, _ctx, options) => {
					seen = options;
					return capturedAssistant();
				},
			},
		);
		expect(seen?.conversationId).toBe("explicit-side");
	});

	it("leaves conversationId unset when there is no session id", async () => {
		let seen: SimpleStreamOptions | undefined;
		await instrumentedCompleteSimple(
			anthropicModel(),
			{ systemPrompt: ["s"], messages: [], tools: [] },
			{},
			{
				telemetry: undefined,
				oneshotKind: "compaction_summary",
				completeImpl: async (_model, _ctx, options) => {
					seen = options;
					return capturedAssistant();
				},
			},
		);
		expect(seen?.conversationId).toBeUndefined();
		expect(seen?.sessionId).toBeUndefined();
	});

	it("reuses the same side id on a retry of the same kind", async () => {
		const ids: Array<string | undefined> = [];
		const run = () =>
			instrumentedCompleteSimple(
				anthropicModel(),
				{ systemPrompt: ["s"], messages: [], tools: [] },
				{ sessionId: SESSION_ID },
				{
					telemetry: undefined,
					oneshotKind: "compaction_summary",
					completeImpl: async (_model, _ctx, options) => {
						ids.push(options.conversationId);
						return capturedAssistant();
					},
				},
			);
		await run();
		await run();
		expect(ids).toEqual([`${SESSION_ID}#compaction_summary`, `${SESSION_ID}#compaction_summary`]);
	});
});

describe("compact() gives each summarization arm its own conversation", () => {
	function basePreparation(overrides: Partial<CompactionPreparation> = {}): CompactionPreparation {
		return {
			firstKeptEntryId: "kept-entry",
			messagesToSummarize: [
				user("first question"),
				assistantToolCall("call-1"),
				toolResult("call-1", "T".repeat(200)),
			],
			turnPrefixMessages: [],
			recentMessages: [assistantText("here is the answer")],
			isSplitTurn: false,
			tokensBefore: 100_000,
			previousSummary: undefined,
			previousPreserveData: undefined,
			fileOps: { read: new Set(), edited: new Set(), written: new Set() },
			settings: { ...DEFAULT_COMPACTION_SETTINGS },
			...overrides,
		};
	}

	const sessionMessages: Message[] = [user("first question")];

	it("tags a non-split history summary with the compaction-summary side ID", async () => {
		const ids: Array<string | undefined> = [];
		await compact(basePreparation(), anthropicModel(), "test-key", undefined, undefined, {
			tools: TOOLS,
			sessionSystemPrompt: SESSION_PROMPT,
			sessionMessages,
			sessionId: SESSION_ID,
			completeImpl: async (_model, _ctx, options) => {
				ids.push(options.conversationId);
				return capturedAssistant();
			},
		});
		expect(ids).toEqual([`${SESSION_ID}#compaction_summary`]);
		expect(ids[0]).not.toBe(SESSION_ID);
	});

	it("gives the split-turn history and turn-prefix arms distinct ids, neither the live session", async () => {
		const ids: Array<string | undefined> = [];
		await compact(
			basePreparation({
				isSplitTurn: true,
				turnPrefixMessages: [user("this turn so far"), assistantToolCall("call-2")],
			}),
			anthropicModel(),
			"test-key",
			undefined,
			undefined,
			{
				tools: TOOLS,
				sessionSystemPrompt: SESSION_PROMPT,
				sessionMessages,
				sessionId: SESSION_ID,
				completeImpl: async (_model, _ctx, options) => {
					ids.push(options.conversationId);
					return capturedAssistant();
				},
			},
		);
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
		expect(ids).toContain(`${SESSION_ID}#compaction_summary`);
		expect(ids).toContain(`${SESSION_ID}#compaction_turn_prefix`);
		expect(ids.includes(SESSION_ID)).toBe(false);
	});
});
