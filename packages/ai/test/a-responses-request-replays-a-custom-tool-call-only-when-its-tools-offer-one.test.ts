import { afterEach, describe, expect, it } from "bun:test";
import { BUILTIN_API_IDS } from "@veyyon/ai/api-registry";
import { streamAzureOpenAIResponses } from "@veyyon/ai/providers/azure-openai-responses";
import { buildTransformedCodexRequestBody } from "@veyyon/ai/providers/openai-codex-responses";
import {
	openAIResponsesServerCompaction,
	resetServerCompactionRouteCache,
	SERVER_COMPACTION_WIRE_APIS,
} from "@veyyon/ai/providers/openai-compaction";
import { streamOpenAIResponses } from "@veyyon/ai/providers/openai-responses";
import { streamSimple } from "@veyyon/ai/stream";
import type { Api, AssistantMessage, Context, FetchImpl, Model, Tool } from "@veyyon/ai/types";
import { createOpenAIResponsesHistoryPayload } from "@veyyon/ai/utils";
import { buildModel } from "@veyyon/catalog/build";
import { emptyUsage } from "@veyyon/catalog/models";
import { type } from "arktype";

/**
 * WHY: the Responses endpoint rejects an `input` that replays a `custom_tool_call` the request's `tools` do not
 * declare as a custom tool. Each Responses provider decides two things separately: whether its tools offer the
 * freeform `apply_patch` grammar, and whether its input replays a freeform call as `custom_tool_call`. The Codex
 * provider converted its input with a private converter that kept `custom_tool_call` for a model whose tools
 * offered `edit` as a function tool, and Azure's input read the catalog flag while every Azure tool is a function
 * tool.
 *
 * THE CLASS: any Responses-wire request whose `input` carries a `custom_tool_call` naming no custom tool in its
 * `tools`, or a `custom_tool_call_output` with no `custom_tool_call` beside it. The sweep enumerates every built-in
 * api and fails on one with no recorded decision. Server compaction sends no tools, so its span is held to the call
 * kinds the same provider's turn replays: a compacted span that disagrees with the turn reintroduces the defect on
 * the first turn after compaction.
 *
 * WHAT THIS DOES NOT CATCH: a `function_call` naming a tool the request no longer offers (a tool removed
 * mid-session), and the Codex websocket transport, which sends the body this builder returns.
 */

const PATCH = "*** Begin Patch\n*** End Patch\n";

const editTool: Tool = {
	name: "edit",
	customWireName: "apply_patch",
	description: "edit files",
	parameters: type({ input: "string" }),
	customFormat: { syntax: "lark", definition: 'start: "*** Begin Patch" LF' },
};

const readTool: Tool = {
	name: "read",
	description: "read a file",
	parameters: type({ path: "string" }),
};

/** The call ids of the two freeform calls: one rebuilt from its content block, one replayed from native history. */
const BLOCK_CALL = "call_block";
const NATIVE_CALL = "call_native";

function transcript(model: Model<Api>): Context {
	const turn = (content: AssistantMessage["content"], timestamp: number): AssistantMessage => ({
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "toolUse",
		timestamp,
	});
	const blockTurn = turn(
		[
			{
				type: "toolCall",
				id: `${BLOCK_CALL}|ctc_1`,
				name: "edit",
				customWireName: "apply_patch",
				arguments: { input: PATCH },
			},
			{ type: "toolCall", id: "call_read|fc_1", name: "read", arguments: { path: "a.ts" } },
		],
		2,
	);
	const nativeTurn = turn(
		[
			{
				type: "toolCall",
				id: `${NATIVE_CALL}|ctc_2`,
				name: "edit",
				customWireName: "apply_patch",
				arguments: { input: PATCH },
			},
		],
		5,
	);
	nativeTurn.providerPayload = createOpenAIResponsesHistoryPayload(model.provider, [
		{ type: "custom_tool_call", id: "ctc_2", call_id: NATIVE_CALL, name: "apply_patch", input: PATCH },
	]);
	const result = (toolCallId: string, toolName: string, timestamp: number) => ({
		role: "toolResult" as const,
		toolCallId,
		toolName,
		content: [{ type: "text" as const, text: "done" }],
		isError: false,
		timestamp,
	});
	return {
		systemPrompt: ["system"],
		messages: [
			{ role: "user", content: "edit the file", timestamp: 1 },
			blockTurn,
			result(`${BLOCK_CALL}|ctc_1`, "edit", 3),
			result("call_read|fc_1", "read", 4),
			nativeTurn,
			result(`${NATIVE_CALL}|ctc_2`, "edit", 6),
			{ role: "user", content: "continue", timestamp: 7 },
		],
		tools: [editTool, readTool],
	};
}

function modelFor(api: Api, freeform: boolean): Model<Api> {
	const provider: Record<string, string> = {
		"openai-responses": "openai",
		"azure-openai-responses": "azure",
		"openai-codex-responses": "openai-codex",
		openrouter: "openrouter",
	};
	return buildModel({
		id: "gpt-5",
		name: "GPT-5",
		api,
		provider: provider[api] ?? api,
		baseUrl: api === "azure-openai-responses" ? "https://example.openai.azure.com/openai/v1" : "",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
		...(freeform ? { applyPatchToolType: "freeform" as const } : {}),
	}) as Model<Api>;
}

