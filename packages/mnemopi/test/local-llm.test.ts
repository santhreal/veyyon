import { afterEach, describe, expect, it } from "bun:test";
import type { FetchImpl } from "@veyyon/ai";
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
});
