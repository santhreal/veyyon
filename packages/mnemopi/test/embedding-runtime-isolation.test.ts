import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
	embed,
	embedQuery,
	getEmbeddingQueryCacheKeysForTests,
	resetEmbeddingProviderForTests,
	setLocalModelInitializerForTests,
} from "@veyyon/mnemopi/core/embeddings";
import {
	type MnemopiProviderTextSanitizer,
	type ResolvedMnemopiRuntimeOptions,
	withMnemopiRuntimeOptions,
} from "@veyyon/mnemopi/core/runtime-options";
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
});
