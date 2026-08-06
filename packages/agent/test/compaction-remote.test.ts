import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import {
	type CompactionPreparation,
	compact,
	compactWithProvider,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	getRemoteCompactionPreserveData,
	REMOTE_COMPACTION_PRESERVE_KEY,
	remoteCompactionAttribution,
	remoteCompactionProviderPayload,
	resolveServerCompactionTransport,
} from "@veyyon/agent-core/compaction";
import type { AssistantMessage, Model } from "@veyyon/ai";
import * as ai from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";

/**
 * Server-side (remote) compaction: the provider compacts the span through
 * `POST /responses/compact` (OpenAI Compaction guide) while the entry
 * dual-writes a real local summary plus the provider's canonical window.
 * These tests pin the wire shape, the dual-write, window chaining, and the
 * stale-window strip in the local path.
 */

function makeAssistantStop(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		provider: "mock",
		model: "mock",
		api: "mock",
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

function makeUserMessage(text: string, timestamp = Date.now()): AgentMessage {
	return { role: "user", content: text, timestamp };
}

function getOpenAIModel(): Model {
	const model = getBundledModel("openai", "gpt-5.1");
	if (!model) throw new Error("Expected built-in openai/gpt-5.1 to exist");
	return model;
}

function makePreparation(overrides: Partial<CompactionPreparation> = {}): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [makeUserMessage("history msg"), makeAssistantStop("history reply")],
		turnPrefixMessages: [],
		recentMessages: [makeUserMessage("recent msg")],
		isSplitTurn: false,
		tokensBefore: 221_568,
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS },
		...overrides,
	};
}

const COMPACT_RESPONSE = {
	id: "resp_compact_1",
	object: "response.compaction",
	created_at: 1764967971,
	output: [
		{
			id: "msg_000",
			type: "message",
			status: "completed",
			role: "user",
			content: [{ type: "input_text", text: "history msg" }],
		},
		{ id: "cmp_001", type: "compaction", encrypted_content: "gAAAAABpM0Yj-fake" },
	],
	usage: { input_tokens: 139, output_tokens: 438, total_tokens: 577 },
};

function mockCompactFetch(responseBody: unknown = COMPACT_RESPONSE) {
	const calls: { url: string; body: Record<string, unknown> }[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				calls.push({
					url: String(input),
					body: JSON.parse(String(init?.body)) as Record<string, unknown>,
				});
				return new Response(JSON.stringify(responseBody), { status: 200 });
			},
			{ preconnect: fetch.preconnect },
		),
	);
	return calls;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("server-side compaction transport resolution is capability data", () => {
	test("an official OpenAI Responses model resolves a transport", () => {
		expect(resolveServerCompactionTransport(getOpenAIModel())).toBeDefined();
	});

	test("a non-Responses api does not: gating is api plus capability data, not a provider-name check", () => {
		const anthropic = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!anthropic) throw new Error("Expected built-in anthropic/claude-sonnet-4-5 to exist");
		expect(resolveServerCompactionTransport(anthropic)).toBeUndefined();
	});

	test("codex does not resolve a transport", () => {
		const codex = getBundledModel("openai-codex", "gpt-5.1-codex");
		if (!codex) throw new Error("Expected built-in openai-codex/gpt-5.1-codex to exist");
		expect(resolveServerCompactionTransport(codex)).toBeUndefined();
	});

	test("an Azure Responses model resolves a transport", () => {
		const azure = getBundledModel("azure", "gpt-4");
		if (!azure) throw new Error("Expected built-in azure/gpt-4 to exist");
		expect(resolveServerCompactionTransport(azure)).toBeDefined();
	});
});

