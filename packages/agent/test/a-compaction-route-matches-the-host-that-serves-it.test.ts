/**
 * WHY THIS SUITE EXISTS: ChatGPT Codex server-side compaction was sent to
 * `POST {base}/codex/responses/compact`. That is the v1 remote-compaction
 * route, and the Codex backend has retired it, so every request answered 404.
 * A 404 is not treated as a transient failure here — it is recorded as
 * route-absent for the process, which is correct for a route that truly does
 * not exist and catastrophic for one that was merely misspelled: the first
 * compaction of a session paid a round trip, warned once, and handed the rest
 * of that session to local compaction in silence. The operator had server-side
 * compaction enabled the whole time.
 *
 * WHAT CLASS THIS CLOSES: an api family in `SERVER_COMPACTION_WIRE_APIS` whose
 * request goes to a route its host does not serve, and the latch that turns
 * one such mistake into a permanent, silent downgrade. The route half sweeps
 * the wire table at run time, so a family added to the transport without a
 * recorded route turns this suite red rather than shipping a guess. The latch
 * half pins which statuses disable the transport and which do not, because the
 * cheap ways to "fix" a 404 storm are to latch every error (which disables
 * compaction on one 500) or to latch none (which restores the per-compaction
 * round trip the latch exists to remove).
 *
 * It also pins route and declared implementation together. Those are one
 * decision: the body's compaction metadata names the wire implementation, and
 * a request that says `responses_compact` while posting to the v2 route, or
 * the reverse, is the defect in a new spelling.
 *
 * WHAT IT DOES NOT CATCH: whether the backend accepts the body it receives.
 * Only a live call answers that, and a live call is not something a test may
 * make. It also does not catch a host that starts serving a route this table
 * says it does not, which shows up as a working feature nobody enabled. The
 * Azure host is unpinned, because its base is the operator's own resource and
 * comes from the environment: only its path is asserted, so an Azure request
 * redirected to another resource passes here.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import {
	type CompactionPreparation,
	compactWithProvider,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	resolveServerCompactionTransport,
} from "@veyyon/agent-core/compaction";
import type { Message, Model } from "@veyyon/ai";
import {
	resetServerCompactionRouteCache,
	SERVER_COMPACTION_WIRE_APIS,
	serverCompactionRouteAbsent,
} from "@veyyon/ai/providers/openai-compaction";
import { getBundledModel } from "@veyyon/catalog/models";
import { OPENAI_HEADERS } from "@veyyon/catalog/wire/codex";

/** A ChatGPT OAuth access token is a JWT; the account id is read out of its payload. */
function fakeCodexToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

