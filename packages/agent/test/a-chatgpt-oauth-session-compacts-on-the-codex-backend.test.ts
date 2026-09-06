/**
 * DO NOT CHANGE THIS TEST WITHOUT OPERATOR PERMISSION.
 * THIS REGRESSION HAS HAPPENED 50+ TIMES.
 *
 * A ChatGPT OAuth (codex) session compacts server-side, on the wire the host
 * actually serves.
 *
 * WHY: `compaction.remote` defaults on. When the compaction route answers 404
 * the transport stands down and every later compaction is a paid LOCAL pass
 * that rewrites the history prefix and invalidates the prompt cache, so the
 * session re-pays full uncached input on every turn afterwards. One such
 * session compacted 31 times.
 *
 * THE PINNED WIRE, measured live on 2026-09-01 against a ChatGPT account on
 * `gpt-5.6-sol`: a STREAMING `POST {base}/codex/responses` whose last input item
 * is `{ type: "compaction_trigger" }` and whose client metadata declares
 * `implementation: "responses_compaction_v2"`, answered with an SSE stream
 * carrying exactly one `compaction` output item. In the same measurement
 * `{base}/codex/responses/compact` answered `404 Not Found`.
 *
 * WHY THE FILE READS AS A REVERSAL. This suite previously pinned the opposite
 * wire — a non-streaming `POST {base}/codex/responses/compact` declared
 * `responses_compact` — and that is how a wire the host does not serve reached
 * production: every codex compaction 404'd into a paid local pass. Both
 * observations behind the flip-flopping are real and dated, which is why the
 * pairing may only move as a pair. The two halves are set in two packages:
 *
 *   {base}/codex/responses/compact  <->  responses_compact
 *   {base}/codex/responses          <->  responses_compaction_v2
 *
 * A route from one pairing sent with the other's declaration is its own 404,
 * which is how a half-applied flip looks exactly like the bug it was meant to
 * fix. `packages/ai/src/providers/openai-compaction.ts` is hash-locked by
 * `scripts/the-codex-compaction-route-is-locked.test.ts` so neither half can
 * move without the change being recorded.
 *
 * WHAT CLASS THIS CLOSES: the mock agreeing with the code instead of with the
 * host. `codexBackend()` is a fake of the host, not of our request. It answers
 * `/compact` with the 404 the host answers, rejects a non-streaming body the
 * way the host rejects one, and answers a turn-route request that carries no
 * trigger item with ordinary prose and no compaction item — which is what the
 * route does. Every assertion therefore fails against the previous wire for the
 * reason that wire is wrong here.
 *
 * WHAT IT DOES NOT CATCH: a change in what the backend does. Only a live call
 * can tell that the host moved again, and when it does, the fix is to move the
 * route AND the declaration together and re-record the lock hash — not to edit
 * one assertion until this file is green.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import {
	type CompactionPreparation,
	compactWithProvider,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	resolveServerCompactionTransport,
} from "@veyyon/agent-core/compaction";
import type { AssistantMessage, Model } from "@veyyon/ai";
import { resetServerCompactionRouteCache } from "@veyyon/ai/providers/openai-compaction";
import { buildOpenAIResponsesCompat } from "@veyyon/catalog/compat/openai";
import { getBundledModel } from "@veyyon/catalog/models";
import type { ResolvedOpenAIResponsesCompat } from "@veyyon/catalog/types";
import { OPENAI_HEADERS } from "@veyyon/catalog/wire/codex";

/** The route the host serves compaction on: the ordinary turn route. */
// A compaction rides a live conversation, so the transport requires the session
// id every production caller passes.
const CODEX_SESSION_ID = "codex-oauth-session";
const TURN_ROUTE = "https://chatgpt.com/backend-api/codex/responses";

/** A ChatGPT OAuth access token is a JWT; the account id is read out of its payload. */
function fakeCodexToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

function makeAssistantStop(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		stopReason: "stop",
		api: "openai-completions",
		provider: "openai-codex",
		model: "gpt-5.1-codex",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function makeUserMessage(text: string, timestamp = Date.now()): AgentMessage {
	return { role: "user", content: text, timestamp };
}

function codexModel(): Model {
	const model = getBundledModel("openai-codex", "gpt-5.1-codex");
	if (!model) throw new Error("Expected built-in openai-codex/gpt-5.1-codex to exist");
	return model;
}

function makePreparation(): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [makeUserMessage("history msg"), makeAssistantStop("history reply")],
		turnPrefixMessages: [],
		recentMessages: [makeUserMessage("recent msg")],
		isSplitTurn: false,
		tokensBefore: 221_568,
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS },
	};
}