interface ResponsesRequest {
	input: unknown[];
	tools: unknown[];
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

/** The payload a stream hands to `onPayload`; rejects when the stream settles without building one. */
async function capturePayload(
	start: (onPayload: (payload: unknown) => undefined) => { result(): Promise<unknown> },
): Promise<ResponsesRequest> {
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	const stream = start(payload => {
		resolve(payload);
		return undefined;
	});
	stream.result().then(
		() => reject(new Error("stream ended without onPayload firing")),
		(error: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
	);
	return toRequest(await promise);
}

function toRequest(payload: unknown): ResponsesRequest {
	const body = payload as { input?: unknown; tools?: unknown };
	return {
		input: Array.isArray(body.input) ? body.input : [],
		tools: Array.isArray(body.tools) ? body.tools : [],
	};
}

/** Every built-in api that builds a Responses `input`, driven through the request build its turn runs. */
const RESPONSES_REQUESTS: Partial<Record<Api, (model: Model<Api>, context: Context) => Promise<ResponsesRequest>>> = {
	"openai-responses": (model, context) =>
		capturePayload(onPayload =>
			streamOpenAIResponses(model as Model<"openai-responses">, context, {
				apiKey: "test-key",
				signal: abortedSignal(),
				onPayload,
			}),
		),
	"azure-openai-responses": (model, context) =>
		capturePayload(onPayload =>
			streamAzureOpenAIResponses(model as Model<"azure-openai-responses">, context, {
				apiKey: "test-key",
				azureBaseUrl: model.baseUrl,
				azureApiVersion: "v1",
				signal: abortedSignal(),
				onPayload,
			}),
		),
	"openai-codex-responses": async (model, context) =>
		toRequest(await buildTransformedCodexRequestBody(model as Model<"openai-codex-responses">, context, undefined)),
	openrouter: (model, context) =>
		capturePayload(onPayload =>
			streamSimple(model, context, { apiKey: "test-key", signal: abortedSignal(), onPayload }),
		),
};

/** The call kind each call id is replayed as. */
function callKinds(input: readonly unknown[]): Map<string, string> {
	const kinds = new Map<string, string>();
	for (const raw of input) {
		const item = raw as { type?: unknown; call_id?: unknown };
		if ((item.type === "function_call" || item.type === "custom_tool_call") && typeof item.call_id === "string") {
			kinds.set(item.call_id, item.type);
		}
	}
	return kinds;
}

afterEach(() => {
	resetServerCompactionRouteCache();
});

describe("a Responses request replays a custom tool call only when its tools offer one", () => {
	it("records a decision for every built-in api", () => {
		const undecided = BUILTIN_API_IDS.filter(api => !(api in RESPONSES_REQUESTS));
		expect(undecided).toEqual([
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
		for (const api of Object.keys(SERVER_COMPACTION_WIRE_APIS)) expect(api in RESPONSES_REQUESTS).toBe(true);
	});

	for (const [api, build] of Object.entries(RESPONSES_REQUESTS)) {
		for (const freeform of [true, false]) {
			it(`${api} with freeform ${freeform ? "enabled" : "disabled"}`, async () => {
				const model = modelFor(api as Api, freeform);
				const { input, tools } = await build!(model, transcript(model));

				const customTools = new Set<string>();
				for (const raw of tools) {
					const tool = raw as { type?: unknown; name?: unknown };
					if (tool.type === "custom" && typeof tool.name === "string") customTools.add(tool.name);
				}
				const customCalls = new Set<string>();
				for (const raw of input) {
					const item = raw as { type?: unknown; name?: unknown; call_id?: unknown };
					if (item.type !== "custom_tool_call") continue;
					expect({ name: item.name, offered: customTools.has(String(item.name)) }).toEqual({
						name: item.name,
						offered: true,
					});
					customCalls.add(String(item.call_id));
				}
				for (const raw of input) {
					const item = raw as { type?: unknown; call_id?: unknown };
					if (item.type !== "custom_tool_call_output") continue;
					expect({ callId: item.call_id, paired: customCalls.has(String(item.call_id)) }).toEqual({
						callId: item.call_id,
						paired: true,
					});
				}

				// Both freeform calls reach the input, as custom calls exactly when the tools offer the grammar.
				const kind = customTools.size > 0 ? "custom_tool_call" : "function_call";
				const kinds = callKinds(input);
				expect([kinds.get(BLOCK_CALL), kinds.get(NATIVE_CALL)]).toEqual([kind, kind]);
			});
		}
	}

	for (const api of Object.keys(SERVER_COMPACTION_WIRE_APIS)) {
		for (const freeform of [true, false]) {
			it(`${api} compaction replays the call kinds its turn replays (freeform ${freeform ? "enabled" : "disabled"})`, async () => {
				const model = modelFor(api as Api, freeform);
				const context = transcript(model);
				const turn = await RESPONSES_REQUESTS[api as Api]!(model, context);

				const bodies: unknown[] = [];
				const fetchImpl: FetchImpl = async (_url, init) => {
					bodies.push(JSON.parse(String(init?.body)));
					return new Response('{"detail":"Not Found"}', { status: 404, statusText: "Not Found" });
				};
				await openAIResponsesServerCompaction
					.compact({
						sessionId: "call-kind-session",
						model,
						messages: context.messages,
						apiKey: "test-access-token",
						fetch: fetchImpl,
					})
					.catch(() => undefined);

				expect(bodies).toHaveLength(1);
				const compacted = callKinds(toRequest(bodies[0]).input);
				const replayed = callKinds(turn.input);
				expect([compacted.get(BLOCK_CALL), compacted.get(NATIVE_CALL)]).toEqual([
					replayed.get(BLOCK_CALL),
					replayed.get(NATIVE_CALL),
				]);
			});
		}
	}
});
