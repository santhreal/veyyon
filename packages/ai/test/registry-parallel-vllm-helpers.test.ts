import { describe, expect, it } from "bun:test";
import * as AIError from "../src/error";
import { parallelProvider } from "../src/registry/parallel";
import { vllmProvider } from "../src/registry/vllm";

describe("parallelProvider", () => {
	it("has id 'parallel'", () => {
		expect(parallelProvider.id).toBe("parallel");
	});
	it("has name 'Parallel'", () => {
		expect(parallelProvider.name).toBe("Parallel");
	});
	it("has a login function", () => {
		expect(typeof parallelProvider.login).toBe("function");
	});
	it("login throws OnPromptRequiredError when onPrompt is missing", async () => {
		await expect(parallelProvider.login({} as Parameters<typeof parallelProvider.login>[0])).rejects.toBeInstanceOf(
			AIError.OnPromptRequiredError,
		);
	});
	it("login returns trimmed api key from prompt", async () => {
		const callbacks = {
			onPrompt: async () => "  sk_test_key  ",
			onAuth: () => {},
			signal: undefined,
		};
		const result = await parallelProvider.login(callbacks as Parameters<typeof parallelProvider.login>[0]);
		expect(result).toBe("sk_test_key");
	});
	it("login throws ApiKeyRequiredError for empty key", async () => {
		const callbacks = {
			onPrompt: async () => "   ",
			onAuth: () => {},
			signal: undefined,
		};
		await expect(
			parallelProvider.login(callbacks as Parameters<typeof parallelProvider.login>[0]),
		).rejects.toBeInstanceOf(AIError.ApiKeyRequiredError);
	});
	it("login throws LoginCancelledError when signal is aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const callbacks = {
			onPrompt: async () => "sk_key",
			onAuth: () => {},
			signal: controller.signal,
		};
		await expect(
			parallelProvider.login(callbacks as Parameters<typeof parallelProvider.login>[0]),
		).rejects.toBeInstanceOf(AIError.LoginCancelledError);
	});
	it("login calls onAuth with url", async () => {
		let authUrl: string | undefined;
		const callbacks = {
			onPrompt: async () => "sk_key",
			onAuth: (info: { url: string }) => {
				authUrl = info.url;
			},
			signal: undefined,
		};
		await parallelProvider.login(callbacks as Parameters<typeof parallelProvider.login>[0]);
		expect(authUrl).toContain("parallel.ai");
	});
});

describe("vllmProvider", () => {
	it("has id 'vllm'", () => {
		expect(vllmProvider.id).toBe("vllm");
	});
	it("has name containing 'vLLM'", () => {
		expect(vllmProvider.name).toContain("vLLM");
	});
	it("has a login function", () => {
		expect(typeof vllmProvider.login).toBe("function");
	});
	it("login throws OnPromptRequiredError when onPrompt is missing", async () => {
		await expect(vllmProvider.login({} as Parameters<typeof vllmProvider.login>[0])).rejects.toBeInstanceOf(
			AIError.OnPromptRequiredError,
		);
	});
	it("login returns trimmed api key from prompt", async () => {
		const callbacks = {
			onPrompt: async () => "  sk_vllm_key  ",
			onAuth: () => {},
			signal: undefined,
		};
		const result = await vllmProvider.login(callbacks as Parameters<typeof vllmProvider.login>[0]);
		expect(result).toBe("sk_vllm_key");
	});
	it("login returns default token for empty key", async () => {
		const callbacks = {
			onPrompt: async () => "",
			onAuth: () => {},
			signal: undefined,
		};
		const result = await vllmProvider.login(callbacks as Parameters<typeof vllmProvider.login>[0]);
		expect(result).toBe("vllm-local");
	});
	it("login returns default token for whitespace-only key", async () => {
		const callbacks = {
			onPrompt: async () => "   ",
			onAuth: () => {},
			signal: undefined,
		};
		const result = await vllmProvider.login(callbacks as Parameters<typeof vllmProvider.login>[0]);
		expect(result).toBe("vllm-local");
	});
	it("login throws LoginCancelledError when signal is aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const callbacks = {
			onPrompt: async () => "sk_key",
			onAuth: () => {},
			signal: controller.signal,
		};
		await expect(vllmProvider.login(callbacks as Parameters<typeof vllmProvider.login>[0])).rejects.toBeInstanceOf(
			AIError.LoginCancelledError,
		);
	});
	it("login calls onAuth with url", async () => {
		let authUrl: string | undefined;
		const callbacks = {
			onPrompt: async () => "sk_key",
			onAuth: (info: { url: string }) => {
				authUrl = info.url;
			},
			signal: undefined,
		};
		await vllmProvider.login(callbacks as Parameters<typeof vllmProvider.login>[0]);
		expect(authUrl).toContain("vllm.ai");
	});
});
