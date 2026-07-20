import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import {
	convertAnthropicMessages,
} from "@veyyon/ai/providers/anthropic";
import { convertMessages } from "@veyyon/ai/providers/openai-completions";
import { transformMessages } from "@veyyon/ai/providers/transform-messages";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	ToolResultMessage,
} from "@veyyon/ai/types";
import type { ResolvedOpenAICompat } from "@veyyon/catalog/types";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { normalizeResponsesToolCallId } from "@veyyon/ai/utils";
import { buildModel } from "@veyyon/catalog/build";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import {
	allocateCanonicalToolCallId,
	canonicalizeToolCallIds,
} from "@veyyon/coding-agent/session/canonicalize-tool-call-ids";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { type } from "arktype";

const LONG_A = "call_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|fc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const LONG_B = "call_cccccccccccccccccccccccccccccccc|fc_dddddddddddddddddddddddddddddddddddd";
const LONG_C = "call_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee|fc_ffffffffffffffffffffffffffffffff";

function usage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantWithCalls(
	ids: string[],
	opts: { api?: AssistantMessage["api"]; provider?: string; model?: string } = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: ids.map((id, i) => ({
			type: "toolCall" as const,
			id,
			name: i % 2 === 0 ? "read" : "bash",
			arguments: { path: `f${i}` },
		})),
		api: opts.api ?? "openai-responses",
		provider: opts.provider ?? "openai",
		model: opts.model ?? "gpt-test",
		usage: usage(),
		stopReason: "toolUse",
		timestamp: 1_000,
	};
}

function toolResult(id: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1_001,
	};
}

function extractPairs(messages: Message[]): Array<{ callId: string; resultId: string }> {
	const calls: string[] = [];
	const results: string[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const block of msg.content) {
				if (block.type === "toolCall") calls.push(block.id);
			}
		} else if (msg.role === "toolResult") {
			results.push(msg.toolCallId);
		}
	}
	return calls.map((callId, i) => ({ callId, resultId: results[i]! }));
}

describe("canonicalizeToolCallIds (unit)", () => {
	it("assigns tc_1..tc_n on first appearance and pairs call/result", () => {
		const map = new Map<string, string>();
		const counter = { value: 0 };
		const allocate = () => allocateCanonicalToolCallId(counter);

		const messages: Message[] = [
			{ role: "user", content: "go", timestamp: 1 },
			assistantWithCalls([LONG_A, LONG_B]),
			toolResult(LONG_A, "a"),
			toolResult(LONG_B, "b"),
			assistantWithCalls([LONG_C]),
			toolResult(LONG_C, "c"),
		];

		const out = canonicalizeToolCallIds(messages, map, allocate);
		const pairs = extractPairs(out);
		expect(pairs).toEqual([
			{ callId: "tc_1", resultId: "tc_1" },
			{ callId: "tc_2", resultId: "tc_2" },
			{ callId: "tc_3", resultId: "tc_3" },
		]);
		expect(map.get(LONG_A)).toBe("tc_1");
		expect(map.get(LONG_B)).toBe("tc_2");
		expect(map.get(LONG_C)).toBe("tc_3");
		// Input history untouched.
		expect((messages[1] as AssistantMessage).content[0]).toMatchObject({ id: LONG_A });
	});

	it("is deterministic across re-serialization (byte-identical prior turns)", () => {
		const map = new Map<string, string>();
		const counter = { value: 0 };
		const allocate = () => allocateCanonicalToolCallId(counter);
		const messages: Message[] = [
			assistantWithCalls([LONG_A, LONG_B]),
			toolResult(LONG_A, "a"),
			toolResult(LONG_B, "b"),
		];

		const first = canonicalizeToolCallIds(messages, map, allocate);
		const firstJson = JSON.stringify(first);

		const second = canonicalizeToolCallIds(messages, map, allocate);
		expect(JSON.stringify(second)).toBe(firstJson);
		expect(counter.value).toBe(2);
	});

	it("rebuilds the same mapping from stored history (resume)", () => {
		const stored: Message[] = [
			assistantWithCalls([LONG_A, LONG_B]),
			toolResult(LONG_A, "a"),
			toolResult(LONG_B, "b"),
			assistantWithCalls([LONG_C]),
			toolResult(LONG_C, "c"),
		];

		const liveMap = new Map<string, string>();
		const liveCounter = { value: 0 };
		canonicalizeToolCallIds(stored, liveMap, () => allocateCanonicalToolCallId(liveCounter));

		const resumeMap = new Map<string, string>();
		const resumeCounter = { value: 0 };
		const resumed = canonicalizeToolCallIds(stored, resumeMap, () =>
			allocateCanonicalToolCallId(resumeCounter),
		);

		expect([...resumeMap.entries()]).toEqual([...liveMap.entries()]);
		expect(extractPairs(resumed)).toEqual([
			{ callId: "tc_1", resultId: "tc_1" },
			{ callId: "tc_2", resultId: "tc_2" },
			{ callId: "tc_3", resultId: "tc_3" },
		]);
	});

	it("remaps provider IDs that already look like tc_N so the namespace stays unambiguous", () => {
		const map = new Map<string, string>();
		const counter = { value: 0 };
		const out = canonicalizeToolCallIds(
			[assistantWithCalls(["tc_1"]), toolResult("tc_1", "x")],
			map,
			() => allocateCanonicalToolCallId(counter),
		);
		expect(extractPairs(out)).toEqual([{ callId: "tc_1", resultId: "tc_1" }]);
		// Provider-emitted "tc_1" was remapped through the map (same handle by coincidence
		// of counter start) — the important part is it went through allocate/map.
		expect(map.get("tc_1")).toBe("tc_1");
		expect(counter.value).toBe(1);
	});
});

