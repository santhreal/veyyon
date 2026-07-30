import { afterEach, describe, expect, it, vi } from "bun:test";
import { SmitheryRegistryError, searchSmitheryRegistry } from "./smithery-registry";

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
		expect(urls.map(url => url.searchParams.get("q"))).toEqual(["safe-1-raw secret", "safe-2-raw secret"]);
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
		expect(String(failure)).toBe(
			"ProviderTransformError: Smithery registry search confidentiality transform failed.",
		);
		expect(String(failure)).not.toContain(rawKeyword);
	});
	/**
	 * The registry used to fetch details for every candidate before slicing the
	 * result list, producing duplicate work and an unbounded request burst even
	 * after the requested limit was satisfied.
	 */
	it("stops detail lookups once the requested result limit is satisfied", async () => {
		const detailUrls: string[] = [];
		const fetchStub = Object.assign(
			async (input: FetchInput) => {
				const url = new URL(String(input));
				if (url.search) {
					return Response.json({
						servers: Array.from({ length: 3 }, (_, index) => ({
							id: `srv_${index}`,
							namespace: "smithery-ai",
							slug: `filesystem-${index}`,
							qualifiedName: `@smithery-ai/filesystem-${index}`,
							displayName: `Filesystem ${index}`,
						})),
					});
				}
				detailUrls.push(url.pathname);
				const name = url.pathname.split("/").at(-1);
				return Response.json({
					qualifiedName: `@smithery-ai/${name}`,
					displayName: name,
					connections: [{ type: "http", deploymentUrl: `https://${name}.example` }],
				});
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const results = await searchSmitheryRegistry("filesystem", { limit: 1 });

		expect(results).toHaveLength(1);
		expect(detailUrls).toEqual(["/servers/smithery-ai/filesystem-0"]);
	});

	/**
	 * A malformed search page previously escaped as an incidental TypeError
	 * while spreading `servers`; callers need a stable upstream failure status.
	 */
	it("reports malformed search pages as a 502 registry error", async () => {
		const fetchStub = Object.assign(async () => Response.json({ servers: {} }), {
			preconnect: globalThis.fetch.preconnect,
		});
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		let failure: unknown;
		try {
			await searchSmitheryRegistry("filesystem", { limit: 1 });
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(SmitheryRegistryError);
		expect(failure).toMatchObject({ status: 502 });
	});

	/**
	 * Detail HTTP failures were treated like missing aliases, retried under
	 * every candidate path, and finally returned as an empty successful search.
	 * The original status must propagate without duplicate alias requests.
	 */
	it("propagates detail HTTP status without retrying alternate aliases", async () => {
		let detailRequests = 0;
		const fetchStub = Object.assign(
			async (input: FetchInput) => {
				const url = new URL(String(input));
				if (url.search) {
					return Response.json({
						servers: [
							{
								id: "srv_1",
								namespace: "smithery-ai",
								slug: "filesystem",
								qualifiedName: "@smithery-ai/filesystem",
								displayName: "Filesystem",
							},
						],
					});
				}
				detailRequests++;
				return new Response("rate limited", { status: 429 });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		let failure: unknown;
		try {
			await searchSmitheryRegistry("filesystem", { limit: 1 });
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(SmitheryRegistryError);
		expect(failure).toMatchObject({ status: 429 });
		expect(detailRequests).toBe(1);
	});

	/**
	 * A pre-cancelled registry search used to invoke fetch and relied on the
	 * transport to notice its signal. Cancellation must prevent every outbound
	 * request and preserve the caller's exact reason.
	 */
	it("does not issue requests for a pre-cancelled search", async () => {
		let fetchCalls = 0;
		const fetchStub = Object.assign(
			async () => {
				fetchCalls++;
				return Response.json({ servers: [] });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
		const controller = new AbortController();
		const reason = new Error("cancel registry search");
		controller.abort(reason);

		await expect(searchSmitheryRegistry("filesystem", { signal: controller.signal })).rejects.toBe(reason);
		expect(fetchCalls).toBe(0);
	});

	/**
	 * A caller may intentionally abort with a TimeoutError reason. The registry
	 * previously confused that caller cancellation with its own ten-second
	 * deadline and replaced the exact reason with a status-0 registry error.
	 */
	it("preserves caller cancellation whose reason is named TimeoutError", async () => {
		const requestStarted = Promise.withResolvers<AbortSignal>();
		const fetchStub = Object.assign(
			async (_input: FetchInput, init?: FetchInit) => {
				const signal = init?.signal as AbortSignal;
				requestStarted.resolve(signal);
				return new Promise<Response>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
		const controller = new AbortController();
		const reason = new DOMException("caller deadline", "TimeoutError");
		const search = searchSmitheryRegistry("filesystem", { signal: controller.signal });
		await requestStarted.promise;

		controller.abort(reason);

		await expect(search).rejects.toBe(reason);
	});

	/**
	 * Non-object entries in an otherwise valid JSON page used to crash identity
	 * filtering with a TypeError. A malformed upstream page must have the same
	 * deterministic 502 status as other malformed registry payloads.
	 */
	it("reports malformed search entries as a 502 registry error", async () => {
		const fetchStub = Object.assign(async () => Response.json({ servers: [null] }), {
			preconnect: globalThis.fetch.preconnect,
		});
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		let failure: unknown;
		try {
			await searchSmitheryRegistry("filesystem", { limit: 1 });
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(SmitheryRegistryError);
		expect(failure).toMatchObject({ status: 502 });
	});

	/**
	 * Structurally malformed detail JSON previously escaped from result
	 * normalization as a raw TypeError. The adapter must translate malformed
	 * upstream details into its stable 502 failure contract.
	 */
	it("reports malformed detail structures as a 502 registry error", async () => {
		const fetchStub = Object.assign(
			async (input: FetchInput) => {
				const url = new URL(String(input));
				if (url.search) {
					return Response.json({
						servers: [
							{
								id: "srv_1",
								namespace: "smithery-ai",
								slug: "filesystem",
								qualifiedName: "@smithery-ai/filesystem",
								displayName: "Filesystem",
							},
						],
					});
				}
				return Response.json({
					qualifiedName: "@smithery-ai/filesystem",
					connections: {},
				});
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		let failure: unknown;
		try {
			await searchSmitheryRegistry("filesystem", { limit: 1 });
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(SmitheryRegistryError);
		expect(failure).toMatchObject({ status: 502 });
	});

	/**
	 * Smithery caps pageSize at 100. Doubling a requested limit of 100 used to
	 * emit pageSize=200, making a valid local limit produce an invalid registry
	 * request instead of a deterministic capped page.
	 */
	it("caps the upstream registry page size at the documented maximum", async () => {
		const pageSizes: Array<string | null> = [];
		const fetchStub = Object.assign(
			async (input: FetchInput) => {
				const url = new URL(String(input));
				pageSizes.push(url.searchParams.get("pageSize"));
				return Response.json({ servers: [] });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		await searchSmitheryRegistry("filesystem", { limit: 100 });

		expect(pageSizes).toEqual(["100"]);
	});

	/**
	 * Detail aliases originate in registry data and may contain URL delimiters.
	 * Interpolating them raw changed the route by turning `?` into a query; each
	 * path segment must be encoded while preserving the namespace separator.
	 */
	it("encodes detail path segments without changing their route", async () => {
		let detailUrl: URL | undefined;
		const fetchStub = Object.assign(
			async (input: FetchInput) => {
				const url = new URL(String(input));
				if (url.searchParams.has("q")) {
					return Response.json({
						servers: [
							{
								id: "srv_1",
								namespace: "smithery-ai",
								slug: "filesystem?variant=bad",
								qualifiedName: "@smithery-ai/filesystem?variant=bad",
								displayName: "Filesystem",
							},
						],
					});
				}
				detailUrl = url;
				return Response.json({
					qualifiedName: "@smithery-ai/filesystem",
					connections: [{ type: "http", deploymentUrl: "https://mcp.example" }],
				});
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		await searchSmitheryRegistry("filesystem", { limit: 1 });

		expect(detailUrl?.pathname).toBe("/servers/smithery-ai/filesystem%3Fvariant%3Dbad");
		expect(detailUrl?.search).toBe("");
	});
});