describe("compactWithProvider", () => {
	test("posts the span to /responses/compact exactly per the documented shape", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(makeAssistantStop("## Goal\nShip the fix."));
		const calls = mockCompactFetch();

		await compactWithProvider(makePreparation(), getOpenAIModel(), "test-key", undefined, undefined, {
			remoteInstructions: "base system prompt",
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://api.openai.com/v1/responses/compact");
		expect(calls[0].body.model).toBe("gpt-5.1");
		expect(calls[0].body.instructions).toBe("base system prompt");
		// Only the documented fields ride the body.
		expect(Object.keys(calls[0].body).sort()).toEqual(["input", "instructions", "model"]);
		const input = calls[0].body.input as Array<Record<string, unknown>>;
		expect(JSON.stringify(input)).toContain("history msg");
		expect(JSON.stringify(input)).toContain("history reply");
	});

	test("stores the provider window verbatim and bills no second model to paraphrase it", async () => {
		// WHY: this used to dual-write, running a full local summary of the same
		// span beside the provider call, which made compacting on OpenAI cost
		// MORE than compacting locally. The provider's window is the compacted
		// context; a second summarization buys nothing it does not already carry.
		// `completeSimple` is every local summarization oneshot, so a call here
		// means the second bill is back.
		const summarize = vi.spyOn(ai, "completeSimple").mockResolvedValue(makeAssistantStop("## Goal\nShip the fix."));
		mockCompactFetch();

		const result = await compactWithProvider(makePreparation(), getOpenAIModel(), "test-key");

		expect(summarize).not.toHaveBeenCalled();
		expect(result.summary).toBe("");
		const data = getRemoteCompactionPreserveData(result.preserveData);
		expect(data).toBeDefined();
		expect(data?.provider).toBe("openai");
		expect(data?.model).toBe("gpt-5.1");
		expect(data?.window).toEqual(COMPACT_RESPONSE.output);
		expect(data?.inputTokens).toBe(139);
		expect(data?.outputTokens).toBe(438);
		expect(remoteCompactionAttribution(result.preserveData)).toBe("openai/gpt-5.1");
	});

	test("carries the structural fields the preparation owns", async () => {
		// WHY: compact() used to supply these on the way through. Nothing else
		// does now, and an entry without them cannot say what it hid.
		mockCompactFetch();

		const result = await compactWithProvider(makePreparation(), getOpenAIModel(), "test-key");

		const preparation = makePreparation();
		expect(result.firstKeptEntryId).toBe(preparation.firstKeptEntryId);
		expect(result.tokensBefore).toBe(preparation.tokensBefore);
	});

	test("forwards the operator's compaction instructions to the provider", async () => {
		// WHY: they used to reach only the local summary. With that gone they
		// would be silently dropped, which is the one thing a configured
		// instruction may never do.
		const calls = mockCompactFetch();

		await compactWithProvider(makePreparation(), getOpenAIModel(), "test-key", "keep every file path", undefined, {
			remoteInstructions: "base system prompt",
		});

		expect(calls[0].body.instructions).toBe("base system prompt\n\nkeep every file path");
	});

	test("the stored window rebuilds to a provider payload for replay", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(makeAssistantStop("summary"));
		mockCompactFetch();

		const result = await compactWithProvider(makePreparation(), getOpenAIModel(), "test-key");
		const payload = remoteCompactionProviderPayload(result.preserveData);

		expect(payload?.type).toBe("openaiResponsesHistory");
		expect(payload?.provider).toBe("openai");
		expect(payload?.items).toEqual(COMPACT_RESPONSE.output);
	});

	test("chains the previous remote window ahead of the new span", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(makeAssistantStop("updated summary"));
		const calls = mockCompactFetch();
		const previousWindow = [{ id: "cmp_prior", type: "compaction", encrypted_content: "prior-blob" }];

		await compactWithProvider(
			makePreparation({
				previousSummary: "prior summary",
				previousPreserveData: {
					[REMOTE_COMPACTION_PRESERVE_KEY]: {
						version: 1,
						provider: "openai",
						api: "openai-responses",
						model: "gpt-5.1",
						window: previousWindow,
						compactedAt: new Date().toISOString(),
					},
				},
			}),
			getOpenAIModel(),
			"test-key",
		);

		const input = calls[0].body.input as Array<Record<string, unknown>>;
		expect(input[0]).toEqual(previousWindow[0]);
		expect(input.length).toBeGreaterThan(1);
	});

	test("the fresh window replaces the previous one instead of accumulating", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(makeAssistantStop("updated summary"));
		mockCompactFetch();

		const result = await compactWithProvider(
			makePreparation({
				previousSummary: "prior summary",
				previousPreserveData: {
					[REMOTE_COMPACTION_PRESERVE_KEY]: {
						version: 1,
						provider: "openai",
						api: "openai-responses",
						model: "gpt-5.1",
						window: [{ id: "cmp_prior", type: "compaction", encrypted_content: "prior-blob" }],
						compactedAt: new Date().toISOString(),
					},
				},
			}),
			getOpenAIModel(),
			"test-key",
		);

		expect(getRemoteCompactionPreserveData(result.preserveData)?.window).toEqual(COMPACT_RESPONSE.output);
	});

	test("a window with no compaction item is rejected, so nothing is stored or replayed", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(makeAssistantStop("summary"));
		mockCompactFetch({ ...COMPACT_RESPONSE, output: [COMPACT_RESPONSE.output[0]] });

		await expect(compactWithProvider(makePreparation(), getOpenAIModel(), "test-key")).rejects.toThrow(
			/no compaction item/,
		);
	});
});

