import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@veyyon/ai/providers/anthropic";
import { openAIResponsesServerCompaction } from "@veyyon/ai/providers/openai-compaction";
import { streamOpenAICompletions } from "@veyyon/ai/providers/openai-completions";
import { streamOpenAIResponses } from "@veyyon/ai/providers/openai-responses";
import { resolveOpenAIRequestSetup } from "@veyyon/ai/providers/openai-shared";
import type { Api, Context, Message, Model } from "@veyyon/ai/types";
import {
	conversationIdForOpenCode,
	getOpenCodeHeaders,
	isOpenCodeProvider,
	OPENCODE_PROVIDER_IDS,
	openCodeSessionHeaderValue,
} from "@veyyon/ai/utils/opencode-headers";
import { buildModel } from "@veyyon/catalog/build";
import { getBundledModels, getBundledProviders } from "@veyyon/catalog/models";

/**
 * WHY: the OpenCode gateway documents two client obligations under "Where can I
 * use it?" (https://opencode.ai/docs/go/): a request has to identify itself
 * with a narrow user agent, and has to carry `x-opencode-session` so the
 * gateway can optimize prompt caching. Traffic that does neither is flagged as
 * abusive, and a request without the session header loses the prompt-cache
 * routing it would otherwise get.
 *
 * THE CLASS: every OpenCode provider id, on every transport it is served over,
 * under every local cache setting. OpenCode fronts models on three wire
 * protocols at once — `/v1/messages` (Claude, Qwen), `/v1/responses` (GPT,
 * Grok, Muse Spark) and `/v1/chat/completions` (GLM, Kimi, MiniMax) — plus
 * server-side compaction on the responses host, so a header wired into one
 * transport covers a fraction of the traffic. The sweeps below enumerate the
 * provider ids and the bundled providers from source, so a new OpenCode id or a
 * new gateway host fails here rather than silently shipping unlabeled traffic.
 *
 * Each transport arm reads the bytes off the wire through the shipped stream
 * entry point rather than calling the header builder, because the wiring under
 * test is at the call site. The cache-disabled arms exist because the session
 * value was first keyed on the prompt-cache key, which is withheld when cache
 * retention is "none": that shipped a request the gateway rejects as
 * unidentified, and no builder-level test could see it.
 *
 * WHAT THIS DOES NOT CATCH: whether the gateway accepts the value, which only a
 * live request against a real OpenCode credential proves, and the Google
 * transport OpenCode serves at `/zen/v1/models/<id>`, which veyyon does not
 * route through an OpenCode provider today.
 */

const SESSION = "01998f4e-7c1a-7000-8000-2b6f9d0c4e11";
const SESSION_HEADER = "x-opencode-session";
const MESSAGES: Message[] = [{ role: "user", content: "hi", timestamp: 0 }];
const CONTEXT: Context = { messages: MESSAGES };

function headerCaseInsensitive(headers: Record<string, string>, name: string): string | undefined {
	const lowered = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lowered) return value;
	}
	return undefined;
}

function openCodeModel<A extends Api>(api: A, provider: string, id: string): Model<A> {
	return buildModel({
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://opencode.ai/zen/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 4_096,
	});
}

/** A complete Anthropic message stream; the SDK reader blocks without one. */
const ANTHROPIC_SSE = [
	{
		type: "message_start",
		message: {
			id: "msg_1",
			type: "message",
			role: "assistant",
			content: [],
			stop_reason: null,
			usage: { input_tokens: 1, output_tokens: 0 },
		},
	},
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
	{ type: "message_stop" },
]
	.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
	.join("");

/** The OpenAI-family terminator; these readers stop on it. */
const OPENAI_SSE = "data: [DONE]\n\n";

/**
 * A fetch that records the outbound headers and answers with an event stream.
 * The body only has to get the request sent; the headers are the subject, and
 * every arm below tolerates a downstream parse failure for that reason.
 */
function captureFetch(body: string): {
	captured: Record<string, string>;
	fetchImpl: typeof fetch;
	calls: () => number;
} {
	const captured: Record<string, string> = {};
	let calls = 0;
	const fetchImpl = (async (input: string | Request | URL, init?: RequestInit): Promise<Response> => {
		calls += 1;
		const raw = init?.headers ?? (input instanceof Request ? input.headers : undefined);
		if (raw instanceof Headers) {
			for (const [key, value] of raw.entries()) captured[key] = value;
		} else if (Array.isArray(raw)) {
			for (const [key, value] of raw) captured[key] = value;
		} else if (raw && typeof raw === "object") {
			for (const [key, value] of Object.entries(raw)) captured[key] = String(value);
		}
		return new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}) as typeof fetch;
	return { captured, fetchImpl, calls: () => calls };
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
	try {
		for await (const _event of stream) {
			// The request is what matters; the fake body may not parse.
		}
	} catch {
		// A rejected body still proves the headers that were sent.
	}
}

type WireArm = {
	name: string;
	send: (provider: string, cacheDisabled: boolean) => Promise<{ headers: Record<string, string>; calls: number }>;
};

