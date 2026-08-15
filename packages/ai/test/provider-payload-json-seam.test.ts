/**
 * WHY THIS BATTERY EXISTS — the class it closes.
 *
 * `options.onPayload` is the final seam before a provider request leaves the
 * process, and veyyon's confidentiality layer installs its secret redactor
 * there. That redactor WALKS the payload rewriting every string and refuses
 * any value JSON cannot express. Three times a transport handed the hook
 * something that is not that shape, and each time the provider became
 * unusable — not degraded — for every operator with secrets configured:
 *
 *   - google-generative-ai / google-vertex handed a live `AbortSignal` in
 *     `params.config` (a class instance);
 *   - the pi-native gateway client handed the raw `context`, whose
 *     `tools[].parameters` are live arktype schemas — function objects;
 *   - devin-agent / cursor-agent handed protobuf messages (uint64 fields
 *     decode to bigint, bytes fields to Uint8Array).
 *
 * Per-transport suites pinned each incident. None of them could see the NEXT
 * transport committing the same mistake, because each walked only its own
 * payload. This battery closes the class at the choke point: it drives every
 * catalog api's real request-build path, captures the object handed to
 * `onPayload`, and asserts every node of it is JSON-expressible — plain
 * objects (Object/null prototype), arrays, strings, finite numbers, booleans,
 * null, undefined. No class instances, functions, bigints, symbols, symbol
 * keys, or cycles; the walker reports the offending `$`-path on failure. The
 * walker mirrors the domain of `mapJsonStrings`
 * (packages/coding-agent/src/json-transform.ts), the walk the redactor runs.
 *
 * FAIL-BY-DEFAULT ON NEW MEMBERS. The catalog's distinct `api` values are
 * enumerated from packages/catalog/src/models.json at run time and each must
 * have a battery case; adding a new api turns this suite red until someone
 * drives it. kimi-code (openai-anthropic shim, default anthropic format),
 * the pi-native gateway transport (`model.transport = "pi-native"`), cursor
 * and devin are additionally required by name regardless of enumeration.
 *
 * WHAT IT DOES NOT CATCH. A payload that is JSON-expressible but semantically
 * wrong (the wire-shape suites own that). A hook call site this battery does
 * not drive: openai-codex-responses is driven over its SSE path only, so its
 * websocket frame hook (openai-codex-responses.ts) is out of scope, and the
 * gitlab-duo case asserts the workflow-create body, not every WebSocket
 * `startRequest` retry. A non-JSON offender that appears only under provider
 * options these cases do not set (service tiers, cache retention, session
 * resume). And a transport whose request build throws before the hook under
 * this exact context shape would show up as "hook never fired", which is the
 * same red but a different defect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type as arkType } from "arktype";
import { streamBedrock } from "@veyyon/ai/providers/amazon-bedrock";
import { streamAnthropic } from "@veyyon/ai/providers/anthropic";
import { streamAzureOpenAIResponses } from "@veyyon/ai/providers/azure-openai-responses";
import { streamCursor } from "@veyyon/ai/providers/cursor";
import { streamDevin } from "@veyyon/ai/providers/devin";
import {
	type GitLabDuoWorkflowWebSocketLike,
	streamGitLabDuoWorkflow,
} from "@veyyon/ai/providers/gitlab-duo-workflow";
import { streamGoogle } from "@veyyon/ai/providers/google";
import { streamGoogleGeminiCli } from "@veyyon/ai/providers/google-gemini-cli";
import { streamGoogleVertex } from "@veyyon/ai/providers/google-vertex";
import { streamKimi } from "@veyyon/ai/providers/kimi";
import { streamOllama } from "@veyyon/ai/providers/ollama";
import { streamOpenAICompletions } from "@veyyon/ai/providers/openai-completions";
import { streamOpenAICodexResponses } from "@veyyon/ai/providers/openai-codex-responses";
import { streamOpenAIResponses } from "@veyyon/ai/providers/openai-responses";
import { streamPiNative } from "@veyyon/ai/providers/pi-native-client";
import { streamSimple } from "@veyyon/ai/stream";
import type {
	AssistantMessage,
	Context,
	FetchImpl,
	Model,
	ModelSpec,
	Tool,
	ToolResultMessage,
} from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { emptyUsage, getBundledModel, getBundledModels, getBundledProviders } from "@veyyon/catalog/models";
import * as piUtils from "@veyyon/utils";
import { create, toBinary } from "@bufbuild/protobuf";
import { GetUserJwtResponseSchema } from "@veyyon/catalog/discovery/devin-gen/exa/auth_pb/auth_pb";

// ---------------------------------------------------------------------------
// JSON-expressibility walker (test-local mirror of the mapJsonStrings domain)
// ---------------------------------------------------------------------------

/**
 * Collect every node of `root` that JSON cannot express, as `$`-paths.
 * Cycles are detected against the active recursion stack, not a global seen
 * set: a shared-but-acyclic subobject serializes fine and is not an offender.
 */
