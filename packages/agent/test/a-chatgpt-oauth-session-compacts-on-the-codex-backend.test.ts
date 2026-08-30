/**
 * A ChatGPT OAuth (codex) session compacts server-side, on the wire codex-rs
 * itself uses.
 *
 * WHY: `compaction.remote` defaults on, and every gate below it was written for
 * the API-key OpenAI host, whose compact route is `POST {base}/responses/compact`
 * answering with one JSON document. The Codex backend serves no compact route —
 * that path, `{base}/codex/compact` and `{base}/responses/compact` all answer
 * 404 — and compacts through an input item instead: an ordinary STREAMING
 * `POST {base}/codex/responses` whose last input item is
 * `{ type: "compaction_trigger" }`, answered with exactly one `compaction`
 * output item on `response.output_item.done`.
 *
 * Three defects shipped because this suite asserted the OpenAI-host shape
 * instead. It pinned `body.stream` as undefined, so the backend's
 * `{"detail":"Stream must be set to true"}` 400 was invisible. It never sent a
 * trigger item, so once the 400 was fixed the backend ran the span as an
 * ordinary turn and answered with prose. And it read the window off
 * `response.completed`, which on this host carries an empty `output`.
 *
 * WHAT CLASS THIS CLOSES: the mock agreeing with the code instead of with the
 * host. `codexBackend()` below is a fake of the REAL backend, not of our
 * request: it rejects a non-streaming body with the recorded 400, answers a
 * body with no trigger item the way the host does (a reasoning item and a
 * message, no compaction item), and only streams a compaction item for a
 * request shaped the way the host requires. Every assertion here therefore
 * fails against each of the three pre-fix states, for the reason that state was
 * wrong. It also pins the negative side, because opening a gate is how a gate
 * stops meaning anything — a repointed proxy row and a non-Responses api must
 * still resolve nothing.
 *
 * WHAT IT DOES NOT CATCH: a change in what the backend does. The fake is
 * faithful to a live call made against the real host on 2026-08-29 (window of
 * retained user messages plus one compaction item, `response.completed` with an
 * empty `output`), and only another live call can tell that it drifted. It also
 * does not cover the websocket transport codex-rs can use for the same request;
 * this path is HTTP SSE only.
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
import { buildOpenAIResponsesCompat } from "@veyyon/catalog/compat/openai";
import { getBundledModel } from "@veyyon/catalog/models";
import type { ResolvedOpenAIResponsesCompat } from "@veyyon/catalog/types";
import { OPENAI_HEADERS } from "@veyyon/catalog/wire/codex";

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

/** The compaction item the live backend returns, with its blob replaced. */
const COMPACTION_ITEM = {
	id: "cmp_001",
	type: "compaction",
	encrypted_content: "gAAAAABpM0Yj-fake",
};

