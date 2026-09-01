import { describe, expect, it } from "bun:test";
import {
	isFireworksFastModelId,
	toFirepassPublicModelId,
	toFirepassWireModelId,
	toFireworksBaseModelId,
	toFireworksPublicModelId,
	toFireworksWireModelId,
} from "../src/fireworks-model-id";
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

describe("hostMatchesUrl", () => {
	it("matches openai host", () => {
		expect(hostMatchesUrl("https://api.openai.com/v1", "openai")).toBe(true);
	});
	it("matches case-insensitively", () => {
		expect(hostMatchesUrl("https://API.OPENAI.COM/v1", "openai")).toBe(true);
	});
	it("does not match different host", () => {
		expect(hostMatchesUrl("https://api.anthropic.com", "openai")).toBe(false);
	});
	it("returns false for undefined", () => {
		expect(hostMatchesUrl(undefined, "openai")).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(hostMatchesUrl("", "openai")).toBe(false);
	});
	it("matches anthropic host", () => {
		expect(hostMatchesUrl("https://api.anthropic.com", "anthropic")).toBe(true);
	});
	it("matches github copilot host", () => {
		expect(hostMatchesUrl("https://api.githubcopilot.com", "githubCopilot")).toBe(true);
	});
	it("matches groq host", () => {
		expect(hostMatchesUrl("https://api.groq.com", "groq")).toBe(true);
	});
	it("matches fireworks host", () => {
		expect(hostMatchesUrl("https://api.fireworks.ai/v1", "fireworks")).toBe(true);
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
		expect(hasLocalLoopbackBaseUrl("http://10.0.0.5:8080")).toBe(true);
	});
	it("returns true for 192.168.x.x", () => {
		expect(hasLocalLoopbackBaseUrl("http://192.168.1.1:8080")).toBe(true);
	});
	it("returns true for 172.16-31.x.x", () => {
		expect(hasLocalLoopbackBaseUrl("http://172.16.0.1:8080")).toBe(true);
	});
	it("returns true for 172.31.x.x", () => {
		expect(hasLocalLoopbackBaseUrl("http://172.31.0.1:8080")).toBe(true);
	});
	it("returns false for 172.32.x.x", () => {
		expect(hasLocalLoopbackBaseUrl("http://172.32.0.1:8080")).toBe(false);
	});
	it("returns true for .local domain", () => {
		expect(hasLocalLoopbackBaseUrl("http://myhost.local:8080")).toBe(true);
	});
	it("returns false for public URL", () => {
		expect(hasLocalLoopbackBaseUrl("https://api.openai.com")).toBe(false);
	});
	it("returns false for undefined", () => {
		expect(hasLocalLoopbackBaseUrl(undefined)).toBe(false);
	});
	it("returns false for invalid URL", () => {
		expect(hasLocalLoopbackBaseUrl("not-a-url")).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(hasLocalLoopbackBaseUrl("")).toBe(false);
	});
});

describe("baseUrlSchemeError", () => {
	it("returns null for valid https URL", () => {
		expect(baseUrlSchemeError("https://api.openai.com")).toBeNull();
	});
	it("returns null for valid http URL", () => {
		expect(baseUrlSchemeError("http://localhost:8080")).toBeNull();
	});
	it("returns error for missing scheme", () => {
		expect(baseUrlSchemeError("api.openai.com")).toContain("missing a scheme");
	});
	it("returns error for non-http scheme", () => {
		expect(baseUrlSchemeError("ftp://example.com")).toContain("not a usable endpoint");
	});
	it("returns error for empty string", () => {
		expect(baseUrlSchemeError("")).toContain("missing a scheme");
	});
	it("returns error for just scheme", () => {
		expect(baseUrlSchemeError("https://")).toContain("not a usable endpoint");
	});
});

describe("modelMatchesHost", () => {
	it("matches by provider", () => {
		expect(modelMatchesHost({ provider: "openai", baseUrl: "" }, "openai")).toBe(true);
	});
	it("matches by baseUrl when provider doesn't match", () => {
		expect(modelMatchesHost({ provider: "custom", baseUrl: "https://api.openai.com" }, "openai")).toBe(true);
	});
	it("does not match when neither provider nor url matches", () => {
		expect(modelMatchesHost({ provider: "custom", baseUrl: "https://example.com" }, "openai")).toBe(false);
	});
	it("matches by provider prefix", () => {
		expect(modelMatchesHost({ provider: "xiaomi-token-plan-abc", baseUrl: "https://example.com" }, "xiaomi")).toBe(
			true,
		);
	});
	it("matches fireworks by url only (no providers)", () => {
		expect(modelMatchesHost({ provider: "custom", baseUrl: "https://fireworks.ai" }, "fireworks")).toBe(true);
	});
});

describe("isVertexExpressOpenAIUrl", () => {
	it("returns true for express openai url", () => {
		expect(isVertexExpressOpenAIUrl("https://vertex.googleapis.com/endpoints/openapi")).toBe(true);
	});
	it("returns false for other url", () => {
		expect(isVertexExpressOpenAIUrl("https://api.openai.com")).toBe(false);
	});
});

