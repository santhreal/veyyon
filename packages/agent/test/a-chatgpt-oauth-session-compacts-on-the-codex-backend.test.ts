/**
 * A ChatGPT OAuth (codex) session compacts server-side, on the route codex-rs
 * itself uses.
 *
 * WHY: `compaction.remote` defaults on, and every gate below it was written for
 * the API-key OpenAI host. `resolveServerCompactionTransport` accepted two api
 * families and `supportsServerCompaction` resolved true only for
 * `api.openai.com` or Azure, so a codex session failed both and silently
 * compacted locally — a second model billed to paraphrase a span the backend
 * would have compacted for free, and the encrypted reasoning thrown away. It
 * was invisible: nothing warned, because from the engine's side no transport
 * existed to fail.
 *
 * WHAT CLASS THIS CLOSES: a host that serves `/responses/compact` being unable
 * to reach it because one of the two gates (api family, capability data) knows
 * about it and the other does not. The suite drives the real engine against a
 * real bundled codex row and asserts the wire the backend actually receives:
 * route, credential, identity headers, and body shape. It also pins the
 * negative side, because opening a gate is how a gate stops meaning anything —
 * a repointed proxy row and a non-Responses api must still resolve nothing.
 *
 * WHAT IT DOES NOT CATCH: whether the ChatGPT backend accepts this body. Only
 * a live call answers that, and a live call is not something a test may make.
 * The engine treats any transport failure as a fall-through to local
 * compaction (`#tryServerSideCompaction` warns once and returns undefined), so
 * a wrong field costs a warning and a local pass, never a lost history.
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

const COMPACT_RESPONSE = {
	id: "resp_compact_codex",
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

interface CapturedCall {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

function mockCompactFetch(responseBody: unknown = COMPACT_RESPONSE): CapturedCall[] {
	const calls: CapturedCall[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				const headers: Record<string, string> = {};
				for (const [name, value] of new Headers(init?.headers).entries()) headers[name.toLowerCase()] = value;
				calls.push({
					url: String(input),
					headers,
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

describe("a ChatGPT OAuth session compacts on the codex backend", () => {
	test("the bundled codex row declares the capability and resolves the transport", () => {
		const compat = codexModel().compat as ResolvedOpenAIResponsesCompat;
		expect(compat.supportsServerCompaction).toBe(true);
		expect(resolveServerCompactionTransport(codexModel())).toBeDefined();
	});

	test("posts the span to the codex compact route with the ChatGPT credential and identity", async () => {
		const calls = mockCompactFetch();
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
		expect(call.url).toBe("https://chatgpt.com/backend-api/codex/responses/compact");
		expect(call.headers.authorization).toBe(`Bearer ${token}`);
		expect(call.headers[OPENAI_HEADERS.ACCOUNT_ID.toLowerCase()]).toBe("acct-9");
		expect(call.headers[OPENAI_HEADERS.ORIGINATOR.toLowerCase()]).toBeDefined();
		// The installation header is the one the compact route requires.
		expect(call.headers[OPENAI_HEADERS.INSTALLATION_ID.toLowerCase()]).toBeDefined();
		expect(call.headers["content-type"]).toBe("application/json");

		// The window the backend returned is the stored artifact, verbatim.
		const preserved = result.preserveData?.remoteCompaction as { window: unknown[] } | undefined;
		expect(preserved?.window).toEqual(COMPACT_RESPONSE.output);
		expect(result.summary).toBe("");
	});

	test("the body carries the span, the instructions, and the codex turn metadata", async () => {
		const calls = mockCompactFetch();

		await compactWithProvider(makePreparation(), codexModel(), fakeCodexToken("acct-9"), "base system prompt");

		const body = calls[0]!.body;
		expect(body.model).toBe(codexModel().id);
		expect(body.store).toBe(false);
		expect(body.stream).toBeUndefined();
		expect(Array.isArray(body.input)).toBe(true);
		expect((body.input as unknown[]).length).toBeGreaterThan(0);
		expect(body.client_metadata).toBeDefined();
		expect(body.instructions).toBe("base system prompt");
	});

	test("a lite codex row moves the instructions into a developer item, as a turn does", async () => {
		// The real bundled row with the lite flag flipped: a hand-built spec
		// would diverge from the shape the encoder actually receives.
		const lite: Model = { ...codexModel(), useResponsesLite: true };
		const calls = mockCompactFetch();

		await compactWithProvider(makePreparation(), lite, fakeCodexToken("acct-9"), "base system prompt");

		const body = calls[0]!.body;
		expect(body.instructions).toBeUndefined();
		const input = body.input as Array<Record<string, unknown>>;
		expect(input[0]?.type).toBe("additional_tools");
		expect(input[1]).toMatchObject({
			type: "message",
			role: "developer",
			content: [{ type: "input_text", text: "base system prompt" }],
		});
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
