import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { getFastembedCacheDir } from "@veyyon/utils";
import "./setup";
import {
	available,
	availableApi,
	embed,
	embedQuery,
	getEmbeddingApiCallCountForTests,
	resetEmbeddingProviderForTests,
	setEmbeddingProviderForTests,
	setLocalModelInitializerForTests,
} from "@veyyon/mnemopi/core/embeddings";
import { Mnemopi } from "@veyyon/mnemopi/core/memory";
import { withMnemopiRuntimeOptions } from "@veyyon/mnemopi/core/runtime-options";
import packageJson from "../package.json" with { type: "json" };

const ENV_KEYS = [
	"NODE_ENV",
	"BUN_ENV",
	"MNEMOPI_NO_EMBEDDINGS",
	"MNEMOPI_EMBEDDING_MODEL",
	"MNEMOPI_EMBEDDING_API_URL",
	"MNEMOPI_EMBEDDING_API_KEY",
	"MNEMOPI_EMBEDDING_MAX_INPUT_CHARS",
	"OPENROUTER_BASE_URL",
	"OPENROUTER_API_KEY",
	"OPENAI_API_KEY",
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

function snapshotEnv(): Partial<Record<EnvKey, string>> {
	const snapshot: Partial<Record<EnvKey, string>> = {};
	for (const key of ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) {
			snapshot[key] = value;
		}
	}
	return snapshot;
}