const WIRE_ARMS: WireArm[] = [
	{
		name: "anthropic-messages",
		send: async (provider, cacheDisabled) => {
			const { captured, fetchImpl, calls } = captureFetch(ANTHROPIC_SSE);
			await drain(
				streamAnthropic(openCodeModel("anthropic-messages", provider, "claude-fable-5-1"), CONTEXT, {
					apiKey: "test-key",
					sessionId: SESSION,
					cacheRetention: cacheDisabled ? "none" : undefined,
					fetch: fetchImpl,
				}),
			);
			return { headers: captured, calls: calls() };
		},
	},
	{
		name: "openai-completions",
		send: async (provider, cacheDisabled) => {
			const { captured, fetchImpl, calls } = captureFetch(OPENAI_SSE);
			await drain(
				streamOpenAICompletions(openCodeModel("openai-completions", provider, "glm-5"), CONTEXT, {
					apiKey: "test-key",
					sessionId: SESSION,
					cacheRetention: cacheDisabled ? "none" : undefined,
					fetch: fetchImpl,
				}),
			);
			return { headers: captured, calls: calls() };
		},
	},
	{
		name: "openai-responses",
		send: async (provider, cacheDisabled) => {
			const { captured, fetchImpl, calls } = captureFetch(OPENAI_SSE);
			await drain(
				streamOpenAIResponses(openCodeModel("openai-responses", provider, "gpt-5.5"), CONTEXT, {
					apiKey: "test-key",
					sessionId: SESSION,
					cacheRetention: cacheDisabled ? "none" : undefined,
					fetch: fetchImpl,
				}),
			);
			return { headers: captured, calls: calls() };
		},
	},
	{
		name: "openai-responses server compaction",
		send: async (provider, cacheDisabled) => {
			const { captured, fetchImpl, calls } = captureFetch(OPENAI_SSE);
			try {
				await openAIResponsesServerCompaction.compact({
					model: openCodeModel("openai-responses", provider, "gpt-5.5"),
					messages: MESSAGES,
					apiKey: "test-key",
					sessionId: SESSION,
					// Same conversation as the session id, so every arm derives one
					// value; the side-channel test below covers a pinned cache key.
					promptCacheKey: cacheDisabled ? undefined : SESSION,
					fetch: fetchImpl,
				});
			} catch {
				// The compact response is fake; the request headers are the subject.
			}
			return { headers: captured, calls: calls() };
		},
	},
];

