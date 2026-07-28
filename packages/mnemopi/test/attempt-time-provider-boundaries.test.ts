import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { ApiKeyResolver, FetchImpl } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { embed, resetEmbeddingProviderForTests } from "@veyyon/mnemopi/core/embeddings";
import { extractFactCategories } from "@veyyon/mnemopi/core/extraction";
import { type ChatMessage, ExtractionClient } from "@veyyon/mnemopi/core/extraction/client";
import { CallableLlmBackend, resetHostLlmBackendForTests, setHostLlmBackend } from "@veyyon/mnemopi/core/llm-backends";
import { complete, summarizeMemories } from "@veyyon/mnemopi/core/local-llm";
import {
	type MnemopiLlmCompletion,
	type MnemopiProviderTextSanitizer,
	type ResolvedMnemopiRuntimeOptions,
	withMnemopiRuntimeOptions,
} from "@veyyon/mnemopi/core/runtime-options";

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

function openAiSse(text: string): Response {
	const chunk = (delta: unknown, finishReason: string | null) =>
		JSON.stringify({
			id: "mnemopi-wire-test",
			object: "chat.completion.chunk",
			created: 0,
			choices: [{ index: 0, delta, finish_reason: finishReason }],
		});
	return new Response(
		`data: ${chunk({ role: "assistant", content: text }, null)}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`,
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function piNativeSse(text: string): Response {
	const message = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "coreweave",
		model: "zai-org/GLM-5.2",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
	return new Response(`data: ${JSON.stringify({ type: "done", reason: "stop", message })}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function projection(secret: string, label: string): MnemopiProviderTextSanitizer {
	return text => text.replaceAll(secret, `[${label}]`);
}

afterEach(() => {
	restoreEnv();
	resetEmbeddingProviderForTests();
	resetHostLlmBackendForTests();
});

describe("attempt-time Mnemopi provider payloads", () => {
	/** Why: clipping or sanitizing before credential/retry waits freezes a stale, potentially secret-bearing body. */
	it("rebuilds embedding JSON from raw input after credential and transient waits", async () => {
		const secret = "EMBED_RAW_SECRET_6a81";
		const runtime: ResolvedMnemopiRuntimeOptions = {
			embeddings: {
				model: "openai/text-embedding-3-small",
				apiUrl: "http://embedding-wire.test/v1",
				maxInputChars: 22,
				sanitizeProviderText: projection(secret, "OLD"),
			},
		};
		const apiKey: ApiKeyResolver = async context => {
			await Promise.resolve();
			if (runtime.embeddings === undefined) throw new Error("missing runtime embedding options");
			runtime.embeddings.sanitizeProviderText = projection(secret, context.error === undefined ? "CURRENT" : "AUTH");
			return context.error === undefined ? "first" : "second";
		};
		if (runtime.embeddings === undefined) throw new Error("missing runtime embedding options");
		runtime.embeddings.apiKey = apiKey;

		const bodies: unknown[] = [];
		let calls = 0;
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (_input: string | URL | Request, init?: RequestInit) => {
					calls += 1;
					bodies.push(JSON.parse(String(init?.body)) as unknown);
					if (calls === 1) {
						if (runtime.embeddings === undefined) throw new Error("missing runtime embedding options");
						runtime.embeddings.sanitizeProviderText = projection(secret, "RETRY");
						return new Response("retry", { status: 500, headers: { "Retry-After": "0" } });
					}
					return Response.json({ data: [{ embedding: [1, 2] }] });
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);
		try {
			const vector = await withMnemopiRuntimeOptions(runtime, () => embed([`xxxxx${secret}yyyyy`]));
			expect(vector).toEqual([new Float32Array([1, 2])]);
			expect(bodies).toHaveLength(2);
			expect(JSON.stringify(bodies[0])).toContain("[CURRENT]");
			expect(JSON.stringify(bodies[1])).toContain("[RETRY]");
			for (const body of bodies) {
				const wire = JSON.stringify(body);
				expect(wire).not.toContain(secret);
				expect(wire).not.toContain("[OLD]");
			}
		} finally {
			fetchSpy.mockRestore();
		}
	});

	/** Why: raw oversized memories can become valid only after the current sanitizer runs, so chunking must be per attempt. */
	it("re-sanitizes and re-chunks raw summary memories on every auth attempt", async () => {
		process.env.MNEMOPI_LLM_ENABLED = "true";
		process.env.MNEMOPI_LLM_N_CTX = "200";
		const secret = `SUMMARY_RAW_${"s".repeat(900)}`;
		const runtime: ResolvedMnemopiRuntimeOptions = {
			llm: {
				enabled: true,
				baseUrl: "http://summary-wire.test/v1",
				model: "summary-model",
				sanitizeProviderText: projection(secret, "OLD"),
			},
		};
		const apiKey: ApiKeyResolver = async context => {
			await Promise.resolve();
			if (runtime.llm === undefined) throw new Error("missing runtime LLM options");
			runtime.llm.sanitizeProviderText = projection(secret, context.error === undefined ? "CURRENT" : "RETRY");
			return context.error === undefined ? "first" : "second";
		};
		if (runtime.llm === undefined) throw new Error("missing runtime LLM options");
		runtime.llm.apiKey = apiKey;

		const bodies: unknown[] = [];
		const fetchMock: FetchImpl = async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)) as unknown);
			if (bodies.length === 1) return new Response("unauthorized", { status: 401 });
			return Response.json({ choices: [{ message: { content: "Summary result." } }] });
		};
		const result = await withMnemopiRuntimeOptions(runtime, () =>
			summarizeMemories([`${secret} harmless retained memory`], `source ${secret}`, { fetch: fetchMock }),
		);

		expect(result).toBe("Summary result.");
		expect(bodies).toHaveLength(2);
		expect(JSON.stringify(bodies[0])).toContain("[CURRENT]");
		expect(JSON.stringify(bodies[1])).toContain("[RETRY]");
		for (const body of bodies) {
			const wire = JSON.stringify(body);
			expect(wire).not.toContain(secret);
			expect(wire).not.toContain("[OLD]");
		}
	});

	/** Why: SDK auth resolution precedes its fetch; only captured wire JSON proves the current projection won. */
	it("applies the live projection at the normal SDK physical fetch seam", async () => {
		const secret = "SDK_RAW_SECRET_a197";
		const runtime: ResolvedMnemopiRuntimeOptions = {
			llm: {
				enabled: true,
				model: getBundledModel("coreweave", "zai-org/GLM-5.2"),
				sanitizeProviderText: projection(secret, "OLD"),
			},
		};
		const apiKey: ApiKeyResolver = async () => {
			await Promise.resolve();
			if (runtime.llm === undefined) throw new Error("missing runtime LLM options");
			runtime.llm.sanitizeProviderText = projection(secret, "CURRENT");
			return "sdk-key";
		};
		if (runtime.llm === undefined) throw new Error("missing runtime LLM options");
		runtime.llm.apiKey = apiKey;

		let body = "";
		const fetchMock: FetchImpl = async (_input, init) => {
			body = String(init?.body);
			return openAiSse("SDK result");
		};
		const result = await withMnemopiRuntimeOptions(runtime, () => complete(`normal ${secret}`, 0, { fetch: fetchMock }));

		expect(result).toBe("SDK result");
		expect(body).toContain("[CURRENT]");
		expect(body).not.toContain(secret);
		expect(body).not.toContain("[OLD]");
	});

	/** Why: pi-native omits function options on the wire, so the client-side physical seam must still apply the hook. */
	it("applies the attempt hook before pi-native strips non-wire options", async () => {
		const secret = "PI_NATIVE_RAW_SECRET_583b";
		const model = {
			...getBundledModel("coreweave", "zai-org/GLM-5.2"),
			baseUrl: "http://pi-native-wire.test",
			transport: "pi-native" as const,
		};
		const runtime: ResolvedMnemopiRuntimeOptions = {
			llm: { enabled: true, model, sanitizeProviderText: projection(secret, "OLD") },
		};
		const apiKey: ApiKeyResolver = async () => {
			await Promise.resolve();
			if (runtime.llm === undefined) throw new Error("missing runtime LLM options");
			runtime.llm.sanitizeProviderText = projection(secret, "CURRENT");
			return "gateway-key";
		};
		if (runtime.llm === undefined) throw new Error("missing runtime LLM options");
		runtime.llm.apiKey = apiKey;

		let body = "";
		const fetchMock: FetchImpl = async (_input, init) => {
			body = String(init?.body);
			return piNativeSse("Pi result");
		};
		const result = await withMnemopiRuntimeOptions(runtime, () => complete(`native ${secret}`, 0, { fetch: fetchMock }));

		expect(result).toBe("Pi result");
		expect(body).toContain("[CURRENT]");
		expect(body).not.toContain(secret);
		expect(body).not.toContain("[OLD]");
	});

	/** Why: an opaque online callback that cannot prove hook support must never receive raw memory context. */
	it("requires a marked custom online completion and verifies its awaited hook", async () => {
		const secret = "CUSTOM_RAW_SECRET_77c1";
		const runtime: ResolvedMnemopiRuntimeOptions = {
			llm: { enabled: true, sanitizeProviderText: projection(secret, "OLD") },
		};
		let body: unknown;
		const completion: MnemopiLlmCompletion = Object.assign(
			async (prompt: string, opts?: Parameters<MnemopiLlmCompletion>[1]) => {
				await Promise.resolve();
				if (runtime.llm === undefined) throw new Error("missing runtime LLM options");
				runtime.llm.sanitizeProviderText = projection(secret, "CURRENT");
				body = await opts?.onPayload?.({ messages: [{ content: prompt }] });
				return "Custom result";
			},
			{ online: true, supportsAttemptPayload: true as const },
		);
		if (runtime.llm === undefined) throw new Error("missing runtime LLM options");
		runtime.llm.complete = completion;

		const result = await withMnemopiRuntimeOptions(runtime, () => complete(`custom ${secret}`));
		const wire = JSON.stringify(body);
		expect(result).toBe("Custom result");
		expect(wire).toContain("[CURRENT]");
		expect(wire).not.toContain(secret);
		expect(wire).not.toContain("[OLD]");

		let unsupportedCalls = 0;
		const unsupported: MnemopiLlmCompletion = Object.assign(
			() => {
				unsupportedCalls += 1;
				return "must not run";
			},
			{ online: true },
		);
		runtime.llm.complete = unsupported;
		expect(await withMnemopiRuntimeOptions(runtime, () => complete(secret))).toBeNull();
		expect(unsupportedCalls).toBe(0);
	});

	/** Why: host adapters may be remote despite living in-process, so online ones need the same verified hook contract. */
	it("requires attempt-time payload support from online host extraction backends", async () => {
		process.env.MNEMOPI_LLM_ENABLED = "true";
		process.env.MNEMOPI_HOST_LLM_ENABLED = "true";
		const secret = "HOST_EXTRACTION_RAW_SECRET_f292";
		const runtime: ResolvedMnemopiRuntimeOptions = {
			llm: { enabled: true, sanitizeProviderText: projection(secret, "OLD") },
		};
		let body: unknown;
		setHostLlmBackend(
			new CallableLlmBackend(
				"online-host",
				async (prompt, opts) => {
					await Promise.resolve();
					if (runtime.llm === undefined) throw new Error("missing runtime LLM options");
					runtime.llm.sanitizeProviderText = projection(secret, "CURRENT");
					body = await opts?.onPayload?.({ messages: [{ content: prompt }] });
					return JSON.stringify({ facts: ["The user prefers safe extraction"] });
				},
				{ online: true, supportsAttemptPayload: true },
			),
		);

		const extracted = await withMnemopiRuntimeOptions(runtime, () =>
			extractFactCategories(`retained ${secret} harmless extraction`),
		);
		const wire = JSON.stringify(body);
		expect(extracted.facts).toEqual(["The user prefers safe extraction"]);
		expect(wire).toContain("[CURRENT]");
		expect(wire).not.toContain(secret);
		expect(wire).not.toContain("[OLD]");
	});

	/** Why: fallback-model and transient loops must rebuild all nested string keys and values from raw input each time. */
	it("recursively sanitizes direct ExtractionClient keys and values on every retry", async () => {
		const secret = "DIRECT_EXTRACTION_RAW_SECRET_19bd";
		let active = projection(secret, "OLD");
		const bodies: unknown[] = [];
		let client: ExtractionClient;
		const apiKey: ApiKeyResolver = async () => {
			await Promise.resolve();
			active = projection(secret, "CURRENT");
			client.sanitizeProviderText = active;
			return "direct-key";
		};
		const originalSleep = Bun.sleep;
		Bun.sleep = (() => Promise.resolve()) as typeof Bun.sleep;
		const fetchMock: FetchImpl = async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)) as unknown);
			if (bodies.length === 1) {
				active = projection(secret, "RETRY");
				client.sanitizeProviderText = active;
				return new Response("rate limited", { status: 429, statusText: "rate limited" });
			}
			return Response.json({ choices: [{ message: { content: "[]" } }] });
		};
		client = new ExtractionClient({
			model: secret,
			apiKey,
			baseUrl: "http://direct-extraction.test/v1",
			fetch: fetchMock,
			sanitizeProviderText: active,
		});
		const messages = [
			{ role: secret, content: secret, [secret]: { [secret]: secret } },
		] as unknown as readonly ChatMessage[];
		try {
			await client.chat(messages);
		} finally {
			Bun.sleep = originalSleep;
		}

		expect(bodies.length).toBeGreaterThanOrEqual(2);
		expect(JSON.stringify(bodies[0])).toContain("[CURRENT]");
		expect(JSON.stringify(bodies[1])).toContain("[RETRY]");
		for (const body of bodies) {
			const wire = JSON.stringify(body);
			expect(wire).not.toContain(secret);
			expect(wire).not.toContain("[OLD]");
		}
	});
});
