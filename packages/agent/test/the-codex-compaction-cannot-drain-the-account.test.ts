/**
 * DO NOT CHANGE THIS TEST WITHOUT OPERATOR PERMISSION.
 * THIS REGRESSION HAS HAPPENED 50+ TIMES.
 *
 * WHY THIS SUITE EXISTS. Server-side compaction spends money on every pass, and
 * every failure mode below is silent: the session keeps working and the bill
 * grows. The wire suites next to this one prove the request is shaped right.
 * This one proves the surrounding machinery cannot turn a working request into
 * a drain, a loop, or a context that cannot be recovered.
 *
 * THE FIVE FAILURE MODES, and why each is not hypothetical:
 *
 * 1. PAID NO-OP / COMPACTION LOOP. `session-context.ts` computes
 *    `usableCompaction = replayable || summary.trim().length > 0`. A
 *    server-side entry's summary is EMPTY by construction, so `replayable` is
 *    the only thing keeping it usable, and an unusable entry re-expands the
 *    whole pre-compaction span from index 0. `openai-codex-responses` could
 *    compact but was missing from `REMOTE_COMPACTION_REPLAY_APIS`, so a codex
 *    session paid for a compaction, got the same context back, crossed the
 *    threshold again and compacted again. That is a per-turn charge that never
 *    converges, and it reads on screen as compaction working.
 *
 * 2. IRRECOVERABLE ROUTE STAND-DOWN. A 404 latches route-absent in a
 *    module-level Set with no expiry, no re-arm and no production caller of
 *    `resetServerCompactionRouteCache`. One 404 — from the host, or from a
 *    proxy, captive portal or middlebox that answers 404 for its own reasons —
 *    downgrades the whole process to paid LOCAL compaction for the rest of its
 *    life. The latch is deliberate; its BOUNDS are what this pins, because a
 *    latch keyed too broadly takes down models that never failed.
 *
 * 3. CACHE BUSTING. Every compaction rewrites the history prefix and
 *    invalidates the prompt cache, so each pass costs a full uncached re-read
 *    afterwards. That makes an extra compaction far more expensive than the
 *    compaction call itself, and it is why a window must chain rather than
 *    re-send a span the window already holds.
 *
 * 4. DUAL COMPACTION. A window and a local summary covering the same span must
 *    never both survive on the path: replaying both doubles that history
 *    instead of halving it.
 *
 * 5. CROSS-HOST REPLAY. The window's `compaction` item is an opaque blob only
 *    the host that minted it can read. Sent anywhere else it is a guaranteed
 *    rejection at the exact moment the context is overflowing.
 *
 * HOW IT CLOSES THE CLASS RATHER THAN THE INCIDENT. The api sweep is derived
 * from `SERVER_COMPACTION_WIRE_APIS` at run time, so a new compaction transport
 * turns this suite RED until someone records whether its window can be
 * replayed. The status matrix enumerates every code that can reach the latch
 * rather than the one that was reported.
 *
 * WHAT IT DOES NOT CATCH. It does not prove the live host still serves this
 * wire, and it does not measure a real prompt-cache hit rate — it pins the
 * structural decisions that make a cache miss avoidable, not the provider's
 * accounting.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	type CompactionPreparation,
	chainableRemoteCompactionWindow,
	compactWithProvider,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	getRemoteCompactionPreserveData,
	REMOTE_COMPACTION_PRESERVE_KEY,
	remoteCompactionAttribution,
	remoteCompactionProviderPayload,
	resolveServerCompactionTransport,
	stripRemoteCompactionPreserveData,
} from "@veyyon/agent-core/compaction";
import type { Message, Model } from "@veyyon/ai";
import {
	resetServerCompactionRouteCache,
	SERVER_COMPACTION_WIRE_APIS,
	serverCompactionRouteAbsent,
} from "@veyyon/ai/providers/openai-compaction";
import { getBundledModel } from "@veyyon/catalog/models";

const BANNER = "DO NOT CHANGE WITHOUT OPERATOR PERMISSION — THIS REGRESSION HAS HAPPENED 50+ TIMES";

/** A ChatGPT OAuth access token is a JWT; the account id is read out of its payload. */
function codexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-drain" } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