function bundled(provider: Parameters<typeof getBundledModel>[0], id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected built-in ${provider}/${id} to exist`);
	return model;
}

/**
 * The compacted window the transport accepts: a retained item plus the opaque
 * compaction item, which it requires before it will call the span compacted.
 */
const COMPACT_RESPONSE = {
	id: "resp_compact_route",
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
	body: Record<string, unknown>;
}

/**
 * An injected fetch, so nothing in this file mutates the global one.
 *
 * The two host families answer differently and this stands in for both: the
 * `/responses/compact` hosts return one JSON document, and the Codex host
 * streams, ending in a `compaction` output item. A streaming request is the
 * one that carries `stream: true`, which is how the real host tells them apart
 * too — it rejects a non-streaming body outright.
 */
function captureFetch(calls: CapturedCall[], status = 200, payload: unknown = COMPACT_RESPONSE) {
	return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		calls.push({ url: String(input), body });
		if (status !== 200 || body.stream !== true) return new Response(JSON.stringify(payload), { status });
		const events = [
			{ type: "response.output_item.done", item: COMPACT_RESPONSE.output.at(-1) },
			{ type: "response.completed", response: { status: "completed", output: [], usage: COMPACT_RESPONSE.usage } },
		];
		return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
			status,
			headers: { "content-type": "text/event-stream" },
		});
	};
}

interface RouteCase {
	/** A real bundled row of this family, never a hand-built spec. */
	model: () => Model;
	apiKey: string;
	/** The trailing path the host serves, appended to whatever base resolves. */
	pathnameEndsWith: string;
	/** Whether this family's compaction route carries the `/compact` suffix. */
	compactSuffix: boolean;
	/**
	 * The host the request must reach. Omitted for Azure alone, whose base is
	 * the operator's own resource and is read from the environment first, so
	 * there is no fixed origin to pin.
	 */
	origin?: string;
}

/**
 * The route each api family's host actually serves. A family added to
 * `SERVER_COMPACTION_WIRE_APIS` without a row here fails the first test below.
 */
const ROUTES: Record<string, RouteCase> = {
	// Documented on the official host: POST /v1/responses/compact.
	"openai-responses": {
		model: () => bundled("openai", "gpt-5.1"),
		apiKey: "sk-unit-test",
		pathnameEndsWith: "/v1/responses/compact",
		compactSuffix: true,
		origin: "https://api.openai.com",
	},
	// Azure serves the same route, api-version as a query parameter.
	"azure-openai-responses": {
		model: () => ({ ...bundled("azure", "gpt-4"), baseUrl: "https://unit-test.openai.azure.com/openai/v1" }),
		apiKey: "azure-unit-test-key",
		pathnameEndsWith: "/responses/compact",
		compactSuffix: true,
	},
	// Codex serves v2 only: an ordinary responses request that its client
	// metadata marks as a compaction. There is no `/compact` route to reach.
	"openai-codex-responses": {
		model: () => bundled("openai-codex", "gpt-5.1-codex"),
		apiKey: fakeCodexToken("acct-9"),
		pathnameEndsWith: "/backend-api/codex/responses",
		compactSuffix: false,
		origin: "https://chatgpt.com",
	},
};

function compactionMessages(): Message[] {
	return [
		{ role: "user", content: "history msg" },
		{ role: "assistant", content: [{ type: "text", text: "history reply" }] },
	] as Message[];
}

beforeEach(() => {
	// The latch is a module-level Set. A test that leaves an entry in it makes
	// every later file resolve undefined for that model.
	resetServerCompactionRouteCache();
});
afterEach(resetServerCompactionRouteCache);

describe("a compaction route matches the host that serves it", () => {
	test("every api family the transport claims has a recorded route", () => {
		// Derived from the exported table at run time: adding a family to the
		// transport turns this red until its route is written down.
		expect(Object.keys(ROUTES).sort()).toEqual(Object.keys(SERVER_COMPACTION_WIRE_APIS).sort());
	});

	for (const [api, route] of Object.entries(ROUTES)) {
		test(`${api} posts to the route its host serves`, async () => {
			const model = route.model();
			expect(model.api).toBe(api);

			const transport = resolveServerCompactionTransport(model);
			if (!transport) throw new Error(`Expected ${api} to resolve a server-side compaction transport`);

			const calls: CapturedCall[] = [];
			await transport.compact({
				model,
				messages: compactionMessages(),
				apiKey: route.apiKey,
				instructions: "base system prompt",
				fetch: captureFetch(calls),
			});

			expect(calls).toHaveLength(1);
			const pathname = new URL(calls[0]!.url).pathname;
			expect(pathname.endsWith(route.pathnameEndsWith)).toBe(true);
			// The suffix is the defect, stated on its own so a wrong route
			// cannot pass by ending in the right characters by accident.
			expect(pathname.endsWith("/compact")).toBe(route.compactSuffix);
			if (route.origin) expect(new URL(calls[0]!.url).origin).toBe(route.origin);
		});
	}

	test("the codex route carries no compact segment anywhere in the path", async () => {
		// `endsWith` alone would accept `/responses/compact/responses`.
		const model = ROUTES["openai-codex-responses"]!.model();
		const transport = resolveServerCompactionTransport(model);
		if (!transport) throw new Error("Expected the codex row to resolve a transport");

		const calls: CapturedCall[] = [];
		await transport.compact({
			model,
			messages: compactionMessages(),
			apiKey: fakeCodexToken("acct-9"),
			fetch: captureFetch(calls),
		});

		expect(new URL(calls[0]!.url).pathname.split("/")).not.toContain("compact");
	});
});

describe("a compaction request declares the implementation it is sent as", () => {
	test("codex names the v2 implementation, matching the v2 route", async () => {
		const model = bundled("openai-codex", "gpt-5.1-codex");
		const calls: CapturedCall[] = [];

		await compactWithProvider(makePreparation(), model, fakeCodexToken("acct-9"), "base system prompt", undefined, {
			sessionId: "session-route-1",
			codexCompaction: {
				operationId: "op-1",
				trigger: "auto",
				reason: "context_limit",
				phase: "pre_turn",
				strategy: "prefix_compaction",
			},
			fetch: captureFetch(calls),
		});

		expect(calls).toHaveLength(1);
		const metadata = calls[0]!.body.client_metadata as Record<string, string> | undefined;
		if (!metadata) throw new Error("Expected the codex compaction body to carry client_metadata");
		const turn = JSON.parse(metadata[OPENAI_HEADERS.TURN_METADATA]!) as {
			request_kind?: string;
			compaction?: { implementation?: string };
		};

		// The two halves of one decision: the marker that makes an ordinary
		// responses request a compaction, and the implementation it claims.
		expect(turn.request_kind).toBe("compaction");
		expect(turn.compaction?.implementation).toBe("responses_compaction_v2");
		expect(new URL(calls[0]!.url).pathname.endsWith("/compact")).toBe(false);
	});
});

describe("a compaction route that answers 404 stands down, and nothing else does", () => {
	/** Statuses that are failures of one request, not evidence the route is gone. */
	const TRANSIENT = [400, 401, 403, 408, 429, 500, 502, 503] as const;

	test("a 404 disables server-side compaction for the rest of the process", async () => {
		const model = bundled("openai-codex", "gpt-5.1-codex");
		const transport = resolveServerCompactionTransport(model);
		if (!transport) throw new Error("Expected the codex row to resolve a transport before the 404");

		await expect(
			transport.compact({
				model,
				messages: compactionMessages(),
				apiKey: fakeCodexToken("acct-9"),
				fetch: captureFetch([], 404, { error: "not found" }),
			}),
		).rejects.toThrow(/not available/);

		expect(serverCompactionRouteAbsent(model)).toBe(true);
		// This is the amplifier: from here the engine never asks again, so a
		// wrong route costs the whole session rather than one compaction.
		expect(resolveServerCompactionTransport(model)).toBeUndefined();
	});

	for (const status of TRANSIENT) {
		test(`a ${status} leaves server-side compaction enabled`, async () => {
			const model = bundled("openai-codex", "gpt-5.1-codex");
			const transport = resolveServerCompactionTransport(model);
			if (!transport) throw new Error("Expected the codex row to resolve a transport");

			await expect(
				transport.compact({
					model,
					messages: compactionMessages(),
					apiKey: fakeCodexToken("acct-9"),
					fetch: captureFetch([], status, { error: "transient" }),
				}),
			).rejects.toThrow();

			expect(serverCompactionRouteAbsent(model)).toBe(false);
			expect(resolveServerCompactionTransport(model)).toBeDefined();
		});
	}

	test("the stand-down is per model, not per process", async () => {
		// One host retiring a route must not silence a different host that
		// still serves one.
		const codex = bundled("openai-codex", "gpt-5.1-codex");
		const official = bundled("openai", "gpt-5.1");
		const transport = resolveServerCompactionTransport(codex);
		if (!transport) throw new Error("Expected the codex row to resolve a transport");

		await expect(
			transport.compact({
				model: codex,
				messages: compactionMessages(),
				apiKey: fakeCodexToken("acct-9"),
				fetch: captureFetch([], 404, { error: "not found" }),
			}),
		).rejects.toThrow();

		expect(serverCompactionRouteAbsent(codex)).toBe(true);
		expect(serverCompactionRouteAbsent(official)).toBe(false);
		expect(resolveServerCompactionTransport(official)).toBeDefined();
	});
});

function makeAssistantStop(text: string): AgentMessage {
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
	} as AgentMessage;
}

function makePreparation(): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [
			{ role: "user", content: "history msg", timestamp: Date.now() },
			makeAssistantStop("history reply"),
		],
		turnPrefixMessages: [],
		recentMessages: [{ role: "user", content: "recent msg", timestamp: Date.now() }],
		isSplitTurn: false,
		tokensBefore: 221_568,
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS },
	};
}
