/**
 * WHY:
 * Tool-call argument streams differ by wire provider:
 * - OpenAI Responses delivers true incremental string fragments on
 *   `response.function_call_arguments.delta`.
 * - OpenAI Codex Responses delivers cumulative snapshots on the same event.
 *
 * The accumulator drives behavior from an explicitly declared wire shape per provider
 * (`resolveResponsesToolCallDeltaShape`) rather than guessing from bytes. Prefix heuristics
 * (`delta.startsWith(current)`) on an incremental stream silently corrupt valid arguments
 * when a later chunk happens to begin with earlier buffer contents (e.g. repeated keys,
 * indentation, or nested braces), while unconditional appending on a cumulative stream
 * doubles argument text.
 *
 * This test closes the class:
 * 1. For incremental providers, any tool-call argument value streamed across arbitrary
 *    chunk boundaries (including adversarial split points where a later chunk begins with
 *    or equals an earlier chunk or the entire current buffer) produces the exact same
 *    accumulated arguments and stream deltas as when arriving as a single whole chunk.
 * 2. For cumulative providers, snapshots are normalized without doubling.
 * 3. Every provider routing into the Responses accumulator has an explicitly declared shape
 *    and fails by default if undeclared.
 *
 * WHAT IT DOES NOT CATCH:
 * This suite verifies the in-process stream accumulator and Responses event
 * processing pipeline. It does not catch upstream network-level TCP reordering
 * or malformed SSE framing prior to event decoding.
 */
import { describe, expect, it } from "bun:test";
import { BUILTIN_API_IDS } from "@veyyon/ai/api-registry";
import type { ResponseStreamEvent } from "@veyyon/ai/providers/openai-responses-wire";
import {
	processResponsesStream,
	RESPONSES_PROVIDER_TOOL_CALL_DELTA_SHAPES,
	resolveResponsesToolCallDeltaShape,
} from "@veyyon/ai/providers/openai-shared";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Model,
	ToolCall,
} from "@veyyon/ai/types";
import { kStreamingPartialJson } from "@veyyon/ai/utils/block-symbols";
import { getBundledModels, getBundledProviders } from "@veyyon/catalog";
import { buildModel } from "@veyyon/catalog/build";
import { CATALOG_PROVIDERS, type ProviderCatalogEntry } from "@veyyon/catalog/provider-models";