function restoreEnv(snapshot: Partial<Record<EnvKey, string>>): void {
	for (const key of ENV_KEYS) {
		const value = snapshot[key];
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

async function withEnv<T>(updates: Partial<Record<EnvKey, string | undefined>>, fn: () => Promise<T> | T): Promise<T> {
	const snapshot = snapshotEnv();
	try {
		for (const key of ENV_KEYS) {
			if (key in updates) {
				const value = updates[key];
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
		}
		resetEmbeddingProviderForTests();
		return await fn();
	} finally {
		restoreEnv(snapshot);
		resetEmbeddingProviderForTests();
	}
}

afterEach(() => {
	resetEmbeddingProviderForTests();
});

/** Wrap a synchronous matrix function as the `AsyncIterable<number[][]>` a provider now returns. */
function streamRows(
	rows: (texts: readonly string[]) => number[][],
): (texts: readonly string[]) => AsyncGenerator<number[][]> {
	return async function* (texts) {
		yield rows(texts);
	};
}

describe("optional embeddings", () => {
	it("falls back cleanly when embeddings are disabled", async () => {
		await withEnv({ MNEMOPI_NO_EMBEDDINGS: "1" }, async () => {
			setEmbeddingProviderForTests({ embed: streamRows(() => [[1, 2, 3]]), available: () => true });

			expect(await available()).toBe(false);
			expect(await embedQuery("hello")).toBeNull();
			expect(await embed(["hello"])).toBeNull();
		});
	});

	it("uses a fake provider and caches single-query embeddings", async () => {
		await withEnv({ MNEMOPI_NO_EMBEDDINGS: undefined }, async () => {
			let calls = 0;
			setEmbeddingProviderForTests({
				embed: streamRows(texts => {
					calls += 1;
					return texts.map(text => [text.length, text.charCodeAt(0) || 0]);
				}),
				available: () => true,
			});

			expect(await available()).toBe(true);
			expect(await embedQuery("cache me")).toEqual(new Float32Array([8, 99]));
			expect(await embedQuery("cache me")).toEqual(new Float32Array([8, 99]));
			expect(calls).toBe(1);
		});
	});

	it("clips an oversized embedding input into a head/tail window before embedding", async () => {
		await withEnv({ MNEMOPI_NO_EMBEDDINGS: undefined, MNEMOPI_EMBEDDING_MAX_INPUT_CHARS: "40" }, async () => {
			let received: readonly string[] = [];
			setEmbeddingProviderForTests({
				embed: streamRows(texts => {
					received = texts;
					return texts.map(text => [text.length, text.charCodeAt(0) || 0]);
				}),
				available: () => true,
			});

			const result = await embed([`${"H".repeat(100)}${"T".repeat(100)}`]);
			// 40-char budget: 15 head chars + the 9-char elision marker + 16 tail chars.
			expect(received[0]).toBe(`${"H".repeat(15)}\n\n[...]\n\n${"T".repeat(16)}`);
			expect(result).toEqual([new Float32Array([40, "H".charCodeAt(0)])]);
		});
	});

	it("falls back to a tail-only clip when the window is too small to split", async () => {
		await withEnv({ MNEMOPI_NO_EMBEDDINGS: undefined, MNEMOPI_EMBEDDING_MAX_INPUT_CHARS: "20" }, async () => {
			let received: readonly string[] = [];
			setEmbeddingProviderForTests({
				embed: streamRows(texts => {
					received = texts;
					return texts.map(text => [text.length, text.charCodeAt(0) || 0]);
				}),
				available: () => true,
			});

			const result = await embed([`${"H".repeat(100)}${"T".repeat(100)}`]);
			// A 20-char window cannot fit the marker plus a useful head, so only the tail is kept.
			expect(received[0]).toBe("T".repeat(20));
			expect(result).toEqual([new Float32Array([20, "T".charCodeAt(0)])]);
		});
	});

	it("reports API availability from the configured embedding API key", async () => {
		await withEnv(
			{ MNEMOPI_EMBEDDING_API_KEY: "sk-configured", OPENROUTER_API_KEY: undefined, OPENAI_API_KEY: undefined },
			() => {
				expect(availableApi()).toBe(true);
			},
		);
		await withEnv(
			{ MNEMOPI_EMBEDDING_API_KEY: undefined, OPENROUTER_API_KEY: undefined, OPENAI_API_KEY: undefined },
			() => {
				expect(availableApi()).toBe(false);
			},
		);
	});

	it("treats a provider without an availability probe as available, and a throwing probe as not", async () => {
		await withEnv({ MNEMOPI_NO_EMBEDDINGS: undefined }, async () => {
			setEmbeddingProviderForTests({ embed: streamRows(() => [[1]]) });
			expect(await available()).toBe(true);

			setEmbeddingProviderForTests({
				embed: streamRows(() => [[1]]),
				available: () => {
					throw new Error("probe failed");
				},
			});
			expect(await available()).toBe(false);
		});
	});

	it("returns null instead of throwing when the provider fails", async () => {
		await withEnv({ MNEMOPI_NO_EMBEDDINGS: undefined }, async () => {
			setEmbeddingProviderForTests({
				embed() {
					throw new Error("provider unavailable");
				},
			});

			expect(await embed(["hello"])).toBeNull();
			expect(await embedQuery("hello")).toBeNull();
		});
	});

	it("calls an OpenAI-compatible custom embeddings endpoint without requiring an API key", async () => {
		let requests = 0;
		const server = Bun.serve({
			port: 0,
			fetch: async request => {
				requests += 1;
				expect(request.headers.get("content-type")).toBe("application/json");
				expect(request.headers.get("user-agent")).toBe(`Veyyon/${packageJson.version}`);
				expect(request.headers.get("http-referer")).toBe("https://veyyon.dev/");
				expect(request.headers.get("x-openrouter-title")).toBe("Veyyon");
				expect(request.headers.get("x-openrouter-categories")).toBe("cli-agent");
				expect(request.headers.get("x-title")).toBeNull();
				expect(request.headers.get("authorization")).toBeNull();
				expect(new URL(request.url).pathname).toBe("/embeddings");
				const payload = (await request.json()) as { model: string; input: string[] };
				expect(payload.model).toBe("openai/text-embedding-3-small");
				return Response.json({
					data: payload.input.map((text, index) => ({ embedding: [text.length, index + 1] })),
				});
			},
		});

		try {
			await withEnv(
				{
					MNEMOPI_NO_EMBEDDINGS: undefined,
					MNEMOPI_EMBEDDING_MODEL: "openai/text-embedding-3-small",
					MNEMOPI_EMBEDDING_API_URL: server.url.toString().replace(/\/+$/, ""),
					MNEMOPI_EMBEDDING_API_KEY: undefined,
					OPENROUTER_API_KEY: undefined,
					OPENAI_API_KEY: undefined,
				},
				async () => {
					expect(await available()).toBe(true);
					expect(await embed(["hi", "world"])).toEqual([new Float32Array([2, 1]), new Float32Array([5, 2])]);
					expect(getEmbeddingApiCallCountForTests()).toBe(1);
				},
			);
			expect(requests).toBe(1);
		} finally {
			server.stop(true);
		}
	});
	it("flattens async batches into one matrix", async () => {
		await withEnv({ MNEMOPI_NO_EMBEDDINGS: undefined }, async () => {
			setEmbeddingProviderForTests({
				// fastembed-shaped: an async generator yielding batches of rows.
				embed: async function* (texts) {
					for (let i = 0; i < texts.length; i += 2) {
						yield texts.slice(i, i + 2).map(text => [text.length, text.charCodeAt(0) || 0]);
					}
				},
				available: () => true,
			});
			expect(await embed(["hi", "world", "test"])).toEqual([
				new Float32Array([2, 104]),
				new Float32Array([5, 119]),
				new Float32Array([4, 116]),
			]);
		});
	});

	it("lets constructor-scoped noEmbeddings override enabled providers", async () => {
		setEmbeddingProviderForTests({
			embed: streamRows(texts => texts.map(() => [1, 2, 3])),
			available: () => true,
		});
		const memory = new Mnemopi({ noEmbeddings: true });
		try {
			const result = await withMnemopiRuntimeOptions(memory.runtimeOptions, () => embed(["hello"]));
			expect(result).toBeNull();
		} finally {
			memory.close();
		}
	});

	it("uses a constructor-scoped embedding provider", async () => {
		const memory = new Mnemopi({
			embeddings: {
				provider: streamRows(texts => texts.map(text => [text.length, text.charCodeAt(0) || 0])),
			},
		});
		try {
			const result = await withMnemopiRuntimeOptions(memory.runtimeOptions, () => embedQuery("cache me"));
			expect(result).toEqual(new Float32Array([8, 99]));
		} finally {
			memory.close();
		}
	});

	it("retries local model initialization after a transient failure", async () => {
		await withEnv(
			{
				NODE_ENV: undefined,
				BUN_ENV: undefined,
				MNEMOPI_NO_EMBEDDINGS: undefined,
				MNEMOPI_EMBEDDING_MODEL: "BAAI/bge-small-en-v1.5",
				MNEMOPI_EMBEDDING_API_URL: undefined,
				OPENROUTER_BASE_URL: undefined,
				OPENROUTER_API_KEY: undefined,
				OPENAI_API_KEY: undefined,
			},
			async () => {
				let initCalls = 0;
				const observedCacheDirs: Array<string | undefined> = [];
				setLocalModelInitializerForTests(async options => {
					initCalls += 1;
					observedCacheDirs.push(options.cacheDir);
					if (initCalls === 1) throw new Error("transient init failure");
					return {
						embed: streamRows(texts => texts.map(text => [text.length, text.charCodeAt(0) || 0])),
					};
				});

				expect(await embed(["first"])).toBeNull();
				expect(await embed(["second"])).toEqual([new Float32Array([6, 115])]);
				expect(initCalls).toBe(2);
				expect(observedCacheDirs).toEqual([getFastembedCacheDir(), getFastembedCacheDir()]);
				expect(observedCacheDirs.some(cacheDir => cacheDir?.includes(".hermes") ?? false)).toBe(false);
			},
		);
	});
});

/** A `fetch` stand-in that keeps `.preconnect` so bun's typed global stays satisfied. */
function mockFetch(handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
	return spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(handler, { preconnect: globalThis.fetch.preconnect }),
	);
}

describe("embedding API transport", () => {
	it("sends a bearer token to a runtime-scoped custom endpoint and decodes the matrix", async () => {
		let auth = "";
		let sentModel = "";
		let calls = 0;
		const spy = mockFetch((_input, init) => {
			calls += 1;
			auth = new Headers(init?.headers).get("authorization") ?? "";
			sentModel = (JSON.parse(String(init?.body)) as { model: string }).model;
			return Promise.resolve(Response.json({ data: [{ embedding: [1, 2, 3] }] }));
		});
		try {
			const result = await withMnemopiRuntimeOptions(
				{
					embeddings: {
						model: "openai/text-embedding-3-small",
						apiKey: "sk-active",
						apiUrl: "http://active.test/v1",
					},
				},
				() => embed(["hi"]),
			);
			expect(result).toEqual([new Float32Array([1, 2, 3])]);
			// Active-scope apiKey and apiUrl override the environment, and a non-empty key sets the header.
			expect(auth).toBe("Bearer sk-active");
			expect(sentModel).toBe("openai/text-embedding-3-small");
			expect(calls).toBe(1);
			expect(getEmbeddingApiCallCountForTests()).toBe(1);
		} finally {
			spy.mockRestore();
		}
	});

	it("returns null when the embedding API responds with a non-retryable client error", async () => {
		const spy = mockFetch(() => Promise.resolve(new Response("bad request", { status: 400 })));
		try {
			const result = await withEnv(
				{
					MNEMOPI_NO_EMBEDDINGS: undefined,
					MNEMOPI_EMBEDDING_MODEL: "openai/text-embedding-3-small",
					MNEMOPI_EMBEDDING_API_URL: "http://custom.test/v1",
					MNEMOPI_EMBEDDING_API_KEY: "sk-x",
				},
				() => embed(["hi"]),
			);
			expect(result).toBeNull();
		} finally {
			spy.mockRestore();
		}
	});

	it("returns null when the embedding API omits the data field", async () => {
		const spy = mockFetch(() => Promise.resolve(Response.json({})));
		try {
			const result = await withEnv(
				{
					MNEMOPI_NO_EMBEDDINGS: undefined,
					MNEMOPI_EMBEDDING_MODEL: "openai/text-embedding-3-small",
					MNEMOPI_EMBEDDING_API_URL: "http://custom.test/v1",
					MNEMOPI_EMBEDDING_API_KEY: "sk-x",
				},
				() => embed(["hi"]),
			);
			expect(result).toBeNull();
		} finally {
			spy.mockRestore();
		}
	});

	it("returns null when a 401 raises a provider error a static key cannot refresh", async () => {
		const spy = mockFetch(() => Promise.resolve(new Response("nope", { status: 401 })));
		try {
			const result = await withEnv(
				{
					MNEMOPI_NO_EMBEDDINGS: undefined,
					MNEMOPI_EMBEDDING_MODEL: "openai/text-embedding-3-small",
					MNEMOPI_EMBEDDING_API_URL: "http://custom.test/v1",
					MNEMOPI_EMBEDDING_API_KEY: "sk-bad",
				},
				() => embed(["hi"]),
			);
			expect(result).toBeNull();
		} finally {
			spy.mockRestore();
		}
	});

	it("never contacts the network for an OpenRouter API model without a configured key", async () => {
		const spy = mockFetch(() => Promise.reject(new Error("fetch should not run")));
		try {
			const result = await withEnv(
				{
					MNEMOPI_NO_EMBEDDINGS: undefined,
					MNEMOPI_EMBEDDING_MODEL: "openai/text-embedding-3-small",
					MNEMOPI_EMBEDDING_API_URL: undefined,
					OPENROUTER_BASE_URL: undefined,
					MNEMOPI_EMBEDDING_API_KEY: undefined,
					OPENROUTER_API_KEY: undefined,
					OPENAI_API_KEY: undefined,
				},
				() => embed(["hi"]),
			);
			expect(result).toBeNull();
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
});

describe("embedding availability branches", () => {
	it("reports API availability for an OpenRouter model from the configured key", async () => {
		await withEnv(
			{
				MNEMOPI_NO_EMBEDDINGS: undefined,
				MNEMOPI_EMBEDDING_MODEL: "openai/text-embedding-3-small",
				MNEMOPI_EMBEDDING_API_URL: undefined,
				OPENROUTER_BASE_URL: undefined,
				MNEMOPI_EMBEDDING_API_KEY: "sk-present",
				OPENROUTER_API_KEY: undefined,
				OPENAI_API_KEY: undefined,
			},
			async () => {
				expect(await available()).toBe(true);
			},
		);
		await withEnv(
			{
				MNEMOPI_NO_EMBEDDINGS: undefined,
				MNEMOPI_EMBEDDING_MODEL: "openai/text-embedding-3-small",
				MNEMOPI_EMBEDDING_API_URL: undefined,
				OPENROUTER_BASE_URL: undefined,
				MNEMOPI_EMBEDDING_API_KEY: undefined,
				OPENROUTER_API_KEY: undefined,
				OPENAI_API_KEY: undefined,
			},
			async () => {
				expect(await available()).toBe(false);
			},
		);
	});

	it("reports availability from a constructor-scoped provider", async () => {
		const memory = new Mnemopi({ embeddings: { provider: streamRows(() => [[1]]) } });
		try {
			// A provider with no availability probe counts as available through the active-scope branch.
			expect(await withMnemopiRuntimeOptions(memory.runtimeOptions, () => available())).toBe(true);
		} finally {
			memory.close();
		}
	});

	it("reports the local fastembed path unavailable inside a test runtime", async () => {
		await withEnv(
			{
				NODE_ENV: "test",
				BUN_ENV: undefined,
				MNEMOPI_NO_EMBEDDINGS: undefined,
				MNEMOPI_EMBEDDING_MODEL: "BAAI/bge-small-en-v1.5",
				MNEMOPI_EMBEDDING_API_URL: undefined,
				OPENROUTER_BASE_URL: undefined,
				MNEMOPI_EMBEDDING_API_KEY: undefined,
				OPENROUTER_API_KEY: undefined,
				OPENAI_API_KEY: undefined,
			},
			async () => {
				expect(await available()).toBe(false);
			},
		);
	});
});

describe("embedding cache-scope and local-model paths", () => {
	it("reuses the provider cache-scope id across distinct queries", async () => {
		const memory = new Mnemopi({
			embeddings: { provider: streamRows(texts => texts.map(text => [text.length])) },
		});
		try {
			await withMnemopiRuntimeOptions(memory.runtimeOptions, async () => {
				expect(await embedQuery("first")).toEqual(new Float32Array([5]));
				// A second distinct query recomputes the key and reuses the id already assigned to the provider.
				expect(await embedQuery("second")).toEqual(new Float32Array([6]));
			});
		} finally {
			memory.close();
		}
	});

	it("returns null when the constructor-scoped provider throws", async () => {
		const memory = new Mnemopi({
			embeddings: {
				provider: () => {
					throw new Error("scoped provider down");
				},
			},
		});
		try {
			expect(await withMnemopiRuntimeOptions(memory.runtimeOptions, () => embed(["hi"]))).toBeNull();
		} finally {
			memory.close();
		}
	});

	it("serves a repeated single-text embed from the query cache and reuses the loaded model", async () => {
		await withEnv(
			{
				NODE_ENV: undefined,
				BUN_ENV: undefined,
				MNEMOPI_NO_EMBEDDINGS: undefined,
				MNEMOPI_EMBEDDING_MODEL: "BAAI/bge-small-en-v1.5",
				MNEMOPI_EMBEDDING_API_URL: undefined,
				OPENROUTER_BASE_URL: undefined,
				MNEMOPI_EMBEDDING_API_KEY: undefined,
				OPENROUTER_API_KEY: undefined,
				OPENAI_API_KEY: undefined,
			},
			async () => {
				let embedCalls = 0;
				setLocalModelInitializerForTests(async () => ({
					embed: streamRows(texts => {
						embedCalls += 1;
						return texts.map(text => [text.length]);
					}),
				}));

				expect(await embed(["repeat"])).toEqual([new Float32Array([6])]);
				// The second identical embed short-circuits on the query cache; the model is not re-invoked.
				expect(await embed(["repeat"])).toEqual([new Float32Array([6])]);
				expect(embedCalls).toBe(1);
				// A different single text misses the cache but reuses the already-loaded model promise.
				expect(await embed(["different"])).toEqual([new Float32Array([9])]);
				expect(embedCalls).toBe(2);
			},
		);
	});

	it("returns null for a local model name fastembed does not recognize outside a test runtime", async () => {
		await withEnv(
			{
				NODE_ENV: undefined,
				BUN_ENV: undefined,
				MNEMOPI_NO_EMBEDDINGS: undefined,
				MNEMOPI_EMBEDDING_MODEL: "acme/mystery-embedder",
				MNEMOPI_EMBEDDING_API_URL: undefined,
				OPENROUTER_BASE_URL: undefined,
				MNEMOPI_EMBEDDING_API_KEY: undefined,
				OPENROUTER_API_KEY: undefined,
				OPENAI_API_KEY: undefined,
			},
			async () => {
				expect(await embed(["hi"])).toBeNull();
			},
		);
	});

	it("returns null when the loaded local model throws during inference", async () => {
		await withEnv(
			{
				NODE_ENV: undefined,
				BUN_ENV: undefined,
				MNEMOPI_NO_EMBEDDINGS: undefined,
				MNEMOPI_EMBEDDING_MODEL: "BAAI/bge-small-en-v1.5",
				MNEMOPI_EMBEDDING_API_URL: undefined,
				OPENROUTER_BASE_URL: undefined,
				MNEMOPI_EMBEDDING_API_KEY: undefined,
				OPENROUTER_API_KEY: undefined,
				OPENAI_API_KEY: undefined,
			},
			async () => {
				setLocalModelInitializerForTests(async () => ({
					embed: () => {
						throw new Error("inference blew up");
					},
				}));
				expect(await embed(["boom"])).toBeNull();
			},
		);
	});
});
