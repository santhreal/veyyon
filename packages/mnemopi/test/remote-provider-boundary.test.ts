import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { ApiKeyResolver } from "@veyyon/ai";
import {
	embed,
	embedQuery,
	resetEmbeddingProviderForTests,
	setLocalModelInitializerForTests,
} from "@veyyon/mnemopi/core/embeddings";
import { extractFactCategories } from "@veyyon/mnemopi/core/extraction";
import { callRemoteLlm, complete, summarizeMemories } from "@veyyon/mnemopi/core/local-llm";
import { withMnemopiRuntimeOptions } from "@veyyon/mnemopi/core/runtime-options";
import { withIsolatedConfigRoot } from "../../utils/test/helpers/isolated-config-root";

function redactKnown(known: ReadonlySet<string>, text: string): string {
	let sanitized = text;
	for (const secret of known) sanitized = sanitized.replaceAll(secret, "#OBFUSCATED#");
	return sanitized;
}

function mockFetch(handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
	return spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(handler, { preconnect: globalThis.fetch.preconnect }),
	);
}

afterEach(() => {
	resetEmbeddingProviderForTests();
});

describe("remote Mnemopi provider confidentiality boundaries", () => {
	it("re-resolves the LLM sanitizer after credential awaits and on an auth retry", async () => {
		const initialSecret = "MNEMOPI_INITIAL_SECRET_615032";
		const postResolveSecret = "MNEMOPI_AFTER_KEY_SECRET_615032";
		const retrySecret = "MNEMOPI_RETRY_SECRET_615032";
		const known = new Set([initialSecret]);
		const bodies: Array<{ messages: Array<{ content: string }> }> = [];
		let keyCalls = 0;
		const apiKey: ApiKeyResolver = context => {
			keyCalls += 1;
			if (context.error === undefined) known.add(postResolveSecret);
			else known.add(retrySecret);
			return context.error === undefined ? "first-key" : "refreshed-key";
		};
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			bodies.push(JSON.parse(String(init?.body)) as (typeof bodies)[number]);
			if (bodies.length === 1) return new Response("unauthorized", { status: 401 });
			return Response.json({ choices: [{ message: { content: "done" } }] });
		};
		const nestedTranscript = JSON.stringify({
			role: "user",
			content: { text: `${initialSecret} ${postResolveSecret} ${retrySecret} harmless transcript text` },
		});

		const result = await withMnemopiRuntimeOptions(
			{
				llm: {
					enabled: true,
					baseUrl: "http://mnemopi-llm.test/v1",
					apiKey,
					model: "memory-model",
					sanitizeProviderText: text => redactKnown(known, text),
				},
			},
			() => callRemoteLlm(`extract ${nestedTranscript}`, 0, { fetch: fetchMock }),
		);

		// Why: sanitation before the first key await would miss postResolveSecret,
		// while reusing that body on 401 would miss retrySecret.
		expect(result).toBe("done");
		expect(keyCalls).toBeGreaterThanOrEqual(2);
		expect(bodies).toHaveLength(2);
		expect(bodies[0]?.messages[0]?.content).not.toContain(initialSecret);
		expect(bodies[0]?.messages[0]?.content).not.toContain(postResolveSecret);
		expect(bodies[0]?.messages[0]?.content).toContain(retrySecret);
		expect(bodies[1]?.messages[0]?.content).not.toContain(initialSecret);
		expect(bodies[1]?.messages[0]?.content).not.toContain(postResolveSecret);
		expect(bodies[1]?.messages[0]?.content).not.toContain(retrySecret);
		expect(bodies[1]?.messages[0]?.content).toContain("harmless transcript text");
	});

	it("sanitizes assembled extraction and consolidation prompts at the production HTTP send", async () => {
		const secret = "MNEMOPI_PROMPT_SECRET_440";
		const sentPrompts: string[] = [];
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
			sentPrompts.push(body.messages[0]?.content ?? "");
			const content =
				sentPrompts.length === 1
					? JSON.stringify({ facts: ["The user prefers harmless summaries"] })
					: "Harmless consolidated summary.";
			return Response.json({ choices: [{ message: { content } }] });
		};
		const options = {
			llm: {
				enabled: true,
				baseUrl: "http://mnemopi-llm.test/v1",
				apiKey: "key",
				model: "memory-model",
				sanitizeProviderText: (text: string) => text.replaceAll(secret, "#OBFUSCATED#"),
			},
		};

		await withMnemopiRuntimeOptions(options, () =>
			extractFactCategories(`retained transcript ${secret} harmless extraction`, { fetch: fetchMock }),
		);
		await withMnemopiRuntimeOptions(options, () =>
			summarizeMemories([`nested transcript ${secret}`, "harmless memory"], `source ${secret}`, {
				fetch: fetchMock,
			}),
		);

		// Why: both prompt builders add surrounding instructions after receiving
		// historical text, so only an intercepted final body proves those bytes
		// cannot bypass the live boundary.
		expect(sentPrompts).toHaveLength(2);
		expect(sentPrompts.every(prompt => !prompt.includes(secret))).toBe(true);
		expect(sentPrompts[0]).toContain("harmless extraction");
		expect(sentPrompts[1]).toContain("harmless memory");
	});

	it("fails with a secret-free error when the live LLM transform rejects", async () => {
		const secret = "MNEMOPI_TRANSFORM_ERROR_SECRET_914";
		let fetchCalls = 0;
		const fetchMock = async (): Promise<Response> => {
			fetchCalls += 1;
			return Response.json({ choices: [] });
		};
		const operation = withMnemopiRuntimeOptions(
			{
				llm: {
					enabled: true,
					baseUrl: "http://mnemopi-llm.test/v1",
					apiKey: "key",
					sanitizeProviderText: () => {
						throw new Error(`do not expose ${secret}`);
					},
				},
			},
			() => callRemoteLlm(`extract ${secret}`, 0, { fetch: fetchMock }),
		);

		// Why: a transform failure may stop dispatch, but reflecting its
		// secret-bearing exception would create a second disclosure.
		await expect(operation).rejects.toThrow("Mnemopi provider text sanitization failed");
		await expect(operation).rejects.not.toThrow(secret);
		expect(fetchCalls).toBe(0);
	});

	it("sanitizes raw embedding transcripts after key resolution and after retry backoff", async () => {
		const initialSecret = "EMBED_INITIAL_SECRET_327";
		const postResolveSecret = "EMBED_AFTER_KEY_SECRET_327";
		const retrySecret = "EMBED_RETRY_SECRET_327";
		const known = new Set([initialSecret]);
		const bodies: Array<{ input: string[] }> = [];
		const apiKey: ApiKeyResolver = context => {
			if (context.error === undefined) known.add(postResolveSecret);
			return "embedding-key";
		};
		const spy = mockFetch(async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)) as (typeof bodies)[number]);
			if (bodies.length === 1) {
				known.add(retrySecret);
				return new Response("retry", { status: 500, headers: { "Retry-After": "0" } });
			}
			return Response.json({ data: [{ embedding: [1, 2] }, { embedding: [3, 4] }] });
		});
		try {
			const transcript = JSON.stringify({
				turns: [{ role: "assistant", content: `${postResolveSecret} ${retrySecret} harmless nested text` }],
			});
			const result = await withMnemopiRuntimeOptions(
				{
					embeddings: {
						model: "openai/text-embedding-3-small",
						apiUrl: "http://mnemopi-embeddings.test/v1",
						apiKey,
						maxInputChars: 80,
						sanitizeProviderText: text => redactKnown(known, text),
					},
				},
				() => embed([`recall ${initialSecret}`, transcript]),
			);

			// Why: fetchWithRetry owns a physical-attempt loop beneath withAuth,
			// so the second intercepted body must observe the live swap.
			expect(result).toEqual([new Float32Array([1, 2]), new Float32Array([3, 4])]);
			expect(bodies).toHaveLength(2);
			expect(JSON.stringify(bodies[0])).not.toContain(initialSecret);
			expect(JSON.stringify(bodies[0])).not.toContain(postResolveSecret);
			expect(JSON.stringify(bodies[1])).not.toContain(initialSecret);
			expect(JSON.stringify(bodies[1])).not.toContain(postResolveSecret);
			expect(JSON.stringify(bodies[1])).not.toContain(retrySecret);
			expect(JSON.stringify(bodies[1])).toContain("harmless nested text");
		} finally {
			spy.mockRestore();
		}
	});

	it("redacts a recall secret before the embedding cap can split its boundary", async () => {
		const secret = "BOUNDARY_SECRET_ABCDEF_912345";
		let sentInput = "";
		const spy = mockFetch(async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as { input: string[] };
			sentInput = body.input[0] ?? "";
			return Response.json({ data: [{ embedding: [5, 6] }] });
		});
		try {
			const query = `${"a".repeat(5)}${secret}${"z".repeat(53)}`;
			const result = await withMnemopiRuntimeOptions(
				{
					embeddings: {
						model: "openai/text-embedding-3-small",
						apiUrl: "http://mnemopi-embeddings.test/v1",
						apiKey: "key",
						maxInputChars: 48,
						sanitizeProviderText: text => text.replaceAll(secret, "#OBFUSCATED#"),
					},
				},
				() => embedQuery(query),
			);

			// Why: clipping first destroys the exact match and leaves independently
			// useful head/tail fragments of a configured secret.
			expect(result).toEqual(new Float32Array([5, 6]));
			expect(sentInput).toContain("#OBFUSCATED#");
			expect(sentInput).not.toContain("BOUNDARY_SECRET");
			expect(sentInput).not.toContain("ABCDEF_912345");
		} finally {
			spy.mockRestore();
		}
	});

	it("leaves fastembed and on-device completion inputs byte-identical", async () => {
		const oldNodeEnv = process.env.NODE_ENV;
		const oldBunEnv = process.env.BUN_ENV;
		process.env.NODE_ENV = "";
		process.env.BUN_ENV = "";
		let sanitizerCalls = 0;
		let embedded: readonly string[] = [];
		let completed = "";
		setLocalModelInitializerForTests(async () => ({
			embed: async function* (texts) {
				embedded = texts;
				yield texts.map(() => [1, 2]);
			},
		}));
		const raw = "local bytes MNEMOPI_LOCAL_SECRET_225";
		await withIsolatedConfigRoot("mnemopi-provider-boundary", async () => {
			try {
				const options = {
					embeddings: {
						model: "BAAI/bge-small-en-v1.5",
						sanitizeProviderText: (text: string) => {
							sanitizerCalls += 1;
							return text.replace("MNEMOPI_LOCAL_SECRET_225", "#OBFUSCATED#");
						},
					},
					llm: {
						enabled: true,
						complete: (prompt: string) => {
							completed = prompt;
							return "local result";
						},
					},
				};
				// Why: the resolver exists in the embedding channel, but choosing
				// fastembed or an on-device completion must not invoke or alter it.
				expect(await withMnemopiRuntimeOptions(options, () => embed([raw]))).toEqual([
					new Float32Array([1, 2]),
				]);
				expect(await withMnemopiRuntimeOptions(options, () => complete(raw))).toBe("local result");
				expect(embedded).toEqual([raw]);
				expect(completed).toBe(raw);
				expect(sanitizerCalls).toBe(0);
			} finally {
				if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
				else process.env.NODE_ENV = oldNodeEnv;
				if (oldBunEnv === undefined) delete process.env.BUN_ENV;
				else process.env.BUN_ENV = oldBunEnv;
			}
		});
	});
});
