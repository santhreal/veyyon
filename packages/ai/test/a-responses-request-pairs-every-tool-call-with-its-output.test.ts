import { afterEach, describe, expect, it } from "bun:test";
import { BUILTIN_API_IDS } from "@veyyon/ai/api-registry";
import { streamAzureOpenAIResponses } from "@veyyon/ai/providers/azure-openai-responses";
import { type InputItem, transformRequestBody } from "@veyyon/ai/providers/openai-codex/request-transformer";
import { buildTransformedCodexRequestBody } from "@veyyon/ai/providers/openai-codex-responses";
import {
	openAIResponsesServerCompaction,
	resetServerCompactionRouteCache,
	SERVER_COMPACTION_WIRE_APIS,
} from "@veyyon/ai/providers/openai-compaction";
import { streamOpenAIResponses } from "@veyyon/ai/providers/openai-responses";
import { ORPHAN_TOOL_CALL_PLACEHOLDER, repairResponsesToolPairs } from "@veyyon/ai/providers/openai-shared";
import { streamSimple } from "@veyyon/ai/stream";
import type { Api, AssistantMessage, Context, FetchImpl, Model } from "@veyyon/ai/types";
import { createOpenAIResponsesHistoryPayload } from "@veyyon/ai/utils";
import { buildModel } from "@veyyon/catalog/build";
import { emptyUsage } from "@veyyon/catalog/models";

/**
 * WHY: the Responses API rejects an `input` holding a tool call without its output
 * (`400 No tool output found for function call …`) or an output without its call
 * (`400 No tool call found for function call output …`). The repair existed twice, once in the shared input
 * builder and once in the Codex request transformer, and the copies drifted: the Codex copy wrote a null payload
 * as `null`, kept an empty tool name, threw on an output with no payload, and copied every input even when nothing
 * was unpaired. The shared builder folded an unpaired output only for callers that asked for it.
 *
 * THE CLASS: any input a Responses request sends with an unpaired call or output, for either call kind
 * (`function_call`, `custom_tool_call`), through either entry point that accepts wire items
 * ({@link repairResponsesToolPairs} and the Codex `transformRequestBody`), and through every built-in api's turn
 * and server-compaction request. Generated inputs sweep the shapes a stored payload can hold: both call kinds,
 * string, structured, null, missing and oversized payloads, empty tool names, and call ids that are not strings.
 * The api sweep fails on a built-in api with no recorded decision.
 *
 * WHAT THIS DOES NOT CATCH: a call paired with an output of the other kind (`function_call` beside a
 * `custom_tool_call_output`), and the Codex websocket delta, which is cut from the repaired full input.
 */

/** The wire fields the repair reads and the items this suite generates. */
interface WireItem {
	type?: string;
	role?: string;
	call_id?: unknown;
	name?: string;
	output?: unknown;
	content?: unknown;
	arguments?: string;
	input?: string;
	summary?: unknown[];
}

const CALL_IDS = ["call_a", "call_b", "call_c", "call_d", "call_e"];
const OUTPUT_LIMIT = 16_000;

function seededRandom(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1_103_515_245 + 12_345) & 0x7fff_ffff;
		return state / 0x8000_0000;
	};
}

function generateInput(random: () => number): WireItem[] {
	const length = Math.floor(random() * 12);
	const items: WireItem[] = [];
	for (let index = 0; index < length; index++) {
		const callId = CALL_IDS[Math.floor(random() * CALL_IDS.length)]!;
		switch (Math.floor(random() * 11)) {
			case 0:
				items.push({ role: "user", content: [{ type: "input_text", text: `turn ${index}` }] });
				break;
			case 1:
				items.push({ type: "function_call", call_id: callId, name: "read", arguments: "{}" });
				break;
			case 2:
				items.push({ type: "custom_tool_call", call_id: callId, name: "apply_patch", input: "patch" });
				break;
			case 3:
				items.push({ type: "function_call_output", call_id: callId, output: `result ${index} of ${callId}` });
				break;
			case 4:
				items.push({ type: "custom_tool_call_output", call_id: callId, output: `patched ${index}` });
				break;
			case 5:
				items.push({
					type: "function_call_output",
					call_id: callId,
					name: "search",
					output: [{ type: "input_text", text: `part ${index}` }],
				});
				break;
			case 6:
				items.push({ type: "function_call_output", call_id: callId, name: "", output: null });
				break;
			case 7:
				items.push({ type: "custom_tool_call_output", call_id: callId });
				break;
			case 8:
				items.push({ type: "function_call_output", call_id: callId, output: "y".repeat(OUTPUT_LIMIT + 50) });
				break;
			case 9:
				items.push({ type: "reasoning", summary: [] });
				break;
			default:
				// A stored payload is not held to the declared string type.
				items.push({ type: "function_call", call_id: index, name: "read", arguments: "{}" });
		}
	}
	return items;
}