/** The compaction item the backend returns, with its blob replaced. */
const COMPACTION_ITEM = {
	id: "cmp_001",
	type: "compaction",
	encrypted_content: "gAAAAABpM0Yj-fake",
};

const USAGE = { input_tokens: 139, output_tokens: 438, total_tokens: 577 };

function json(payload: unknown, status = 200, statusText?: string): Response {
	return new Response(JSON.stringify(payload), {
		status,
		statusText,
		headers: { "content-type": "application/json" },
	});
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
	return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

interface CapturedCall {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

/**
 * A fake of the ChatGPT Codex backend, not of our request. It answers the way
 * the host serving the pinned wire answers, including each refusal.
 */
function codexBackend(options?: { items?: unknown[] }): CapturedCall[] {
	const calls: CapturedCall[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				const headers: Record<string, string> = {};
				for (const [name, value] of new Headers(init?.headers).entries()) headers[name.toLowerCase()] = value;
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				calls.push({ url: String(input), headers, body });

				if (String(input).endsWith("/compact")) {
					// The host does not serve this route. Posting here is the defect,
					// and the 404 is what turns the session over to paid local passes.
					return json({ detail: "Not Found" }, 404, "Not Found");
				}
				if (body.stream !== true) {
					return json({ detail: "Stream must be set to true" }, 400, "Bad Request");
				}
				const items = Array.isArray(body.input) ? body.input : [];
				if (!items.some(item => !!item && typeof item === "object" && item.type === "compaction_trigger")) {
					// Without the trigger the route runs the span as an ordinary paid
					// turn and answers prose. A reader that accepts this claims a
					// compaction that never happened and replays the span forever.
					return sseResponse([
						{
							type: "response.output_item.done",
							item: {
								id: "msg_0",
								type: "message",
								role: "assistant",
								content: [{ type: "output_text", text: "The conversation references history msg." }],
							},
						},
						{ type: "response.completed", response: { usage: USAGE } },
					]);
				}
				return sseResponse([
					...(options?.items ?? [COMPACTION_ITEM]).map(item => ({ type: "response.output_item.done", item })),
					{ type: "response.completed", response: { status: "completed", output: [], usage: USAGE } },
				]);
			},
			{ preconnect: fetch.preconnect },
		),
	);
	return calls;
}

function remoteWindow(result: { preserveData?: Record<string, unknown> }): Array<Record<string, unknown>> | undefined {
	const preserved = result.preserveData?.remoteCompaction;
	if (!preserved || typeof preserved !== "object" || !("window" in preserved)) return undefined;
	const window = preserved.window;
	return Array.isArray(window) ? window : undefined;
}

afterEach(() => {
	vi.restoreAllMocks();
	// The route-absent stand-down is module-level state. A 404 reached in this
	// file otherwise makes every later file resolve no transport for this model,
	// which is a failure that appears only in a full-suite run.
	resetServerCompactionRouteCache();
});

