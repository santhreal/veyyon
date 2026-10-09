/**
 * Wire contract of `GET /wham/predictions/config`, the remote half of Codex composer
 * predictions. The payload shape is the one the Codex desktop app parses. A payload missing a
 * required field must read as unavailable, never as a prediction sent with a half-read prompt,
 * and a proxy `baseUrl` must not redirect the request off the ChatGPT origin.
 *
 * Not covered: the five-minute cache, which belongs to the caller.
 */
import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@veyyon/ai/types";
import { fetchCodexPredictionsConfig, parseCodexPredictionsConfig } from "@veyyon/ai/usage/openai-codex-predictions";

const PAYLOAD = {
	is_enabled: true,
	prompt: "Predict the next message.",
	prompt_version: "5",
	prediction_reasoning_effort: "high",
	unsupported_models: ["gpt-5.5", 7, "gpt-6-sol"],
	sample_rate: 0.5,
};

function recordingFetch(status: number, payload: unknown) {
	const calls: Array<{ url: string; headers: Record<string, string> }> = [];
	const fetch = (async (url: string, init?: RequestInit) => {
		calls.push({ url: String(url), headers: (init?.headers as Record<string, string>) ?? {} });
		return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
	}) as unknown as FetchImpl;
	return { fetch, calls };
}

describe("parseCodexPredictionsConfig", () => {
	it("reads every field the prediction request uses and drops non-string model ids", () => {
		expect(parseCodexPredictionsConfig(PAYLOAD)).toEqual({
			enabled: true,
			prompt: "Predict the next message.",
			promptVersion: "5",
			reasoningEffort: "high",
			unsupportedModels: ["gpt-5.5", "gpt-6-sol"],
		});
	});

	it("keeps the session's effort when the backend sends an empty one", () => {
		expect(parseCodexPredictionsConfig({ ...PAYLOAD, prediction_reasoning_effort: "" })?.reasoningEffort).toBe(
			undefined,
		);
	});

	it.each([
		["is_enabled", { ...PAYLOAD, is_enabled: "true" }],
		["prompt", { ...PAYLOAD, prompt: undefined }],
		["prompt_version", { ...PAYLOAD, prompt_version: 5 }],
	])("rejects a payload whose %s is missing or mistyped", (_field, payload) => {
		expect(parseCodexPredictionsConfig(payload)).toBeNull();
	});
});

describe("fetchCodexPredictionsConfig", () => {
	it("reads the ChatGPT origin with the account's bearer and account id, ignoring a proxy base URL", async () => {
		const { fetch, calls } = recordingFetch(200, PAYLOAD);
		const config = await fetchCodexPredictionsConfig({
			accessToken: "tok",
			accountId: "acct-1",
			baseUrl: "https://proxy.example/backend-api/codex/responses",
			fetch,
		});
		expect(config.enabled).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://chatgpt.com/backend-api/wham/predictions/config");
		expect(calls[0]?.headers.Authorization).toBe("Bearer tok");
		expect(calls[0]?.headers["chatgpt-account-id"]).toBe("acct-1");
	});

	it("fails naming the HTTP status", async () => {
		const { fetch } = recordingFetch(401, { detail: "Unauthorized" });
		await expect(fetchCodexPredictionsConfig({ accessToken: "tok", fetch })).rejects.toThrow("HTTP 401");
	});

	it("fails on a payload it cannot read", async () => {
		const { fetch } = recordingFetch(200, { is_enabled: true });
		await expect(fetchCodexPredictionsConfig({ accessToken: "tok", fetch })).rejects.toThrow("malformed");
	});
});