const isCall = (item: WireItem) => item.type === "function_call" || item.type === "custom_tool_call";
const isOutput = (item: WireItem) => item.type === "function_call_output" || item.type === "custom_tool_call_output";

/** The call ids of every call and of every output, string ids only. */
function pairing(items: readonly WireItem[]): { calls: Set<string>; outputs: Set<string> } {
	const calls = new Set<string>();
	const outputs = new Set<string>();
	for (const item of items) {
		if (typeof item.call_id !== "string") continue;
		if (isCall(item)) calls.add(item.call_id);
		if (isOutput(item)) outputs.add(item.call_id);
	}
	return { calls, outputs };
}

/** Every call id that appears on one side only. */
function unpaired(items: readonly WireItem[]): string[] {
	const { calls, outputs } = pairing(items);
	return [...calls].filter(id => !outputs.has(id)).concat([...outputs].filter(id => !calls.has(id)));
}

/** The text a folded output's note holds: the payload, as JSON when structured, capped at the limit. */
function notePayload(output: unknown): string {
	const text = typeof output === "string" ? output : output == null ? "" : JSON.stringify(output);
	return text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n...[truncated]` : text;
}

/**
 * The invariant every entry point holds: the result is fully paired; every item of the input except an unpaired
 * output reaches it in order and by reference; each unpaired output becomes one user note carrying its payload; each
 * unpaired call is followed by one placeholder output of its own kind; nothing else is added.
 */
function expectRepaired(input: readonly WireItem[], repaired: readonly WireItem[]): void {
	const { calls, outputs } = pairing(input);
	const orphanOutputs = input.filter(
		item => isOutput(item) && typeof item.call_id === "string" && !calls.has(item.call_id),
	);
	expect(unpaired(repaired)).toEqual([]);

	const originals = new Set<WireItem>(input);
	expect(repaired.filter(item => originals.has(item))).toEqual(input.filter(item => !orphanOutputs.includes(item)));

	const added = repaired.filter(item => !originals.has(item));
	const notes = added.filter(item => item.role === "user");
	expect(
		notes.map(note => ({ type: note.type, content: note.content })),
		"each unpaired output folds into one user note, in input order",
	).toEqual(
		orphanOutputs.map(item => ({
			type: "message",
			content: `<stale-tool-result tool="${item.name || "tool"}" id="${String(item.call_id)}">\n${notePayload(item.output)}\n</stale-tool-result>`,
		})),
	);

	const placeholders = added.filter(item => item.role !== "user");
	const expectedPlaceholders = input
		.filter(item => isCall(item) && typeof item.call_id === "string" && !outputs.has(item.call_id))
		.map(item => ({
			type: item.type === "custom_tool_call" ? "custom_tool_call_output" : "function_call_output",
			call_id: item.call_id,
			output: ORPHAN_TOOL_CALL_PLACEHOLDER,
		}));
	expect(placeholders).toEqual(expectedPlaceholders);
	for (const placeholder of placeholders) {
		const call = repaired[repaired.indexOf(placeholder) - 1]!;
		expect({ follows: call.type, call_id: call.call_id }).toEqual({
			follows: placeholder.type === "custom_tool_call_output" ? "custom_tool_call" : "function_call",
			call_id: placeholder.call_id,
		});
	}
}

const PROVIDERS: Record<string, string> = {
	"openai-responses": "openai",
	"azure-openai-responses": "azure",
	"openai-codex-responses": "openai-codex",
	openrouter: "openrouter",
};

function modelFor(api: Api): Model<Api> {
	return buildModel({
		id: "gpt-5",
		name: "GPT-5",
		api,
		provider: PROVIDERS[api] ?? api,
		baseUrl: api === "azure-openai-responses" ? "https://example.openai.azure.com/openai/v1" : "",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
	}) as Model<Api>;
}

const ORPHAN_PAYLOAD = "listing of the flags the rejected call read";

/**
 * A transcript holding both orphans a session produces: a native-history payload replays a `function_call` whose
 * result never persisted, and a tool result arrives whose call was rejected before it streamed.
 */
function orphanTranscript(model: Model<Api>): Context {
	const turn: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "reading" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: 2,
	};
	turn.providerPayload = createOpenAIResponsesHistoryPayload(model.provider, [
		{ type: "function_call", call_id: "call_interrupted", name: "read", arguments: "{}" },
		{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "reading" }] },
	]);
	return {
		systemPrompt: ["system"],
		messages: [
			{ role: "user", content: "list the flags", timestamp: 1 },
			turn,
			{
				role: "toolResult",
				toolCallId: "call_rejected",
				toolName: "search",
				content: [{ type: "text", text: ORPHAN_PAYLOAD }],
				isError: false,
				timestamp: 3,
			},
			{ role: "user", content: "continue", timestamp: 4 },
		],
	};
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

/** The request `input` a stream hands to `onPayload`; rejects when the stream settles without building one. */
async function capturedInput(
	start: (onPayload: (payload: unknown) => undefined) => { result(): Promise<unknown> },
): Promise<WireItem[]> {
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	const stream = start(payload => {
		resolve(payload);
		return undefined;
	});
	stream.result().then(
		() => reject(new Error("stream ended without onPayload firing")),
		(error: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
	);
	return inputOf(await promise);
}

function inputOf(body: unknown): WireItem[] {
	const input = (body as { input?: unknown }).input;
	return Array.isArray(input) ? (input as WireItem[]) : [];
}

/** Every built-in api that sends a Responses `input`, driven through the request build its turn runs. */
const RESPONSES_REQUESTS: Partial<Record<Api, (model: Model<Api>, context: Context) => Promise<WireItem[]>>> = {
	"openai-responses": (model, context) =>
		capturedInput(onPayload =>
			streamOpenAIResponses(model as Model<"openai-responses">, context, {
				apiKey: "test-key",
				signal: abortedSignal(),
				onPayload,
			}),
		),
	"azure-openai-responses": (model, context) =>
		capturedInput(onPayload =>
			streamAzureOpenAIResponses(model as Model<"azure-openai-responses">, context, {
				apiKey: "test-key",
				azureBaseUrl: model.baseUrl,
				azureApiVersion: "v1",
				signal: abortedSignal(),
				onPayload,
			}),
		),
	"openai-codex-responses": async (model, context) =>
		inputOf(await buildTransformedCodexRequestBody(model as Model<"openai-codex-responses">, context, undefined)),
	openrouter: (model, context) =>
		capturedInput(onPayload =>
			streamSimple(model, context, { apiKey: "test-key", signal: abortedSignal(), onPayload }),
		),
};

/** An item's text, whether the wire shape holds a string or content parts. */
function textOf(item: WireItem): string {
	if (typeof item.content === "string") return item.content;
	if (!Array.isArray(item.content)) return "";
	let text = "";
	for (const part of item.content as { text?: unknown }[]) if (typeof part.text === "string") text += part.text;
	return text;
}

/** The items that carry the rejected call's payload. */
function payloadNotes(input: readonly WireItem[]): WireItem[] {
	return input.filter(item => textOf(item).includes(ORPHAN_PAYLOAD));
}

afterEach(() => {
	resetServerCompactionRouteCache();
});

describe("a Responses request pairs every tool call with its output", () => {
	const GENERATED = 3_000;

	it(`repairResponsesToolPairs holds the invariant over ${GENERATED} generated inputs`, () => {
		const random = seededRandom(0x5eed);
		for (let round = 0; round < GENERATED; round++) {
			const input = generateInput(random);
			const repaired = repairResponsesToolPairs(input);
			expectRepaired(input, repaired);
			if (unpaired(input).length === 0) expect(repaired).toBe(input);
			expect(repairResponsesToolPairs(repaired)).toBe(repaired);
		}
	});

	it(`the Codex transformer holds the invariant over ${GENERATED} generated inputs`, async () => {
		const model = modelFor("openai-codex-responses") as Model<"openai-codex-responses">;
		const random = seededRandom(0xc0de);
		for (let round = 0; round < GENERATED; round++) {
			const input = generateInput(random);
			// Generated items carry call ids a stored payload can hold but `InputItem` does not declare.
			const body = await transformRequestBody({ model: model.id, input: [...input] as InputItem[] }, model);
			expectRepaired(input, inputOf(body));
		}
	});

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
		it(`${api} sends a paired input and keeps the rejected call's payload in a user note`, async () => {
			const model = modelFor(api as Api);
			const input = await build!(model, orphanTranscript(model));

			expect(unpaired(input)).toEqual([]);
			expect(payloadNotes(input).map(item => item.role)).toEqual(["user"]);
		});
	}

	for (const api of Object.keys(SERVER_COMPACTION_WIRE_APIS)) {
		it(`${api} compaction sends a paired input and keeps the rejected call's payload in a user note`, async () => {
			const model = modelFor(api as Api);
			const bodies: unknown[] = [];
			const fetchImpl: FetchImpl = async (_url, init) => {
				bodies.push(JSON.parse(String(init?.body)));
				return new Response('{"detail":"Not Found"}', { status: 404, statusText: "Not Found" });
			};
			await openAIResponsesServerCompaction
				.compact({
					sessionId: "pairing-session",
					model,
					messages: orphanTranscript(model).messages,
					apiKey: "test-access-token",
					fetch: fetchImpl,
				})
				.catch(() => undefined);

			expect(bodies).toHaveLength(1);
			const input = inputOf(bodies[0]);
			expect(unpaired(input)).toEqual([]);
			expect(payloadNotes(input).map(item => item.role)).toEqual(["user"]);
		});
	}
});
