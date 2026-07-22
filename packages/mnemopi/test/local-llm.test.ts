import { afterEach, describe, expect, it } from "bun:test";
import type { FetchImpl } from "@veyyon/ai";
import { ProviderHttpError } from "@veyyon/ai/error";
import { createMockModel, registerMockApi } from "@veyyon/ai/providers/mock";
import { CallableLlmBackend, resetHostLlmBackendForTests, setHostLlmBackend } from "@veyyon/mnemopi/core/llm-backends";
import {
	buildHostPrompt,
	buildPrompt,
	callLocalLlm,
	callRemoteLlm,
	chunkMemoriesByBudget,
	cleanOutput,
	complete,
	configuredLlmWillHandleCall,
	llmAvailable,
	localGgufAvailable,
	summarizeMemories,
} from "@veyyon/mnemopi/core/local-llm";
import { Mnemopi } from "@veyyon/mnemopi/core/memory";
import { withMnemopiRuntimeOptions } from "@veyyon/mnemopi/core/runtime-options";

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

afterEach(() => {
	restoreEnv();
	resetHostLlmBackendForTests();
});

registerMockApi();

describe("local LLM TypeScript port", () => {
	it("reports remote availability and calls OpenAI-compatible HTTP", async () => {
		process.env.MNEMOPI_LLM_BASE_URL = "http://local-llm/v1";
		process.env.MNEMOPI_LLM_API_KEY = "sk-test";
		process.env.MNEMOPI_LLM_MODEL = "test-model";
		let auth = "";
		let model = "";
		const fetchMock: FetchImpl = async (_input, init?) => {
			auth = new Headers(init?.headers).get("authorization") ?? "";
			model = (JSON.parse(String(init?.body)) as { model: string }).model;
			return new Response(JSON.stringify({ choices: [{ message: { content: "Remote summary." } }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		expect(llmAvailable()).toBe(true);
		expect(await callRemoteLlm("Test prompt", 0.2, { fetch: fetchMock })).toBe("Remote summary.");
		expect(auth).toBe("Bearer sk-test");
		expect(model).toBe("test-model");
	});

	it("keeps local GGUF unavailable and returns null for local completion", async () => {
		expect(localGgufAvailable()).toBe(false);
		expect(await callLocalLlm("prompt")).toBeNull();
	});

	it("uses host backend before remote and skips remote on host miss", async () => {
		process.env.MNEMOPI_LLM_ENABLED = "true";
		process.env.MNEMOPI_HOST_LLM_ENABLED = "true";
		process.env.MNEMOPI_LLM_BASE_URL = "http://remote/v1";
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			return new Response(JSON.stringify({ choices: [{ message: { content: "Remote summary." } }] }), {
				status: 200,
			});
		};

		setHostLlmBackend(new CallableLlmBackend("host", () => "Host summary."));
		expect(await summarizeMemories(["Memory one"], "", { fetch: fetchMock })).toBe("Host summary.");
		expect(calls).toBe(0);

		setHostLlmBackend(new CallableLlmBackend("host", () => null));
		expect(await summarizeMemories(["Memory one"], "", { fetch: fetchMock })).toBeNull();
		expect(calls).toBe(0);
	});

	// Recall-preserving loud fallback: when the remote transport throws during
	// summarization, the failure is surfaced (console.warn in summaryOrNull) and
	// the call falls through to the local backend rather than propagating the
	// throw out of summarizeMemories. The fallback is allowed only because it is
	// loud, not silent (Law 10). Without the wrap, callRemoteLlm now throws and
	// this would reject instead of returning null.
	it("survives a throwing remote transport by falling through loudly, not propagating the throw", async () => {
		process.env.MNEMOPI_LLM_ENABLED = "true";
		process.env.MNEMOPI_LLM_BASE_URL = "http://remote/v1";
		delete process.env.MNEMOPI_HOST_LLM_ENABLED;
		const fetchThrow: FetchImpl = async () => {
			throw new Error("remote summarize connection reset");
		};
		expect(await summarizeMemories(["Memory one"], "", { fetch: fetchThrow })).toBeNull();
	});

	// Twin for a host backend that throws during summarization: tryHostLlm logs
	// the crash and reports the call as attempted-but-empty, so summarization
	// falls through to a local backend instead of rejecting.
	it("survives a throwing host backend during summarization by falling through loudly", async () => {
		process.env.MNEMOPI_LLM_ENABLED = "true";
		process.env.MNEMOPI_HOST_LLM_ENABLED = "true";
		delete process.env.MNEMOPI_LLM_BASE_URL;
		setHostLlmBackend(
			new CallableLlmBackend("host-boom", () => {
				throw new Error("host summarize crashed");
			}),
		);
		expect(await summarizeMemories(["Memory one"], "", {})).toBeNull();
	});

	it("renders host sleep prompt override without chat-template tokens", () => {
		process.env.MNEMOPI_SLEEP_PROMPT = "Write in German. Source={source}. Memories:\n{memories}";
		expect(buildHostPrompt(["User prefers tea"], "profile")).toBe(
			"Write in German. Source=profile. Memories:\n- User prefers tea",
		);
	});

	it("expands chunk budget when host backend will handle calls", () => {
		process.env.MNEMOPI_LLM_ENABLED = "true";
		process.env.MNEMOPI_HOST_LLM_ENABLED = "true";
		process.env.MNEMOPI_HOST_LLM_N_CTX = "32000";
		process.env.MNEMOPI_LLM_N_CTX = "2048";
		setHostLlmBackend(new CallableLlmBackend("host", () => "x"));
		const hostChunks = chunkMemoriesByBudget(["x".repeat(10_000)]);
		resetHostLlmBackendForTests();
		const localChunks = chunkMemoriesByBudget(["x".repeat(10_000)]);
		expect(hostChunks).toHaveLength(1);
		expect(localChunks).toHaveLength(0);
	});

	it("uses a constructor-scoped completion function instead of remote URL settings", async () => {
		process.env.MNEMOPI_LLM_ENABLED = "true";
		process.env.MNEMOPI_LLM_BASE_URL = "http://remote.example/v1";
		let fetchCalls = 0;
		const fetchMock: FetchImpl = async () => {
			fetchCalls += 1;
			throw new Error("remote should not be called");
		};
		const memory = new Mnemopi({
			llm: async (prompt, opts) => `fn:${prompt}:${opts?.maxTokens ?? 0}`,
		});
		try {
			const text = await withMnemopiRuntimeOptions(memory.runtimeOptions, () =>
				complete("hello", 0.3, { fetch: fetchMock }),
			);
			expect(text).toBe("fn:hello:2048");
			expect(fetchCalls).toBe(0);
		} finally {
			memory.close();
		}
	});

	it("uses a constructor-scoped pi-ai Model instance", async () => {
		const model = createMockModel({
			handler: () => ({ content: ["model summary"] }),
		});
		const memory = new Mnemopi({ llm: model });
		try {
			const text = await withMnemopiRuntimeOptions(memory.runtimeOptions, () => complete("hello"));
			expect(text).toBe("model summary");
		} finally {
			memory.close();
		}
	});

	it("builds the local prompt with and without a source suffix", () => {
		expect(buildPrompt(["a", "b"], "")).toBe(
			"/no_think\nSummarize the following memories into 1-3 concise sentences. Preserve facts, names, preferences, and decisions. Discard fluff.\n\n- a\n- b\n\nSummary:",
		);
		expect(buildPrompt(["a"], "profile")).toBe(
			"/no_think\nSummarize the following memories into 1-3 concise sentences. Preserve facts, names, preferences, and decisions. Discard fluff. Source: profile.\n\n- a\n\nSummary:",
		);
	});

	it("defines the summarization header literal in exactly one place", async () => {
		// buildPrompt, buildHostPrompt, and chunkMemoriesByBudget all share one
		// SUMMARY_HEADER owner; a second inline copy would reintroduce drift.
		const source = await Bun.file(new URL("../src/core/local-llm.ts", import.meta.url)).text();
		const matches = source.match(/Summarize the following memories into 1-3 concise sentences\. Preserve facts/g);
		expect(matches).toHaveLength(1);
	});

	it("strips chat-template tokens, echoed instructions, source lines, and bullets", () => {
		expect(cleanOutput("<|assistant|>Hello there.</s>")).toBe("Hello there.");
		expect(cleanOutput("Summarize the following memories into one. Real summary here.")).toBe("Real summary here.");
		expect(cleanOutput("Source: profile\nReal line")).toBe("Real line");
		expect(cleanOutput("- bullet one\n- bullet two\nActual content")).toBe("Actual content");
	});

	it("reports no configured completion when neither a function nor a pi-ai model is active", () => {
		expect(configuredLlmWillHandleCall()).toBe(false);
	});

	it("splits memories across budget boundaries and skips oversized memories", () => {
		process.env.MNEMOPI_LLM_N_CTX = "800";
		delete process.env.MNEMOPI_HOST_LLM_ENABLED;
		expect(
			chunkMemoriesByBudget(["x".repeat(600), "y".repeat(600), "z".repeat(600)], "src").map(c => c.length),
		).toEqual([2, 1]);
		delete process.env.MNEMOPI_LLM_N_CTX;
		// A memory larger than the whole budget is dropped; the small ones survive.
		expect(chunkMemoriesByBudget(["small", "z".repeat(100_000), "tiny"]).flat()).toEqual(["small", "tiny"]);
	});

	it("lets llm:false override remote environment defaults", async () => {
		process.env.MNEMOPI_LLM_ENABLED = "true";
		process.env.MNEMOPI_LLM_BASE_URL = "http://remote.example/v1";
		let fetchCalls = 0;
		const fetchMock: FetchImpl = async () => {
			fetchCalls += 1;
			throw new Error("remote should not be called");
		};
		const memory = new Mnemopi({ llm: false });
		try {
			const text = await withMnemopiRuntimeOptions(memory.runtimeOptions, () =>
				complete("hello", 0.3, { fetch: fetchMock }),
			);
			expect(text).toBeNull();
			expect(fetchCalls).toBe(0);
		} finally {
			memory.close();
		}
	});

	it("threads the runtime-scoped maxTokens into a custom completion", async () => {
		const memory = new Mnemopi({ llm: { complete: (_p, o) => `mt:${o?.maxTokens}`, maxTokens: 111 } });
		try {
			const text = await withMnemopiRuntimeOptions(memory.runtimeOptions, () => complete("hi"));
			expect(text).toBe("mt:111");
		} finally {
			memory.close();
		}
	});

	it("chunks and merges multi-part summaries through a custom completion", async () => {
		process.env.MNEMOPI_LLM_N_CTX = "200";
		delete process.env.MNEMOPI_HOST_LLM_ENABLED;
		let calls = 0;
		const memory = new Mnemopi({
			llm: {
				complete: () => {
					calls += 1;
					return "S";
				},
			},
		});
		try {
			const text = await withMnemopiRuntimeOptions(memory.runtimeOptions, () =>
				summarizeMemories(["x".repeat(100), "y".repeat(100)], "src"),
			);
			// Two chunks each summarize to "S", then a third call merges the two summaries.
			expect(text).toBe("S");
			expect(calls).toBe(3);
		} finally {
			memory.close();
		}
	});

	// complete() still returns null when the configured pi-ai model throws, but the
	// failure is no longer swallowed silently: callConfiguredCompletion now
	// propagates the throw and summaryOrNull logs it before falling through
	// (Law 10). The null here is the loud, recall-preserving fallback, not a hidden
	// error. The extraction layer records the same throw as
	// configured_completion_raised (extraction.test.ts).
	it("returns null loudly from a pi-ai model whose completion throws, forwarding the runtime api key", async () => {
		const okModel = createMockModel({ handler: () => ({ content: ["model summary"] }) });
		const okMemory = new Mnemopi({ llm: { model: okModel, apiKey: "sk-runtime" } });
		try {
			expect(await withMnemopiRuntimeOptions(okMemory.runtimeOptions, () => complete("hello"))).toBe(
				"model summary",
			);
		} finally {
			okMemory.close();
		}

		const throwingModel = createMockModel({
			handler: () => {
				throw new Error("model exploded");
			},
		});
		const badMemory = new Mnemopi({ llm: { model: throwingModel } });
		try {
			expect(await withMnemopiRuntimeOptions(badMemory.runtimeOptions, () => complete("hello"))).toBeNull();
		} finally {
			badMemory.close();
		}
	});

	// Regression: callRemoteLlm must PROPAGATE real failures, not swallow them to
	// null. The old `catch { return null }` (and the silent `!response.ok → null`)
	// made a hard failure look like "the model produced no output", hid the error
	// from the operator, and left extraction's remote_call_raised branch dead
	// (Law 10: no silent fallbacks). A non-2xx response, a network throw, and a
	// 401 must each raise so the caller can classify them.
	it("propagates remote non-ok, network throw, and unauthorized responses instead of returning null", async () => {
		process.env.MNEMOPI_LLM_BASE_URL = "http://remote/v1";
		process.env.MNEMOPI_LLM_API_KEY = "sk-static";

		const serverError: FetchImpl = async () => new Response("upstream error", { status: 500 });
		await expect(callRemoteLlm("prompt", 0.3, { fetch: serverError })).rejects.toBeInstanceOf(ProviderHttpError);
		await expect(callRemoteLlm("prompt", 0.3, { fetch: serverError })).rejects.toThrow("HTTP 500");

		const networkThrow: FetchImpl = async () => {
			throw new Error("connection reset");
		};
		await expect(callRemoteLlm("prompt", 0.3, { fetch: networkThrow })).rejects.toThrow("connection reset");

		// A 401 raises ProviderHttpError; a static key cannot refresh, so the error
		// surfaces to the caller rather than being swallowed.
		const unauthorized: FetchImpl = async () => new Response("nope", { status: 401 });
		await expect(callRemoteLlm("prompt", 0.3, { fetch: unauthorized })).rejects.toBeInstanceOf(ProviderHttpError);
	});

	it("completes through the remote transport when only environment settings are present", async () => {
		process.env.MNEMOPI_LLM_ENABLED = "true";
		process.env.MNEMOPI_LLM_BASE_URL = "http://remote/v1";
		delete process.env.MNEMOPI_HOST_LLM_ENABLED;
		const fetchMock: FetchImpl = async () =>
			new Response(JSON.stringify({ choices: [{ message: { content: "Remote done." } }] }), { status: 200 });
		expect(await complete("summarize this", 0.3, { fetch: fetchMock })).toBe("Remote done.");
	});

	it("renders the env sleep-prompt override through buildPrompt with all three substitutions", () => {
		process.env.MNEMOPI_SLEEP_PROMPT = "Digest {memory_count} from {source}:\n{memories}";
		expect(buildPrompt(["alpha", "beta"], "chat")).toBe("Digest 2 from chat:\n- alpha\n- beta");
	});

	it("prefers a runtime consolidationPrompt over the env sleep prompt in buildPrompt", async () => {
		process.env.MNEMOPI_SLEEP_PROMPT = "ENV {memories}";
		const memory = new Mnemopi({ llm: { consolidationPrompt: "RUNTIME {memory_count}: {memories}" } });
		const rendered = await withMnemopiRuntimeOptions(memory.runtimeOptions, () => buildPrompt(["one"], ""));
		expect(rendered).toBe("RUNTIME 1: - one");
	});

	it("chunks an empty memory list into an empty batch list", () => {
		expect(chunkMemoriesByBudget([])).toEqual([]);
	});

	it("summarizes an empty memory list as null without touching any backend", async () => {
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			return new Response("", { status: 200 });
		};
		expect(await summarizeMemories([], "", { fetch: fetchMock })).toBeNull();
		expect(calls).toBe(0);
	});

	it("returns null from callRemoteLlm when no base URL is configured", async () => {
		delete process.env.MNEMOPI_LLM_BASE_URL;
		let calls = 0;
		const fetchMock: FetchImpl = async () => {
			calls += 1;
			return new Response("", { status: 200 });
		};
		expect(await callRemoteLlm("prompt", 0.3, { fetch: fetchMock })).toBeNull();
		expect(calls).toBe(0);
	});

	it("reports llmAvailable true through a configured completion function", async () => {
		const memory = new Mnemopi({ llm: { complete: () => "ok" } });
		expect(await withMnemopiRuntimeOptions(memory.runtimeOptions, () => llmAvailable())).toBe(true);
	});

	it("reports llmAvailable true through an enabled host backend", () => {
		process.env.MNEMOPI_LLM_ENABLED = "true";
		process.env.MNEMOPI_HOST_LLM_ENABLED = "true";
		delete process.env.MNEMOPI_LLM_BASE_URL;
		setHostLlmBackend(new CallableLlmBackend("host", () => "x"));
		expect(llmAvailable()).toBe(true);
	});

	it("reports llmAvailable false with no completion, host backend, or remote URL", () => {
		process.env.MNEMOPI_LLM_ENABLED = "true";
		delete process.env.MNEMOPI_HOST_LLM_ENABLED;
		delete process.env.MNEMOPI_LLM_BASE_URL;
		resetHostLlmBackendForTests();
		expect(llmAvailable()).toBe(false);
	});
});