function collectJsonOffenders(root: unknown): string[] {
	const offenders: string[] = [];
	const active = new Set<object>();
	const walk = (value: unknown, path: string): void => {
		if (value === null || value === undefined) return;
		const kind = typeof value;
		if (kind === "string" || kind === "boolean") return;
		if (kind === "number") {
			if (!Number.isFinite(value as number)) offenders.push(`${path}: non-finite number`);
			return;
		}
		if (kind !== "object") {
			// function, bigint, symbol — none survive JSON.
			offenders.push(`${path}: ${kind}`);
			return;
		}
		const node = value as object;
		if (active.has(node)) {
			offenders.push(`${path}: <cycle>`);
			return;
		}
		if (!Array.isArray(node)) {
			const prototype = Object.getPrototypeOf(node) as object | null;
			if (prototype !== Object.prototype && prototype !== null) {
				const name = (prototype?.constructor as { name?: string } | undefined)?.name ?? "null-prototype";
				offenders.push(`${path}: ${name}`);
				return;
			}
			// mapJsonStrings refuses only ENUMERABLE symbol keys (non-enumerable
			// stamps like the schema converter's epoch marker never reach the wire:
			// JSON.stringify reads enumerable string keys only).
			const enumerableSymbolKeys = Object.getOwnPropertySymbols(node).filter(
				symbol => Object.getOwnPropertyDescriptor(node, symbol)?.enumerable,
			);
			if (enumerableSymbolKeys.length > 0) {
				offenders.push(`${path}: ${enumerableSymbolKeys.length} enumerable symbol key(s)`);
			}
		}
		active.add(node);
		try {
			if (Array.isArray(node)) {
				node.forEach((entry, index) => walk(entry, `${path}[${index}]`));
				return;
			}
			for (const [key, entry] of Object.entries(node)) walk(entry, path === "$" ? `$.${key}` : `${path}.${key}`);
		} finally {
			active.delete(node);
		}
	};
	walk(root, "$");
	return offenders;
}

// ---------------------------------------------------------------------------
// Shared battery context: arktype tool schemas, an image part, and
// assistant/toolResult history — the shapes that produced every past leak.
// ---------------------------------------------------------------------------

const BATTERY_ASSISTANT_TURN: AssistantMessage = {
	role: "assistant",
	content: [
		{ type: "text", text: "I will read the file." },
		{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "src/index.ts" } },
	],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage: emptyUsage(),
	stopReason: "toolUse",
	timestamp: 2,
};

const BATTERY_TOOL_RESULT: ToolResultMessage = {
	role: "toolResult",
	toolCallId: "call_1",
	toolName: "read",
	content: [{ type: "text", text: "file contents" }],
	isError: false,
	timestamp: 3,
};

