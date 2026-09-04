import { afterEach, describe, expect, it } from "bun:test";
import {
	CallableLlmBackend,
	callHostLlm,
	getHostLlmBackend,
	resetHostLlmBackendForTests,
	setHostLlmBackend,
} from "@veyyon/mnemopi/core/llm-backends";

afterEach(() => resetHostLlmBackendForTests());

describe("host LLM backend registry", () => {
	it("sets, gets, and clears the process-global backend", () => {
		expect(getHostLlmBackend()).toBeNull();
		const backend = new CallableLlmBackend("test", () => "ok");
		setHostLlmBackend(backend);
		expect(getHostLlmBackend()).toBe(backend);
		setHostLlmBackend(null);
		expect(getHostLlmBackend()).toBeNull();
	});

	it("returns null without a backend", async () => {
		expect(await callHostLlm("anything", { maxTokens: 64 })).toBeNull();
	});

	it("passes completion options through", async () => {
		const captured: Record<string, unknown> = {};
		setHostLlmBackend(
			new CallableLlmBackend("test", (prompt, opts) => {
				captured.prompt = prompt;
				captured.maxTokens = opts?.maxTokens;
				captured.temperature = opts?.temperature;
				captured.timeout = opts?.timeout;
				captured.provider = opts?.provider;
				captured.model = opts?.model;
				return "out";
			}),
		);

		expect(
			await callHostLlm("hello", {
				maxTokens: 128,
				temperature: 0.1,
				timeout: 7.5,
				provider: "openai-codex",
				model: "gpt-5.1-mini",
			}),
		).toBe("out");
		expect(captured).toEqual({
			prompt: "hello",
			maxTokens: 128,
			temperature: 0.1,
			timeout: 7.5,
			provider: "openai-codex",
			model: "gpt-5.1-mini",
		});
	});

	// Regression: callHostLlm must NOT swallow a backend throw to null. Doing so
	// (the old `catch { return null }`) made the extraction layer misreport a hard
	// failure as "the model produced no output" and left its host_adapter_raised
	// branch dead. The error must propagate so the caller can classify it (Law 10:
	// no silent fallbacks).
	it("propagates backend exceptions instead of swallowing them to null", async () => {
		setHostLlmBackend(
			new CallableLlmBackend("boom", () => {
				throw new Error("provider exploded");
			}),
		);
		await expect(callHostLlm("anything", { maxTokens: 64 })).rejects.toThrow("provider exploded");
	});

	// A rejected promise from the backend is a failure too, not "no output".
	it("propagates a rejected backend promise", async () => {
		setHostLlmBackend(
			new CallableLlmBackend("boom-async", async () => {
				throw new Error("socket hung up");
			}),
		);
		await expect(callHostLlm("anything", { maxTokens: 64 })).rejects.toThrow("socket hung up");
	});
});