describe("a ChatGPT OAuth session compacts on the codex backend", () => {
	test("the bundled codex row declares the capability and resolves the transport", () => {
		const compat = codexModel().compat as ResolvedOpenAIResponsesCompat;
		expect(compat.supportsServerCompaction).toBe(true);
		expect(resolveServerCompactionTransport(codexModel())).toBeDefined();
	});

	test("posts the span to the turn route with the ChatGPT credential and identity", async () => {
		const calls = codexBackend();
		const token = fakeCodexToken("acct-9");

		const result = await compactWithProvider(
			makePreparation(),
			codexModel(),
			token,
			"base system prompt",
			undefined,
			{
				sessionId: "session-compact-1",
			},
		);

		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(call.url).toBe(TURN_ROUTE);
		expect(call.headers.authorization).toBe(`Bearer ${token}`);
		expect(call.headers[OPENAI_HEADERS.ACCOUNT_ID.toLowerCase()]).toBe("acct-9");
		expect(call.headers[OPENAI_HEADERS.ORIGINATOR.toLowerCase()]).toBeDefined();
		// The installation header is the one a direct codex call requires.
		expect(call.headers[OPENAI_HEADERS.INSTALLATION_ID.toLowerCase()]).toBeDefined();
		expect(call.headers["content-type"]).toBe("application/json");
		// The route is streaming-only, so the request builder asks for SSE.
		expect(call.headers.accept).toBe("text/event-stream");
		expect(result.summary).toBe("");
	});

	test("never posts compaction to the /compact route, which answers 404", async () => {
		const calls = codexBackend();

		await compactWithProvider(
			makePreparation(),
			codexModel(),
			fakeCodexToken("acct-9"),
			"base system prompt",
			undefined,
			{
				sessionId: CODEX_SESSION_ID,
			},
		);

		expect(calls.map(call => call.url).filter(url => url.endsWith("/compact"))).toEqual([]);
	});

	test("the body streams and carries exactly one trigger item, last", async () => {
		const calls = codexBackend();

		await compactWithProvider(
			makePreparation(),
			codexModel(),
			fakeCodexToken("acct-9"),
			"base system prompt",
			undefined,
			{
				sessionId: CODEX_SESSION_ID,
			},
		);

		const body = calls[0]!.body;
		expect(body.model).toBe(codexModel().id);
		expect(body.store).toBe(false);
		expect(body.stream).toBe(true);
		expect(body.client_metadata).toBeDefined();
		expect(body.instructions).toBe("base system prompt");
		const input = body.input as Array<Record<string, unknown>>;
		expect(input.filter(item => item.type === "compaction_trigger")).toEqual([{ type: "compaction_trigger" }]);
		expect(input.at(-1)?.type).toBe("compaction_trigger");
		// The span itself is what gets sent, never a marker standing in for it.
		expect(input.some(item => item.role === "user")).toBe(true);
	});

	test("the request declares the route it is posted to", async () => {
		// The two halves are set in different packages, so each can be right
		// while the pair is wrong. This is the assertion that fails on half a flip.
		//
		// The codex context is supplied because every production entry supplies it
		// before reaching the transport (`agent-session.ts` builds one at each of
		// the manual, automatic and overflow entries).
		const calls = codexBackend();

		await compactWithProvider(
			makePreparation(),
			codexModel(),
			fakeCodexToken("acct-9"),
			"base system prompt",
			undefined,
			{
				sessionId: "session-declaration",
				codexCompaction: {
					operationId: "op-declaration",
					trigger: "auto",
					reason: "context_limit",
					phase: "pre_turn",
					strategy: "prefix_compaction",
				},
			},
		);

		const metadata = calls[0]!.body.client_metadata as Record<string, string>;
		const turn = JSON.parse(metadata[OPENAI_HEADERS.TURN_METADATA]!) as {
			request_kind?: string;
			compaction?: { implementation?: string };
		};
		expect(turn.request_kind).toBe("compaction");
		expect(turn.compaction?.implementation).toBe("responses_compaction_v2");
	});

	test("the stored window is the retained user messages followed by the compaction item", async () => {
		codexBackend();

		const result = await compactWithProvider(
			makePreparation(),
			codexModel(),
			fakeCodexToken("acct-9"),
			"base system prompt",
			undefined,
			{ sessionId: CODEX_SESSION_ID },
		);

		const window = remoteWindow(result);
		expect(window).toBeDefined();
		expect(window?.at(-1)).toEqual(COMPACTION_ITEM);
		expect(window?.length).toBeGreaterThan(1);
		const retained = window!.slice(0, -1);
		expect(retained.every(item => item.role === "user")).toBe(true);
		expect(JSON.stringify(retained)).toContain("history msg");
		// Replaying the trigger would compact on every turn.
		expect(retained.some(item => item.type === "compaction_trigger")).toBe(false);
	});

	test("a stream carrying no compaction item compacts nothing", async () => {
		// What the route answers when the trigger did not take: real output items,
		// none of them a compaction. Storing that window would claim a compaction
		// that did not happen.
		codexBackend({ items: [{ id: "msg_1", type: "message", role: "assistant", content: [] }] });

		await expect(
			compactWithProvider(
				makePreparation(),
				codexModel(),
				fakeCodexToken("acct-9"),
				"base system prompt",
				undefined,
				{
					sessionId: CODEX_SESSION_ID,
				},
			),
		).rejects.toThrow(/expected exactly one/);
	});

	test("a stream carrying two compaction items is refused rather than picking one", async () => {
		// Which blob supersedes which span is not recoverable from the stream.
		codexBackend({ items: [COMPACTION_ITEM, { ...COMPACTION_ITEM, id: "cmp_002" }] });

		await expect(
			compactWithProvider(
				makePreparation(),
				codexModel(),
				fakeCodexToken("acct-9"),
				"base system prompt",
				undefined,
				{
					sessionId: CODEX_SESSION_ID,
				},
			),
		).rejects.toThrow(/expected exactly one/);
	});

	test("an empty stream is a failure, not an empty window", async () => {
		codexBackend({ items: [] });

		await expect(
			compactWithProvider(
				makePreparation(),
				codexModel(),
				fakeCodexToken("acct-9"),
				"base system prompt",
				undefined,
				{
					sessionId: CODEX_SESSION_ID,
				},
			),
		).rejects.toThrow(/expected exactly one/);
	});

	test("a stream that ends before response.completed is a failure, not a short window", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async () =>
					new Response(
						`data: ${JSON.stringify({ type: "response.output_item.done", item: COMPACTION_ITEM })}\n\n`,
						{
							status: 200,
							headers: { "content-type": "text/event-stream" },
						},
					),
				{ preconnect: fetch.preconnect },
			),
		);

		await expect(
			compactWithProvider(
				makePreparation(),
				codexModel(),
				fakeCodexToken("acct-9"),
				"base system prompt",
				undefined,
				{
					sessionId: CODEX_SESSION_ID,
				},
			),
		).rejects.toThrow(/before response.completed/);
	});

	test("a lite codex row moves the instructions into a developer item and pins all_turns replay", async () => {
		// A real bundled lite row, not a flag flipped onto another row: lite is
		// refused for a model that cannot be sent `all_turns` reasoning context,
		// so a hand-built spec would prove the opposite of what it claims.
		const lite = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!lite) throw new Error("Expected built-in openai-codex/gpt-5.6-sol to exist");
		expect(lite.useResponsesLite).toBe(true);
		const calls = codexBackend();

		await compactWithProvider(makePreparation(), lite, fakeCodexToken("acct-9"), "base system prompt", undefined, {
			sessionId: CODEX_SESSION_ID,
		});

		const body = calls[0]!.body;
		expect(body.instructions).toBeUndefined();
		// The lite marker header and this value are one contract; the host
		// answers a lite request without it with 400 `unsupported_value`.
		expect(body.reasoning).toMatchObject({ context: "all_turns" });
		expect(body.include).toEqual(["reasoning.encrypted_content"]);
		const input = body.input as Array<Record<string, unknown>>;
		expect(input[0]?.type).toBe("additional_tools");
		expect(input[1]).toMatchObject({
			type: "message",
			role: "developer",
			content: [{ type: "input_text", text: "base system prompt" }],
		});
		// The lite rewrite prepends to a new array; the trigger must survive it and
		// stay last, or the host runs the span as an ordinary paid turn.
		expect(input.filter(item => item.type === "compaction_trigger")).toEqual([{ type: "compaction_trigger" }]);
		expect(input.at(-1)?.type).toBe("compaction_trigger");
	});

	test("a row that cannot take all_turns reasoning keeps top-level instructions even with the lite flag on", async () => {
		// The transport marker and `reasoning.context: "all_turns"` are one
		// decision: the backend refuses the marker without that context, so a
		// pre-5.4 codex row stays on the full transport however it is flagged.
		const flagged: Model = { ...codexModel(), useResponsesLite: true };
		const calls = codexBackend();

		await compactWithProvider(makePreparation(), flagged, fakeCodexToken("acct-9"), "base system prompt", undefined, {
			sessionId: CODEX_SESSION_ID,
		});

		expect(calls[0]!.body.instructions).toBe("base system prompt");
	});

	test("opening codex does not open every Responses host", () => {
		// A repointed `openai` row: the same api family, a host that does not
		// serve the route.
		const official = getBundledModel("openai", "gpt-5.1");
		if (!official) throw new Error("Expected built-in openai/gpt-5.1 to exist");
		const proxied: Model = {
			...official,
			baseUrl: "https://proxy.example.com/v1",
			compat: buildOpenAIResponsesCompat({
				provider: "openai",
				name: "GPT-5.1 via proxy",
				baseUrl: "https://proxy.example.com/v1",
			}),
		};
		expect(resolveServerCompactionTransport(proxied)).toBeUndefined();

		const anthropic = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!anthropic) throw new Error("Expected built-in anthropic/claude-sonnet-4-5 to exist");
		expect(resolveServerCompactionTransport(anthropic)).toBeUndefined();
	});
});