describe("canonicalizeToolCallIds provider paths", () => {
	it("Anthropic accepts tc_N (charset/length) and preserves call↔result pairing", () => {
		const map = new Map<string, string>();
		const counter = { value: 0 };
		const model = buildModel({
			api: "anthropic-messages",
			id: "claude-sonnet-4-6",
			name: "Claude Sonnet 4.6",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			maxTokens: 8192,
			contextWindow: 200_000,
			reasoning: false,
		});

		const canonical = canonicalizeToolCallIds(
			[
				assistantWithCalls([LONG_A, LONG_B], {
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-6",
				}),
				toolResult(LONG_A, "a"),
				toolResult(LONG_B, "b"),
			],
			map,
			() => allocateCanonicalToolCallId(counter),
		);

		const transformed = transformMessages(canonical, model);
		const pairs = extractPairs(transformed);
		expect(pairs).toEqual([
			{ callId: "tc_1", resultId: "tc_1" },
			{ callId: "tc_2", resultId: "tc_2" },
		]);

		const wire = convertAnthropicMessages(transformed, model, false);
		const assistant = wire.find(m => m.role === "assistant");
		const toolUseIds = (assistant?.content as Array<{ type: string; id?: string }>)
			.filter(b => b.type === "tool_use")
			.map(b => b.id);
		expect(toolUseIds).toEqual(["tc_1", "tc_2"]);

		const userTool = wire.find(
			m =>
				m.role === "user" &&
				Array.isArray(m.content) &&
				(m.content as Array<{ type: string }>).some(b => b.type === "tool_result"),
		);
		const resultIds = (userTool?.content as Array<{ type: string; tool_use_id?: string }>)
			.filter(b => b.type === "tool_result")
			.map(b => b.tool_use_id);
		expect(resultIds).toEqual(["tc_1", "tc_2"]);
	});

	it("Mistral strips _ / pads to 9 alnum deterministically with matching pairs", () => {
		const map = new Map<string, string>();
		const counter = { value: 0 };
		const model = buildModel({
			api: "openai-completions",
			id: "mistral-large-latest",
			name: "Mistral Large",
			provider: "mistral",
			baseUrl: "https://api.mistral.ai/v1",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			maxTokens: 8192,
			contextWindow: 128_000,
			reasoning: false,
			compat: { requiresMistralToolIds: true },
		});
		const compat = model.compat as ResolvedOpenAICompat;

		const canonical = canonicalizeToolCallIds(
			[
				assistantWithCalls([LONG_A, LONG_B], {
					api: "openai-completions",
					provider: "mistral",
					model: "mistral-large-latest",
				}),
				toolResult(LONG_A, "a"),
				toolResult(LONG_B, "b"),
			],
			map,
			() => allocateCanonicalToolCallId(counter),
		);

		const wire = convertMessages(model, { messages: canonical }, compat);
		const assistant = wire.find(m => m.role === "assistant") as {
			tool_calls?: Array<{ id: string }>;
		};
		const callIds = assistant.tool_calls?.map(tc => tc.id) ?? [];
		expect(callIds).toHaveLength(2);
		for (const id of callIds) {
			expect(id).toMatch(/^[a-zA-Z0-9]{9}$/);
		}
		// tc_1 → strip _ → tc1 → pad → tc1ABCDEF; tc_2 → tc2ABCDEF
		expect(callIds).toEqual(["tc1ABCDEF", "tc2ABCDEF"]);

		const toolMsgs = wire.filter(m => m.role === "tool") as Array<{ tool_call_id: string }>;
		expect(toolMsgs.map(m => m.tool_call_id)).toEqual(callIds);
	});

	it("OpenAI Responses path: composite IDs canonicalize then normalizeResponsesToolCallId stays paired", () => {
		const map = new Map<string, string>();
		const counter = { value: 0 };
		const model = buildModel({
			api: "openai-responses",
			id: "gpt-test",
			name: "GPT Test",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			maxTokens: 2048,
			contextWindow: 8192,
			reasoning: false,
		});

		const canonical = canonicalizeToolCallIds(
			[assistantWithCalls([LONG_A, LONG_B]), toolResult(LONG_A, "a"), toolResult(LONG_B, "b")],
			map,
			() => allocateCanonicalToolCallId(counter),
		);
		expect(extractPairs(canonical)).toEqual([
			{ callId: "tc_1", resultId: "tc_1" },
			{ callId: "tc_2", resultId: "tc_2" },
		]);

		const transformed = transformMessages(canonical, model);
		const callIds = transformed
			.filter((m): m is AssistantMessage => m.role === "assistant")
			.flatMap(m => m.content)
			.filter(b => b.type === "toolCall")
			.map(b => normalizeResponsesToolCallId((b as { id: string }).id).callId);
		const resultIds = transformed
			.filter((m): m is ToolResultMessage => m.role === "toolResult")
			.map(m => normalizeResponsesToolCallId(m.toolCallId).callId);
		expect(callIds).toHaveLength(2);
		expect(new Set(callIds).size).toBe(2);
		expect(resultIds).toEqual(callIds);
	});
});

