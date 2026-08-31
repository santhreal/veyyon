/**
 * DO NOT CHANGE THIS TEST WITHOUT OPERATOR PERMISSION.
 * THIS REGRESSION HAS HAPPENED 50+ TIMES.
 *
 * WHY THIS SUITE EXISTS. The ChatGPT Codex server-side compaction wire has been
 * broken and re-fixed more than fifty times. Every break looks like a tidy-up and
 * every break costs real money: when the compaction route answers 404 the session
 * falls back to LOCAL compaction, a paid summarization call that rewrites the
 * history prefix and invalidates the prompt cache, so every later turn re-pays
 * full uncached input. One broken route produced 31 compactions in one session.
 *
 * WHY IT KEPT COMING BACK. Both candidate routes have answered 404 in real runs
 * at different times, so the loop is: someone flips the path, the other 404
 * appears, someone flips it back. The path was never the whole decision. The
 * route and the `implementation` in the client metadata are ONE decision, and
 * they are set in two different packages:
 *
 *   {base}/codex/responses/compact  <->  implementation "responses_compact"
 *   {base}/codex/responses          <->  implementation "responses_compaction_v2"
 *
 * A route from one pairing sent with the other's declaration is its own 404. Half
 * a change is indistinguishable from the bug, which is why this suite drives
 * `compactWithProvider` — the production owner that joins both halves — and never
 * passes an implementation of its own. A suite that supplies the value it then
 * asserts stays green while the shipped code says the opposite.
 *
 * THE PINNED WIRE is the second pairing, and it is pinned to a live measurement
 * rather than to a document. Measured 2026-09-01 against a ChatGPT account on
 * `gpt-5.6-sol` with a valid OAuth token:
 *
 *   POST {base}/codex/responses/compact         -> 404 Not Found
 *   POST {base}/codex/responses + trigger item  -> 200, one compaction item,
 *                                                  1740-char encrypted_content
 *
 * The previous revision of this file pinned the first pairing, which is how a
 * wire the host does not serve reached production: every codex compaction 404'd
 * into a paid local pass. Re-measure before moving it again.
 *
 * WHAT THIS DOES NOT CATCH. It pins the request veyyon builds and the reply it
 * accepts; it cannot prove the live backend still serves that wire. If the host
 * changes, these tests stay green while production 404s. The operator's own run
 * is the only authority on that, and changing this suite to chase it needs the
 * operator to say so out loud.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	type CompactionPreparation,
	compactWithProvider,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	resolveServerCompactionTransport,
} from "@veyyon/agent-core/compaction";
import type { Message, Model } from "@veyyon/ai";
import { resetServerCompactionRouteCache } from "@veyyon/ai/providers/openai-compaction";
import { getBundledModel } from "@veyyon/catalog/models";
import { OPENAI_HEADERS } from "@veyyon/catalog/wire/codex";

const BANNER = "DO NOT CHANGE WITHOUT OPERATOR PERMISSION — THIS REGRESSION HAS HAPPENED 50+ TIMES";

/** The route the host serves: an ordinary streaming turn carrying a trigger item. */
const TURN_ROUTE = "https://chatgpt.com/backend-api/codex/responses";
/** The route that answers 404. Posting compaction here is the defect. */
const COMPACT_ROUTE = "https://chatgpt.com/backend-api/codex/responses/compact";

const SESSION_ID = "session-regression";

/** A ChatGPT OAuth access token is a JWT; the account id is read out of its payload. */
function codexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-regression" } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

function codexModel(): Model {
	const model = getBundledModel("openai-codex", "gpt-5.1-codex");
	if (!model) throw new Error(`${BANNER}: the bundled openai-codex row this wire is pinned to is gone`);
	return model;
}

function sse(...events: Array<Record<string, unknown>>): string {
	return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
}

const COMPACTION_ITEM = { id: "cmp_0", type: "compaction", encrypted_content: "gAAAAAB-opaque-window" };

/** A well-formed reply: the one compaction item, then the terminal event. */
const COMPACTED_STREAM = sse(
	{ type: "response.output_item.done", item: COMPACTION_ITEM },
	{ type: "response.completed", response: { usage: { input_tokens: 139, output_tokens: 438 } } },
);

interface Captured {
	url: string;
	body: Record<string, unknown>;
	headers: Record<string, string>;
}

function captureFetch(calls: Captured[], status = 200, payload: string = COMPACTED_STREAM) {
	return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const headers: Record<string, string> = {};
		for (const [name, value] of new Headers(init?.headers).entries()) headers[name.toLowerCase()] = value;
		calls.push({
			url: String(input),
			body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
			headers,
		});
		return new Response(payload, {
			status,
			headers: { "content-type": status === 200 ? "text/event-stream" : "application/json" },
		});
	};
}

