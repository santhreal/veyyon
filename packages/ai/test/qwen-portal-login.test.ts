import { describe, expect, it } from "bun:test";
import { loginQwenPortal } from "@veyyon/ai/registry/qwen-portal";
import type { FetchImpl } from "@veyyon/catalog/types";

describe("qwen portal login", () => {
	it("opens Qwen portal settings and validates the pasted key", async () => {
		let authUrl: string | undefined;
		let authInstructions: string | undefined;
		let promptMessage: string | undefined;
		let promptPlaceholder: string | undefined;
		let progressMessage: string | undefined;
		let capturedUrl = "";
		let capturedAuth = "";
		let capturedModel: string | undefined;

		const fetchImpl: FetchImpl = async (input, init) => {
			capturedUrl = typeof input === "string" ? input : input.toString();
			capturedAuth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
			if (init?.body) {
				const parsed = JSON.parse(init.body as string) as { model?: string };
				capturedModel = parsed.model;
			}
			return new Response(
				JSON.stringify({
					choices: [{ message: { role: "assistant", content: "ok" } }],
				}),
				{ status: 200 },
			);
		};

		const apiKey = await loginQwenPortal({
			fetch: fetchImpl,
			onAuth: info => {
				authUrl = info.url;
				authInstructions = info.instructions;
			},
			onPrompt: async prompt => {
				promptMessage = prompt.message;
				promptPlaceholder = prompt.placeholder;
				expect(prompt.secret).toBe(true);
				return "  sk-qwen-token-123  ";
			},
			onProgress: msg => {
				progressMessage = msg;
			},
		});

		expect(authUrl).toBe("https://chat.qwen.ai");
		expect(authInstructions).toContain("Copy your Qwen OAuth token or API key");
		expect(promptMessage).toBe("Paste your Qwen OAuth token or API key");
		expect(promptPlaceholder).toBe("sk-...");
		expect(apiKey).toBe("sk-qwen-token-123");
		expect(progressMessage).toBe("Validating credentials...");
		expect(capturedUrl).toBe("https://portal.qwen.ai/v1/chat/completions");
		expect(capturedAuth).toBe("Bearer sk-qwen-token-123");
		expect(capturedModel).toBe("coder-model");
	});

	it("rejects empty keys with the provider-specific message", async () => {
		await expect(
			loginQwenPortal({
				onPrompt: async () => "   ",
			}),
		).rejects.toThrow("Qwen token/API key is required");
	});

	it("requires onPrompt callback", async () => {
		await expect(loginQwenPortal({})).rejects.toThrow("Qwen Portal login requires onPrompt callback");
	});

	it("executes onAuth and onPrompt before post-prompt cancellation check when signal is aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		let onAuthCalled = false;
		let onPromptCalled = false;

		await expect(
			loginQwenPortal({
				signal: controller.signal,
				onAuth: () => {
					onAuthCalled = true;
				},
				onPrompt: async () => {
					onPromptCalled = true;
					return "sk-test";
				},
			}),
		).rejects.toThrow("Login cancelled");

		expect(onAuthCalled).toBe(true);
		expect(onPromptCalled).toBe(true);
	});

	it("surfaces validation failure when provider endpoint rejects the key", async () => {
		const fetchImpl: FetchImpl = async () =>
			new Response(JSON.stringify({ error: { message: "Invalid API key" } }), { status: 401 });

		await expect(
			loginQwenPortal({
				fetch: fetchImpl,
				onPrompt: async () => "sk-invalid",
			}),
		).rejects.toThrow(/qwen-portal API key validation failed \(401\)/);
	});
});
