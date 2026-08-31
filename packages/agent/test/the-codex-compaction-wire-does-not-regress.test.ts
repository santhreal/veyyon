/**
 * DO NOT CHANGE THIS TEST WITHOUT OPERATOR PERMISSION.
 * THIS REGRESSION HAS HAPPENED 50+ TIMES.
 *
 * WHY THIS SUITE EXISTS. The ChatGPT Codex server-side compaction wire has been
 * broken and re-fixed more than fifty times. Every break looks like a tidy-up and
 * every break costs real money: when the compact route answers 404 the session
 * falls back to LOCAL compaction, a paid summarization call that rewrites the
 * history prefix and invalidates the prompt cache, so every later turn re-pays
 * full uncached input. One broken route produced 31 compactions in one session.
 *
 * WHY IT KEPT COMING BACK. Both codex routes have answered 404 in real runs at
 * different times, so the loop is: someone flips the path, the other 404 appears,
 * someone flips it back. The path was never the whole decision. The route and the
 * `implementation` in the client metadata are ONE decision, and they are set in
 * two different packages:
 *
 *   {base}/codex/responses/compact  <->  implementation "responses_compact"
 *   {base}/codex/responses          <->  implementation "responses_compaction_v2"
 *
 * A route from one pairing sent with the other's declaration is its own 404. Half
 * a change is indistinguishable from the bug, which is why this suite drives
 * `compactWithProvider` — the production owner that joins both halves — and never
 * passes an implementation of its own. A suite that supplies the value it then
 * asserts stays green while the shipped code says the opposite; that suite was
 * written first here, and flipping the declaration to v2 did not turn it red.
 *
 * THE PINNED WIRE is oh-my-pi's (`can1357/oh-my-pi`,
 * `packages/agent/src/compaction/openai.ts`): the `/compact` endpoint,
 * `responses_compact`, ONE JSON document in reply, NO `compaction_trigger` input
 * item, NO `stream: true`.
 *
 * WHAT THIS DOES NOT CATCH. It pins the request veyyon builds and the reply it
 * accepts; it cannot prove the live backend still serves that wire. If the host
 * changes, these tests stay green while production 404s. The operator's own run is
 * the only authority on that, and changing this suite to chase it needs the
 * operator to say so out loud.
 */

import { afterEach, describe, expect, test } from "bun:test";
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

const COMPACT_ROUTE = "https://chatgpt.com/backend-api/codex/responses/compact";
/** The plain turn route. Posting compaction here is one half of the defect. */
const TURN_ROUTE = "https://chatgpt.com/backend-api/codex/responses";

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

/** A well-formed reply: ONE JSON document carrying the opaque compaction item. */
const COMPACTED = {
	id: "resp_regression",
	object: "response.compaction",
	output: [
		{
			id: "msg_0",
			type: "message",
			status: "completed",
			role: "user",
			content: [{ type: "input_text", text: "kept" }],
		},
		{ id: "cmp_0", type: "compaction", encrypted_content: "gAAAAAB-opaque-window" },
	],
	usage: { input_tokens: 139, output_tokens: 438, total_tokens: 577 },
};

interface Captured {
	url: string;
	body: Record<string, unknown>;
}