function preparation(): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [
			{ role: "user", content: "history msg", timestamp: Date.now() },
			{ role: "user", content: "history msg two", timestamp: Date.now() },
		],
		turnPrefixMessages: [],
		recentMessages: [{ role: "user", content: "recent msg", timestamp: Date.now() }],
		isSplitTurn: false,
		tokensBefore: 221_568,
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS },
	};
}

/**
 * The whole production path: the engine that decides the declaration, then the
 * transport that decides the route. Nothing here supplies an implementation, so
 * every assertion below reads what the shipped code chose.
 */
async function captureAll(operationId = "op-regression"): Promise<Captured[]> {
	const calls: Captured[] = [];
	await compactWithProvider(preparation(), codexModel(), codexToken(), "base system prompt", undefined, {
		sessionId: SESSION_ID,
		codexCompaction: {
			operationId,
			trigger: "auto",
			reason: "context_limit",
			phase: "pre_turn",
			strategy: "prefix_compaction",
		},
		fetch: captureFetch(calls),
	});
	return calls;
}

async function captureOne(): Promise<Captured> {
	const calls = await captureAll();
	const call = calls[0];
	if (!call) throw new Error(`${BANNER}: the compaction engine made no server-side request at all`);
	return call;
}

function inputItems(call: Captured): Array<Record<string, unknown>> {
	return call.body.input as Array<Record<string, unknown>>;
}

/** The turn metadata the codex host reads to tell a compaction from a turn. */
function readTurnMetadata(call: Captured): { request_kind?: string; compaction?: { implementation?: string } } {
	const metadata = call.body.client_metadata as Record<string, string> | undefined;
	if (!metadata) throw new Error(`${BANNER}: no client_metadata on the compaction body`);
	return JSON.parse(metadata[OPENAI_HEADERS.TURN_METADATA]!) as {
		request_kind?: string;
		compaction?: { implementation?: string };
	};
}

async function turnMetadata(): Promise<{ request_kind?: string; compaction?: { implementation?: string } }> {
	return readTurnMetadata(await captureOne());
}

/** Drives the transport alone, for the replies the engine converts into fallback. */
async function compactDirect(
	status: number,
	payload: string,
	calls: Captured[] = [],
): Promise<{ error?: Error; window?: Array<Record<string, unknown>>; calls: Captured[] }> {
	const model = codexModel();
	const transport = resolveServerCompactionTransport(model);
	if (!transport) throw new Error(`${BANNER}: codex resolves no server-side compaction transport`);
	try {
		const result = await transport.compact({
			model,
			messages: [{ role: "user", content: "history msg" }] as Message[],
			apiKey: codexToken(),
			sessionId: SESSION_ID,
			fetch: captureFetch(calls, status, payload),
		});
		return { window: result.window, calls };
	} catch (error) {
		return { error: error as Error, calls };
	}
}

afterEach(() => {
	resetServerCompactionRouteCache();
});

describe(`the codex compaction ROUTE (${BANNER})`, () => {
	test("posts to the plain turn route, which is the route the host serves", async () => {
		expect((await captureOne()).url).toBe(TURN_ROUTE);
	});

	test("never posts to the /compact endpoint, which answers 404", async () => {
		expect((await captureOne()).url).not.toBe(COMPACT_ROUTE);
	});

	test("carries no path segment named compact", async () => {
		// `endsWith` alone would miss `/compact/responses`.
		const segments = new URL((await captureOne()).url).pathname.split("/");
		expect(segments.filter(segment => segment === "compact")).toEqual([]);
	});

	test("keeps the codex backend origin", async () => {
		expect(new URL((await captureOne()).url).origin).toBe("https://chatgpt.com");
	});

	test("keeps the backend-api/codex prefix", async () => {
		expect(new URL((await captureOne()).url).pathname).toBe("/backend-api/codex/responses");
	});
});

describe(`the codex compaction DECLARATION (${BANNER})`, () => {
	test("declares responses_compaction_v2, the pairing for this route", async () => {
		expect((await turnMetadata()).compaction?.implementation).toBe("responses_compaction_v2");
	});

	test("never declares the compact-route implementation on the turn route", async () => {
		expect((await turnMetadata()).compaction?.implementation).not.toBe("responses_compact");
	});

	test("marks the request as a compaction", async () => {
		expect((await turnMetadata()).request_kind).toBe("compaction");
	});

	test("sends client_metadata at all", async () => {
		expect((await captureOne()).body.client_metadata).toBeDefined();
	});

	test("declares the route it is posted to, both halves in one request", async () => {
		// The two halves are set in different packages, so each can be right while
		// the pair is wrong. This is the assertion that fails on half a change.
		const call = await captureOne();
		expect([
			new URL(call.url).pathname.endsWith("/compact"),
			readTurnMetadata(call).compaction?.implementation,
		]).toEqual([false, "responses_compaction_v2"]);
	});
});