/**
 * A compacted window is bound to the host that minted it: its `compaction`
 * item is opaque `encrypted_content` and the endpoint is stateless, so that
 * blob is the whole conversation state and only its minting provider can
 * decrypt it. A session that switched hosts mid-run still carries the old
 * window in `previousPreserveData`, and chaining it would post a blob the new
 * host must reject: a wasted compaction round trip plus a warned fallback to
 * local compaction at exactly the moment the context is overflowing. So the
 * stored `provider`/`api` decide whether the window is chained at all.
 */
describe("a stored window chains only onto the host that minted it", () => {
	const PRIOR_ITEM = { id: "cmp_prior", type: "compaction", encrypted_content: "prior-blob" };

	function preparationWithStoredWindow(provider: string, api: string): CompactionPreparation {
		return makePreparation({
			previousSummary: "prior summary",
			previousPreserveData: {
				[REMOTE_COMPACTION_PRESERVE_KEY]: {
					version: 1,
					provider,
					api,
					model: "gpt-5.1",
					window: [PRIOR_ITEM],
					compactedAt: new Date().toISOString(),
				},
			},
		});
	}

	// Always compacts on openai/gpt-5.1, so the stored identity is the only variable.
	async function compactAndReadInput(provider: string, api: string): Promise<unknown[]> {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(makeAssistantStop("summary"));
		const calls = mockCompactFetch();
		await compactWithProvider(preparationWithStoredWindow(provider, api), getOpenAIModel(), "test-key");
		expect(calls).toHaveLength(1);
		const input = calls[0].body.input;
		// The posted body is JSON this test just parsed, so prove the shape here
		// rather than asserting it: a malformed body must fail loudly, not read
		// as an empty input that trivially satisfies every "not chained" check.
		if (!Array.isArray(input)) throw new Error(`Expected an input array on the compact body, got ${typeof input}`);
		return input;
	}

	test("a window minted by a different provider is dropped, not posted to this host", async () => {
		const input = await compactAndReadInput("azure", "azure-openai-responses");

		expect(input).not.toContainEqual(PRIOR_ITEM);
		expect(JSON.stringify(input)).not.toContain("prior-blob");
		// The span itself still goes up; only the foreign window is withheld.
		expect(JSON.stringify(input)).toContain("history msg");
	});

	test("a window minted by a different api on the same provider is dropped", async () => {
		const input = await compactAndReadInput("openai", "openai-codex-responses");

		expect(input).not.toContainEqual(PRIOR_ITEM);
		expect(JSON.stringify(input)).not.toContain("prior-blob");
	});

	test("a window minted by this same provider and api is chained ahead of the span", async () => {
		const input = await compactAndReadInput("openai", "openai-responses");

		expect(input[0]).toEqual(PRIOR_ITEM);
		expect(input.length).toBeGreaterThan(1);
	});
});

describe("the local path never carries a stale remote window forward", () => {
	test("compact() strips the remote key but keeps unrelated preserve data", async () => {
		vi.spyOn(ai, "completeSimple").mockResolvedValue(makeAssistantStop("fresh local summary"));

		const result = await compact(
			makePreparation({
				previousPreserveData: {
					[REMOTE_COMPACTION_PRESERVE_KEY]: {
						version: 1,
						provider: "openai",
						api: "openai-responses",
						model: "gpt-5.1",
						window: [{ id: "cmp_prior", type: "compaction", encrypted_content: "prior-blob" }],
						compactedAt: new Date().toISOString(),
					},
					somethingElse: "kept",
				},
			}),
			getOpenAIModel(),
			"test-key",
		);

		expect(result.preserveData?.[REMOTE_COMPACTION_PRESERVE_KEY]).toBeUndefined();
		expect(result.preserveData?.somethingElse).toBe("kept");
	});
});

describe("entry payload validation", () => {
	test("malformed payloads degrade to no payload, never to a bad replay", () => {
		expect(getRemoteCompactionPreserveData(undefined)).toBeUndefined();
		expect(getRemoteCompactionPreserveData({ [REMOTE_COMPACTION_PRESERVE_KEY]: { version: 2 } })).toBeUndefined();
		expect(
			getRemoteCompactionPreserveData({
				[REMOTE_COMPACTION_PRESERVE_KEY]: {
					version: 1,
					provider: "openai",
					api: "openai-responses",
					model: "gpt-5.1",
					window: [{ type: "message", role: "user", content: [] }],
					compactedAt: "now",
				},
			}),
		).toBeUndefined();
		expect(remoteCompactionProviderPayload(undefined)).toBeUndefined();
	});
});