function bundled(provider: Parameters<typeof getBundledModel>[0], id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`${BANNER}: bundled ${provider}/${id} is gone`);
	return model;
}

function codexModel(): Model {
	return bundled("openai-codex", "gpt-5.1-codex");
}

const COMPACTION_ITEM = { type: "compaction", encrypted_content: "gAAAAAB-opaque" };
const RETAINED_ITEM = { type: "message", role: "user", content: [{ type: "input_text", text: "kept" }] };

/** A well-formed stored entry, which each case below mutates one field of. */
function preserved(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		[REMOTE_COMPACTION_PRESERVE_KEY]: {
			version: 1,
			provider: "openai-codex",
			api: "openai-codex-responses",
			model: "gpt-5.1-codex",
			window: [RETAINED_ITEM, COMPACTION_ITEM],
			compactedAt: "2026-08-30T00:00:00.000Z",
			...overrides,
		},
	};
}

interface Captured {
	url: string;
	body: Record<string, unknown>;
}

/**
 * The two host families answer differently and this stands in for both: the
 * `/responses/compact` hosts return one JSON document, and the codex host
 * streams. `stream: true` is how the real host tells them apart too, so the
 * `payload.output` a case supplies becomes the streamed output items for codex
 * and the JSON `output` array for the others.
 */
function captureFetch(calls: Captured[], status = 200, payload: unknown = undefined) {
	return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const request = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		calls.push({ url: String(input), body: request });
		const body =
			payload ??
			({
				id: "resp_1",
				object: "response.compaction",
				output: [RETAINED_ITEM, COMPACTION_ITEM],
				usage: { input_tokens: 10, output_tokens: 2 },
			} as unknown);
		if (status === 200 && request.stream === true) {
			const source = body as { output?: unknown; usage?: unknown };
			const output = Array.isArray(source.output) ? source.output : [];
			const events = [
				...output.map(item => ({ type: "response.output_item.done", item })),
				{ type: "response.completed", response: { status: "completed", output: [], usage: source.usage } },
			];
			return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
				status,
				headers: { "content-type": "text/event-stream" },
			});
		}
		return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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
		recentMessages: [{ role: "user", content: "recent", timestamp: Date.now() }],
		isSplitTurn: false,
		tokensBefore: 221_568,
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS },
	};
}

async function compactDirect(model: Model, status: number, payload?: unknown): Promise<Error | undefined> {
	const transport = resolveServerCompactionTransport(model);
	if (!transport) throw new Error(`${BANNER}: ${model.api} resolves no transport`);
	try {
		await transport.compact({
			sessionId: "drain-guard-session",
			model,
			messages: [{ role: "user", content: "span" }] as Message[],
			apiKey: codexToken(),
			fetch: captureFetch([], status, payload),
		});
		return undefined;
	} catch (error) {
		return error as Error;
	}
}

afterEach(resetServerCompactionRouteCache);

// ---------------------------------------------------------------------------
// 1. THE PAID NO-OP: an api that can compact but whose window cannot replay
// ---------------------------------------------------------------------------