describe(`the codex compaction BODY (${BANNER})`, () => {
	test("is a streaming request", async () => {
		// A body without `stream: true` is rejected with 400
		// `{"detail":"Stream must be set to true"}`.
		expect((await captureOne()).body.stream).toBe(true);
	});

	test("appends exactly one compaction_trigger input item", async () => {
		// The trigger item is what makes the backend compact instead of answering
		// the span as an ordinary paid turn. Two would be ambiguous.
		const triggers = inputItems(await captureOne()).filter(item => item?.type === "compaction_trigger");
		expect(triggers).toEqual([{ type: "compaction_trigger" }]);
	});

	test("puts the trigger last, after the span it compacts", async () => {
		const input = inputItems(await captureOne());
		expect(input.at(-1)?.type).toBe("compaction_trigger");
	});

	test("sends the span itself, not only the trigger", async () => {
		// A trigger with no span compacts nothing and still costs a call.
		const input = inputItems(await captureOne());
		expect(input.filter(item => item?.type !== "compaction_trigger").length).toBeGreaterThan(0);
	});

	test("does not store the compaction turn", async () => {
		expect((await captureOne()).body.store).toBe(false);
	});

	test("names the codex wire model", async () => {
		expect((await captureOne()).body.model).toBe(codexModel().id);
	});
});

describe(`the codex compaction REPLY (${BANNER})`, () => {
	test("reads the stream and returns a window ending in the compaction item", async () => {
		const { error, window } = await compactDirect(200, COMPACTED_STREAM);
		expect(error).toBeUndefined();
		expect(window?.at(-1)).toMatchObject({ type: "compaction" });
	});

	test("rejects a stream with no compaction item rather than claiming success", async () => {
		// Zero means the trigger did not take and the host answered the span as an
		// ordinary turn: the history is NOT compacted and the caller must fall back.
		const { error } = await compactDirect(
			200,
			sse(
				{ type: "response.output_item.done", item: { type: "message", role: "assistant" } },
				{ type: "response.completed", response: {} },
			),
		);
		expect(error?.message).toContain("expected exactly one");
	});

	test("rejects a stream with two compaction items rather than picking one", async () => {
		// Which blob supersedes which span is not recoverable, and storing the wrong
		// one silently drops history.
		const { error } = await compactDirect(
			200,
			sse(
				{ type: "response.output_item.done", item: COMPACTION_ITEM },
				{ type: "response.output_item.done", item: { ...COMPACTION_ITEM, id: "cmp_1" } },
				{ type: "response.completed", response: {} },
			),
		);
		expect(error?.message).toContain("expected exactly one");
	});

	test("rejects a stream that ends before response.completed", async () => {
		// A truncated stream can carry the item and still be a partial window.
		const { error } = await compactDirect(200, sse({ type: "response.output_item.done", item: COMPACTION_ITEM }));
		expect(error?.message).toContain("before response.completed");
	});

	test("surfaces a response.failed event instead of returning an empty window", async () => {
		const { error } = await compactDirect(
			200,
			sse({ type: "response.failed", response: { error: { code: "server_error", message: "boom" } } }),
		);
		expect(error?.message).toContain("server_error");
	});
});

/**
 * The compaction posts to the SAME route as a turn, so it shares the cache
 * identity of the session it belongs to. If it did not, the compaction would
 * open a second cache lineage and the next turn would re-pay full uncached
 * input — the exact cost the whole feature exists to avoid.
 */
