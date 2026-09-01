import { describe, expect, it } from "bun:test";
import {
	baseUrlSchemeError,
	hasLocalLoopbackBaseUrl,
	hostMatchesUrl,
	isVertexExpressOpenAIUrl,
	isVertexRawPredictUrl,
	KNOWN_HOSTS,
	modelMatchesHost,
} from "../src/hosts";

describe("hostMatchesUrl", () => {
	it("returns false for undefined baseUrl", () => {
		expect(hostMatchesUrl(undefined, "anthropic")).toBe(false);
	});
	it("returns false for empty baseUrl", () => {
		expect(hostMatchesUrl("", "anthropic")).toBe(false);
	});
	it("returns true when URL contains known marker", () => {
		expect(hostMatchesUrl("https://api.anthropic.com/v1", "anthropic")).toBe(true);
	});
	it("returns false for unknown URL", () => {
		expect(hostMatchesUrl("https://example.com", "anthropic")).toBe(false);
	});
	it("is case-insensitive", () => {
		expect(hostMatchesUrl("https://API.ANTHROPIC.COM/v1", "anthropic")).toBe(true);
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
		expect(hasLocalLoopbackBaseUrl("http://192.168.1.100:8080")).toBe(true);
	});
	it("returns true for 172.16-31.x.x", () => {
		expect(hasLocalLoopbackBaseUrl("http://172.16.0.1:8080")).toBe(true);
		expect(hasLocalLoopbackBaseUrl("http://172.31.0.1:8080")).toBe(true);
	});
	it("returns false for 172.15.x.x (outside private range)", () => {
		expect(hasLocalLoopbackBaseUrl("http://172.15.0.1:8080")).toBe(false);
	});
	it("returns false for 172.32.x.x (outside private range)", () => {
		expect(hasLocalLoopbackBaseUrl("http://172.32.0.1:8080")).toBe(false);
	});
	it("returns true for .local mDNS", () => {
		expect(hasLocalLoopbackBaseUrl("http://myserver.local:8080")).toBe(true);
	});
	it("returns false for public host", () => {
		expect(hasLocalLoopbackBaseUrl("https://api.openai.com")).toBe(false);
	});
	it("returns false for undefined", () => {
		expect(hasLocalLoopbackBaseUrl(undefined)).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(hasLocalLoopbackBaseUrl("")).toBe(false);
	});
	it("returns false for unparseable URL", () => {
		expect(hasLocalLoopbackBaseUrl("not-a-url")).toBe(false);
	});
});

describe("baseUrlSchemeError", () => {
	it("returns null for valid http URL", () => {
		expect(baseUrlSchemeError("http://localhost:8080")).toBeNull();
	});
	it("returns null for valid https URL", () => {
		expect(baseUrlSchemeError("https://api.openai.com")).toBeNull();
	});
	it("returns error for missing scheme", () => {
		const error = baseUrlSchemeError("localhost:11434");
		expect(error).toContain("missing a scheme");
		expect(error).toContain("http://localhost:11434");
	});
	it("returns error for non-http scheme", () => {
		const error = baseUrlSchemeError("ftp://example.com");
		expect(error).toContain("not a usable endpoint");
	});
	it("returns error for unparseable URL", () => {
		const error = baseUrlSchemeError("not-a-url");
		expect(error).toContain("missing a scheme");
	});
	it("returns error for empty string", () => {
		const error = baseUrlSchemeError("");
		expect(error).not.toBeNull();
	});
	it("returns error for URL without hostname", () => {
		const error = baseUrlSchemeError("http://");
		expect(error).not.toBeNull();
	});
});

describe("modelMatchesHost", () => {
	it("matches by provider id", () => {
		expect(modelMatchesHost({ provider: "anthropic", baseUrl: "" }, "anthropic")).toBe(true);
	});
	it("matches by baseUrl when provider doesn't match", () => {
		expect(modelMatchesHost({ provider: "custom", baseUrl: "https://api.anthropic.com" }, "anthropic")).toBe(true);
	});
	it("returns false when neither matches", () => {
		expect(modelMatchesHost({ provider: "custom", baseUrl: "https://example.com" }, "anthropic")).toBe(false);
	});
});

describe("isVertexExpressOpenAIUrl", () => {
	it("returns true for /endpoints/openapi URL", () => {
		expect(isVertexExpressOpenAIUrl("https://us-central1-aiplatform.googleapis.com/endpoints/openapi")).toBe(true);
	});
	it("returns false for other URLs", () => {
		expect(isVertexExpressOpenAIUrl("https://api.openai.com")).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(isVertexExpressOpenAIUrl("")).toBe(false);
	});
});

describe("isVertexRawPredictUrl", () => {
	it("returns true for :streamRawPredict URL", () => {
		expect(isVertexRawPredictUrl("https://us-central1-aiplatform.googleapis.com:streamRawPredict")).toBe(true);
	});
	it("returns true for :rawPredict URL", () => {
		expect(isVertexRawPredictUrl("https://us-central1-aiplatform.googleapis.com:rawPredict")).toBe(true);
	});
	it("returns false for other URLs", () => {
		expect(isVertexRawPredictUrl("https://api.openai.com")).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(isVertexRawPredictUrl("")).toBe(false);
	});
});

describe("KNOWN_HOSTS", () => {
	it("has anthropic host", () => {
		expect(KNOWN_HOSTS.anthropic).toBeDefined();
	});
	it("has openai host", () => {
		expect(KNOWN_HOSTS.openai).toBeDefined();
	});
	it("each host has urlMarkers", () => {
		for (const key in KNOWN_HOSTS) {
			const host = KNOWN_HOSTS[key as keyof typeof KNOWN_HOSTS];
			expect(Array.isArray(host.urlMarkers)).toBe(true);
		}
	});
});
