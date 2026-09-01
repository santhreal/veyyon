import { describe, expect, it } from "bun:test";
import {
	baseUrlSchemeError,
	hasLocalLoopbackBaseUrl,
	hostMatchesUrl,
	isDashscopeCompatibleModeUrl,
	isVertexExpressOpenAIUrl,
	isVertexRawPredictUrl,
	KNOWN_HOSTS,
	modelMatchesHost,
} from "../src/hosts";

describe("KNOWN_HOSTS", () => {
	it("has entry for openai", () => {
		expect(KNOWN_HOSTS.openai).toBeDefined();
	});
	it("has entry for anthropic", () => {
		expect(KNOWN_HOSTS.anthropic).toBeDefined();
	});
	it("every host has urlMarkers", () => {
		for (const spec of Object.values(KNOWN_HOSTS)) {
			expect(spec.urlMarkers.length).toBeGreaterThan(0);
		}
	});
});

describe("hostMatchesUrl", () => {
	it("matches openai url", () => {
		expect(hostMatchesUrl("https://api.openai.com/v1", "openai")).toBe(true);
	});
	it("does not match wrong url", () => {
		expect(hostMatchesUrl("https://api.anthropic.com", "openai")).toBe(false);
	});
	it("matches case-insensitively", () => {
		expect(hostMatchesUrl("https://API.OPENAI.COM/v1", "openai")).toBe(true);
	});
	it("returns false for undefined url", () => {
		expect(hostMatchesUrl(undefined, "openai")).toBe(false);
	});
	it("returns false for empty url", () => {
		expect(hostMatchesUrl("", "openai")).toBe(false);
	});
	it("matches anthropic url", () => {
		expect(hostMatchesUrl("https://api.anthropic.com/v1/messages", "anthropic")).toBe(true);
	});
	it("matches openrouter url", () => {
		expect(hostMatchesUrl("https://openrouter.ai/api/v1", "openrouter")).toBe(true);
	});
	it("matches github copilot url", () => {
		expect(hostMatchesUrl("https://githubcopilot.com", "githubCopilot")).toBe(true);
	});
	it("matches copilot-api prefix", () => {
		expect(hostMatchesUrl("https://copilot-api.example.com", "githubCopilot")).toBe(true);
	});
});

describe("hasLocalLoopbackBaseUrl", () => {
	it("returns true for localhost", () => {
		expect(hasLocalLoopbackBaseUrl("http://localhost:8080")).toBe(true);
	});
	it("returns true for 127.0.0.1", () => {
		expect(hasLocalLoopbackBaseUrl("http://127.0.0.1:8080")).toBe(true);
	});
	it("returns true for 0.0.0.0", () => {
		expect(hasLocalLoopbackBaseUrl("http://0.0.0.0:8080")).toBe(true);
	});
	it("returns true for ::1", () => {
		expect(hasLocalLoopbackBaseUrl("http://[::1]:8080")).toBe(true);
	});
	it("returns true for 10.x.x.x", () => {
		expect(hasLocalLoopbackBaseUrl("http://10.0.0.1:8080")).toBe(true);
	});
	it("returns true for 192.168.x.x", () => {
		expect(hasLocalLoopbackBaseUrl("http://192.168.1.1:8080")).toBe(true);
	});
	it("returns true for 172.16.x.x", () => {
		expect(hasLocalLoopbackBaseUrl("http://172.16.0.1:8080")).toBe(true);
	});
	it("returns true for 172.31.x.x", () => {
		expect(hasLocalLoopbackBaseUrl("http://172.31.0.1:8080")).toBe(true);
	});
	it("returns false for 172.15.x.x", () => {
		expect(hasLocalLoopbackBaseUrl("http://172.15.0.1:8080")).toBe(false);
	});
	it("returns false for 172.32.x.x", () => {
		expect(hasLocalLoopbackBaseUrl("http://172.32.0.1:8080")).toBe(false);
	});
	it("returns true for .local domain", () => {
		expect(hasLocalLoopbackBaseUrl("http://my-server.local:8080")).toBe(true);
	});
	it("returns false for public url", () => {
		expect(hasLocalLoopbackBaseUrl("https://api.openai.com")).toBe(false);
	});
	it("returns false for undefined", () => {
		expect(hasLocalLoopbackBaseUrl(undefined)).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(hasLocalLoopbackBaseUrl("")).toBe(false);
	});
	it("returns false for invalid url", () => {
		expect(hasLocalLoopbackBaseUrl("not-a-url")).toBe(false);
	});
});

