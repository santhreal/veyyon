import { describe, expect, it } from "bun:test";
import {
	baseUrlSchemeError,
	hasLocalLoopbackBaseUrl,
	isDashscopeCompatibleModeUrl,
	isVertexExpressOpenAIUrl,
	isVertexRawPredictUrl,
} from "../src/hosts";

describe("hasLocalLoopbackBaseUrl", () => {
	it("returns false for undefined", () => {
		expect(hasLocalLoopbackBaseUrl(undefined)).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(hasLocalLoopbackBaseUrl("")).toBe(false);
	});

	it("returns false for invalid URL", () => {
		expect(hasLocalLoopbackBaseUrl("not a url")).toBe(false);
	});

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

	it("returns true for 172.16-31.x.x", () => {
		expect(hasLocalLoopbackBaseUrl("http://172.16.0.1:8080")).toBe(true);
		expect(hasLocalLoopbackBaseUrl("http://172.31.255.255:8080")).toBe(true);
	});

	it("returns false for 172.15.x.x (outside private range)", () => {
		expect(hasLocalLoopbackBaseUrl("http://172.15.0.1:8080")).toBe(false);
	});

	it("returns false for 172.32.x.x (outside private range)", () => {
		expect(hasLocalLoopbackBaseUrl("http://172.32.0.1:8080")).toBe(false);
	});

	it("returns true for .local domain", () => {
		expect(hasLocalLoopbackBaseUrl("http://myhost.local:8080")).toBe(true);
	});

	it("returns false for public URL", () => {
		expect(hasLocalLoopbackBaseUrl("https://api.example.com")).toBe(false);
	});

	it("is case-insensitive for hostname", () => {
		expect(hasLocalLoopbackBaseUrl("http://LOCALHOST:8080")).toBe(true);
	});
});

describe("baseUrlSchemeError", () => {
	it("returns null for valid https URL", () => {
		expect(baseUrlSchemeError("https://api.example.com")).toBeNull();
	});

	it("returns null for valid http URL", () => {
		expect(baseUrlSchemeError("http://localhost:8080")).toBeNull();
	});

	it("returns error for URL without scheme", () => {
		const error = baseUrlSchemeError("api.example.com");
		expect(error).toContain("missing a scheme");
		expect(error).toContain("http://");
	});

	it("returns error for non-http/https scheme", () => {
		const error = baseUrlSchemeError("ftp://example.com");
		expect(error).toContain("not a usable endpoint");
	});

	it("returns error for empty string", () => {
		const error = baseUrlSchemeError("");
		expect(error).toContain("missing a scheme");
	});

	it("returns error for URL with no hostname", () => {
		const error = baseUrlSchemeError("https://");
		expect(error).not.toBeNull();
	});

	it("returns error for just a scheme", () => {
		const error = baseUrlSchemeError("http://");
		expect(error).not.toBeNull();
	});

	it("returns null for URL with path and query", () => {
		expect(baseUrlSchemeError("https://api.example.com/v1/chat?model=test")).toBeNull();
	});
});

describe("isVertexExpressOpenAIUrl", () => {
	it("returns true for URL with /endpoints/openapi", () => {
		expect(isVertexExpressOpenAIUrl("https://vertex.example.com/endpoints/openapi")).toBe(true);
	});

	it("returns false for URL without /endpoints/openapi", () => {
		expect(isVertexExpressOpenAIUrl("https://vertex.example.com/v1/chat")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isVertexExpressOpenAIUrl("")).toBe(false);
	});
});

describe("isVertexRawPredictUrl", () => {
	it("returns true for URL with :streamRawPredict", () => {
		expect(isVertexRawPredictUrl("https://vertex.example.com:streamRawPredict")).toBe(true);
	});

	it("returns true for URL with :rawPredict", () => {
		expect(isVertexRawPredictUrl("https://vertex.example.com:rawPredict")).toBe(true);
	});

	it("returns false for URL without rawPredict", () => {
		expect(isVertexRawPredictUrl("https://vertex.example.com/v1/chat")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isVertexRawPredictUrl("")).toBe(false);
	});
});

describe("isDashscopeCompatibleModeUrl", () => {
	it("returns true for dashscope aliayuncs compatible-mode URL", () => {
		expect(isDashscopeCompatibleModeUrl("https://dashscope.aliyuncs.com/compatible-mode/v1")).toBe(true);
	});

	it("returns false for dashscope URL without compatible-mode", () => {
		expect(isDashscopeCompatibleModeUrl("https://dashscope.aliyuncs.com/api/v1")).toBe(false);
	});

	it("returns false for compatible-mode URL without dashscope", () => {
		expect(isDashscopeCompatibleModeUrl("https://example.com/compatible-mode/v1")).toBe(false);
	});

	it("returns false for URL without aliyuncs.com", () => {
		expect(isDashscopeCompatibleModeUrl("https://dashscope.example.com/compatible-mode/v1")).toBe(false);
	});

	it("is case-insensitive", () => {
		expect(isDashscopeCompatibleModeUrl("https://DASHSCOPE.ALIYUNCS.COM/compatible-mode/v1")).toBe(true);
	});

	it("returns false for empty string", () => {
		expect(isDashscopeCompatibleModeUrl("")).toBe(false);
	});
});