describe("isVertexRawPredictUrl", () => {
	it("returns true for streamRawPredict", () => {
		expect(isVertexRawPredictUrl("https://vertex:streamRawPredict")).toBe(true);
	});
	it("returns true for rawPredict", () => {
		expect(isVertexRawPredictUrl("https://vertex:rawPredict")).toBe(true);
	});
	it("returns false for other url", () => {
		expect(isVertexRawPredictUrl("https://api.openai.com")).toBe(false);
	});
});

describe("isDashscopeCompatibleModeUrl", () => {
	it("returns true for dashscope compatible url", () => {
		expect(isDashscopeCompatibleModeUrl("https://dashscope.aliyuncs.com/compatible-mode/v1")).toBe(true);
	});
	it("returns false for dashscope without compatible-mode", () => {
		expect(isDashscopeCompatibleModeUrl("https://dashscope.aliyuncs.com/v1")).toBe(false);
	});
	it("returns false for non-dashscope url", () => {
		expect(isDashscopeCompatibleModeUrl("https://api.openai.com")).toBe(false);
	});
	it("is case-insensitive", () => {
		expect(isDashscopeCompatibleModeUrl("https://DASHSCOPE.ALIYUNCS.COM/compatible-mode/v1")).toBe(true);
	});
});

describe("KNOWN_HOSTS", () => {
	it("has openai host", () => {
		expect(KNOWN_HOSTS.openai.providers).toContain("openai");
	});
	it("has anthropic host", () => {
		expect(KNOWN_HOSTS.anthropic.providers).toContain("anthropic");
	});
	it("fireworks has no providers", () => {
		expect((KNOWN_HOSTS.fireworks as { providers?: string[] }).providers).toBeUndefined();
	});
	it("xiaomi has providerPrefixes", () => {
		expect(KNOWN_HOSTS.xiaomi.providerPrefixes).toContain("xiaomi-token-plan-");
	});
});

describe("toFireworksPublicModelId", () => {
	it("strips wire prefix and converts p to dot", () => {
		expect(toFireworksPublicModelId("accounts/fireworks/models/llama-v3p1-8b")).toBe("llama-v3.1-8b");
	});
	it("converts p to dot without prefix", () => {
		expect(toFireworksPublicModelId("llama-v3p1-8b")).toBe("llama-v3.1-8b");
	});
	it("handles id without version separator", () => {
		expect(toFireworksPublicModelId("llama-v3-8b")).toBe("llama-v3-8b");
	});
	it("handles already public id", () => {
		expect(toFireworksPublicModelId("llama-v3.1-8b")).toBe("llama-v3.1-8b");
	});
});

describe("toFireworksWireModelId", () => {
	it("adds wire prefix and converts dot to p", () => {
		expect(toFireworksWireModelId("llama-v3.1-8b")).toBe("accounts/fireworks/models/llama-v3p1-8b");
	});
	it("does not double-add prefix", () => {
		expect(toFireworksWireModelId("accounts/fireworks/models/llama-v3.1-8b")).toBe(
			"accounts/fireworks/models/llama-v3p1-8b",
		);
	});
	it("handles id without version separator", () => {
		expect(toFireworksWireModelId("llama-v3-8b")).toBe("accounts/fireworks/models/llama-v3-8b");
	});
});

describe("toFirepassPublicModelId", () => {
	it("strips firepass prefix and converts p to dot", () => {
		expect(toFirepassPublicModelId("accounts/fireworks/routers/llama-v3p1-8b")).toBe("llama-v3.1-8b");
	});
	it("converts p to dot without prefix", () => {
		expect(toFirepassPublicModelId("llama-v3p1-8b")).toBe("llama-v3.1-8b");
	});
});

describe("toFirepassWireModelId", () => {
	it("adds firepass prefix and converts dot to p", () => {
		expect(toFirepassWireModelId("llama-v3.1-8b")).toBe("accounts/fireworks/routers/llama-v3p1-8b");
	});
	it("does not double-add prefix", () => {
		expect(toFirepassWireModelId("accounts/fireworks/routers/llama-v3.1-8b")).toBe(
			"accounts/fireworks/routers/llama-v3p1-8b",
		);
	});
});

describe("isFireworksFastModelId", () => {
	it("returns true for fast model", () => {
		expect(isFireworksFastModelId("llama-v3-8b-fast")).toBe(true);
	});
	it("returns false for non-fast model", () => {
		expect(isFireworksFastModelId("llama-v3-8b")).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(isFireworksFastModelId("")).toBe(false);
	});
});

describe("toFireworksBaseModelId", () => {
	it("strips fast suffix", () => {
		expect(toFireworksBaseModelId("llama-v3-8b-fast")).toBe("llama-v3-8b");
	});
	it("returns id unchanged when no fast suffix", () => {
		expect(toFireworksBaseModelId("llama-v3-8b")).toBe("llama-v3-8b");
	});
	it("handles empty string", () => {
		expect(toFireworksBaseModelId("")).toBe("");
	});
});
