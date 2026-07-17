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
