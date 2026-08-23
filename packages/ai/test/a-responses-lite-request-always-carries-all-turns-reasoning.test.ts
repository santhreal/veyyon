/**
 * WHY:
 * A live session against the OpenAI Codex provider failed with:
 * `Codex error event: X-OpenAI-Internal-Codex-Responses-Lite requires \`reasoning.context\` to be \`all_turns\`.`
 *
 * The root cause was a contradiction between the Responses Lite transport requirement
 * (the server strictly requires `reasoning.context: "all_turns"`) and the gpt-5.4 version floor
 * (pre-5.4 models reject `all_turns` with `Unsupported value: 'all_turns' is not supported with this model`).
 * When a pre-5.4 model took the lite transport (via catalog flag or option override), `request-transformer.ts`
 * deleted `body.reasoning.context` to satisfy the model floor while the HTTP/WS transport still emitted
 * the `x-openai-internal-codex-responses-lite` header/metadata, causing the server to reject the turn.
 *
 * Class Closed:
 * 1. Guarantees that EVERY request carrying the `x-openai-internal-codex-responses-lite` marker
 *    (HTTP SSE, WebSocket frames, stateful deltas, compaction, and retries) ALWAYS carries
 *    `reasoning.context: "all_turns"` in the emitted body, regardless of effort level (unset, "none", medium, etc.).
 * 2. Guarantees that any model ineligible for `all_turns` (pre-5.4 Codex models) is structurally
 *    filtered out at `resolveCodexResponsesLite`, falling back to standard Responses without the lite marker
 *    or lite body shape.
 * 3. Dynamically sweeps all Codex models in the catalog at run time so newly added models are tested
 *    against the invariant without needing test updates.
 *
 * What this does not catch:
 * Upstream server changes that alter the `x-openai-internal-codex-responses-lite` wire requirement
 * or add new unsupported values for future OpenAI models beyond gpt-5.4.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	acceptsAllTurnsReasoningContext,
	resolveCodexResponsesLite,
	transformRequestBody,
} from "@veyyon/ai/providers/openai-codex/request-transformer";
import {
	createOpenAICodexDirectRequest,
	streamOpenAICodexResponses,
} from "@veyyon/ai/providers/openai-codex-responses";
import type { Context, FetchImpl, Model, ProviderSessionState } from "@veyyon/ai/types";
import { supportsAllTurnsReasoningContext } from "@veyyon/catalog/identity";
import { getBundledModels } from "@veyyon/catalog/models";
import { OPENAI_HEADERS } from "@veyyon/catalog/wire/codex";
import * as piUtils from "@veyyon/utils";
import { createCodexModel } from "./helpers";

const TEST_INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";
const originalWebSocket = global.WebSocket;

beforeEach(() => {
	vi.spyOn(piUtils, "getInstallId").mockReturnValue(TEST_INSTALLATION_ID);
});

afterEach(() => {
	global.WebSocket = originalWebSocket;
	vi.restoreAllMocks();
});

function createCodexTestToken(accountId = "acc_test"): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

function createCodexTestContext(): Context {
	return {
		systemPrompt: ["You are a helpful assistant."],
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function createCodexSse(events: Array<Record<string, unknown>>): string {
	return `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
}

const COMPLETED_CODEX_EVENTS: Array<Record<string, unknown>> = [
	{
		type: "response.output_item.added",
		item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
	},
	{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
	{ type: "response.output_text.delta", delta: "Hello" },
	{
		type: "response.output_item.done",
		item: {
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "Hello" }],
		},
	},
	{
		type: "response.completed",
		response: {
			status: "completed",
			usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
		},
	},
];

interface CapturedCodexRequest {
	headers: Headers;
	body: Record<string, unknown>;
}

function createCodexFetchMock(sse: string, onRequest: (captured: CapturedCodexRequest) => void): FetchImpl {
	return (async (input: string | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		if (url === "https://api.github.com/repos/openai/codex/releases/latest") {
			return new Response(JSON.stringify({ tag_name: "rust-v0.0.0" }), { status: 200 });
		}
		if (url.startsWith("https://raw.githubusercontent.com/openai/codex/")) {
			return new Response("PROMPT", { status: 200, headers: { etag: '"etag"' } });
		}
		if (url.endsWith("/responses") || url.endsWith("/compact")) {
			onRequest({
				headers: init?.headers instanceof Headers ? init.headers : new Headers(init?.headers),
				body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {},
			});
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		}
		return new Response("not found", { status: 404 });
	}) as FetchImpl;
}

class MockWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readyState: number = MockWebSocket.CONNECTING;
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: Event) => void) | null = null;

	constructor(
		public readonly url: string,
		public readonly options?: { headers?: Record<string, string> },
	) {}

	send(_data: string): void {}

	close(): void {
		this.readyState = MockWebSocket.CLOSED;
	}

	emit(type: string, event: Event): void {
		const handler = (this as unknown as Record<string, unknown>)[`on${type}`];
		if (typeof handler === "function") (handler as (e: Event) => void).call(this, event);
	}

	// Asynchronous open is required because caller attaches `ws.onopen` after `new WebSocket(...)` returns.
	scheduleOpen(): void {
		setTimeout(() => {
			this.readyState = MockWebSocket.OPEN;
			this.emit("open", new Event("open"));
		}, 0);
	}

	sendJson(payload: Record<string, unknown>): void {
		this.emit("message", { data: JSON.stringify(payload) } as unknown as MessageEvent);
	}

	emitCodexResponse(opts: { messageId: string; responseId: string; text: string }): void {
		this.sendJson({
			type: "response.output_item.added",
			item: { type: "message", id: opts.messageId, role: "assistant", status: "in_progress", content: [] },
		});
		this.sendJson({ type: "response.content_part.added", part: { type: "output_text", text: "" } });
		this.sendJson({ type: "response.output_text.delta", delta: opts.text });
		this.sendJson({
			type: "response.output_item.done",
			item: {
				type: "message",
				id: opts.messageId,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: opts.text }],
			},
		});
		this.sendJson({
			type: "response.done",
			response: {
				id: opts.responseId,
				status: "completed",
				usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
			},
		});
	}
}

describe("Responses Lite all_turns invariant suite", () => {
	const allCodexCatalogModels = getBundledModels("openai-codex").filter(
		(m): m is Model<"openai-codex-responses"> => m.api === "openai-codex-responses",
	);

	it("discovers both lite-eligible and lite-ineligible models from the catalog", () => {
		expect(allCodexCatalogModels.length).toBeGreaterThan(0);
		const eligible = allCodexCatalogModels.filter(m => acceptsAllTurnsReasoningContext(m));
		const ineligible = allCodexCatalogModels.filter(m => !acceptsAllTurnsReasoningContext(m));
		expect(eligible.length).toBeGreaterThan(0);
		expect(ineligible.length).toBeGreaterThan(0);
		// A codenamed id the version floor cannot read is eligible only through
		// its lite flag, and the catalog ships some: the two rules are separate.
		expect(eligible.some(m => !supportsAllTurnsReasoningContext(m.id))).toBe(true);
	});

	describe("Dynamic catalog model sweep for HTTP SSE requests", () => {
		for (const catalogModel of allCodexCatalogModels) {
			const isEligible = acceptsAllTurnsReasoningContext(catalogModel);

			it(`verifies lite invariant for catalog model ${catalogModel.id} (eligible: ${isEligible})`, async () => {
				let captured: CapturedCodexRequest | undefined;
				const fetchMock = createCodexFetchMock(createCodexSse(COMPLETED_CODEX_EVENTS), req => {
					captured = req;
				});

				const supportedEffort = catalogModel.reasoningOptions?.efforts?.[0];
				const reasoningOption = supportedEffort ? { reasoning: supportedEffort } : {};
				const result = await streamOpenAICodexResponses(catalogModel, createCodexTestContext(), {
					apiKey: createCodexTestToken(),
					fetch: fetchMock,
					responsesLite: true,
					...reasoningOption,
				}).result();
				expect(result.stopReason).toBe("stop");
				if (!captured) throw new Error(`expected captured request for ${catalogModel.id}`);

				const hasLiteHeader = captured.headers.get(OPENAI_HEADERS.RESPONSES_LITE) === "true";
				const bodyReasoning = captured.body.reasoning as Record<string, unknown> | undefined;

				if (isEligible) {
					// Eligible models: MUST have lite header AND reasoning.context === "all_turns"
					expect(hasLiteHeader).toBe(true);
					expect(bodyReasoning?.context).toBe("all_turns");
					// Must have lite shape applied:
					expect(captured.body.instructions).toBeUndefined();
					expect(captured.body.parallel_tool_calls).toBe(false);
					expect(Array.isArray(captured.body.input)).toBe(true);
					const input = captured.body.input as Array<Record<string, unknown>>;
					expect(input.some(item => item.type === "additional_tools")).toBe(true);
				} else {
					// Ineligible models: MUST NOT have lite header AND MUST NOT have reasoning.context === "all_turns"
					expect(hasLiteHeader).toBe(false);
					expect(bodyReasoning?.context).toBeUndefined();
					// Must preserve standard responses shape:
					expect(captured.body.instructions).toBe("You are a helpful assistant.");
					const input = captured.body.input as Array<Record<string, unknown>>;
					expect(input.some(item => item.type === "additional_tools")).toBe(false);
				}
			});
		}
	});

	describe("Reasoning effort and context override matrix under Responses Lite", () => {
		const eligibleModel = createCodexModel("gpt-5.6-terra");
		const ineligibleModel = createCodexModel("gpt-5.1-codex");

		it("guarantees reasoning.context === all_turns when effort is unset for eligible model", async () => {
			const body = await transformRequestBody({ model: eligibleModel.id }, eligibleModel, {
				responsesLite: true,
			});
			expect(body.reasoning?.context).toBe("all_turns");
			expect(body.reasoning?.effort).toBeUndefined();
		});

		it("guarantees reasoning.context === all_turns when effort is none for eligible model", async () => {
			const body = await transformRequestBody({ model: eligibleModel.id }, eligibleModel, {
				responsesLite: true,
				reasoningEffort: "none",
			});
			expect(body.reasoning?.context).toBe("all_turns");
			expect(body.reasoning?.effort).toBe("none");
		});

		it("overrides explicit reasoningContext (current_turn / auto) to all_turns under lite for eligible model", async () => {
			for (const override of ["current_turn", "auto"] as const) {
				const body = await transformRequestBody({ model: eligibleModel.id }, eligibleModel, {
					responsesLite: true,
					reasoningContext: override,
				});
				expect(body.reasoning?.context).toBe("all_turns");
			}
		});

		it("suppresses lite and all_turns context for ineligible model even if requested", async () => {
			expect(resolveCodexResponsesLite(ineligibleModel, true)).toBe(false);
			expect(resolveCodexResponsesLite({ ...ineligibleModel, useResponsesLite: true }, undefined)).toBe(false);

			const body = await transformRequestBody({ model: ineligibleModel.id }, ineligibleModel, {
				responsesLite: true,
				reasoningEffort: "medium",
			});
			expect(body.reasoning?.context).toBeUndefined();
			expect(body.instructions).toBeUndefined();
		});

		it("suppresses explicit all_turns on ineligible model while preserving current_turn and auto", async () => {
			const forcedAllTurns = await transformRequestBody({ model: ineligibleModel.id }, ineligibleModel, {
				reasoningEffort: "medium",
				reasoningContext: "all_turns",
			});
			expect(forcedAllTurns.reasoning?.context).toBeUndefined();

			const currentTurn = await transformRequestBody({ model: ineligibleModel.id }, ineligibleModel, {
				reasoningEffort: "medium",
				reasoningContext: "current_turn",
			});
			expect(currentTurn.reasoning?.context).toBe("current_turn");

			const auto = await transformRequestBody({ model: ineligibleModel.id }, ineligibleModel, {
				reasoningEffort: "medium",
				reasoningContext: "auto",
			});
			expect(auto.reasoning?.context).toBe("auto");
		});
	});

	describe("WebSocket transport: initial turn, stateful delta, and retry", () => {
		it("emits lite marker and reasoning.context === all_turns over WebSocket for eligible model", async () => {
			const model = createCodexModel("gpt-5.6-terra", { preferWebsockets: true });
			let capturedUpgradeHeaders: Record<string, string> | undefined;
			const sentFrames: Array<Record<string, unknown>> = [];

			class TestWs extends MockWebSocket {
				constructor(url: string, opts?: { headers?: Record<string, string> }) {
					super(url, opts);
					capturedUpgradeHeaders = opts?.headers;
					this.scheduleOpen();
				}

				send(data: string): void {
					const parsed = JSON.parse(data) as Record<string, unknown>;
					sentFrames.push(parsed);
					this.emitCodexResponse({ messageId: "msg_1", responseId: "resp_1", text: "Hello" });
				}
			}

			global.WebSocket = TestWs as unknown as typeof WebSocket;

			const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
				apiKey: createCodexTestToken(),
				sessionId: "ws-test-session",
				providerSessionState: new Map<string, ProviderSessionState>(),
				responsesLite: true,
			}).result();

			expect(result.stopReason).toBe("stop");
			expect(capturedUpgradeHeaders?.[OPENAI_HEADERS.RESPONSES_LITE]).toBe("true");
			expect(sentFrames).toHaveLength(1);
			expect(sentFrames[0]?.type).toBe("response.create");

			const clientMetadata = sentFrames[0]?.client_metadata as Record<string, unknown> | undefined;
			expect(clientMetadata?.ws_request_header_x_openai_internal_codex_responses_lite).toBe("true");

			const reasoning = sentFrames[0]?.reasoning as Record<string, unknown> | undefined;
			expect(reasoning?.context).toBe("all_turns");
		});

		it("suppresses lite marker in WebSocket upgrade and frame metadata for ineligible model", async () => {
			const model = createCodexModel("gpt-5.1-codex", { preferWebsockets: true });
			let capturedUpgradeHeaders: Record<string, string> | undefined;
			const sentFrames: Array<Record<string, unknown>> = [];

			class TestWs extends MockWebSocket {
				constructor(url: string, opts?: { headers?: Record<string, string> }) {
					super(url, opts);
					capturedUpgradeHeaders = opts?.headers;
					this.scheduleOpen();
				}

				send(data: string): void {
					const parsed = JSON.parse(data) as Record<string, unknown>;
					sentFrames.push(parsed);
					this.emitCodexResponse({ messageId: "msg_1", responseId: "resp_1", text: "Hello" });
				}
			}

			global.WebSocket = TestWs as unknown as typeof WebSocket;

			const result = await streamOpenAICodexResponses(model, createCodexTestContext(), {
				apiKey: createCodexTestToken(),
				sessionId: "ws-ineligible-session",
				providerSessionState: new Map<string, ProviderSessionState>(),
				responsesLite: true,
				reasoning: "medium",
			}).result();

			expect(result.stopReason).toBe("stop");
			expect(capturedUpgradeHeaders?.[OPENAI_HEADERS.RESPONSES_LITE]).toBeUndefined();
			expect(sentFrames).toHaveLength(1);

			const clientMetadata = sentFrames[0]?.client_metadata as Record<string, unknown> | undefined;
			expect(clientMetadata?.ws_request_header_x_openai_internal_codex_responses_lite).toBeUndefined();

			const reasoning = sentFrames[0]?.reasoning as Record<string, unknown> | undefined;
			expect(reasoning?.context).toBeUndefined();
		});

		it("preserves reasoning.context === all_turns in stateful delta WebSocket turn", async () => {
			const model = createCodexModel("gpt-5.6-terra", { preferWebsockets: true });
			const providerSessionState = new Map<string, ProviderSessionState>();
			const sentFrames: Array<Record<string, unknown>> = [];

			class DeltaWs extends MockWebSocket {
				constructor(url: string, opts?: { headers?: Record<string, string> }) {
					super(url, opts);
					this.scheduleOpen();
				}

				send(data: string): void {
					const parsed = JSON.parse(data) as Record<string, unknown>;
					sentFrames.push(parsed);
					const turnIdx = sentFrames.length;
					this.emitCodexResponse({
						messageId: `msg_${turnIdx}`,
						responseId: `resp_${turnIdx}`,
						text: `Answer ${turnIdx}`,
					});
				}
			}

			global.WebSocket = DeltaWs as unknown as typeof WebSocket;

			const context1: Context = {
				systemPrompt: ["You are an assistant."],
				messages: [{ role: "user", content: "First turn", timestamp: 1000 }],
			};

			const result1 = await streamOpenAICodexResponses(model, context1, {
				apiKey: createCodexTestToken(),
				sessionId: "ws-delta-session",
				providerSessionState,
				responsesLite: true,
			}).result();

			expect(result1.stopReason).toBe("stop");
			expect(sentFrames).toHaveLength(1);
			expect(sentFrames[0]?.previous_response_id).toBeUndefined();
			expect((sentFrames[0]?.reasoning as Record<string, unknown>)?.context).toBe("all_turns");

			const context2: Context = {
				systemPrompt: ["You are an assistant."],
				messages: [
					{ role: "user", content: "First turn", timestamp: 1000 },
					result1,
					{ role: "user", content: "Second turn", timestamp: 2000 },
				],
			};

			const result2 = await streamOpenAICodexResponses(model, context2, {
				apiKey: createCodexTestToken(),
				sessionId: "ws-delta-session",
				providerSessionState,
				responsesLite: true,
			}).result();

			expect(result2.stopReason).toBe("stop");
			expect(sentFrames).toHaveLength(2);
			// Stateful delta frame carries previous_response_id AND preserves reasoning.context === "all_turns"
			expect(sentFrames[1]?.previous_response_id).toBe("resp_1");
			expect((sentFrames[1]?.reasoning as Record<string, unknown>)?.context).toBe("all_turns");
			const metadata = sentFrames[1]?.client_metadata as Record<string, unknown>;
			expect(metadata.ws_request_header_x_openai_internal_codex_responses_lite).toBe("true");
		});

		it("retains reasoning.context === all_turns during full-replay fallback after previous_response_not_found", async () => {
			const model = createCodexModel("gpt-5.6-terra", { preferWebsockets: true });
			const providerSessionState = new Map<string, ProviderSessionState>();
			const sentFrames: Array<Record<string, unknown>> = [];
			let simulateStaleOnNextTurn = false;

			class RecoveryWs extends MockWebSocket {
				constructor(url: string, opts?: { headers?: Record<string, string> }) {
					super(url, opts);
					this.scheduleOpen();
				}

				send(data: string): void {
					const parsed = JSON.parse(data) as Record<string, unknown>;
					sentFrames.push(parsed);

					if (simulateStaleOnNextTurn && parsed.previous_response_id) {
						simulateStaleOnNextTurn = false;
						this.sendJson({
							type: "error",
							error: {
								code: "previous_response_not_found",
								message: "Previous response ID resp_1 not found",
							},
						});
						return;
					}

					this.emitCodexResponse({
						messageId: `msg_${sentFrames.length}`,
						responseId: `resp_${sentFrames.length}`,
						text: "Response",
					});
				}
			}

			global.WebSocket = RecoveryWs as unknown as typeof WebSocket;

			const context1: Context = {
				systemPrompt: ["You are an assistant."],
				messages: [{ role: "user", content: "Turn 1", timestamp: 1000 }],
			};

			const result1 = await streamOpenAICodexResponses(model, context1, {
				apiKey: createCodexTestToken(),
				sessionId: "ws-recovery-session",
				providerSessionState,
				responsesLite: true,
			}).result();

			expect(result1.stopReason).toBe("stop");
			expect(sentFrames).toHaveLength(1);

			simulateStaleOnNextTurn = true;
			const context2: Context = {
				systemPrompt: ["You are an assistant."],
				messages: [
					{ role: "user", content: "Turn 1", timestamp: 1000 },
					result1,
					{ role: "user", content: "Turn 2", timestamp: 2000 },
				],
			};

			const result2 = await streamOpenAICodexResponses(model, context2, {
				apiKey: createCodexTestToken(),
				sessionId: "ws-recovery-session",
				providerSessionState,
				responsesLite: true,
			}).result();

			expect(result2.stopReason).toBe("stop");
			// Frame 1: Turn 1
			// Frame 2: Turn 2 (with previous_response_id -> rejected with previous_response_not_found)
			// Frame 3: Turn 2 retry (full context replay, no previous_response_id, carries all_turns reasoning)
			expect(sentFrames).toHaveLength(3);
			expect(sentFrames[1]?.previous_response_id).toBe("resp_1");
			expect(sentFrames[2]?.previous_response_id).toBeUndefined();
			expect((sentFrames[2]?.reasoning as Record<string, unknown>)?.context).toBe("all_turns");
			const metadata = sentFrames[2]?.client_metadata as Record<string, unknown>;
			expect(metadata.ws_request_header_x_openai_internal_codex_responses_lite).toBe("true");
		});
	});

	describe("Direct compaction requests", () => {
		it("includes lite header for eligible model and omits it for ineligible model", () => {
			const eligible = createCodexModel("gpt-5.6-terra");
			const ineligible = createCodexModel("gpt-5.1-codex");

			const eligibleReq = createOpenAICodexDirectRequest({
				model: eligible,
				accessToken: createCodexTestToken(),
				requestKind: "compaction",
				responsesLite: true,
			});
			expect(eligibleReq.headers[OPENAI_HEADERS.RESPONSES_LITE]).toBe("true");

			const ineligibleReq = createOpenAICodexDirectRequest({
				model: ineligible,
				accessToken: createCodexTestToken(),
				requestKind: "compaction",
				responsesLite: true,
			});
			expect(ineligibleReq.headers[OPENAI_HEADERS.RESPONSES_LITE]).toBeUndefined();
		});
	});
});