describe("AgentSession transformProviderContext canonicalization", () => {
	let tempDir: TempDir;
	const cleanups: Array<() => Promise<void>> = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-agent-tw8-canonicalize-");
		cleanups.length = 0;
	});

	afterEach(async () => {
		for (const cleanup of cleanups) await cleanup();
		cleanups.length = 0;
		tempDir.removeSync();
	});

	async function createHarness(seedMessages: Message[] = []) {
		const observedContexts: Context[] = [];
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5");

		const authStorage = await AuthStorage.create(path.join(tempDir.path(), `auth-${cleanups.length}.db`));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), `models-${cleanups.length}.yml`));
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"contextPromotion.enabled": false,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());

		const mockBashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		};

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [mockBashTool],
				messages: seedMessages,
			},
			convertToLlm,
			streamFn: (_model, context) => {
				observedContexts.push({
					systemPrompt: context.systemPrompt,
					messages: context.messages,
					tools: context.tools,
				});
				const stream = new AssistantMessageEventStream();
				const message = {
					role: "assistant" as const,
					content: [{ type: "text" as const, text: "done" }],
					api: "anthropic-messages" as const,
					provider: "anthropic" as const,
					model: "claude-sonnet-4-5",
					usage: usage(),
					stopReason: "stop" as const,
					timestamp: Date.now(),
				};
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: message.stopReason, message });
				});
				return stream;
			},
		});

		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map([[mockBashTool.name, mockBashTool]]),
		});
		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});
		return { session, agent, sessionManager, observedContexts, model };
	}

	it("multi-turn outbound context carries tc_1..tc_n with matching pairs; history keeps originals", async () => {
		const seed: Message[] = [
			{ role: "user", content: "first", timestamp: 1 },
			assistantWithCalls([LONG_A, LONG_B], {
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
			}),
			toolResult(LONG_A, "a"),
			toolResult(LONG_B, "b"),
		];
		const { session, observedContexts, agent } = await createHarness(seed);

		await session.prompt("continue");

		expect(observedContexts.length).toBeGreaterThanOrEqual(1);
		const outbound = observedContexts[0]!;
		const pairs = extractPairs(outbound.messages);
		expect(pairs).toEqual([
			{ callId: "tc_1", resultId: "tc_1" },
			{ callId: "tc_2", resultId: "tc_2" },
		]);
		expect(JSON.stringify(outbound.messages)).not.toContain(LONG_A);
		expect(JSON.stringify(outbound.messages)).not.toContain(LONG_B);

		// Persisted / agent state still holds original provider IDs.
		const persisted = JSON.stringify(agent.state.messages);
		expect(persisted).toContain(LONG_A);
		expect(persisted).toContain(LONG_B);
	});

	it("same session serialized twice is byte-identical up to the new turn", async () => {
		const seed: Message[] = [
			{ role: "user", content: "first", timestamp: 1 },
			assistantWithCalls([LONG_A], {
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
			}),
			toolResult(LONG_A, "a"),
		];
		const { session, observedContexts } = await createHarness(seed);

		await session.prompt("turn-a");
		await session.prompt("turn-b");

		expect(observedContexts.length).toBeGreaterThanOrEqual(2);
		const firstPrior = observedContexts[0]!.messages.filter(
			m => !(m.role === "user" && typeof m.content === "string" && m.content === "turn-a"),
		);
		// Second request's prefix (everything before the new user turn) must match
		// the first request's tool-call IDs byte-for-byte.
		const secondMessages = observedContexts[1]!.messages;
		const secondPrior = secondMessages.slice(0, firstPrior.length);
		expect(JSON.stringify(extractPairs(secondPrior))).toBe(JSON.stringify(extractPairs(firstPrior)));
		expect(JSON.stringify(secondPrior.map(m => (m.role === "assistant" ? extractPairs([m]) : m.role)))).toEqual(
			JSON.stringify(firstPrior.map(m => (m.role === "assistant" ? extractPairs([m]) : m.role))),
		);
		// Canonical IDs for prior calls stay tc_1 across turns.
		expect(extractPairs(secondPrior)[0]).toEqual({ callId: "tc_1", resultId: "tc_1" });
	});

	it("resume from stored history reproduces the same mapping", async () => {
		const seed: Message[] = [
			{ role: "user", content: "first", timestamp: 1 },
			assistantWithCalls([LONG_A, LONG_B], {
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
			}),
			toolResult(LONG_A, "a"),
			toolResult(LONG_B, "b"),
		];
		const first = await createHarness(seed);
		await first.session.prompt("continue");
		const firstPairs = extractPairs(first.observedContexts[0]!.messages);

		// Simulate resume: new AgentSession, same stored messages (original long IDs).
		const resumed = await createHarness(seed);
		await resumed.session.prompt("continue-after-resume");
		const resumePairs = extractPairs(resumed.observedContexts[0]!.messages);

		expect(resumePairs).toEqual(firstPairs);
		expect(resumePairs).toEqual([
			{ callId: "tc_1", resultId: "tc_1" },
			{ callId: "tc_2", resultId: "tc_2" },
		]);
	});
});