function batteryContext(): Context {
	const batteryTool: Tool = {
		name: "read",
		description: "Read a file from disk.",
		parameters: arkType({ path: "string", "offset?": "number" }),
	};
	return {
		systemPrompt: ["battery system prompt"],
		messages: [
			{ role: "user", content: "start the task", timestamp: 1 },
			BATTERY_ASSISTANT_TURN,
			BATTERY_TOOL_RESULT,
			{
				role: "user",
				content: [
					{ type: "text", text: "now look at this screenshot" },
					{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				],
				timestamp: 4,
			},
		],
		tools: [batteryTool],
	};
}

// ---------------------------------------------------------------------------
// Capture harness. Each case installs `cap` as `options.onPayload`; the first
// hook call resolves the capture. `stream.result()` is the only place a
// failure BEFORE request build can surface, so it rejects the capture when
// the stream settles without the hook firing (a vacuous pass is a failure).
// ---------------------------------------------------------------------------

interface Streamish {
	result(): Promise<unknown>;
}

type CaptureHook = (payload: unknown) => undefined;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function asFetch(implementation: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): FetchImpl {
	return Object.assign(implementation, { preconnect: fetch.preconnect });
}

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function sseResponse(...chunks: unknown[]): Response {
	const body = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Top-level `candidates` chunk (public Generative Language + Vertex). */
function genaiChunk(text: string): Record<string, unknown> {
	return {
		candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
	};
}

async function runBatteryCase(start: (cap: CaptureHook) => Streamish): Promise<unknown> {
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	let calls = 0;
	let settled = false;
	const cap: CaptureHook = payload => {
		calls++;
		if (!settled) {
			settled = true;
			resolve(payload);
		}
		return undefined;
	};
	const stream = start(cap);
	// Guard: a stream that ends (or aborts/errors) without the hook firing must
	// fail the case instead of hanging to the test deadline.
	stream.result().then(
		() => {
			if (!settled) {
				settled = true;
				reject(new Error("stream ended without onPayload firing"));
			}
		},
		(error: unknown) => {
			if (!settled) {
				settled = true;
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		},
	);
	const payload = await promise;
	expect(calls, "onPayload hook fired").toBeGreaterThan(0);
	const offenders = collectJsonOffenders(payload);
	expect(offenders, "payload handed to onPayload is JSON-expressible").toEqual([]);
	return payload;
}

// ---------------------------------------------------------------------------
// Per-transport start functions. Each returns the stream synchronously after
// installing `cap` as onPayload. Where a pre-aborted signal cannot reach the
// hook, the case carries a live controller and aborts inside the hook so the
// stream unwinds instead of consuming the mock response.
// ---------------------------------------------------------------------------

function startAnthropic(cap: CaptureHook): Streamish {
	return streamAnthropic(
		buildModel({
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text", "image"],
			cost: ZERO_COST,
			contextWindow: 200_000,
			maxTokens: 8_192,
		}),
		batteryContext(),
		{
			apiKey: "test-key",
			signal: abortedSignal(),
			onPayload: payload => cap(payload),
		},
	);
}

function startAzure(cap: CaptureHook): Streamish {
	const model = buildModel({
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "azure-openai-responses",
		provider: "azure",
		baseUrl: "https://example.openai.azure.com/openai/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 400_000,
		maxTokens: 128_000,
	});
	return streamAzureOpenAIResponses(model, batteryContext(), {
		apiKey: "test-key",
		azureBaseUrl: model.baseUrl,
		azureApiVersion: "v1",
		signal: abortedSignal(),
		onPayload: payload => cap(payload),
	});
}

function startBedrock(cap: CaptureHook): Streamish {
	return streamBedrock(
		buildModel({
			id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
			name: "Claude Sonnet 4.5 (Bedrock)",
			api: "bedrock-converse-stream",
			provider: "bedrock",
			baseUrl: "",
			reasoning: false,
			input: ["text", "image"],
			cost: ZERO_COST,
			contextWindow: 200_000,
			maxTokens: 8_192,
		}),
		batteryContext(),
		{
			apiKey: "test-key",
			signal: abortedSignal(),
			fetch: asFetch(async () => new Response("", { status: 200 })),
			onPayload: payload => cap(payload),
		},
	);
}

function startCursor(cap: CaptureHook): Streamish {
	const controller = new AbortController();
	return streamCursor(
		buildModel({
			id: "cursor-payload-seam",
			name: "Payload seam Cursor",
			api: "cursor-agent",
			provider: "cursor",
			// The hook fires before any connection; an unroutable loopback port
			// fails the post-capture connect fast instead of hanging.
			baseUrl: "http://127.0.0.1:9",
			reasoning: false,
			input: ["text", "image"],
			cost: ZERO_COST,
			contextWindow: 16_384,
			maxTokens: 1_024,
		}),
		batteryContext(),
		{
			apiKey: "resolved-cursor-credential",
			signal: controller.signal,
			onPayload: payload => {
				const result = cap(payload);
				controller.abort();
				return result;
			},
		},
	);
}

function startDevin(cap: CaptureHook): Streamish {
	const controller = new AbortController();
	const authResponse = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt" }));
	// A framed Connect message with an empty body: enough for the chat call if
	// the abort inside the hook does not cut the flow first.
	const emptyFrame = new Uint8Array(5);
	new DataView(emptyFrame.buffer).setUint32(1, 0, false);
	const fetchImpl = asFetch(async input => {
		if (String(input).includes("GetUserJwt")) return new Response(authResponse);
		return new Response(emptyFrame);
	});
	return streamDevin(
		buildModel({
			id: "devin-payload-seam",
			name: "Devin Payload Seam",
			api: "devin-agent",
			provider: "devin",
			baseUrl: "https://server.codeium.com",
			reasoning: false,
			input: ["text", "image"],
			cost: ZERO_COST,
			contextWindow: 16_384,
			maxTokens: 1_024,
		}),
		batteryContext(),
		{
			apiKey: "resolved-devin-credential",
			fetch: fetchImpl,
			signal: controller.signal,
			onPayload: payload => {
				const result = cap(payload);
				controller.abort();
				return result;
			},
		},
	);
}

function startGitLabDuo(cap: CaptureHook): Streamish {
	const controller = new AbortController();
	const fetchImpl = asFetch(async input => {
		const url = String(input);
		if (url.includes("/api/graphql")) {
			return new Response(
				JSON.stringify({
					data: {
						aiChatAvailableModels: {
							defaultModel: { name: "Claude", ref: "claude_sonnet_4_6_vertex" },
							selectableModels: [],
							pinnedModel: null,
						},
					},
				}),
				{ status: 200 },
			);
		}
		if (url.includes("/direct_access")) {
			return new Response(
				JSON.stringify({
					duo_workflow_service: { base_url: "https://workflow.example.com", token: "wf-token", headers: {} },
					gitlab_rails: { token: "rails-token" },
				}),
				{ status: 200 },
			);
		}
		if (url.includes("/api/v4/ai/duo_workflows/workflows")) {
			return new Response(JSON.stringify({ id: "workflow-1" }), { status: 200 });
		}
		return new Response("{}", { status: 200 });
	});
	// The create-body hook fires before any socket is needed; the factory only
	// exists so a flow that outruns the abort opens nothing real.
	const webSocketFactory = (): GitLabDuoWorkflowWebSocketLike => ({
		onopen: null,
		onmessage: null,
		onerror: null,
		onclose: null,
		send() {},
		close() {},
	});
	return streamGitLabDuoWorkflow(
		buildModel({
			id: "claude_sonnet_4_6_vertex",
			name: "Claude Sonnet 4.6 - Vertex",
			api: "gitlab-duo-agent",
			provider: "gitlab-duo-agent",
			baseUrl: "https://gitlab.example.com",
			reasoning: false,
			input: ["text"],
			cost: ZERO_COST,
			contextWindow: 128_000,
			maxTokens: 8_192,
			supportsTools: true,
		}),
		batteryContext(),
		{
			apiKey: "redacted",
			rootNamespaceId: "gid://gitlab/Group/1",
			workflowDefinition: "chat",
			fetch: fetchImpl,
			webSocketFactory,
			idleTimeoutMs: 25,
			signal: controller.signal,
			onPayload: payload => {
				const result = cap(payload);
				controller.abort();
				return result;
			},
		},
	);
}

function startGeminiCli(cap: CaptureHook): Streamish {
	const controller = new AbortController();
	return streamGoogleGeminiCli(
		buildModel({
			id: "gemini-2.5-flash",
			name: "Gemini 2.5 Flash (CCA)",
			api: "google-gemini-cli",
			provider: "google-gemini-cli",
			baseUrl: "https://example.com",
			reasoning: false,
			input: ["text", "image"],
			cost: ZERO_COST,
			contextWindow: 200_000,
			maxTokens: 8_192,
		}),
		batteryContext(),
		{
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: asFetch(async () => sseResponse({ response: genaiChunk("hi") })),
			signal: controller.signal,
			onPayload: payload => {
				const result = cap(payload);
				controller.abort();
				return result;
			},
		},
	);
}

function startGoogle(cap: CaptureHook): Streamish {
	const controller = new AbortController();
	return streamGoogle(
		buildModel({
			id: "gemini-3-flash",
			name: "Gemini 3 Flash",
			api: "google-generative-ai",
			provider: "google",
			baseUrl: "",
			reasoning: true,
			input: ["text", "image"],
			cost: ZERO_COST,
			contextWindow: 200_000,
			maxTokens: 32_000,
		}),
		batteryContext(),
		{
			apiKey: "test-key",
			fetch: asFetch(async () => sseResponse(genaiChunk("hi"))),
			signal: controller.signal,
			onPayload: payload => {
				const result = cap(payload);
				controller.abort();
				return result;
			},
		},
	);
}

function startVertex(cap: CaptureHook): Streamish {
	const controller = new AbortController();
	const fetchImpl = asFetch(async input => {
		const url = input instanceof Request ? input.url : String(input);
		if (url.includes("oauth2.googleapis.com/token") || url.includes("metadata.google.internal")) {
			return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }));
		}
		return sseResponse(genaiChunk("hi"));
	});
	return streamGoogleVertex(
		buildModel({
			id: "gemini-3-flash",
			name: "Gemini 3 Flash (Vertex)",
			api: "google-vertex",
			provider: "google",
			baseUrl: "",
			reasoning: true,
			input: ["text", "image"],
			cost: ZERO_COST,
			contextWindow: 200_000,
			maxTokens: 32_000,
		}),
		batteryContext(),
		{
			project: "project",
			location: "location",
			fetch: fetchImpl,
			signal: controller.signal,
			onPayload: payload => {
				const result = cap(payload);
				controller.abort();
				return result;
			},
		},
	);
}