describe(`a compaction that cannot replay is a paid no-op (${BANNER})`, () => {
	// Derived from the transport's own table at run time. A new compaction
	// transport turns this red until someone records whether its window replays,
	// because the failure mode of getting this wrong is a per-turn charge.
	const wireApis = Object.keys(SERVER_COMPACTION_WIRE_APIS);

	test("the transport claims at least one api, so the sweep below is not vacuous", () => {
		expect(wireApis.length).toBeGreaterThan(0);
	});

	for (const api of wireApis) {
		test(`${api} stores a window its own rebuild can replay`, () => {
			// `usableCompaction` in session-context.ts is
			// `replayable || summary.trim().length > 0`, and a server-side summary
			// is empty. Undefined here means the entry is dropped as unusable and
			// the whole span is re-expanded: the provider was paid for nothing.
			const payload = remoteCompactionProviderPayload(preserved({ api, provider: "openai" }));
			expect(payload).toBeDefined();
		});
	}

	test("every compaction-capable api is recorded, with no silent opt-out", () => {
		const replayable = wireApis.filter(
			api => remoteCompactionProviderPayload(preserved({ api, provider: "openai" })) !== undefined,
		);
		// Pinned by exact equality, never by count: an api that stops replaying
		// must be a decision someone wrote down, not a shrinking list.
		expect(replayable.sort()).toEqual(wireApis.sort());
	});

	test("codex specifically replays, because that is the api the OAuth session runs on", () => {
		expect(remoteCompactionProviderPayload(preserved())).toBeDefined();
	});

	test("an api outside the compaction set does not fabricate a replay payload", () => {
		expect(remoteCompactionProviderPayload(preserved({ api: "anthropic-messages" }))).toBeUndefined();
	});

	test("a payload that fails validation cannot be replayed", () => {
		expect(remoteCompactionProviderPayload(preserved({ window: [] }))).toBeUndefined();
	});

	test("no stored entry at all replays nothing", () => {
		expect(remoteCompactionProviderPayload(undefined)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// 2. THE STORED WINDOW: what a rebuild is allowed to treat as compacted
// ---------------------------------------------------------------------------

describe(`a stored window is validated before it is trusted (${BANNER})`, () => {
	test("a well-formed entry reads back", () => {
		expect(getRemoteCompactionPreserveData(preserved())?.model).toBe("gpt-5.1-codex");
	});

	const absent: Array<[string, Record<string, unknown> | undefined]> = [
		["undefined preserveData", undefined],
		["empty preserveData", {}],
		["a different key only", { somethingElse: { version: 1 } }],
		["a null payload", { [REMOTE_COMPACTION_PRESERVE_KEY]: null }],
		["a string payload", { [REMOTE_COMPACTION_PRESERVE_KEY]: "window" }],
		["a number payload", { [REMOTE_COMPACTION_PRESERVE_KEY]: 42 }],
		["a boolean payload", { [REMOTE_COMPACTION_PRESERVE_KEY]: true }],
	];
	for (const [name, input] of absent) {
		test(`${name} reads as no window`, () => {
			expect(getRemoteCompactionPreserveData(input)).toBeUndefined();
		});
	}

	// A persisted shape resurrects fixed bugs after the fix ships, so a stale
	// copy must be REJECTED rather than served.
	const versions: Array<[string, unknown]> = [
		["a missing version", undefined],
		["version 0", 0],
		["version 2", 2],
		["version -1", -1],
		["a string version", "1"],
		["a null version", null],
		["a NaN version", Number.NaN],
		["a float version", 1.5],
	];
	for (const [name, version] of versions) {
		test(`${name} is refused rather than misread`, () => {
			expect(getRemoteCompactionPreserveData(preserved({ version }))).toBeUndefined();
		});
	}

	for (const field of ["provider", "api", "model"] as const) {
		const bad: Array<[string, unknown]> = [
			["missing", undefined],
			["empty", ""],
			["a number", 7],
			["null", null],
			["an object", {}],
		];
		for (const [name, value] of bad) {
			test(`${field} ${name} is refused`, () => {
				expect(getRemoteCompactionPreserveData(preserved({ [field]: value }))).toBeUndefined();
			});
		}
	}

	const windows: Array<[string, unknown]> = [
		["a missing window", undefined],
		["a non-array window", { items: [] }],
		["a string window", "window"],
		["an empty window", []],
		["a window of only a retained item", [RETAINED_ITEM]],
		["a window whose compaction item has no encrypted_content", [{ type: "compaction" }]],
		["a window whose encrypted_content is a number", [{ type: "compaction", encrypted_content: 1 }]],
		["a window whose encrypted_content is null", [{ type: "compaction", encrypted_content: null }]],
		["a window of nulls", [null]],
		["a window of strings", ["compaction"]],
		["a window naming the type on a nested field", [{ item: { type: "compaction", encrypted_content: "x" } }]],
	];
	for (const [name, window] of windows) {
		test(`${name} is not a compacted window`, () => {
			expect(getRemoteCompactionPreserveData(preserved({ window }))).toBeUndefined();
		});
	}

	test("a window carrying the compaction item anywhere in the array is accepted", () => {
		expect(getRemoteCompactionPreserveData(preserved({ window: [COMPACTION_ITEM, RETAINED_ITEM] }))).toBeDefined();
	});

	test("an empty encrypted_content string is still a compaction item", () => {
		// Emptiness is the host's to decide; the reader's contract is the type.
		const window = [{ type: "compaction", encrypted_content: "" }];
		expect(getRemoteCompactionPreserveData(preserved({ window }))).toBeDefined();
	});

	for (const [name, compactedAt] of [
		["missing", undefined],
		["empty", ""],
		["a number", 0],
		["null", null],
	] as Array<[string, unknown]>) {
		test(`a ${name} compactedAt is refused`, () => {
			expect(getRemoteCompactionPreserveData(preserved({ compactedAt }))).toBeUndefined();
		});
	}

	test("token accounting is optional and its absence does not void the window", () => {
		expect(getRemoteCompactionPreserveData(preserved({ inputTokens: undefined }))).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// 3. CROSS-HOST REPLAY: an opaque blob is bound to the host that minted it
// ---------------------------------------------------------------------------

describe(`a window is bound to the host that minted it (${BANNER})`, () => {
	const model = { provider: "openai-codex", api: "openai-codex-responses" };

	test("the minting host chains its own window", () => {
		expect(chainableRemoteCompactionWindow(preserved(), model)).toHaveLength(2);
	});

	const foreign: Array<[string, Record<string, unknown>]> = [
		["another provider", { provider: "openai" }],
		["another api", { api: "openai-responses" }],
		["both different", { provider: "azure", api: "azure-openai-responses" }],
		["a provider differing only in case", { provider: "OpenAI-Codex" }],
		["an api differing only in case", { api: "OpenAI-Codex-Responses" }],
		["a provider with trailing space", { provider: "openai-codex " }],
	];
	for (const [name, override] of foreign) {
		test(`${name} is dropped rather than sent to a host that cannot read it`, () => {
			expect(chainableRemoteCompactionWindow(preserved(override), model)).toBeUndefined();
		});
	}

	test("a malformed window is not chained", () => {
		expect(chainableRemoteCompactionWindow(preserved({ window: [] }), model)).toBeUndefined();
	});

	test("no stored entry chains nothing", () => {
		expect(chainableRemoteCompactionWindow(undefined, model)).toBeUndefined();
	});

	test("a stale-version window is not chained even from the same host", () => {
		expect(chainableRemoteCompactionWindow(preserved({ version: 2 }), model)).toBeUndefined();
	});

	test("attribution names the compacting host, not the session model", () => {
		expect(remoteCompactionAttribution(preserved())).toBe("openai-codex/gpt-5.1-codex");
	});

	test("attribution of a malformed entry is absent rather than a half name", () => {
		expect(remoteCompactionAttribution(preserved({ model: "" }))).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// 4. DUAL COMPACTION: a window and a summary never cover the same span
// ---------------------------------------------------------------------------

describe(`a window and a local summary never both survive (${BANNER})`, () => {
	test("a local pass strips the window it would otherwise replay beside", () => {
		expect(stripRemoteCompactionPreserveData(preserved())).toBeUndefined();
	});

	test("stripping keeps every unrelated key", () => {
		const withOther = { ...preserved(), archive: { blocks: 1 } };
		expect(stripRemoteCompactionPreserveData(withOther)).toEqual({ archive: { blocks: 1 } });
	});

	test("stripping an entry that has no window is a no-op, not an erasure", () => {
		const other = { archive: { blocks: 1 } };
		expect(stripRemoteCompactionPreserveData(other)).toBe(other);
	});

	test("stripping undefined stays undefined", () => {
		expect(stripRemoteCompactionPreserveData(undefined)).toBeUndefined();
	});

	test("a stripped entry can no longer be replayed", () => {
		expect(remoteCompactionProviderPayload(stripRemoteCompactionPreserveData(preserved()))).toBeUndefined();
	});

	test("a stripped entry can no longer be chained", () => {
		const stripped = stripRemoteCompactionPreserveData(preserved());
		expect(
			chainableRemoteCompactionWindow(stripped, { provider: "openai-codex", api: "openai-codex-responses" }),
		).toBeUndefined();
	});

	test("a remote result carries exactly one artifact, and its summary is empty", async () => {
		// Two artifacts covering one span is the dual-compaction shape: a window
		// replayed beside a summary of the same messages doubles that history.
		const result = await compactWithProvider(preparation(), codexModel(), codexToken(), "sys", undefined, {
			sessionId: "s",
			codexCompaction: {
				operationId: "op",
				trigger: "auto",
				reason: "context_limit",
				phase: "pre_turn",
				strategy: "prefix_compaction",
			},
			fetch: captureFetch([]),
		});
		expect(result.summary).toBe("");
		expect(Object.keys(result.preserveData ?? {})).toEqual([REMOTE_COMPACTION_PRESERVE_KEY]);
	});

	test("the stored window is the span plus the provider's compaction item, and nothing the host injected", async () => {
		// Under the codex wire the host answers `response.completed` with an empty
		// output, so the window is assembled from the span that was sent. The blob
		// is the provider's; every other item must come from the span. A host item
		// that reached the stored window would be replayed as conversation history
		// on every later turn.
		const result = await compactWithProvider(preparation(), codexModel(), codexToken(), "sys", undefined, {
			sessionId: "s",
			codexCompaction: {
				operationId: "op",
				trigger: "auto",
				reason: "context_limit",
				phase: "pre_turn",
				strategy: "prefix_compaction",
			},
			fetch: captureFetch([]),
		});
		const data = getRemoteCompactionPreserveData(result.preserveData);
		const window = data?.window ?? [];
		expect(window.at(-1)).toEqual(COMPACTION_ITEM);
		expect(window.slice(0, -1).every(item => (item as { role?: string }).role === "user")).toBe(true);
		expect(JSON.stringify(window.slice(0, -1))).toContain("history msg");
		// RETAINED_ITEM is the host's own item, text "kept". It is not the span's.
		expect(window).not.toContainEqual(RETAINED_ITEM);
	});

	test("structural fields come from the preparation, so a provider cannot move the keep marker", async () => {
		const result = await compactWithProvider(preparation(), codexModel(), codexToken(), "sys", undefined, {
			sessionId: "s",
			codexCompaction: {
				operationId: "op",
				trigger: "auto",
				reason: "context_limit",
				phase: "pre_turn",
				strategy: "prefix_compaction",
			},
			fetch: captureFetch([]),
		});
		expect([result.firstKeptEntryId, result.tokensBefore]).toEqual(["kept-1", 221_568]);
	});
});

// ---------------------------------------------------------------------------
// 5. THE LATCH: bounded stand-down, and nothing wider
// ---------------------------------------------------------------------------

describe(`only a 404 stands the route down (${BANNER})`, () => {
	// Every status that can reach the latch, not the one that was reported. A
	// transient failure latched as route-absent downgrades the whole process to
	// paid local compaction with no way back.
	const TRANSIENT = [400, 401, 402, 403, 405, 408, 409, 410, 418, 422, 425, 429, 500, 502, 503, 504] as const;

	for (const status of TRANSIENT) {
		test(`${status} is one failed request, not evidence the route is gone`, async () => {
			const model = codexModel();
			await compactDirect(model, status, { detail: "nope" });
			expect(serverCompactionRouteAbsent(model)).toBe(false);
		});
	}

	for (const status of TRANSIENT) {
		test(`${status} leaves the transport resolvable for the next compaction`, async () => {
			const model = codexModel();
			await compactDirect(model, status, { detail: "nope" });
			expect(resolveServerCompactionTransport(model)).toBeDefined();
		});
	}

	test("404 stands the route down", async () => {
		const model = codexModel();
		await compactDirect(model, 404, { detail: "Not Found" });
		expect(serverCompactionRouteAbsent(model)).toBe(true);
	});

	test("404 stops the transport resolving, so the next pass does not re-ask", async () => {
		const model = codexModel();
		await compactDirect(model, 404, { detail: "Not Found" });
		expect(resolveServerCompactionTransport(model)).toBeUndefined();
	});

	test("the stand-down is keyed to the model, not the whole provider", async () => {
		await compactDirect(codexModel(), 404, { detail: "Not Found" });
		const sibling = bundled("openai-codex", "gpt-5.6-sol");
		expect(serverCompactionRouteAbsent(sibling)).toBe(false);
	});

	test("the stand-down does not reach another provider's models", async () => {
		await compactDirect(codexModel(), 404, { detail: "Not Found" });
		expect(serverCompactionRouteAbsent(bundled("openai", "gpt-5.1"))).toBe(false);
	});

	test("a sibling model still resolves a transport after another model's 404", async () => {
		await compactDirect(codexModel(), 404, { detail: "Not Found" });
		expect(resolveServerCompactionTransport(bundled("openai-codex", "gpt-5.6-sol"))).toBeDefined();
	});

	test("the stand-down persists across calls within the process", async () => {
		const model = codexModel();
		await compactDirect(model, 404, { detail: "Not Found" });
		await compactDirect(model, 404, { detail: "Not Found" }).catch(() => undefined);
		expect(serverCompactionRouteAbsent(model)).toBe(true);
	});

	test("a reset clears the stand-down, which is the only way back", async () => {
		const model = codexModel();
		await compactDirect(model, 404, { detail: "Not Found" });
		resetServerCompactionRouteCache();
		expect(serverCompactionRouteAbsent(model)).toBe(false);
	});

	test("a model that never failed reports no stand-down", () => {
		expect(serverCompactionRouteAbsent(codexModel())).toBe(false);
	});

	test("a successful compaction leaves no stand-down behind", async () => {
		const model = codexModel();
		await compactDirect(model, 200);
		expect(serverCompactionRouteAbsent(model)).toBe(false);
	});

	test("a malformed 200 is a failed pass, not a dead route", async () => {
		// The difference matters: a dead route is permanent, a bad reply is one
		// pass. Conflating them turns a transient parse failure into a downgrade.
		const model = codexModel();
		await compactDirect(model, 200, { output: [] });
		expect(serverCompactionRouteAbsent(model)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 6. THE REPLY: nothing is treated as compacted unless it is
// ---------------------------------------------------------------------------

describe(`a reply is not a compaction until it carries one (${BANNER})`, () => {
	const rejected: Array<[string, unknown, RegExp]> = [
		// The codex reader counts compaction items, not output items, so an absent
		// or unusable output reads as "no compaction item arrived" rather than as
		// an empty document. Both refusals name the fallback and the fact that the
		// history was not compacted, which is the contract the caller relies on.
		["an empty output", { output: [] }, /expected exactly one/],
		["a missing output", {}, /expected exactly one/],
		["a null output", { output: null }, /expected exactly one/],
		["a non-array output", { output: { item: 1 } }, /expected exactly one/],
		["an output of only prose", { output: [{ type: "message", role: "assistant", content: [] }] }, /compaction item/],
		["a compaction item with no blob", { output: [{ type: "compaction" }] }, /compaction item/],
		[
			"a compaction item whose blob is a number",
			{ output: [{ type: "compaction", encrypted_content: 5 }] },
			/compaction item/,
		],
		[
			"a compaction item whose blob is null",
			{ output: [{ type: "compaction", encrypted_content: null }] },
			/compaction item/,
		],
		["an output of nulls", { output: [null] }, /compaction item/],
		[
			"a mistyped compaction item",
			{ output: [{ type: "compaction_result", encrypted_content: "x" }] },
			/compaction item/,
		],
	];
	for (const [name, payload, message] of rejected) {
		test(`${name} is refused`, async () => {
			expect((await compactDirect(codexModel(), 200, payload))?.message).toMatch(message);
		});
	}

	test("a well-formed reply is accepted", async () => {
		expect(await compactDirect(codexModel(), 200)).toBeUndefined();
	});

	test("a reply carrying the compaction item alone is accepted", async () => {
		expect(await compactDirect(codexModel(), 200, { output: [COMPACTION_ITEM] })).toBeUndefined();
	});

	test("a refusal names the fallback, so the cost of the next pass is visible", async () => {
		const error = await compactDirect(codexModel(), 200, { output: [] });
		expect(error?.message).toContain("local compaction");
	});

	test("a refusal states the history was not compacted", async () => {
		const error = await compactDirect(codexModel(), 200, { output: [] });
		expect(error?.message).toContain("NOT compacted");
	});
});

// ---------------------------------------------------------------------------
// 7. THE SPEND: one request per pass, and the window chained not re-sent
// ---------------------------------------------------------------------------

describe(`one compaction is one paid request (${BANNER})`, () => {
	function options(calls: Captured[], extra: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			sessionId: "s",
			codexCompaction: {
				operationId: "op",
				trigger: "auto",
				reason: "context_limit",
				phase: "pre_turn",
				strategy: "prefix_compaction",
			},
			fetch: captureFetch(calls),
			...extra,
		};
	}

	test("a successful pass makes exactly one request", async () => {
		const calls: Captured[] = [];
		await compactWithProvider(preparation(), codexModel(), codexToken(), "sys", undefined, options(calls));
		expect(calls).toHaveLength(1);
	});

	test("a 404 makes exactly one request, never a retry storm", async () => {
		const calls: Captured[] = [];
		const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
			return new Response('{"detail":"Not Found"}', { status: 404 });
		};
		await compactWithProvider(preparation(), codexModel(), codexToken(), "sys", undefined, {
			...options([]),
			fetch: fetchImpl,
		}).catch(() => undefined);
		expect(calls).toHaveLength(1);
	});

	test("a 500 makes exactly one request, so a failing host is not billed repeatedly", async () => {
		const calls: Captured[] = [];
		const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
			return new Response('{"detail":"boom"}', { status: 500 });
		};
		await compactWithProvider(preparation(), codexModel(), codexToken(), "sys", undefined, {
			...options([]),
			fetch: fetchImpl,
		}).catch(() => undefined);
		expect(calls).toHaveLength(1);
	});

	test("a malformed reply makes exactly one request", async () => {
		const calls: Captured[] = [];
		await compactWithProvider(preparation(), codexModel(), codexToken(), "sys", undefined, {
			...options([]),
			fetch: captureFetch(calls, 200, { output: [] }),
		}).catch(() => undefined);
		expect(calls).toHaveLength(1);
	});

	test("a model with no transport spends nothing and says why", async () => {
		const calls: Captured[] = [];
		await expect(
			compactWithProvider(
				preparation(),
				bundled("anthropic", "claude-sonnet-4-5"),
				"key",
				"sys",
				undefined,
				options(calls),
			),
		).rejects.toThrow(/must gate on resolveServerCompactionTransport/);
		expect(calls).toHaveLength(0);
	});

	test("a stood-down model spends nothing on the next pass", async () => {
		const model = codexModel();
		await compactDirect(model, 404, { detail: "Not Found" });
		const calls: Captured[] = [];
		await compactWithProvider(preparation(), model, codexToken(), "sys", undefined, options(calls)).catch(
			() => undefined,
		);
		// The whole point of the latch: the second pass costs nothing.
		expect(calls).toHaveLength(0);
	});

	test("an aborted pass does not resolve as a compaction", async () => {
		const controller = new AbortController();
		controller.abort();
		const calls: Captured[] = [];
		await expect(
			compactWithProvider(preparation(), codexModel(), codexToken(), "sys", controller.signal, options(calls)),
		).rejects.toThrow();
	});

	test("the span is sent as input items, so the provider is paid to read the span", async () => {
		const calls: Captured[] = [];
		await compactWithProvider(preparation(), codexModel(), codexToken(), "sys", undefined, options(calls));
		const input = calls[0]!.body.input as unknown[];
		expect(Array.isArray(input) && input.length > 0).toBe(true);
	});

	test("the compaction turn is not stored, so the host keeps no state to bill for", async () => {
		const calls: Captured[] = [];
		await compactWithProvider(preparation(), codexModel(), codexToken(), "sys", undefined, options(calls));
		expect(calls[0]!.body.store).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 8. CACHE BUSTING: chaining rather than re-sending what the window holds
// ---------------------------------------------------------------------------

describe(`a second compaction chains instead of re-reading the span (${BANNER})`, () => {
	function chained(calls: Captured[], previous: Record<string, unknown> | undefined): Promise<unknown> {
		const prep = preparation();
		prep.remoteChain = {
			previousPreserveData: previous,
			messagesToSummarize: [{ role: "user", content: "since the window", timestamp: Date.now() }],
			turnPrefixMessages: [],
		} as CompactionPreparation["remoteChain"];
		return compactWithProvider(prep, codexModel(), codexToken(), "sys", undefined, {
			sessionId: "s",
			codexCompaction: {
				operationId: "op",
				trigger: "auto",
				reason: "context_limit",
				phase: "pre_turn",
				strategy: "prefix_compaction",
			},
			fetch: captureFetch(calls),
		});
	}

	test("the previous window leads the input, so the span behind it is not paid for twice", async () => {
		const calls: Captured[] = [];
		await chained(calls, preserved());
		const input = calls[0]!.body.input as Array<Record<string, unknown>>;
		expect(input[0]).toEqual(RETAINED_ITEM);
	});

	test("the chained request carries the previous compaction item", async () => {
		const calls: Captured[] = [];
		await chained(calls, preserved());
		const input = calls[0]!.body.input as Array<Record<string, unknown>>;
		expect(input.some(item => item.type === "compaction")).toBe(true);
	});

	test("a foreign window is not chained, and the full span is sent instead", async () => {
		const calls: Captured[] = [];
		await chained(calls, preserved({ provider: "openai", api: "openai-responses" }));
		const input = calls[0]!.body.input as Array<Record<string, unknown>>;
		expect(input.some(item => item.type === "compaction")).toBe(false);
	});

	test("no previous window sends the span alone", async () => {
		const calls: Captured[] = [];
		await chained(calls, undefined);
		const input = calls[0]!.body.input as Array<Record<string, unknown>>;
		expect(input.some(item => item.type === "compaction")).toBe(false);
	});

	test("a malformed previous window is not chained", async () => {
		const calls: Captured[] = [];
		await chained(calls, preserved({ window: [] }));
		const input = calls[0]!.body.input as Array<Record<string, unknown>>;
		expect(input.some(item => item.type === "compaction")).toBe(false);
	});

	test("only one compaction item is stored, so windows do not accumulate", async () => {
		const calls: Captured[] = [];
		const result = (await chained(calls, preserved())) as { preserveData?: Record<string, unknown> };
		const data = getRemoteCompactionPreserveData(result.preserveData);
		const window = data?.window ?? [];
		// The chained request sends the previous blob so the host reads it, and the
		// blob it answers with supersedes it. Keeping both would replay two
		// overlapping histories and grow the window on every pass.
		expect(window.filter(item => (item as { type?: string }).type === "compaction")).toEqual([COMPACTION_ITEM]);
		expect(window.at(-1)).toEqual(COMPACTION_ITEM);
	});
});