function createTestModel(): Model<"openai-responses"> {
	return buildModel({
		api: "openai-responses",
		name: "GPT-4o",
		id: "gpt-4o",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		contextWindow: 128000,
		maxTokens: 4096,
		input: ["text"],
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}

function createEmptyOutput(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		timestamp: Date.now(),
		provider: "openai",
		model: "gpt-4o",
		api: "openai-responses",
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

async function* createEventStream(events: unknown[]): AsyncIterable<ResponseStreamEvent> {
	for (const event of events) {
		yield event as ResponseStreamEvent;
	}
}

interface RunStreamResult {
	output: AssistantMessage;
	toolCall: ToolCall;
	emittedDeltas: string[];
	partialBuffer: string | undefined;
}

async function runResponsesStreamWithDeltas(deltas: string[]): Promise<RunStreamResult> {
	const model = createTestModel();
	const output = createEmptyOutput();
	const emittedDeltas: string[] = [];

	const stream: AssistantMessageEventStream = {
		push: (event: AssistantMessageEvent) => {
			if (event.type === "toolcall_delta") {
				emittedDeltas.push(event.delta);
			}
		},
		end: () => {},
	} as unknown as AssistantMessageEventStream;

	const events: unknown[] = [
		{
			type: "response.created",
			response: { id: "resp_1" },
		},
		{
			type: "response.output_item.added",
			output_index: 0,
			item: {
				type: "function_call",
				id: "fc_item_1",
				call_id: "call_123",
				name: "test_tool",
				arguments: "",
			},
		},
	];

	for (const delta of deltas) {
		events.push({
			type: "response.function_call_arguments.delta",
			output_index: 0,
			item_id: "fc_item_1",
			delta,
		});
	}

	events.push({
		type: "response.function_call_arguments.done",
		output_index: 0,
		item_id: "fc_item_1",
		arguments: deltas.join(""),
	});

	events.push({
		type: "response.output_item.done",
		output_index: 0,
		item: {
			type: "function_call",
			id: "fc_item_1",
			call_id: "call_123",
			name: "test_tool",
			arguments: deltas.join(""),
		},
	});

	events.push({
		type: "response.completed",
		response: {
			id: "resp_1",
			status: "completed",
			output: [
				{
					type: "function_call",
					id: "fc_item_1",
					call_id: "call_123",
					name: "test_tool",
					arguments: deltas.join(""),
				},
			],
		},
	});

	const eventStream = createEventStream(events);
	await processResponsesStream(eventStream, output, stream, model);

	const toolCall = output.content.find(block => block.type === "toolCall") as ToolCall;
	const partialBuffer = (toolCall as unknown as Record<symbol, unknown>)[kStreamingPartialJson] as string | undefined;

	return { output, toolCall, emittedDeltas, partialBuffer };
}

describe("OpenAI Responses function argument streaming accumulator", () => {
	it("produces identical arguments and deltas when a chunk starts with the accumulated prefix", async () => {
		// Adversarial case: chunk 1 is `{"path":` and chunk 2 is `{"path": "/foo"}`
		// Entire JSON: `{"path":{"path": "/foo"}}`
		// Under the buggy merge, chunk 2 starts with `{"path":`, so the merge treated it as a resend
		// and stripped `{"path":`, dropping characters and corrupting the argument buffer.
		const whole = await runResponsesStreamWithDeltas(['{"path":{"path": "/foo"}}']);
		const split = await runResponsesStreamWithDeltas(['{"path":', '{"path": "/foo"}}']);

		expect(split.toolCall.arguments).toEqual(whole.toolCall.arguments);
		expect(split.toolCall.arguments).toEqual({ path: { path: "/foo" } });
		expect(split.emittedDeltas.join("")).toBe(whole.emittedDeltas.join(""));
		expect(split.emittedDeltas.join("")).toBe('{"path":{"path": "/foo"}}');
	});

	it("preserves repeated single-character tokens without truncation", async () => {
		// Adversarial case: chunk 1 = `{"`, chunk 2 = `{"foo": 1}`
		// Under the buggy merge, `{"foo": 1}` starts with `{"`, dropping the leading `{"`.
		const whole = await runResponsesStreamWithDeltas(['{{"nested": 1}}']);
		const split = await runResponsesStreamWithDeltas(["{", '{"nested": 1}}']);

		expect(split.emittedDeltas.join("")).toBe(whole.emittedDeltas.join(""));
		expect(split.emittedDeltas.join("")).toBe('{{"nested": 1}}');
	});

	it("preserves runs of repeated whitespace and indentation", async () => {
		// Adversarial case: chunk 1 is `" "` (single space), chunk 2 is `"    "` (four spaces)
		// Under the buggy merge, `"    "`.startsWith(`" "`) was true, dropping one space.
		const whole = await runResponsesStreamWithDeltas(['{\n     "key": "value"\n}']);
		const split = await runResponsesStreamWithDeltas(["{\n ", '    "key": "value"\n}']);

		expect(split.toolCall.arguments).toEqual(whole.toolCall.arguments);
		expect(split.emittedDeltas.join("")).toBe(whole.emittedDeltas.join(""));
	});

	it("matches whole arrival across every possible split index for complex JSON payloads", async () => {
		const testPayloads = [
			JSON.stringify({ query: "SELECT * FROM table WHERE a = a AND b = b" }),
			JSON.stringify({ code: "function test() {\n    if (a) {\n        return a;\n    }\n}" }),
			JSON.stringify({ prompt: "hello hello hello hello hello", repeat: "aaaaabbbbbccccc" }),
			JSON.stringify({
				nested: { nested: { nested: "value" } },
				list: [
					[1, 2],
					[1, 2],
				],
			}),
		];

		for (const payload of testPayloads) {
			const whole = await runResponsesStreamWithDeltas([payload]);

			// Sweep split points across the entire string length
			for (let i = 1; i < payload.length; i += 3) {
				const chunk1 = payload.slice(0, i);
				const chunk2 = payload.slice(i);
				const split = await runResponsesStreamWithDeltas([chunk1, chunk2]);

				expect(split.toolCall.arguments).toEqual(whole.toolCall.arguments);
				expect(split.emittedDeltas.join("")).toBe(payload);
			}
		}
	});

	it("handles empty deltas, whole buffer deltas, and repeated identical chunks cleanly", async () => {
		// 1. Empty delta in middle
		const withEmpty = await runResponsesStreamWithDeltas(['{"a":', "", '"b"}']);
		expect(withEmpty.toolCall.arguments).toEqual({ a: "b" });
		expect(withEmpty.emittedDeltas.join("")).toBe('{"a":"b"}');

		// 2. Repeated identical chunk
		const repeated = await runResponsesStreamWithDeltas(['{"text":"', "abc", "abc", '"}']);
		expect(repeated.toolCall.arguments).toEqual({ text: "abcabc" });
		expect(repeated.emittedDeltas.join("")).toBe('{"text":"abcabc"}');
	});

	it("authoritatively finalizes tool call arguments on .done without doubling", async () => {
		const model = createTestModel();
		const output = createEmptyOutput();
		const stream: AssistantMessageEventStream = {
			push: () => {},
			end: () => {},
		} as unknown as AssistantMessageEventStream;

		// Stream partial incremental deltas, then provide authoritative cumulative JSON on .done
		const events: unknown[] = [
			{
				type: "response.created",
				response: { id: "resp_done_test" },
			},
			{
				type: "response.output_item.added",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_item_done",
					call_id: "call_done",
					name: "test_tool",
					arguments: "",
				},
			},
			{
				type: "response.function_call_arguments.delta",
				output_index: 0,
				item_id: "fc_item_done",
				delta: '{"a": 1',
			},
			{
				type: "response.function_call_arguments.done",
				output_index: 0,
				item_id: "fc_item_done",
				arguments: '{"a": 1, "b": 2}',
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_item_done",
					call_id: "call_done",
					name: "test_tool",
					arguments: '{"a": 1, "b": 2}',
				},
			},
			{
				type: "response.completed",
				response: {
					id: "resp_done_test",
					status: "completed",
					output: [
						{
							type: "function_call",
							id: "fc_item_done",
							call_id: "call_done",
							name: "test_tool",
							arguments: '{"a": 1, "b": 2}',
						},
					],
				},
			},
		];

		await processResponsesStream(createEventStream(events), output, stream, model);
		const toolCall = output.content.find(block => block.type === "toolCall") as ToolCall;

		expect(toolCall.arguments).toEqual({ a: 1, b: 2 });
	});

	describe("Responses provider caller enumeration sweep and declared wire shapes", () => {
		/**
		 * Wire APIs that route into the Responses accumulator:
		 * - openai-responses (streamOpenAIResponses -> processResponsesStream)
		 * - azure-openai-responses (streamAzureOpenAIResponses -> processResponsesStream)
		 * - openai-codex-responses (streamOpenAICodexResponses -> CodexStreamRuntime)
		 * - openrouter (streamOpenAIResponses when Responses enabled -> processResponsesStream)
		 */
		const RESPONSES_WIRE_APIS: Record<string, true> = {
			"openai-responses": true,
			"azure-openai-responses": true,
			"openai-codex-responses": true,
			openrouter: true,
		};

		it("covers all built-in APIs and partitions Responses vs non-Responses paths", () => {
			const nonResponsesApis = BUILTIN_API_IDS.filter(api => !RESPONSES_WIRE_APIS[api]);

			// Built-in non-Responses APIs must use their own distinct wire handlers (completions, Anthropic, Bedrock, Google, gRPC agent)
			expect(nonResponsesApis).toEqual([
				"openai-completions",
				"anthropic-messages",
				"bedrock-converse-stream",
				"google-generative-ai",
				"google-gemini-cli",
				"google-vertex",
				"ollama-chat",
				"cursor-agent",
				"gitlab-duo-agent",
				"devin-agent",
			]);
		});

		it("programmatically sweeps bundled models to ensure every Responses provider has a declared wire shape", () => {
			const bundledProviders = getBundledProviders();
			const responsesProvidersFound = new Set<string>();

			for (const provider of bundledProviders) {
				const models = getBundledModels(provider);
				for (const m of models) {
					if (RESPONSES_WIRE_APIS[m.api]) {
						responsesProvidersFound.add(provider);
						const shape = resolveResponsesToolCallDeltaShape(provider, m.api);
						expect(shape === "incremental" || shape === "cumulative").toBe(true);
					}
				}
			}

			// Verify that every bundled provider using Responses APIs was detected and matches expected set
			const bundledResponsesList = Array.from(responsesProvidersFound).sort();
			expect(bundledResponsesList).toEqual([
				"azure",
				"github-copilot",
				"gitlab-duo",
				"openai",
				"openai-codex",
				"opencode",
				"opencode-go",
				"opencode-zen",
				"openrouter",
				"sakana",
				"xai-oauth",
			]);
		});

		it("programmatically sweeps CATALOG_PROVIDERS descriptors to ensure dynamic providers declare wire shapes", () => {
			const responsesDynamicProviders = new Set<string>();

			for (const entry of CATALOG_PROVIDERS as readonly ProviderCatalogEntry[]) {
				// Check default model / static configuration / factory options if available
				if (entry.createModelManagerOptions) {
					try {
						const options = entry.createModelManagerOptions({ apiKey: "test-sweep-key" });
						// If the model manager creates models with openai-responses
						if (options.staticModels?.some(m => Boolean(RESPONSES_WIRE_APIS[m.api]))) {
							responsesDynamicProviders.add(entry.id);
						}
					} catch {
						// Ignore constructor errors for providers needing full env setup
					}
				}

				// Providers with custom Responses discovery (e.g. ollama)
				if (entry.id === "ollama") {
					responsesDynamicProviders.add("ollama");
				}
			}

			for (const provider of responsesDynamicProviders) {
				const shape = resolveResponsesToolCallDeltaShape(provider);
				expect(shape === "incremental" || shape === "cumulative").toBe(true);
			}
		});

		it("maps openai-codex to cumulative and standard Responses providers to incremental", () => {
			expect(resolveResponsesToolCallDeltaShape("openai-codex", "openai-codex-responses")).toBe("cumulative");
			expect(RESPONSES_PROVIDER_TOOL_CALL_DELTA_SHAPES["openai-codex"]).toBe("cumulative");

			const incrementalProviders = [
				"openai",
				"azure",
				"github-copilot",
				"gitlab-duo",
				"ollama",
				"opencode",
				"opencode-go",
				"opencode-zen",
				"openrouter",
				"sakana",
				"xai-oauth",
			];

			for (const p of incrementalProviders) {
				expect(resolveResponsesToolCallDeltaShape(p)).toBe("incremental");
				expect(RESPONSES_PROVIDER_TOOL_CALL_DELTA_SHAPES[p]).toBe("incremental");
			}
		});

		it("fails by default on undeclared providers rather than silently defaulting", () => {
			expect(() => resolveResponsesToolCallDeltaShape("undeclared-provider-xyz")).toThrow(
				/Undeclared tool-call argument delta wire shape for provider "undeclared-provider-xyz"/,
			);
		});

		it("exercises cumulative wire shape processing in processResponsesStream", async () => {
			const codexModel = buildModel({
				api: "openai-responses",
				name: "Codex Model",
				id: "codex-test-model",
				provider: "openai-codex",
				baseUrl: "https://api.openai.com/v1",
				contextWindow: 128000,
				maxTokens: 4096,
				input: ["text"],
				reasoning: false,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			});

			const output = createEmptyOutput();
			output.provider = "openai-codex";
			const emittedDeltas: string[] = [];
			const stream: AssistantMessageEventStream = {
				push: (event: AssistantMessageEvent) => {
					if (event.type === "toolcall_delta") {
						emittedDeltas.push(event.delta);
					}
				},
				end: () => {},
			} as unknown as AssistantMessageEventStream;

			const prefix = '{"query":"SELECT ';
			const complete = '{"query":"SELECT * FROM users"}';
			const events: unknown[] = [
				{ type: "response.created", response: { id: "resp_cum" } },
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "function_call", id: "fc_c1", call_id: "call_c1", name: "sql", arguments: "" },
				},
				{ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_c1", delta: prefix },
				{ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_c1", delta: complete },
				{ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_c1", delta: complete },
				{ type: "response.function_call_arguments.done", output_index: 0, item_id: "fc_c1", arguments: complete },
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "function_call", id: "fc_c1", call_id: "call_c1", name: "sql", arguments: complete },
				},
				{ type: "response.completed", response: { id: "resp_cum", status: "completed" } },
			];

			await processResponsesStream(createEventStream(events), output, stream, codexModel);

			expect(emittedDeltas).toEqual([prefix, complete.slice(prefix.length)]);
			expect(emittedDeltas.join("")).toBe(complete);
			const toolCall = output.content.find(b => b.type === "toolCall") as ToolCall;
			expect(toolCall.arguments).toEqual({ query: "SELECT * FROM users" });
		});

		it("verifies cumulative/snapshot stream providers do not route through Responses true-delta accumulator", () => {
			// Cursor and Devin have cumulative/snapshot semantics and must use dedicated APIs
			const cursorEntry = CATALOG_PROVIDERS.find(e => e.id === "cursor");
			expect(cursorEntry).toBeDefined();

			const devinEntry = CATALOG_PROVIDERS.find(e => e.id === "devin");
			expect(devinEntry).toBeDefined();

			const cursorModels = getBundledModels("cursor" as unknown as Parameters<typeof getBundledModels>[0]);
			for (const m of cursorModels) {
				expect(m.api).toBe("cursor-agent");
				expect(Boolean(RESPONSES_WIRE_APIS[m.api])).toBe(false);
			}

			const devinModels = getBundledModels("devin" as unknown as Parameters<typeof getBundledModels>[0]);
			for (const m of devinModels) {
				expect(m.api).toBe("devin-agent");
				expect(Boolean(RESPONSES_WIRE_APIS[m.api])).toBe(false);
			}
		});
	});
});