function captureFetch(calls: Captured[], status = 200, payload: unknown = COMPACTED) {
	return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
		return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
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
async function captureOne(): Promise<Captured> {
	const calls: Captured[] = [];
	await compactWithProvider(preparation(), codexModel(), codexToken(), "base system prompt", undefined, {
		sessionId: "session-regression",
		codexCompaction: {
			operationId: "op-regression",
			trigger: "auto",
			reason: "context_limit",
			phase: "pre_turn",
			strategy: "prefix_compaction",
		},
		fetch: captureFetch(calls),
	});
	const call = calls[0];
	if (!call) throw new Error(`${BANNER}: the compaction engine made no server-side request at all`);
	return call;
}

/** The turn metadata the codex host reads to tell a compaction from a turn. */
async function turnMetadata(): Promise<{ request_kind?: string; compaction?: { implementation?: string } }> {
	const call = await captureOne();
	const metadata = call.body.client_metadata as Record<string, string> | undefined;
	if (!metadata) throw new Error(`${BANNER}: no client_metadata on the compaction body`);
	return JSON.parse(metadata[OPENAI_HEADERS.TURN_METADATA]!) as {
		request_kind?: string;
		compaction?: { implementation?: string };
	};
}

/** Drives the transport alone, for the replies the engine converts into fallback. */
async function compactDirect(status: number, payload: unknown): Promise<Error | undefined> {
	const model = codexModel();
	const transport = resolveServerCompactionTransport(model);
	if (!transport) throw new Error(`${BANNER}: codex resolves no server-side compaction transport`);
	try {
		await transport.compact({
			model,
			messages: [{ role: "user", content: "history msg" }] as Message[],
			apiKey: codexToken(),
			fetch: captureFetch([], status, payload),
		});
		return undefined;
	} catch (error) {
		return error as Error;
	}
}

afterEach(resetServerCompactionRouteCache);

describe(`the codex compaction ROUTE (${BANNER})`, () => {
	test("posts to the /compact endpoint", async () => {
		expect((await captureOne()).url).toBe(COMPACT_ROUTE);
	});

	test("never posts compaction to the plain turn route", async () => {
		expect((await captureOne()).url).not.toBe(TURN_ROUTE);
	});

	test("ends the path with /compact", async () => {
		expect(new URL((await captureOne()).url).pathname.endsWith("/compact")).toBe(true);
	});

	test("carries exactly one compact segment, at the end", async () => {
		// `endsWith` alone would accept `/compact/responses/compact`.
		const segments = new URL((await captureOne()).url).pathname.split("/");
		expect(segments.filter(segment => segment === "compact")).toEqual(["compact"]);
		expect(segments.at(-1)).toBe("compact");
	});

	test("keeps the codex backend origin", async () => {
		expect(new URL((await captureOne()).url).origin).toBe("https://chatgpt.com");
	});

	test("keeps the backend-api/codex prefix", async () => {
		expect(new URL((await captureOne()).url).pathname).toBe("/backend-api/codex/responses/compact");
	});
});

describe(`the codex compaction DECLARATION (${BANNER})`, () => {
	test("declares responses_compact, the pairing for this route", async () => {
		expect((await turnMetadata()).compaction?.implementation).toBe("responses_compact");
	});

	test("never declares the v2 implementation on the /compact route", async () => {
		expect((await turnMetadata()).compaction?.implementation).not.toBe("responses_compaction_v2");
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
		const metadata = call.body.client_metadata as Record<string, string>;
		const turn = JSON.parse(metadata[OPENAI_HEADERS.TURN_METADATA]!) as {
			compaction?: { implementation?: string };
		};
		expect([new URL(call.url).pathname.endsWith("/compact"), turn.compaction?.implementation]).toEqual([
			true,
			"responses_compact",
		]);
	});
});

describe(`the codex compaction BODY (${BANNER})`, () => {
	test("is not a streaming request", async () => {
		// The compact route answers one JSON document. `stream: true` belongs to the
		// turn route, and asking for it here is half of the mismatched hybrid.
		expect((await captureOne()).body.stream).toBeUndefined();
	});

	test("appends no compaction_trigger input item", async () => {
		// The trigger item is the v2 wire's marker. On the /compact route the host
		// rejects it.
		const input = (await captureOne()).body.input as Array<Record<string, unknown>>;
		expect(input.filter(item => item?.type === "compaction_trigger")).toEqual([]);
	});

	test("does not store the compaction turn", async () => {
		expect((await captureOne()).body.store).toBe(false);
	});

	test("names the codex wire model", async () => {
		expect((await captureOne()).body.model).toBe(codexModel().id);
	});

	test("sends the span as input items", async () => {
		const input = (await captureOne()).body.input;
		expect(Array.isArray(input) && input.length > 0).toBe(true);
	});
});

describe(`the codex compaction REPLY (${BANNER})`, () => {
	test("reads one JSON document and accepts the compacted window", async () => {
		expect(await compactDirect(200, COMPACTED)).toBeUndefined();
	});

	test("rejects a reply with no compaction item rather than claiming success", async () => {
		// Without the opaque item there is no window to resume from, and treating the
		// reply as a success drops the history instead of compacting it.
		const error = await compactDirect(200, { output: [COMPACTED.output[0]] });
		expect(error?.message).toContain("compaction");
	});

	test("rejects an empty output rather than compacting to nothing", async () => {
		expect((await compactDirect(200, { output: [] }))?.message).toContain("no output items");
	});
});

describe(`the codex compaction 404 STAND-DOWN (${BANNER})`, () => {
	test("names the provider, the model and the code when the route is absent", async () => {
		// The status text is the runtime's, not the wire's; the provider, model and
		// code are what distinguishes a dead route from a token failure in a log.
		const error = await compactDirect(404, { detail: "Not Found" });
		expect(error?.message).toStartWith(
			`Server-side compaction is not available for openai-codex/${codexModel().id} (404`,
		);
	});

	test("asks once, then stops resolving a transport for that model", async () => {
		await compactDirect(404, { detail: "Not Found" });
		// A 404 is the host answering the capability question. Re-asking once per
		// compaction is what turned one broken route into a session of paid local
		// fallbacks; the latch is what bounds it.
		expect(resolveServerCompactionTransport(codexModel())).toBeUndefined();
	});
});