describe(`the codex compaction CACHE IDENTITY (${BANNER})`, () => {
	test("carries the session's conversation id, so it shares the turn's cache lineage", async () => {
		expect((await captureOne()).headers[OPENAI_HEADERS.CONVERSATION_ID.toLowerCase()]).toBe(SESSION_ID);
	});

	test("carries the session id, not a per-compaction identifier", async () => {
		expect((await captureOne()).headers[OPENAI_HEADERS.SESSION_ID.toLowerCase()]).toBe(SESSION_ID);
	});

	test("two compactions of the same session keep one cache lineage", async () => {
		// A fresh identifier per compaction is cache busting even when every single
		// request looks correct on its own.
		const first = await captureOne();
		const second = await captureOne();
		expect(second.headers[OPENAI_HEADERS.CONVERSATION_ID.toLowerCase()]).toBe(
			first.headers[OPENAI_HEADERS.CONVERSATION_ID.toLowerCase()],
		);
	});

	test("does not ask the host to store the turn, which would fork the lineage", async () => {
		expect((await captureOne()).body.store).toBe(false);
	});
	test("sends the prompt_cache_key a turn sends, so it lands on the session's cached prefix", async () => {
		// A compaction body with no `prompt_cache_key` is a cache miss on the
		// session's own prefix, and the turn after it re-pays full uncached input.
		expect((await captureOne()).body.prompt_cache_key).toBe(SESSION_ID);
	});

	test("prefers the session's own cache key over the session id when they differ", async () => {
		// The agent may key its cache on something other than the session id
		// (`promptCacheKey ?? sessionId` is what a turn uses). A compaction that
		// keyed on the session id alone would open a second lineage beside it.
		const calls: Captured[] = [];
		await compactWithProvider(preparation(), codexModel(), codexToken(), "base system prompt", undefined, {
			sessionId: SESSION_ID,
			promptCacheKey: "the-turns-cache-key",
			fetch: captureFetch(calls),
		});
		expect(calls[0]?.body.prompt_cache_key).toBe("the-turns-cache-key");
		// The conversation identity stays the session's; only the cache key moves.
		expect(calls[0]?.headers[OPENAI_HEADERS.CONVERSATION_ID.toLowerCase()]).toBe(SESSION_ID);
	});

	test("refuses to compact without a session id rather than minting a new lineage", async () => {
		// No session id means no conversation to ride: the old code minted a
		// random one, which is a fresh cache lineage AND a post-compaction reset
		// that silently finds nothing. Falling back to local compaction is worse
		// than a cache hit and better than a silent fork, so it must not request.
		const calls: Captured[] = [];
		await compactWithProvider(preparation(), codexModel(), codexToken(), "base system prompt", undefined, {
			fetch: captureFetch(calls),
		}).catch(() => undefined);
		expect(calls).toEqual([]);
	});
});

/**
 * One logical compaction is one paid provider call. Every extra call is money,
 * and a retry that re-sends the span is also a second compaction of the same
 * history, whose window silently replaces the first.
 */
describe(`the codex compaction SINGLE CALL (${BANNER})`, () => {
	test("issues exactly one request when it succeeds", async () => {
		expect((await captureAll()).length).toBe(1);
	});

	test("issues exactly one request when the route answers 404", async () => {
		const { calls } = await compactDirect(404, JSON.stringify({ detail: "Not Found" }));
		expect(calls.length).toBe(1);
	});

	test("issues exactly one request when the host rejects the body", async () => {
		const { calls } = await compactDirect(400, JSON.stringify({ detail: "Stream must be set to true" }));
		expect(calls.length).toBe(1);
	});

	test("does not retry a stream that produced no compaction item", async () => {
		// Retrying here would pay twice to learn the same thing; the caller's local
		// pass is the fallback, not a second remote attempt.
		const { calls } = await compactDirect(200, sse({ type: "response.completed", response: {} }));
		expect(calls.length).toBe(1);
	});

	test("does not retry a truncated stream", async () => {
		const { calls } = await compactDirect(200, sse({ type: "response.output_item.done", item: COMPACTION_ITEM }));
		expect(calls.length).toBe(1);
	});
});

describe(`the codex compaction 404 STAND-DOWN (${BANNER})`, () => {
	test("names the provider, the model and the code when the route is absent", async () => {
		// The status text is the runtime's, not the wire's; the provider, model and
		// code are what distinguishes a dead route from a token failure in a log.
		const { error } = await compactDirect(404, JSON.stringify({ detail: "Not Found" }));
		expect(error?.message).toStartWith(
			`Server-side compaction is not available for openai-codex/${codexModel().id} (404`,
		);
	});

	test("asks once, then stops resolving a transport for that model", async () => {
		await compactDirect(404, JSON.stringify({ detail: "Not Found" }));
		// A 404 is the host answering the capability question. Re-asking once per
		// compaction is what turned one broken route into a session of paid local
		// fallbacks; the latch is what bounds it.
		expect(resolveServerCompactionTransport(codexModel())).toBeUndefined();
	});

	test("re-arms after its window, so one bad 404 does not force local compaction forever", async () => {
		// The stand-down used to last the whole process. A proxy that answers 404
		// while it reloads then costs a paid LOCAL compaction on every compaction
		// for the rest of the run, which is the drain the latch was meant to stop.
		await compactDirect(404, JSON.stringify({ detail: "Not Found" }));
		expect(resolveServerCompactionTransport(codexModel())).toBeUndefined();

		const realNow = Date.now();
		const clock = spyOn(Date, "now").mockReturnValue(realNow + 31 * 60_000);
		try {
			expect(resolveServerCompactionTransport(codexModel())).toBeDefined();
		} finally {
			clock.mockRestore();
		}
	});

	test("still stands down inside the window", async () => {
		await compactDirect(404, JSON.stringify({ detail: "Not Found" }));
		const realNow = Date.now();
		const clock = spyOn(Date, "now").mockReturnValue(realNow + 29 * 60_000);
		try {
			expect(resolveServerCompactionTransport(codexModel())).toBeUndefined();
		} finally {
			clock.mockRestore();
		}
	});
});
