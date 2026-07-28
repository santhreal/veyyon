import { afterEach, describe, expect, it, vi } from "bun:test";
import { searchSmitheryRegistry } from "./smithery-registry";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

describe("searchSmitheryRegistry", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("adds timeout signals to search and detail requests", async () => {
		const signals: AbortSignal[] = [];
		const fetchStub = Object.assign(
			async (input: FetchInput, init?: FetchInit) => {
				if (init?.signal instanceof AbortSignal) signals.push(init.signal);
				const url = String(input);
				if (url.includes("?")) {
					return Response.json({
						servers: [
							{
								id: "srv_1",
								namespace: "smithery-ai",
								slug: "filesystem",
								qualifiedName: "@smithery-ai/filesystem",
								displayName: "Filesystem",
								description: "File access",
								useCount: 1,
							},
						],
					});
				}
				return Response.json({
					qualifiedName: "@smithery-ai/filesystem",
					displayName: "Filesystem",
					description: "File access",
					connections: [{ type: "http", deploymentUrl: "https://mcp.example" }],
					tools: [],
				});
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const results = await searchSmitheryRegistry("filesystem", { limit: 1 });

		expect(results[0]?.name).toBe("smithery-ai/filesystem");
		expect(signals).toHaveLength(2);
		expect(signals.every(signal => signal instanceof AbortSignal)).toBe(true);
	});

	it("resolves and applies the current keyword transform for every search page", async () => {
		const urls: URL[] = [];
		let resolverCalls = 0;
		const fetchStub = Object.assign(
			async (input: FetchInput) => {
				const url = new URL(String(input));
				urls.push(url);
				if (url.searchParams.get("page") === "2") {
					return Response.json({ servers: [] });
				}
				return Response.json({
					servers: Array.from({ length: 20 }, (_, index) => ({
						id: `unrelated-${index}`,
						qualifiedName: `@smithery-ai/unrelated-${index}`,
						displayName: `Unrelated ${index}`,
					})),
				});
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const results = await searchSmitheryRegistry(" raw secret ", {
			limit: 1,
			resolveProviderTextTransform: () => {
				const pageAttempt = ++resolverCalls;
				return text => `safe-${pageAttempt}-${text}`;
			},
		});

		expect(results).toEqual([]);
		expect(resolverCalls).toBe(2);
		expect(urls.map(url => url.searchParams.get("q"))).toEqual([
			"safe-1-raw secret",
			"safe-2-raw secret",
		]);
	});

	it("fails closed before fetch when the keyword transform rejects", async () => {
		const rawKeyword = "never-send-this-keyword";
		let fetchCalls = 0;
		const fetchStub = Object.assign(
			async () => {
				fetchCalls++;
				return Response.json({ servers: [] });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		let failure: unknown;
		try {
			await searchSmitheryRegistry(rawKeyword, {
				resolveProviderTextTransform: () => () => {
					throw new Error(rawKeyword);
				},
			});
		} catch (error) {
			failure = error;
		}

		expect(fetchCalls).toBe(0);
		expect(String(failure)).toBe("Error: Smithery registry search confidentiality transform failed.");
		expect(String(failure)).not.toContain(rawKeyword);
	});
});
