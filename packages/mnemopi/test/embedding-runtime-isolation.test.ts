import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
	embed,
	embedQuery,
	getEmbeddingQueryCacheKeysForTests,
	resetEmbeddingProviderForTests,
	setEmbeddingProviderForTests,
	setLocalModelInitializerForTests,
} from "@veyyon/mnemopi/core/embeddings";
import {
	type MnemopiProviderTextSanitizer,
	type ResolvedMnemopiRuntimeOptions,
	withMnemopiRuntimeOptions,
} from "@veyyon/mnemopi/core/runtime-options";
import { logger } from "@veyyon/utils";
import { enterIsolatedConfigRoot } from "../../utils/test/helpers/isolated-config-root";

const OLD_ENV = { ...process.env };

function restoreEnv(): void {
	for (const key in process.env) {
		if (!(key in OLD_ENV)) delete process.env[key];
	}
	for (const key in OLD_ENV) {
		const value = OLD_ENV[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

function localRows(value: number) {
	return async function* (texts: string[]) {
		yield texts.map(() => [value]);
	};
}

afterEach(() => {
	restoreEnv();
	resetEmbeddingProviderForTests();
});

describe("embedding runtime identity isolation", () => {
	/** Why: one process-global model promise aliases concurrent runtime scopes and lets one failed identity evict another. */
	it("initializes concurrent model scopes independently and removes only the failed key", async () => {
		const isolated = enterIsolatedConfigRoot("mnemopi-embedding-runtime");
		const debugSpy = spyOn(logger, "debug").mockImplementation(() => undefined);
		try {
		process.env.NODE_ENV = "";
		process.env.BUN_ENV = "";
		delete process.env.MNEMOPI_NO_EMBEDDINGS;
		delete process.env.MNEMOPI_EMBEDDING_API_URL;
		delete process.env.MNEMOPI_EMBEDDINGS_VIA_API;

		const started: string[] = [];
		const calls = new Map<string, number>();
		const gate = Promise.withResolvers<void>();
		let rejectSmallOnce = true;
		setLocalModelInitializerForTests(async options => {
			const model = String(options.model);
			started.push(model);
			calls.set(model, (calls.get(model) ?? 0) + 1);
			if (started.length === 2) gate.resolve();
			await gate.promise;
			if (model === "fast-bge-small-en-v1.5" && rejectSmallOnce) {
				rejectSmallOnce = false;
				throw new Error("small model failed once");
			}
			return {
				embed: localRows(model === "fast-bge-small-en-v1.5" ? 1 : 2),
			};
		});

		const small: ResolvedMnemopiRuntimeOptions = {
			embeddings: { model: "BAAI/bge-small-en-v1.5" },
		};
		const base: ResolvedMnemopiRuntimeOptions = {
			embeddings: { model: "BAAI/bge-base-en-v1.5" },
		};
		const [smallFirst, baseFirst] = await Promise.all([
			withMnemopiRuntimeOptions(small, () => embed(["small first"])),
			withMnemopiRuntimeOptions(base, () => embed(["base first"])),
		]);

		expect(new Set(started)).toEqual(new Set(["fast-bge-small-en-v1.5", "fast-bge-base-en-v1.5"]));
		expect(smallFirst).toBeNull();
		expect(baseFirst).toEqual([new Float32Array([2])]);

		const smallSecond = await withMnemopiRuntimeOptions(small, () => embed(["small second"]));
		const baseSecond = await withMnemopiRuntimeOptions(base, () => embed(["base second"]));
		expect(smallSecond).toEqual([new Float32Array([1])]);
		expect(baseSecond).toEqual([new Float32Array([2])]);
		expect(calls.get("fast-bge-small-en-v1.5")).toBe(2);
		expect(calls.get("fast-bge-base-en-v1.5")).toBe(1);
		} finally {
			debugSpy.mockRestore();
			isolated.restore();
		}
	});

	/** Why: query vectors change with transport/cap/sanitizer behavior, while unversioned live closures are unsafe to cache. */
	it("keys query vectors by URL, cap, and stable sanitizer epoch and disables unsafe live caching", async () => {
		let fetchCalls = 0;
		const urls: string[] = [];
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: string | URL | Request) => {
					fetchCalls += 1;
					urls.push(String(input));
					return Response.json({ data: [{ embedding: [fetchCalls] }] });
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);
		try {
			const stable = ((text: string) => text.replaceAll("cache-secret", "[SAFE]")) as MnemopiProviderTextSanitizer;
			stable.epoch = "sanitizer-v1";
			const runtime: ResolvedMnemopiRuntimeOptions = {
				embeddings: {
					model: "openai/text-embedding-3-small",
					apiUrl: "http://cache-a.test/v1",
					apiKey: "key",
					maxInputChars: 100,
					sanitizeProviderText: stable,
				},
			};

			expect(await withMnemopiRuntimeOptions(runtime, () => embedQuery("stable cache-secret"))).toEqual(
				new Float32Array([1]),
			);
			expect(await withMnemopiRuntimeOptions(runtime, () => embedQuery("stable cache-secret"))).toEqual(
				new Float32Array([1]),
			);
			expect(fetchCalls).toBe(1);

			if (runtime.embeddings === undefined) throw new Error("missing embedding runtime options");
			runtime.embeddings.maxInputChars = 80;
			expect(await withMnemopiRuntimeOptions(runtime, () => embedQuery("stable cache-secret"))).toEqual(
				new Float32Array([2]),
			);
			runtime.embeddings.apiUrl = "http://cache-b.test/v1";
			expect(await withMnemopiRuntimeOptions(runtime, () => embedQuery("stable cache-secret"))).toEqual(
				new Float32Array([3]),
			);
			stable.epoch = "sanitizer-v2";
			expect(await withMnemopiRuntimeOptions(runtime, () => embedQuery("stable cache-secret"))).toEqual(
				new Float32Array([4]),
			);
			expect(await withMnemopiRuntimeOptions(runtime, () => embedQuery("stable cache-secret"))).toEqual(
				new Float32Array([4]),
			);
			expect(fetchCalls).toBe(4);

			const unversioned: MnemopiProviderTextSanitizer = text => text.replaceAll("cache-secret", "[LIVE]");
			runtime.embeddings.sanitizeProviderText = unversioned;
			expect(await withMnemopiRuntimeOptions(runtime, () => embedQuery("uncached cache-secret"))).toEqual(
				new Float32Array([5]),
			);
			expect(await withMnemopiRuntimeOptions(runtime, () => embedQuery("uncached cache-secret"))).toEqual(
				new Float32Array([6]),
			);

			runtime.embeddings.sanitizeProviderText = stable;
			runtime.embeddings.apiUrl = undefined;
			process.env.MNEMOPI_EMBEDDING_API_URL = "http://env-cache-a.test/v1";
			expect(await withMnemopiRuntimeOptions(runtime, () => embedQuery("effective env URL"))).toEqual(
				new Float32Array([7]),
			);
			process.env.MNEMOPI_EMBEDDING_API_URL = "http://env-cache-b.test/v1";
			expect(await withMnemopiRuntimeOptions(runtime, () => embedQuery("effective env URL"))).toEqual(
				new Float32Array([8]),
			);
			expect(urls).toContain("http://env-cache-a.test/v1/embeddings");
			expect(urls).toContain("http://env-cache-b.test/v1/embeddings");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	/**
	 * Why: raw cache keys expose retained queries in heap dumps, and returning
	 * the cached Float32Array by reference lets one caller corrupt later recall.
	 */
	it("HMACs query cache text and isolates cached vectors from caller mutation", async () => {
		let providerCalls = 0;
		const runtime: ResolvedMnemopiRuntimeOptions = {
			embeddings: {
				provider: {
					embed: async function* (texts) {
						providerCalls += 1;
						yield texts.map(() => [providerCalls]);
					},
				},
			},
		};
		const firstQuery = "low-entropy-sensitive-query";
		const secondQuery = "different-sensitive-query";

		const first = await withMnemopiRuntimeOptions(runtime, () => embedQuery(firstQuery));
		if (first === null) throw new Error("expected first query vector");
		first[0] = 999;
		const firstHit = await withMnemopiRuntimeOptions(runtime, () => embedQuery(firstQuery));
		expect(firstHit).toEqual(new Float32Array([1]));
		if (firstHit === null) throw new Error("expected cached query vector");
		firstHit[0] = 777;
		expect(await withMnemopiRuntimeOptions(runtime, () => embedQuery(firstQuery))).toEqual(new Float32Array([1]));

		expect(await withMnemopiRuntimeOptions(runtime, () => embedQuery(secondQuery))).toEqual(new Float32Array([2]));
		expect(await withMnemopiRuntimeOptions(runtime, () => embedQuery(secondQuery))).toEqual(new Float32Array([2]));
		expect(providerCalls).toBe(2);

		const keys = getEmbeddingQueryCacheKeysForTests();
		expect(keys).toHaveLength(2);
		expect(new Set(keys).size).toBe(2);
		for (const key of keys) {
			expect(key).not.toContain(firstQuery);
			expect(key).not.toContain(secondQuery);
			expect(key.split("::").at(-1)).toMatch(/^[0-9a-f]{64}$/);
		}
	});
	/**
	 * Why: clearing a nested runtime scope must not inherit an outer tenant's provider,
	 * or an unconfigured memory instance can send text to the wrong embedding backend.
	 */
	it("clears an outer provider when an explicit undefined runtime scope is entered", async () => {
		setEmbeddingProviderForTests({
			embed: async function* (texts) {
				yield texts.map(() => [9]);
			},
		});
		const outer: ResolvedMnemopiRuntimeOptions = {
			embeddings: {
				provider: {
					embed: async function* (texts) {
						yield texts.map(() => [1]);
					},
				},
			},
		};

		await withMnemopiRuntimeOptions(outer, async () => {
			expect(await embedQuery("outer provider query")).toEqual(new Float32Array([1]));
			expect(await withMnemopiRuntimeOptions(undefined, () => embedQuery("cleared provider query"))).toEqual(
				new Float32Array([9]),
			);
		});
	});

	/**
	 * Why: a provider swap clears completed entries, but an older in-flight request
	 * must not repopulate the new provider's cache after that invalidation boundary.
	 */
	it("does not publish an in-flight vector across provider invalidation", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let replacementCalls = 0;
		setEmbeddingProviderForTests({
			embed: async function* () {
				started.resolve();
				await release.promise;
				yield [[1]];
			},
		});

		const staleRequest = embedQuery("provider swap race");
		await started.promise;
		setEmbeddingProviderForTests({
			embed: async function* () {
				replacementCalls += 1;
				yield [[2]];
			},
		});
		release.resolve();

		expect(await staleRequest).toEqual(new Float32Array([1]));
		expect(await embedQuery("provider swap race")).toEqual(new Float32Array([2]));
		expect(replacementCalls).toBe(1);
	});

	/**
	 * Why: credential-scoped proxy endpoints can resolve the same model alias
	 * differently, so one tenant's cached vector must never satisfy another tenant.
	 */
	it("separates API query vectors by credential identity", async () => {
		let calls = 0;
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (_input: string | URL | Request, init?: RequestInit) => {
					calls += 1;
					const authorization = new Headers(init?.headers).get("Authorization");
					return Response.json({ data: [{ embedding: [authorization === "Bearer tenant-a" ? 1 : 2] }] });
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);
		const runtime = (apiKey: string): ResolvedMnemopiRuntimeOptions => ({
			embeddings: {
				model: "openai/text-embedding-3-small",
				apiUrl: "http://tenant-embedding.test/v1",
				apiKey,
			},
		});
		try {
			expect(await withMnemopiRuntimeOptions(runtime("tenant-a"), () => embedQuery("tenant query"))).toEqual(
				new Float32Array([1]),
			);
			expect(await withMnemopiRuntimeOptions(runtime("tenant-b"), () => embedQuery("tenant query"))).toEqual(
				new Float32Array([2]),
			);
			expect(calls).toBe(2);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	/**
	 * Why: simultaneous misses for one cache identity must share one physical request;
	 * otherwise completion order makes both returned vectors and the stored winner nondeterministic.
	 */
	it("coalesces concurrent misses for the same provider identity", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let calls = 0;
		setEmbeddingProviderForTests({
			embed: async function* () {
				const call = ++calls;
				started.resolve();
				await release.promise;
				yield [[call]];
			},
		});

		const first = embedQuery("concurrent cache miss");
		const second = embedQuery("concurrent cache miss");
		await started.promise;
		release.resolve();

		expect(await Promise.all([first, second])).toEqual([
			new Float32Array([1]),
			new Float32Array([1]),
		]);
		expect(calls).toBe(1);
		expect(await embedQuery("concurrent cache miss")).toEqual(new Float32Array([1]));
	});

	/**
	 * Why: empty, overlong, or non-finite provider matrices are protocol failures;
	 * accepting them lets callers persist vectors that do not correspond to inputs.
	 */
	it("rejects malformed custom-provider matrices deterministically", async () => {
		const warnSpy = spyOn(logger, "warn").mockImplementation(() => undefined);
		const outputs = [[], [[1], [2]], [[Number.NaN]], [[Number.MAX_VALUE]]] as const;
		for (const output of outputs) {
			setEmbeddingProviderForTests({
				embed: async function* () {
					yield output as unknown as number[][];
				},
			});
			expect(await embed(["one input"])).toBeNull();
		}
		warnSpy.mockRestore();
	});

	/**
	 * Why: an HTTP 200 with an empty data matrix is still a failed embedding call,
	 * not a successful empty result for a non-empty input batch.
	 */
	it("rejects a successful HTTP response whose matrix does not match the request", async () => {
		const warnSpy = spyOn(logger, "warn").mockImplementation(() => undefined);
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(async () => Response.json({ data: [] }), { preconnect: globalThis.fetch.preconnect }),
		);
		try {
			const runtime: ResolvedMnemopiRuntimeOptions = {
				embeddings: {
					model: "openai/text-embedding-3-small",
					apiUrl: "http://malformed-embedding.test/v1",
					apiKey: "key",
				},
			};
			expect(await withMnemopiRuntimeOptions(runtime, () => embed(["one input"]))).toBeNull();
		} finally {
			fetchSpy.mockRestore();
			warnSpy.mockRestore();
		}
	});

	/**
	 * Why: a host initializer can throw before returning its promise; that failure
	 * must follow the same null fallback and retryable cache path as an async rejection.
	 */
	it("contains a synchronous local-model initializer failure", async () => {
		const isolated = enterIsolatedConfigRoot("mnemopi-sync-initializer");
		const debugSpy = spyOn(logger, "debug").mockImplementation(() => undefined);
		try {
			process.env.NODE_ENV = "";
			process.env.BUN_ENV = "";
			delete process.env.MNEMOPI_NO_EMBEDDINGS;
			delete process.env.MNEMOPI_EMBEDDING_API_URL;
			delete process.env.MNEMOPI_EMBEDDINGS_VIA_API;
			setLocalModelInitializerForTests(() => {
				throw new Error("initializer failed before returning");
			});

			expect(await embed(["local input"])).toBeNull();
		} finally {
			debugSpy.mockRestore();
			isolated.restore();
		}
	});
});
