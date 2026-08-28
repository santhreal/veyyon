import { afterEach, describe, expect, it, vi } from "bun:test";
import { createHindsightClient, HindsightApi } from "./client";
import type { HindsightConfig } from "./config";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

describe("HindsightApi fetch cancellation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("combines caller cancellation with the request timeout", async () => {
		let requestSignal: AbortSignal | undefined;
		const fetchStub = Object.assign(
			async (_input: FetchInput, init?: FetchInit) => {
				requestSignal = init?.signal ?? undefined;
				return Response.json({ results: [] });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const caller = new AbortController();
		const client = new HindsightApi({ baseUrl: "https://hindsight.example" });
		await client.recall("bank", "query", { signal: caller.signal });

		expect(requestSignal).toBeInstanceOf(AbortSignal);
		expect(requestSignal).not.toBe(caller.signal);
		caller.abort(new Error("caller aborted"));
		expect(requestSignal?.aborted).toBe(true);
		expect(requestSignal?.reason).toBe(caller.signal.reason);
	});

	it("reports the effective per-op deadline in timeout errors", async () => {
		const fetchStub = Object.assign(
			async (_input: FetchInput, _init?: FetchInit) => {
				const err = new Error("Timeout");
				err.name = "TimeoutError";
				return Promise.reject(err);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const client = new HindsightApi({
			baseUrl: "https://hindsight.example",
			timeouts: { reflect: 90_000, recall: 15_000, request: 5_000 },
		});

		await expect(client.reflect("bank", "query")).rejects.toThrow("reflect request timed out after 90s");
		await expect(client.recall("bank", "query")).rejects.toThrow("recall request timed out after 15s");
		await expect(client.listDocuments("bank")).rejects.toThrow("listDocuments request timed out after 5s");
	});
});

/**
 * The port that made these timeouts configurable (upstream#6225, PR #202) added
 * the four `hindsight.*TimeoutMs` settings, their `HINDSIGHT_*_TIMEOUT_MS` env
 * overrides, and the client's use of them, but left `createHindsightClient`
 * constructing the client without a `timeouts` bag. Everything parsed, nothing
 * applied: a user raising `hindsight.reflectTimeoutMs` still got the built-in
 * 120s. Nothing failed, because each timeout silently fell back to its default.
 * These cases assert the config actually reaches the wire.
 */
describe("createHindsightClient timeout wiring", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const configWith = (over: Partial<HindsightConfig>) =>
		({
			hindsightApiUrl: "https://hindsight.example",
			hindsightApiToken: null,
			requestTimeoutMs: 30_000,
			reflectTimeoutMs: 120_000,
			recallTimeoutMs: 30_000,
			retainTimeoutMs: 60_000,
			...over,
		}) as HindsightConfig & { hindsightApiUrl: string };

	/** Drive a timeout to expiry and read the deadline back out of the error. */
	const deadlineFor = async (client: HindsightApi, call: (c: HindsightApi) => Promise<unknown>) => {
		const fetchStub = Object.assign(
			async (_input: FetchInput, init?: FetchInit) => {
				const err = new Error("The operation timed out.");
				err.name = "TimeoutError";
				(init?.signal as AbortSignal | undefined)?.throwIfAborted();
				return Promise.reject(err);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
		return await call(client).then(
			() => "no error",
			(e: Error) => e.message,
		);
	};

	it("passes each configured per-operation timeout through to the request deadline", async () => {
		const client = createHindsightClient(
			configWith({ reflectTimeoutMs: 90_000, recallTimeoutMs: 15_000, requestTimeoutMs: 5_000 }),
		);
		expect(await deadlineFor(client, c => c.reflect("bank", "query"))).toBe("reflect request timed out after 90s");
		expect(await deadlineFor(client, c => c.recall("bank", "query"))).toBe("recall request timed out after 15s");
		expect(await deadlineFor(client, c => c.listDocuments("bank"))).toBe("listDocuments request timed out after 5s");
	});

	it("carries a raised reflect budget, the setting a slow reflect actually needs", async () => {
		const client = createHindsightClient(configWith({ reflectTimeoutMs: 300_000 }));
		expect(await deadlineFor(client, c => c.reflect("bank", "query"))).toBe("reflect request timed out after 300s");
	});

	it("keeps the four operations independent, so lowering recall never shortens reflect", async () => {
		const client = createHindsightClient(configWith({ recallTimeoutMs: 1_000, reflectTimeoutMs: 120_000 }));
		expect(await deadlineFor(client, c => c.recall("bank", "query"))).toBe("recall request timed out after 1s");
		expect(await deadlineFor(client, c => c.reflect("bank", "query"))).toBe("reflect request timed out after 120s");
	});
});

describe("HindsightApi User-Agent identity (SPEC-MEMORY #2)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends a User-Agent header containing veyyon by default", async () => {
		let sentHeaders: Record<string, string> | undefined;
		const fetchStub = Object.assign(
			async (_input: FetchInput, init?: FetchInit) => {
				sentHeaders = init?.headers as Record<string, string> | undefined;
				return Response.json({ results: [] });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const client = new HindsightApi({ baseUrl: "https://hindsight.example" });
		await client.recall("bank", "query");

		expect(sentHeaders?.["User-Agent"]).toContain("veyyon");
		expect(sentHeaders?.["User-Agent"]).not.toContain("Oh My Pi");
	});

	it("createHindsightClient wires the same veyyon-branded User-Agent", async () => {
		let sentHeaders: Record<string, string> | undefined;
		const fetchStub = Object.assign(
			async (_input: FetchInput, init?: FetchInit) => {
				sentHeaders = init?.headers as Record<string, string> | undefined;
				return Response.json({ results: [] });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const client = createHindsightClient({
			hindsightApiUrl: "https://hindsight.example",
			hindsightApiToken: null,
		} as HindsightConfig & { hindsightApiUrl: string });
		await client.recall("bank", "query");

		expect(sentHeaders?.["User-Agent"]).toBe("veyyon-coding-agent");
	});
});

describe("HindsightApi recall context-agnostic (SPEC-MEMORY #3)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("recall never filters on the retain `context` provenance tag, so an omp->veyyon default change cannot orphan existing memories", async () => {
		let sentBody: Record<string, unknown> | undefined;
		const fetchStub = Object.assign(
			async (_input: FetchInput, init?: FetchInit) => {
				sentBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
				return Response.json({ results: [] });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const client = new HindsightApi({ baseUrl: "https://hindsight.example" });
		await client.recall("bank", "query");

		expect(sentBody).not.toHaveProperty("context");
	});
});
