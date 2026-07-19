/**
 * Coverage for the V2 streaming compaction path: endpoint resolution, request
 * building, the retained-history filter + token-budget truncation, the SSE
 * collector (output-item / completed / failed events, usage parsing), the
 * retry-on-transient-error loop, and the preserve-data round trip.
 *
 * The streaming tests drive `requestCompactionV2Streaming` with a mock fetch
 * that returns a real SSE `Response`, so the collector parses bytes exactly as
 * it would against a live endpoint.
 */
import { describe, expect, test } from "bun:test";
import {
	buildCompactionV2ReplacementHistory,
	buildCompactionV2Request,
	getCompactionV2Endpoint,
	getCompactionV2PreserveData,
	requestCompactionV2Streaming,
	resolveCompactionV2RetainedMessageBudget,
	shouldUseCompactionV2Streaming,
	storeCompactionV2PreserveData,
	V2_RETAINED_MESSAGE_TOKEN_BUDGET,
} from "@veyyon/agent-core/compaction/compaction-v2-streaming";
import { OPENAI_REMOTE_COMPACTION_PRESERVE_KEY } from "@veyyon/agent-core/compaction/openai";
import type { FetchImpl, Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import type { ModelSpec } from "@veyyon/catalog/types";

function makeModel(overrides: Partial<ModelSpec<"openai-responses">> = {}): Model<"openai-responses"> {
	return buildModel({
		id: "gpt-5",
		name: "GPT-5",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
		...overrides,
	});
}

function userText(text: string): Record<string, unknown> {
	return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

function sseResponse(raw: string, init?: ResponseInit): Response {
	return new Response(raw, { headers: { "content-type": "text/event-stream" }, ...init });
}

const COMPLETED_EVENT = {
	type: "response.completed",
	response: {
		usage: {
			input_tokens: 100,
			output_tokens: 20,
			total_tokens: 120,
			input_tokens_details: { cached_tokens: 10 },
			output_tokens_details: { reasoning_tokens: 5 },
		},
	},
};

function successStream(compactionId = "cmp-1"): string {
	const itemEvent = {
		type: "response.output_item.done",
		item: { type: "compaction", id: compactionId, content: "summary text" },
	};
	return (
		`event: response.output_item.done\ndata: ${JSON.stringify(itemEvent)}\n\n` +
		`event: response.completed\ndata: ${JSON.stringify(COMPLETED_EVENT)}\n\n` +
		`data: [DONE]\n\n`
	);
}

describe("getCompactionV2Endpoint", () => {
	test("appends /responses to a bare /v1 OpenAI base URL", () => {
		expect(getCompactionV2Endpoint(makeModel())).toBe("https://api.openai.com/v1/responses");
	});

	test("leaves an already-/responses endpoint unchanged", () => {
		expect(getCompactionV2Endpoint(makeModel({ baseUrl: "https://host/v1/responses" }))).toBe(
			"https://host/v1/responses",
		);
	});

	test("adds /v1/responses when the base URL has neither suffix", () => {
		expect(getCompactionV2Endpoint(makeModel({ baseUrl: "https://proxy.internal" }))).toBe(
			"https://proxy.internal/v1/responses",
		);
	});

	test("resolves the codex responses endpoint for codex models", () => {
		const codex = makeModel({ provider: "openai-codex", api: "openai-codex-responses" as never, baseUrl: "" });
		expect(getCompactionV2Endpoint(codex)).toBe("https://chatgpt.com/backend-api/codex/responses");
	});

	test("prefers an explicitly configured v2 endpoint", () => {
		const model = makeModel({ remoteCompaction: { v2Endpoint: "https://custom/compact" } as never });
		expect(getCompactionV2Endpoint(model)).toBe("https://custom/compact");
	});

	test("returns undefined when remote compaction is disabled or the api is incompatible", () => {
		expect(getCompactionV2Endpoint(makeModel({ remoteCompaction: { enabled: false } as never }))).toBeUndefined();
		expect(getCompactionV2Endpoint(makeModel({ api: "mock" as never }))).toBeUndefined();
	});
});

describe("shouldUseCompactionV2Streaming", () => {
	test("requires the v2StreamingEnabled flag and a resolvable endpoint", () => {
		expect(shouldUseCompactionV2Streaming(makeModel())).toBe(false);
		const enabled = makeModel({ remoteCompaction: { v2StreamingEnabled: true } as never });
		expect(shouldUseCompactionV2Streaming(enabled)).toBe(true);
	});
});

describe("resolveCompactionV2RetainedMessageBudget", () => {
	test("defaults, clamps to the ceiling, and floors at 1", () => {
		expect(resolveCompactionV2RetainedMessageBudget(undefined)).toBe(V2_RETAINED_MESSAGE_TOKEN_BUDGET);
		expect(resolveCompactionV2RetainedMessageBudget(Number.POSITIVE_INFINITY)).toBe(V2_RETAINED_MESSAGE_TOKEN_BUDGET);
		expect(resolveCompactionV2RetainedMessageBudget(10_000_000)).toBe(V2_RETAINED_MESSAGE_TOKEN_BUDGET);
		expect(resolveCompactionV2RetainedMessageBudget(0)).toBe(1);
		expect(resolveCompactionV2RetainedMessageBudget(4096.9)).toBe(4096);
	});
});

describe("buildCompactionV2Request", () => {
	test("clamps the retained budget and carries options through", () => {
		const request = buildCompactionV2Request(makeModel(), [userText("hi")], "compact now", {
			retainedMessageBudget: 8000,
			sessionId: "sess-1",
			reasoning: { effort: "high", summary: "auto" },
		});
		expect(request.model).toBe("gpt-5");
		expect(request.instructions).toBe("compact now");
		expect(request.retainedMessageBudget).toBe(8000);
		expect(request.sessionId).toBe("sess-1");
		expect(request.reasoning).toEqual({ effort: "high", summary: "auto" });
	});
});

describe("buildCompactionV2ReplacementHistory", () => {
	const compactionItem = { type: "compaction", id: "cmp", content: "summary" };

	test("keeps plain user messages, drops contextual and non-user messages, and appends the compaction item", () => {
		const input = [
			userText("keep me"),
			{ type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\nctx" }] },
			{ type: "message", role: "developer", content: [{ type: "input_text", text: "dev" }] },
			{
				type: "message",
				role: "user",
				content: [
					{ type: "input_text", text: "with image" },
					{ type: "input_image", image_url: "data:..." },
				],
			},
			{ type: "function_call", call_id: "c1", name: "read" },
		];
		const { replacementHistory, retainedImageCount } = buildCompactionV2ReplacementHistory(input, compactionItem);
		expect(replacementHistory).toHaveLength(3);
		expect((replacementHistory[0].content as Array<{ text: string }>)[0].text).toBe("keep me");
		expect((replacementHistory[1].content as Array<{ text: string }>)[0].text).toBe("with image");
		expect(replacementHistory[2]).toBe(compactionItem);
		expect(retainedImageCount).toBe(1);
	});

	test("truncates the oldest retained text to fit a tiny token budget", () => {
		const long = "word ".repeat(400); // ~2000 chars => ~500 tokens
		const { replacementHistory } = buildCompactionV2ReplacementHistory([userText(long)], compactionItem, 20);
		const keptText = (replacementHistory[0].content as Array<{ text: string }>)[0].text;
		expect(keptText.length).toBeLessThan(long.length);
		expect(keptText).toContain("tokens truncated");
		expect(replacementHistory[1]).toBe(compactionItem);
	});

	test("keeps an image and truncates trailing text when the budget covers the image", () => {
		const item = {
			type: "message",
			role: "user",
			content: [
				{ type: "input_image", image_url: "data:..." },
				{ type: "input_text", text: "word ".repeat(400) },
			],
		};
		// 800 tokens: 765 for the image leaves 35 for text, forcing truncation.
		const { replacementHistory } = buildCompactionV2ReplacementHistory([item], compactionItem, 800);
		const content = replacementHistory[0].content as Array<Record<string, unknown>>;
		expect(content[0].type).toBe("input_image");
		expect(content[1].type).toBe("input_text");
		expect(String(content[1].text)).toContain("tokens truncated");
	});

	test("drops an image that does not fit in the remaining budget", () => {
		const item = {
			type: "message",
			role: "user",
			content: [
				{ type: "input_image", image_url: "data:..." },
				{ type: "input_text", text: "word ".repeat(400) },
			],
		};
		// 200 tokens is below the 765-token image estimate, so the image is skipped.
		const { replacementHistory, retainedImageCount } = buildCompactionV2ReplacementHistory(
			[item],
			compactionItem,
			200,
		);
		const content = replacementHistory[0].content as Array<Record<string, unknown>>;
		expect(content.every(part => part.type !== "input_image")).toBe(true);
		expect(retainedImageCount).toBe(0);
	});
});

describe("preserve data round trip", () => {
	test("stores and reads back the V2 replacement history under the shared preserve key", () => {
		const response = {
			compactionItem: { type: "compaction", id: "c" },
			replacementHistory: [userText("kept")],
			usedTokens: 321,
			usage: undefined,
			retainedImageCount: 0,
		};
		const stored = storeCompactionV2PreserveData(response, makeModel());
		const slot = stored[OPENAI_REMOTE_COMPACTION_PRESERVE_KEY] as Record<string, unknown>;
		expect(slot.version).toBe("v2");
		expect(slot.provider).toBe("openai");

		const read = getCompactionV2PreserveData(stored);
		expect(read?.provider).toBe("openai");
		expect(read?.usedTokens).toBe(321);
		expect(read?.replacementHistory).toHaveLength(1);
	});

	test("returns undefined for a missing, non-record, or provider-less slot", () => {
		expect(getCompactionV2PreserveData(undefined)).toBeUndefined();
		expect(getCompactionV2PreserveData({ [OPENAI_REMOTE_COMPACTION_PRESERVE_KEY]: 5 })).toBeUndefined();
		expect(
			getCompactionV2PreserveData({ [OPENAI_REMOTE_COMPACTION_PRESERVE_KEY]: { replacementHistory: [] } }),
		).toBeUndefined();
	});
});

describe("requestCompactionV2Streaming", () => {
	test("parses a streamed compaction item, usage, and replacement history", async () => {
		const fetchMock: FetchImpl = async () => sseResponse(successStream());
		const request = buildCompactionV2Request(makeModel(), [userText("keep me")], "compact");
		const result = await requestCompactionV2Streaming(makeModel(), "key", request, undefined, { fetch: fetchMock });
		expect(result.compactionItem.id).toBe("cmp-1");
		expect(result.usedTokens).toBe(100);
		expect(result.usage).toEqual({
			inputTokens: 100,
			outputTokens: 20,
			totalTokens: 120,
			cachedInputTokens: 10,
			reasoningOutputTokens: 5,
		});
		// One retained user message + the compaction item.
		expect(result.replacementHistory).toHaveLength(2);
		expect(result.replacementHistory[1]).toBe(result.compactionItem);
	});

	test("throws when the model cannot use V2 streaming", async () => {
		const request = buildCompactionV2Request(makeModel(), [], "compact");
		await expect(
			requestCompactionV2Streaming(makeModel({ api: "mock" as never }), "key", request, undefined, {
				fetch: async () => sseResponse(successStream()),
			}),
		).rejects.toThrow("does not support V2 streaming compaction");
	});

	test("surfaces a response.failed event as a descriptive error", async () => {
		const failed = {
			type: "response.failed",
			response: { error: { code: "invalid_request", message: "bad input" } },
		};
		const stream = `event: response.failed\ndata: ${JSON.stringify(failed)}\n\n`;
		const request = buildCompactionV2Request(makeModel(), [], "compact");
		await expect(
			requestCompactionV2Streaming(makeModel(), "key", request, undefined, {
				fetch: async () => sseResponse(stream),
			}),
		).rejects.toThrow("V2 compaction stream response.failed (invalid_request): bad input");
	});

	test("throws when the stream closes before response.completed", async () => {
		const stream = `data: [DONE]\n\n`;
		const request = buildCompactionV2Request(makeModel(), [], "compact");
		await expect(
			requestCompactionV2Streaming(makeModel(), "key", request, undefined, {
				fetch: async () => sseResponse(stream),
			}),
		).rejects.toThrow("closed before response.completed");
	});

	test("retries a transient 503 and then succeeds", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls++;
			if (calls === 1) return sseResponse("service unavailable", { status: 503, statusText: "Service Unavailable" });
			return sseResponse(successStream("cmp-retry"));
		};
		const request = buildCompactionV2Request(makeModel(), [userText("hi")], "compact");
		const result = await requestCompactionV2Streaming(makeModel(), "key", request, undefined, {
			fetch: fetchMock,
			retryWait: async () => {},
		});
		expect(calls).toBe(2);
		expect(result.compactionItem.id).toBe("cmp-retry");
	});

	test("retries a stream-parse failure until retries are exhausted, then throws", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls++;
			return sseResponse(`event: response.output_item.done\ndata: {not-json}\n\n`);
		};
		const request = buildCompactionV2Request(makeModel(), [], "compact");
		await expect(
			requestCompactionV2Streaming(makeModel(), "key", request, undefined, {
				fetch: fetchMock,
				retryWait: async () => {},
			}),
		).rejects.toThrow("stream parse failed");
		expect(calls).toBe(3); // initial attempt + 2 retries
	});

	test("treats a timeout-named fetch error as retryable", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls++;
			const err = new Error("request timeout exceeded");
			throw err;
		};
		const request = buildCompactionV2Request(makeModel(), [], "compact");
		await expect(
			requestCompactionV2Streaming(makeModel(), "key", request, undefined, {
				fetch: fetchMock,
				retryWait: async () => {},
			}),
		).rejects.toThrow("timeout");
		expect(calls).toBe(3);
	});

	test("errors when the stream carries more than one compaction item", async () => {
		const item = (id: string) =>
			`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", item: { type: "compaction", id } })}\n\n`;
		const stream = item("a") + item("b") + `event: response.completed\ndata: ${JSON.stringify(COMPLETED_EVENT)}\n\n`;
		const request = buildCompactionV2Request(makeModel(), [], "compact");
		await expect(
			requestCompactionV2Streaming(makeModel(), "key", request, undefined, {
				fetch: async () => sseResponse(stream),
			}),
		).rejects.toThrow("expected exactly one compaction output item, got 2");
	});

	test("sends reasoning and encrypted-content include when the request carries reasoning", async () => {
		let sentBody: Record<string, unknown> = {};
		const fetchMock: FetchImpl = async (_endpoint, init) => {
			sentBody = JSON.parse(String(init?.body));
			return sseResponse(successStream());
		};
		const request = buildCompactionV2Request(makeModel(), [], "compact", {
			reasoning: { effort: "high", summary: "auto" },
		});
		await requestCompactionV2Streaming(makeModel(), "key", request, undefined, { fetch: fetchMock });
		expect(sentBody.reasoning).toEqual({ effort: "high", summary: "auto" });
		expect(sentBody.include).toEqual(["reasoning.encrypted_content"]);
		expect(sentBody.store).toBe(false);
	});

	test("adds codex account and beta headers for a codex model", async () => {
		const b64url = (obj: unknown) =>
			btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		const jwt = `${b64url({ alg: "none" })}.${b64url({
			"https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
		})}.sig`;
		let headers: Record<string, string> = {};
		const fetchMock: FetchImpl = async (_endpoint, init) => {
			headers = (init?.headers ?? {}) as Record<string, string>;
			return sseResponse(successStream());
		};
		const codex = makeModel({ provider: "openai-codex", api: "openai-codex-responses" as never, baseUrl: "" });
		const request = buildCompactionV2Request(codex, [], "compact");
		await requestCompactionV2Streaming(codex, jwt, request, undefined, { fetch: fetchMock });
		expect(headers["chatgpt-account-id"]).toBe("acct-1");
		expect(headers.originator).toBe("pi");
		expect(headers["OpenAI-Beta"]).toBeDefined();
	});
});

describe("getCompactionV2Endpoint azure", () => {
	test("builds the azure responses endpoint with an api-version query from the env base URL", () => {
		const previous = process.env.AZURE_OPENAI_BASE_URL;
		process.env.AZURE_OPENAI_BASE_URL = "https://res.openai.azure.com/openai/v1";
		try {
			const azure = makeModel({ provider: "azure-openai" as never, api: "azure-openai-responses" as never });
			expect(getCompactionV2Endpoint(azure)).toBe("https://res.openai.azure.com/openai/v1/responses?api-version=v1");
		} finally {
			if (previous === undefined) delete process.env.AZURE_OPENAI_BASE_URL;
			else process.env.AZURE_OPENAI_BASE_URL = previous;
		}
	});
});