function startOllama(cap: CaptureHook): Streamish {
	const controller = new AbortController();
	const fetchImpl = asFetch(
		async () =>
			new Response(
				`${JSON.stringify({
					message: { role: "assistant", content: "hi" },
					done: true,
					done_reason: "stop",
					prompt_eval_count: 10,
					eval_count: 5,
				})}\n`,
				{ status: 200 },
			),
	);
	return streamOllama(
		buildModel({
			id: "deepseek-v4-flash",
			name: "DeepSeek V4 Flash",
			api: "ollama-chat",
			provider: "ollama",
			baseUrl: "http://localhost:11434/v1",
			reasoning: true,
			input: ["text"],
			cost: ZERO_COST,
			contextWindow: 4_096,
			maxTokens: 4_096,
		}),
		batteryContext(),
		{
			apiKey: "test-key",
			fetch: fetchImpl,
			signal: controller.signal,
			onPayload: payload => {
				const result = cap(payload);
				controller.abort();
				return result;
			},
		},
	);
}

function startCodex(cap: CaptureHook): Streamish {
	const tempDir = piUtils.TempDir.createSync("@pi-payload-seam-codex-");
	piUtils.setAgentDir(tempDir.path());
	const controller = new AbortController();
	const token = `aaa.${Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toBase64()}.bbb`;
	const model: Model<"openai-codex-responses"> = {
		...buildModel({
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text", "image"],
			cost: ZERO_COST,
			contextWindow: 128_000,
			maxTokens: 128_000,
		}),
		// The SSE request path; the websocket frame hook is out of scope (see WHY).
		preferWebsockets: false,
	};
	return streamOpenAICodexResponses(model, batteryContext(), {
		apiKey: token,
		fetch: asFetch(async () => {
			const events = [
				`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hi" })}`,
				`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } })}`,
			];
			return new Response(`${events.join("\n\n")}\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}),
		signal: controller.signal,
		onPayload: payload => {
			const result = cap(payload);
			controller.abort();
			return result;
		},
	});
}

function startOpenAICompletions(cap: CaptureHook): Streamish {
	return streamOpenAICompletions(
		buildModel({
			id: "payload-seam-openai",
			name: "Payload seam OpenAI",
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://payload-seam.invalid/v1",
			reasoning: false,
			input: ["text", "image"],
			cost: ZERO_COST,
			contextWindow: 16_384,
			maxTokens: 1_024,
		}),
		batteryContext(),
		{
			apiKey: "test-key",
			fetch: asFetch(async () => sseResponse("[DONE]")),
			signal: abortedSignal(),
			onPayload: payload => cap(payload),
		},
	);
}

function startOpenAIResponses(cap: CaptureHook): Streamish {
	return streamOpenAIResponses(
		buildModel({
			id: "gpt-5",
			name: "GPT-5",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: ZERO_COST,
			contextWindow: 400_000,
			maxTokens: 128_000,
		}),
		batteryContext(),
		{
			apiKey: "test-key",
			signal: abortedSignal(),
			onPayload: payload => cap(payload),
		},
	);
}

function startOpenrouter(cap: CaptureHook): Streamish {
	// The production dispatch: stream.ts routes api "openrouter" into the
	// Responses request build (VEYYON_OPENROUTER_RESPONSES unset).
	return streamSimple(getBundledModel("openrouter", "anthropic/claude-sonnet-4"), batteryContext(), {
		apiKey: "test-key",
		fetch: asFetch(async () => sseResponse("[DONE]")),
		signal: abortedSignal(),
		onPayload: payload => cap(payload),
	});
}

function startKimiCode(cap: CaptureHook): Streamish {
	// Default format is the Anthropic shim (KIMI_ANTHROPIC_BASE_URL); the
	// pre-aborted signal reaches streamAnthropic's hook before any fetch.
	const model = getBundledModel("kimi-code", "kimi-for-coding") as Model<"openai-completions">;
	return streamKimi(model, batteryContext(), {
		apiKey: "test-key",
		signal: abortedSignal(),
		onPayload: payload => cap(payload),
	});
}

function startPiNative(cap: CaptureHook): Streamish {
	const controller = new AbortController();
	const doneMessage: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: 0,
	};
	const fetchImpl = asFetch(async () => sseResponse({ type: "done", reason: "stop", message: doneMessage }));
	return streamPiNative(
		buildModel({
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "http://llm-gateway.internal:4000",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
			contextWindow: 200_000,
			maxTokens: 64_000,
			transport: "pi-native",
		} as ModelSpec<"anthropic-messages">),
		batteryContext(),
		{
			apiKey: "gw-bearer",
			fetch: fetchImpl,
			signal: controller.signal,
			onPayload: payload => {
				const result = cap(payload);
				controller.abort();
				return result;
			},
		},
	);
}

// ---------------------------------------------------------------------------
// The battery
// ---------------------------------------------------------------------------

interface BatteryCase {
	/** Case label; also the required-variant name for non-catalog cases. */
	name: string;
	/** Catalog api values this case covers for the fail-by-default gate. */
	covers: string[];
	start: (cap: CaptureHook) => Streamish;
}

const BATTERY: BatteryCase[] = [
	{ name: "anthropic-messages", covers: ["anthropic-messages"], start: startAnthropic },
	{ name: "azure-openai-responses", covers: ["azure-openai-responses"], start: startAzure },
	{ name: "bedrock-converse-stream", covers: ["bedrock-converse-stream"], start: startBedrock },
	{ name: "cursor-agent", covers: ["cursor-agent"], start: startCursor },
	{ name: "devin-agent", covers: ["devin-agent"], start: startDevin },
	{ name: "gitlab-duo-agent", covers: ["gitlab-duo-agent"], start: startGitLabDuo },
	{ name: "google-gemini-cli", covers: ["google-gemini-cli"], start: startGeminiCli },
	{ name: "google-generative-ai", covers: ["google-generative-ai"], start: startGoogle },
	{ name: "google-vertex", covers: ["google-vertex"], start: startVertex },
	{ name: "ollama-chat", covers: ["ollama-chat"], start: startOllama },
	{ name: "openai-codex-responses", covers: ["openai-codex-responses"], start: startCodex },
	{ name: "openai-completions", covers: ["openai-completions"], start: startOpenAICompletions },
	{ name: "openai-responses", covers: ["openai-responses"], start: startOpenAIResponses },
	{ name: "openrouter", covers: ["openrouter"], start: startOpenrouter },
	// Provider variants required regardless of api enumeration.
	{ name: "kimi-code (openai-anthropic shim, default anthropic format)", covers: [], start: startKimiCode },
	{ name: "pi-native gateway transport", covers: [], start: startPiNative },
];

/** Variants that must exist by name even though they share an api with another case. */
const REQUIRED_VARIANT_LABELS = ["kimi-code", "pi-native", "cursor-agent", "devin-agent"] as const;

// The codex case redirects the agent dir into a temp dir; restore the real
// environment exactly the way the codex suite does so nothing leaks into
// later files in the same process.
const originalAgentDir = piUtils.getAgentDir();
const originalAgentDirEnv = process.env.VEYYON_CODING_AGENT_DIR;
const originalProfileEnv = process.env.VEYYON_PROFILE;

beforeEach(() => {
	vi.spyOn(piUtils, "getInstallId").mockReturnValue("00000000-0000-4000-8000-000000000001");
});

afterEach(() => {
	piUtils.setAgentDir(originalAgentDir);
	restoreEnv("VEYYON_CODING_AGENT_DIR", originalAgentDirEnv);
	restoreEnv("VEYYON_PROFILE", originalProfileEnv);
	piUtils.__resetDirsFromEnvForTests();
	vi.restoreAllMocks();
});

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete Bun.env[name];
		return;
	}
	Bun.env[name] = value;
}

describe("provider onPayload JSON seam battery", () => {
	for (const kase of BATTERY) {
		it(`hands ${kase.name} a JSON-expressible payload`, async () => {
			await runBatteryCase(kase.start);
		});
	}

	it("covers every api enumerated from the bundled catalog, failing by default on a new one", () => {
		const covered = new Set(BATTERY.flatMap(kase => kase.covers));
		const catalogApis = new Set<string>();
		for (const provider of getBundledProviders()) {
			for (const model of getBundledModels(provider)) catalogApis.add(model.api);
		}
		const missing = [...catalogApis].filter(api => !covered.has(api)).sort();
		expect(missing, "catalog apis with no payload-seam battery case").toEqual([]);
	});

	it("drives the required provider variants regardless of api enumeration", () => {
		const names = BATTERY.map(kase => kase.name);
		for (const required of REQUIRED_VARIANT_LABELS) {
			expect(
				names.some(name => name === required || name.startsWith(`${required} `)),
				`battery case for ${required}`,
			).toBe(true);
		}
	});
});
