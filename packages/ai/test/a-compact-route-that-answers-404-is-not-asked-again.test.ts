import { afterEach, describe, expect, test } from "bun:test";
import type { Api, Model } from "@veyyon/ai";
import {
	openAIResponsesServerCompaction,
	resetServerCompactionRouteCache,
	resolveServerCompactionTransport,
	SERVER_COMPACTION_WIRE_APIS,
} from "@veyyon/ai/providers/openai-compaction";
import { buildModel } from "@veyyon/catalog/build";
import type { FetchImpl } from "@veyyon/utils";

/**
 * WHY: a real run compacted on a ChatGPT Codex model and every compaction
 * answered 404 with `{"detail":"Not Found"}`: one request, one warning, one
 * fallback, repeated for the whole session. The cause was the route. Veyyon
 * posted to `POST /responses/compact`, the v1 remote-compaction route, which
 * the Codex backend has retired; it serves v2, an ordinary `POST /responses`
 * marked as a compaction by its client metadata. The capability flag can only
 * predict support from the host; a 404 is the host answering the question, and
 * that answer was being thrown away.
 *
 * The class this closes: a permanent negative from the compact route being
 * treated as a transient failure. It covers every non-2xx status, not the one
 * that was reported, so a sibling status is not quietly given the same
 * treatment — 401, 429 and 500 must stay retryable, because a credential, a
 * rate limit and an outage all resolve on their own.
 *
 * What it does NOT catch: a host that starts serving the route mid-process.
 * The negative is process-scoped and never persisted, so it clears on the next
 * launch, but this run will not notice.
 */

/** The live v2 route. The recorded 404 came from the retired v1 one below. */
const CODEX_COMPACT_URL = "https://chatgpt.com/backend-api/codex/responses";
const RETIRED_COMPACT_URL = "https://chatgpt.com/backend-api/codex/responses/compact";
const RECORDED_404_BODY = '{"detail":"Not Found"}';
function codexModel(id = "gpt-test-codex"): Model<Api> {
	// Built through the real catalog path so `supportsServerCompaction` is the
	// resolved host capability rather than a value the test asserts into place.
	return buildModel({
		id,
		name: id,
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
	}) as Model<Api>;
}

function respondWith(status: number, statusText: string, body: string): { fetch: FetchImpl; calls: string[] } {
	const calls: string[] = [];
	const impl: FetchImpl = async (input: string | URL | Request) => {
		calls.push(typeof input === "string" ? input : input.toString());
		return new Response(body, { status, statusText, headers: { "content-type": "application/json" } });
	};
	return { fetch: impl, calls };
}

async function compactOnce(model: Model<Api>, impl: FetchImpl): Promise<Error | undefined> {
	try {
		await openAIResponsesServerCompaction.compact({
			model,
			messages: [{ role: "user", content: "compact this span", timestamp: Date.now() }],
			apiKey: "test-access-token",
			fetch: impl,
		});
		return undefined;
	} catch (error) {
		return error as Error;
	}
}

afterEach(() => {
	resetServerCompactionRouteCache();
});

describe("a compact route that answers 404", () => {
	test("reports the model it is unavailable for, not a bare failure", async () => {
		const model = codexModel();
		const { fetch: impl, calls } = respondWith(404, "Not Found", RECORDED_404_BODY);

		const error = await compactOnce(model, impl);

		expect(calls).toEqual([CODEX_COMPACT_URL]);
		// The recorded defect, as a standing negative: this is the route that
		// produced the 404, and nothing may post to it again.
		expect(calls).not.toContain(RETIRED_COMPACT_URL);
		expect(error?.message).toBe(
			"Server-side compaction is not available for openai-codex/gpt-test-codex (404 Not Found)",
		);
	});

	test("stops resolving a transport for that model, so no second request is made", async () => {
		const model = codexModel();
		expect(resolveServerCompactionTransport(model)).toBe(openAIResponsesServerCompaction);

		const { fetch: impl, calls } = respondWith(404, "Not Found", RECORDED_404_BODY);
		await compactOnce(model, impl);

		expect(resolveServerCompactionTransport(model)).toBeUndefined();
		expect(calls).toHaveLength(1);
	});

	test("disables only the model that answered, not every model on the host", async () => {
		const answered = codexModel("gpt-test-codex");
		const sibling = codexModel("gpt-test-codex-mini");
		const { fetch: impl } = respondWith(404, "Not Found", RECORDED_404_BODY);

		await compactOnce(answered, impl);

		expect(resolveServerCompactionTransport(answered)).toBeUndefined();
		expect(resolveServerCompactionTransport(sibling)).toBe(openAIResponsesServerCompaction);
	});

	test("clearing the cache restores the declared capability", async () => {
		const model = codexModel();
		const { fetch: impl } = respondWith(404, "Not Found", RECORDED_404_BODY);
		await compactOnce(model, impl);
		expect(resolveServerCompactionTransport(model)).toBeUndefined();

		resetServerCompactionRouteCache();

		expect(resolveServerCompactionTransport(model)).toBe(openAIResponsesServerCompaction);
	});
});

describe("a compact route that fails for a reason that resolves on its own", () => {
	test.each([
		[401, "Unauthorized", '{"error":"invalid_token"}'],
		[403, "Forbidden", '{"error":"forbidden"}'],
		[429, "Too Many Requests", '{"error":"rate_limited"}'],
		[500, "Internal Server Error", '{"error":"server_error"}'],
		[503, "Service Unavailable", '{"error":"unavailable"}'],
	])("keeps the transport after %i so the next compaction retries", async (status, statusText, body) => {
		const model = codexModel(`gpt-test-codex-${status}`);
		const { fetch: impl } = respondWith(status, statusText, body);

		const error = await compactOnce(model, impl);

		expect(error?.message).toBe(`Server-side compaction failed (${status} ${statusText})`);
		expect(resolveServerCompactionTransport(model)).toBe(openAIResponsesServerCompaction);
	});
});

describe("the wire families server-side compaction is offered for", () => {
	// Pinned by exact equality. Removing a family here is how Codex compaction
	// was switched off before, and it read as a one-line cleanup.
	test("are exactly the three OpenAI Responses families", () => {
		expect(Object.keys(SERVER_COMPACTION_WIRE_APIS).sort()).toEqual([
			"azure-openai-responses",
			"openai-codex-responses",
			"openai-responses",
		]);
	});

	test("a model outside those families resolves no transport even when its compat says yes", () => {
		const chatModel = { ...codexModel(), api: "openai-completions" } as unknown as Model<Api>;
		expect(resolveServerCompactionTransport(chatModel)).toBeUndefined();
	});

	test("a model inside those families resolves none when its compat says no", () => {
		const optedOut = { ...codexModel(), compat: { supportsServerCompaction: false } } as unknown as Model<Api>;
		expect(resolveServerCompactionTransport(optedOut)).toBeUndefined();
	});
});