function sse(events: Array<Record<string, unknown>>): Response {
	const body = events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/**
 * The terminal event as the host sends it: `output` is EMPTY, so a reader that
 * takes the window from here gets nothing and a reader that collects
 * `response.output_item.done` gets the item.
 */
function completedEvent(): Record<string, unknown> {
	return {
		type: "response.completed",
		response: {
			id: "resp_codex_compaction",
			object: "response",
			status: "completed",
			output: [],
			usage: { input_tokens: 139, output_tokens: 438, total_tokens: 577 },
		},
	};
}

interface CapturedCall {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

/**
 * A fake of the ChatGPT Codex backend, not of our request. It answers the way
 * the real host answered a live call, including both refusals.
 */
function codexBackend(options?: { streamed?: Array<Record<string, unknown>> }): CapturedCall[] {
	const calls: CapturedCall[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				const headers: Record<string, string> = {};
				for (const [name, value] of new Headers(init?.headers).entries()) headers[name.toLowerCase()] = value;
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				calls.push({ url: String(input), headers, body });

				if (String(input).endsWith("/compact")) {
					return new Response('{"detail":"Not Found"}', { status: 404, statusText: "Not Found" });
				}
				if (body.stream !== true) {
					// Recorded verbatim from the live host.
					return new Response('{"detail":"Stream must be set to true"}', {
						status: 400,
						statusText: "Bad Request",
					});
				}
				const items = Array.isArray(body.input) ? body.input : [];
				const last = items.at(-1);
				const triggered =
					!!last && typeof last === "object" && "type" in last && last.type === "compaction_trigger";
				if (!triggered) {
					// What the host does with a compaction-marked request that
					// carries no trigger item: it just answers the conversation.
					return sse([
						{
							type: "response.output_item.done",
							item: { id: "rs_0", type: "reasoning", encrypted_content: "gAAA-reasoning" },
						},
						{
							type: "response.output_item.done",
							item: {
								id: "msg_0",
								type: "message",
								role: "assistant",
								content: [{ type: "output_text", text: "The conversation references history msg." }],
							},
						},
						completedEvent(),
					]);
				}
				const streamed = options?.streamed ?? [{ type: "response.output_item.done", item: COMPACTION_ITEM }];
				return sse([...streamed, completedEvent()]);
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
});

describe("a ChatGPT OAuth session compacts on the codex backend", () => {
	test("the bundled codex row declares the capability and resolves the transport", () => {
		const compat = codexModel().compat as ResolvedOpenAIResponsesCompat;
		expect(compat.supportsServerCompaction).toBe(true);
		expect(resolveServerCompactionTransport(codexModel())).toBeDefined();
	});

	test("posts the span to the codex responses route with the ChatGPT credential and identity", async () => {
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
		expect(call.url).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(call.headers.authorization).toBe(`Bearer ${token}`);
		expect(call.headers[OPENAI_HEADERS.ACCOUNT_ID.toLowerCase()]).toBe("acct-9");
		expect(call.headers[OPENAI_HEADERS.ORIGINATOR.toLowerCase()]).toBeDefined();
		// The installation header is the one a direct codex call requires.
		expect(call.headers[OPENAI_HEADERS.INSTALLATION_ID.toLowerCase()]).toBeDefined();
		expect(call.headers["content-type"]).toBe("application/json");
		// The route streams, so a JSON-only accept is a request the host serves
		// as a turn body the reader cannot parse.
		expect(call.headers.accept).toBe("text/event-stream");
		expect(result.summary).toBe("");
	});

	test("the body streams, carries the trigger as its last input item, and asks for encrypted reasoning", async () => {
		const calls = codexBackend();

		await compactWithProvider(makePreparation(), codexModel(), fakeCodexToken("acct-9"), "base system prompt");

		const body = calls[0]!.body;
		expect(body.model).toBe(codexModel().id);
		expect(body.store).toBe(false);
		expect(body.stream).toBe(true);
		expect(body.include).toEqual(["reasoning.encrypted_content"]);
		expect(body.client_metadata).toBeDefined();
		expect(body.instructions).toBe("base system prompt");
		const input = body.input as Array<Record<string, unknown>>;
		expect(input.length).toBeGreaterThan(1);
		expect(input.at(-1)).toEqual({ type: "compaction_trigger" });
		// The trigger is appended, never a replacement for the span.
		expect(input.some(item => item.role === "user")).toBe(true);
	});

	test("the stored window is the retained user messages followed by the compaction item", async () => {
		codexBackend();

		const result = await compactWithProvider(
			makePreparation(),
			codexModel(),
			fakeCodexToken("acct-9"),
			"base system prompt",
		);

		const window = remoteWindow(result);
		expect(window).toBeDefined();
		expect(window?.at(-1)).toEqual(COMPACTION_ITEM);
		// `response.completed.output` is empty on this host, so a window of one
		// item means the reader took it from the terminal event.
		expect(window?.length).toBeGreaterThan(1);
		const retained = window!.slice(0, -1);
		expect(retained.every(item => item.role === "user")).toBe(true);
		expect(JSON.stringify(retained)).toContain("history msg");
		// The trigger is a request item; replaying it would compact on every turn.
		expect(retained.some(item => item.type === "compaction_trigger")).toBe(false);
	});

	test("a stream that carries no compaction item compacts nothing", async () => {
		// The host's answer when the trigger did not take: real output items,
		// none of them a compaction. Storing that window would claim a
		// compaction that did not happen and replay the span at full size.
		codexBackend({
			streamed: [
				{
					type: "response.output_item.done",
					item: { id: "msg_1", type: "message", role: "assistant", content: [] },
				},
			],
		});

		await expect(
			compactWithProvider(makePreparation(), codexModel(), fakeCodexToken("acct-9"), "base system prompt"),
		).rejects.toThrow(/expected exactly one/);
	});

	test("two compaction items are refused rather than picked between", async () => {
		codexBackend({
			streamed: [
				{ type: "response.output_item.done", item: COMPACTION_ITEM },
				{ type: "response.output_item.done", item: { ...COMPACTION_ITEM, id: "cmp_002" } },
			],
		});

		await expect(
			compactWithProvider(makePreparation(), codexModel(), fakeCodexToken("acct-9"), "base system prompt"),
		).rejects.toThrow(/expected exactly one/);
	});

	test("a stream that ends before response.completed is a failure, not a short window", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async () =>
					new Response(
						`event: response.output_item.done\ndata: ${JSON.stringify({
							type: "response.output_item.done",
							item: COMPACTION_ITEM,
						})}\n\n`,
						{ status: 200, headers: { "content-type": "text/event-stream" } },
					),
				{ preconnect: fetch.preconnect },
			),
		);

		await expect(
			compactWithProvider(makePreparation(), codexModel(), fakeCodexToken("acct-9"), "base system prompt"),
		).rejects.toThrow(/closed before response\.completed/);
	});

	test("a lite codex row moves the instructions into a developer item and pins all_turns replay", async () => {
		// A real bundled lite row, not a flag flipped onto another row: lite is
		// refused for a model that cannot be sent `all_turns` reasoning context,
		// so a hand-built spec would prove the opposite of what it claims.
		const lite = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!lite) throw new Error("Expected built-in openai-codex/gpt-5.6-sol to exist");
		expect(lite.useResponsesLite).toBe(true);
		const calls = codexBackend();

		await compactWithProvider(makePreparation(), lite, fakeCodexToken("acct-9"), "base system prompt");

		const body = calls[0]!.body;
		expect(body.instructions).toBeUndefined();
		// The lite marker header and this value are one contract; the host
		// answers a lite request without it with 400 `unsupported_value`.
		expect(body.reasoning).toMatchObject({ context: "all_turns" });
		const input = body.input as Array<Record<string, unknown>>;
		expect(input[0]?.type).toBe("additional_tools");
		expect(input[1]).toMatchObject({
			type: "message",
			role: "developer",
			content: [{ type: "input_text", text: "base system prompt" }],
		});
		// The lite rewrite prepends to a new array; the trigger must survive it.
		expect(input.at(-1)).toEqual({ type: "compaction_trigger" });
	});

	test("a row that cannot take all_turns reasoning keeps top-level instructions even with the lite flag on", async () => {
		// The transport marker and `reasoning.context: "all_turns"` are one
		// decision: the backend refuses the marker without that context, so a
		// pre-5.4 codex row stays on the full transport however it is flagged.
		const flagged: Model = { ...codexModel(), useResponsesLite: true };
		const calls = codexBackend();

		await compactWithProvider(makePreparation(), flagged, fakeCodexToken("acct-9"), "base system prompt");

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
