import { describe, expect, it } from "bun:test";
import { loginOllamaCloud } from "@veyyon/ai/registry/ollama-cloud";

describe("ollama cloud login", () => {
	it("opens Ollama Cloud key settings and trims the pasted key", async () => {
		let authUrl: string | undefined;
		let authInstructions: string | undefined;
		let promptMessage: string | undefined;
		let promptPlaceholder: string | undefined;

		const apiKey = await loginOllamaCloud({
			onAuth: info => {
				authUrl = info.url;
				authInstructions = info.instructions;
			},
			onPrompt: async prompt => {
				promptMessage = prompt.message;
				promptPlaceholder = prompt.placeholder;
				return "  ollama-cloud-key  ";
			},
		});

		expect(authUrl).toBe("https://ollama.com/settings/keys");
		expect(authInstructions).toContain("Create an Ollama Cloud API key");
		expect(promptMessage).toBe("Paste your Ollama Cloud API key");
		expect(promptPlaceholder).toBe("ollama-cloud-api-key");
		expect(apiKey).toBe("ollama-cloud-key");
	});

	it("rejects empty keys", async () => {
		await expect(
			loginOllamaCloud({
				onPrompt: async () => "   ",
			}),
		).rejects.toThrow("Ollama Cloud API key is required");
	});

	it("requires onPrompt callback", async () => {
		await expect(loginOllamaCloud({})).rejects.toThrow("Interactive prompt is required for Ollama Cloud login");
	});

	it("aborts before onAuth or onPrompt callbacks when signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		let onAuthCalled = false;
		let onPromptCalled = false;

		await expect(
			loginOllamaCloud({
				signal: controller.signal,
				onAuth: () => {
					onAuthCalled = true;
				},
				onPrompt: async () => {
					onPromptCalled = true;
					return "sk-key";
				},
			}),
		).rejects.toThrow("Login cancelled");

		expect(onAuthCalled).toBe(false);
		expect(onPromptCalled).toBe(false);
	});
});