describe("every OpenCode provider labels its traffic and carries a session", () => {
	it("exposes the provider ids it claims to cover", () => {
		// Pinned by equality, not by count: a new id has to be added here
		// deliberately, and the sweeps below then hold it to the same contract.
		expect([...OPENCODE_PROVIDER_IDS].sort()).toEqual(["opencode", "opencode-go", "opencode-zen"]);
	});

	type MatrixRow = [string, string, boolean, WireArm];
	const matrix: MatrixRow[] = WIRE_ARMS.flatMap(arm =>
		OPENCODE_PROVIDER_IDS.flatMap(provider =>
			[false, true].map((cacheDisabled): MatrixRow => [arm.name, provider, cacheDisabled, arm]),
		),
	);

	it.each(matrix)(
		"%s carries both headers for %s (cache disabled: %p)",
		async (_armName, provider, cacheDisabled, arm) => {
			const { headers, calls } = await arm.send(provider, cacheDisabled);
			// A transport that never reached fetch would assert nothing below.
			expect(calls).toBeGreaterThan(0);
			expect(headerCaseInsensitive(headers, "User-Agent")).toMatch(/^Veyyon\//);
			expect(headerCaseInsensitive(headers, SESSION_HEADER)).toBe(openCodeSessionHeaderValue(SESSION));
		},
	);

	it("derives one session value for a conversation across every transport", async () => {
		// The gateway pins a conversation to an upstream provider by this value, so
		// a turn and its compaction pass have to agree on it.
		const values = await Promise.all(
			WIRE_ARMS.map(async arm =>
				headerCaseInsensitive((await arm.send("opencode-zen", false)).headers, SESSION_HEADER),
			),
		);
		expect(new Set(values).size).toBe(1);
		expect(values[0]).toBe(openCodeSessionHeaderValue(SESSION));
	});

	it("covers every bundled provider served from an OpenCode host", () => {
		// Fail-by-default on a new gateway host: a provider whose bundled models
		// point at opencode.ai but which is not recognised would ship unlabeled.
		const openCodeHosted = getBundledProviders().filter(provider =>
			getBundledModels(provider).some(model => (model.baseUrl ?? "").includes("opencode.ai")),
		);
		expect(openCodeHosted.length).toBeGreaterThan(0);
		expect(openCodeHosted.filter(provider => !isOpenCodeProvider(provider))).toEqual([]);
	});

	it("leaves a non-OpenCode provider untouched on every transport", async () => {
		for (const arm of WIRE_ARMS) {
			const { headers } = await arm.send("openai", false);
			expect(headerCaseInsensitive(headers, SESSION_HEADER)).toBeUndefined();
		}
	});

	it("omits the session header when there is no session, and still labels the request", () => {
		// A per-request value would defeat the affinity the header exists for, so
		// the absence of a session must not be papered over with a random id.
		const headers = resolveOpenAIRequestSetup(
			{ provider: "opencode-zen", id: "gpt-5.5", baseUrl: "https://opencode.ai/zen/v1" },
			{ apiKey: "test-key", messages: MESSAGES },
		).headers;
		expect(headerCaseInsensitive(headers, SESSION_HEADER)).toBeUndefined();
		expect(headerCaseInsensitive(headers, "User-Agent")).toMatch(/^Veyyon\//);
	});

	it("lets a caller-supplied user agent win", () => {
		const headers = resolveOpenAIRequestSetup(
			{ provider: "opencode-zen", id: "gpt-5.5", baseUrl: "https://opencode.ai/zen/v1" },
			{
				apiKey: "test-key",
				messages: MESSAGES,
				conversationId: SESSION,
				extraHeaders: { "User-Agent": "Custom/9.9" },
			},
		).headers;
		expect(headerCaseInsensitive(headers, "User-Agent")).toBe("Custom/9.9");
		expect(headerCaseInsensitive(headers, SESSION_HEADER)).toBe(openCodeSessionHeaderValue(SESSION));
	});

	/**
	 * A side-channel turn (idle recap, /btw) deliberately routes under a fresh
	 * per-request session id while keeping the conversation's prompt-cache key,
	 * so routing the header on the session id would mint a new gateway session
	 * per recap and cold-miss the prefix the header exists to hit. Both transport
	 * families run side turns, so both are swept.
	 */
	const SIDE_CHANNEL_SENDERS: Array<{
		name: string;
		send: (sessionId: string, promptCacheKey: string) => Promise<Record<string, string>>;
	}> = [
		{
			name: "openai-completions",
			send: async (sessionId, promptCacheKey) => {
				const { captured, fetchImpl } = captureFetch(OPENAI_SSE);
				await drain(
					streamOpenAICompletions(openCodeModel("openai-completions", "opencode-zen", "glm-5"), CONTEXT, {
						apiKey: "test-key",
						sessionId,
						promptCacheKey,
						fetch: fetchImpl,
					}),
				);
				return captured;
			},
		},
		{
			name: "anthropic-messages",
			send: async (sessionId, promptCacheKey) => {
				const { captured, fetchImpl } = captureFetch(ANTHROPIC_SSE);
				await drain(
					streamAnthropic(openCodeModel("anthropic-messages", "opencode-zen", "claude-fable-5-1"), CONTEXT, {
						apiKey: "test-key",
						sessionId,
						promptCacheKey,
						fetch: fetchImpl,
					}),
				);
				return captured;
			},
		},
	];

	it.each(SIDE_CHANNEL_SENDERS.map(sender => [sender.name, sender]))(
		"%s keeps one session value across a side-channel turn",
		async (_name, sender) => {
			const conversation = "01a05f22-278d-7245-a5ee-73408ed7d508";
			const sent: Array<string | undefined> = [];
			for (const side of [1, 2]) {
				const captured = await sender.send(`${conversation}:side:${side}`, conversation);
				sent.push(headerCaseInsensitive(captured, SESSION_HEADER));
			}
			expect(sent[0]).toBe(openCodeSessionHeaderValue(conversation));
			expect(sent[1]).toBe(sent[0]);
		},
	);
});

describe("the session value is stable, opaque and per-conversation", () => {
	it("is identical for the same session and different for another", () => {
		// Stability is the whole point: the gateway pins a session's requests to
		// one upstream provider and its warm prompt cache.
		expect(openCodeSessionHeaderValue(SESSION)).toBe(openCodeSessionHeaderValue(SESSION));
		expect(openCodeSessionHeaderValue(SESSION)).not.toBe(openCodeSessionHeaderValue(`${SESSION}-other`));
	});

	it("never ships the local session id itself", () => {
		// The gateway needs one stable value per conversation, not the identifier
		// the local session, its transcript and its files are keyed by.
		const value = openCodeSessionHeaderValue(SESSION);
		expect(value).not.toContain(SESSION);
		expect(value).toMatch(/^ses_[0-9a-f]{32}$/);
	});

	it("carries no session header when the caller has no session id", () => {
		expect(getOpenCodeHeaders()[SESSION_HEADER]).toBeUndefined();
		expect(getOpenCodeHeaders("")[SESSION_HEADER]).toBeUndefined();
	});

	it("keys the conversation on the pinned cache key before the session id", () => {
		// A side-channel turn routes under a unique per-request session id while
		// keeping the conversation's cache key; the header has to follow the key,
		// or the turn lands on a different upstream session and a cold cache.
		expect(conversationIdForOpenCode({ promptCacheKey: "conv", sessionId: "conv:side:1" })).toBe("conv");
		expect(conversationIdForOpenCode({ sessionId: "conv" })).toBe("conv");
		expect(conversationIdForOpenCode({})).toBeUndefined();
		expect(conversationIdForOpenCode(undefined)).toBeUndefined();
	});
});