describe("baseUrlSchemeError", () => {
	it("returns null for valid https url", () => {
		expect(baseUrlSchemeError("https://api.openai.com")).toBeNull();
	});
	it("returns null for valid http url", () => {
		expect(baseUrlSchemeError("http://localhost:8080")).toBeNull();
	});
	it("returns error for missing scheme", () => {
		const error = baseUrlSchemeError("api.openai.com");
		expect(error).toContain("missing a scheme");
	});
	it("returns error for non-http scheme", () => {
		const error = baseUrlSchemeError("ftp://example.com");
		expect(error).toContain("not a usable endpoint");
	});
	it("returns error for empty string", () => {
		const error = baseUrlSchemeError("");
		expect(error).toContain("missing a scheme");
	});
	it("returns error for just scheme", () => {
		const error = baseUrlSchemeError("https://");
		expect(error).toContain("not a usable endpoint");
	});
});

describe("modelMatchesHost", () => {
	it("matches by provider", () => {
		expect(modelMatchesHost({ provider: "openai", baseUrl: "https://other.com" }, "openai")).toBe(true);
	});
	it("matches by url when provider does not match", () => {
		expect(modelMatchesHost({ provider: "unknown", baseUrl: "https://api.openai.com" }, "openai")).toBe(true);
	});
	it("matches by provider prefix", () => {
		expect(modelMatchesHost({ provider: "xiaomi-token-plan-abc", baseUrl: "https://other.com" }, "xiaomi")).toBe(
			true,
		);
	});
	it("does not match when neither provider nor url matches", () => {
		expect(modelMatchesHost({ provider: "unknown", baseUrl: "https://other.com" }, "openai")).toBe(false);
	});
	it("matches anthropic by provider", () => {
		expect(modelMatchesHost({ provider: "anthropic", baseUrl: "https://other.com" }, "anthropic")).toBe(true);
	});
	it("matches moonshot by provider", () => {
		expect(modelMatchesHost({ provider: "moonshot", baseUrl: "https://other.com" }, "moonshotNative")).toBe(true);
	});
	it("matches kimi-code by provider", () => {
		expect(modelMatchesHost({ provider: "kimi-code", baseUrl: "https://other.com" }, "moonshotNative")).toBe(true);
	});
});

describe("isVertexExpressOpenAIUrl", () => {
	it("returns true for endpoints/openapi url", () => {
		expect(isVertexExpressOpenAIUrl("https://us-central1-aiplatform.googleapis.com/endpoints/openapi")).toBe(true);
	});
	it("returns false for non-vertex url", () => {
		expect(isVertexExpressOpenAIUrl("https://api.openai.com")).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(isVertexExpressOpenAIUrl("")).toBe(false);
	});
});

describe("isVertexRawPredictUrl", () => {
	it("returns true for streamRawPredict url", () => {
		expect(isVertexRawPredictUrl("https://example.com:streamRawPredict")).toBe(true);
	});
	it("returns true for rawPredict url", () => {
		expect(isVertexRawPredictUrl("https://example.com:rawPredict")).toBe(true);
	});
	it("returns false for non-vertex url", () => {
		expect(isVertexRawPredictUrl("https://api.openai.com")).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(isVertexRawPredictUrl("")).toBe(false);
	});
});

describe("isDashscopeCompatibleModeUrl", () => {
	it("returns true for dashscope compatible-mode url", () => {
		expect(isDashscopeCompatibleModeUrl("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions")).toBe(
			true,
		);
	});
	it("returns false for dashscope without compatible-mode", () => {
		expect(isDashscopeCompatibleModeUrl("https://dashscope.aliyuncs.com/api/v1")).toBe(false);
	});
	it("returns false for compatible-mode without dashscope", () => {
		expect(isDashscopeCompatibleModeUrl("https://example.com/compatible-mode")).toBe(false);
	});
	it("returns false for non-dashscope url", () => {
		expect(isDashscopeCompatibleModeUrl("https://api.openai.com")).toBe(false);
	});
	it("is case insensitive", () => {
		expect(isDashscopeCompatibleModeUrl("https://DASHSCOPE.ALIYUNCS.COM/COMPATIBLE-MODE/v1")).toBe(true);
	});
	it("returns false for empty string", () => {
		expect(isDashscopeCompatibleModeUrl("")).toBe(false);
	});
});
