import { describe, expect, it } from "bun:test";
import {
	buildBetaHeader,
	buildClaudeCodeBetas,
	claudeCodeAgentBetaDefaults,
	claudeCodeAgentPostEffortBetas,
	claudeCodeUtilityBetaDefaults,
	contextManagementBeta,
	effortBeta,
	fastModeBeta,
	fineGrainedToolStreamingBeta,
	getHeaderCaseInsensitive,
	interleavedThinkingBeta,
	isClaudeCodeClientUserAgent,
	midConversationSystemBeta,
	normalizeAnthropicBaseUrl,
	redactThinkingBeta,
	serverSideFallbackBeta,
	structuredOutputsBeta,
	taskBudgetBeta,
} from "../src/providers/anthropic-helpers";

describe("normalizeAnthropicBaseUrl", () => {
	it("returns undefined for undefined input", () => {
		expect(normalizeAnthropicBaseUrl(undefined)).toBeUndefined();
	});

	it("returns undefined for empty string", () => {
		expect(normalizeAnthropicBaseUrl("")).toBeUndefined();
	});

	it("returns undefined for whitespace-only string", () => {
		expect(normalizeAnthropicBaseUrl("   ")).toBeUndefined();
	});

	it("returns URL without trailing slash", () => {
		expect(normalizeAnthropicBaseUrl("https://api.anthropic.com/")).toBe("https://api.anthropic.com");
	});

	it("removes multiple trailing slashes", () => {
		expect(normalizeAnthropicBaseUrl("https://api.anthropic.com///")).toBe("https://api.anthropic.com");
	});

	it("strips /v1 suffix", () => {
		expect(normalizeAnthropicBaseUrl("https://api.anthropic.com/v1")).toBe("https://api.anthropic.com");
	});

	it("strips /v1 suffix with trailing slash", () => {
		expect(normalizeAnthropicBaseUrl("https://api.anthropic.com/v1/")).toBe("https://api.anthropic.com");
	});

	it("preserves URL without /v1 suffix", () => {
		expect(normalizeAnthropicBaseUrl("https://custom.example.com/api")).toBe("https://custom.example.com/api");
	});

	it("trims whitespace around URL", () => {
		expect(normalizeAnthropicBaseUrl("  https://api.anthropic.com  ")).toBe("https://api.anthropic.com");
	});

	it("handles URL with path segments", () => {
		expect(normalizeAnthropicBaseUrl("https://gateway.example.com/proxy/v1")).toBe(
			"https://gateway.example.com/proxy",
		);
	});

	it("does not strip /v1 from middle of path", () => {
		expect(normalizeAnthropicBaseUrl("https://example.com/v1/messages")).toBe("https://example.com/v1/messages");
	});
});

describe("buildBetaHeader", () => {
	it("joins base and extra betas with comma", () => {
		expect(buildBetaHeader(["a", "b"], ["c"])).toBe("a,b,c");
	});

	it("deduplicates betas", () => {
		expect(buildBetaHeader(["a", "b"], ["b", "c"])).toBe("a,b,c");
	});

	it("trims whitespace from betas", () => {
		expect(buildBetaHeader([" a ", "b"], [" c "])).toBe("a,b,c");
	});

	it("skips empty betas", () => {
		expect(buildBetaHeader(["a", "", "b"], ["", "c"])).toBe("a,b,c");
	});

	it("handles empty base betas", () => {
		expect(buildBetaHeader([], ["a", "b"])).toBe("a,b");
	});

	it("handles empty extra betas", () => {
		expect(buildBetaHeader(["a", "b"], [])).toBe("a,b");
	});

	it("handles both empty", () => {
		expect(buildBetaHeader([], [])).toBe("");
	});

	it("preserves order with dedup keeping first occurrence", () => {
		expect(buildBetaHeader(["a", "b", "a"], ["b", "c", "a"])).toBe("a,b,c");
	});
});

describe("buildClaudeCodeBetas", () => {
	it("returns utility defaults for non-agent, no redact, no strict-tools disable", () => {
		const result = buildClaudeCodeBetas(false, false, false, false);
		expect(result).toEqual(claudeCodeUtilityBetaDefaults);
	});

	it("includes all agent defaults for agent request", () => {
		const result = buildClaudeCodeBetas(true, false, false, false);
		for (const beta of claudeCodeAgentBetaDefaults) {
			expect(result).toContain(beta);
		}
	});

	it("includes effort beta when thinking is requested for agent", () => {
		const result = buildClaudeCodeBetas(true, true, false, false);
		expect(result).toContain(effortBeta);
	});

	it("includes post-effort betas for agent request", () => {
		const result = buildClaudeCodeBetas(true, false, false, false);
		for (const beta of claudeCodeAgentPostEffortBetas) {
			expect(result).toContain(beta);
		}
	});

	it("includes redact-thinking beta after interleaved-thinking when redactThinking is true", () => {
		const result = buildClaudeCodeBetas(false, false, true, false);
		const redactIdx = result.indexOf(redactThinkingBeta);
		const interleavedIdx = result.indexOf(interleavedThinkingBeta);
		expect(redactIdx).toBeGreaterThan(-1);
		expect(interleavedIdx).toBeGreaterThan(-1);
		expect(redactIdx).toBe(interleavedIdx + 1);
	});

	it("excludes structured-outputs beta when disableStrictTools is true", () => {
		const result = buildClaudeCodeBetas(false, false, false, true);
		expect(result).not.toContain(structuredOutputsBeta);
	});

	it("excludes structured-outputs beta for agent with strict tools disabled", () => {
		const result = buildClaudeCodeBetas(true, false, false, true);
		expect(result).not.toContain(structuredOutputsBeta);
	});

	it("includes redact-thinking for agent with redactThinking", () => {
		const result = buildClaudeCodeBetas(true, false, true, false);
		expect(result).toContain(redactThinkingBeta);
	});

	it("does not include effort beta when thinking is not requested", () => {
		const result = buildClaudeCodeBetas(true, false, false, false);
		expect(result).not.toContain(effortBeta);
	});

	it("does not include effort beta for non-agent", () => {
		const result = buildClaudeCodeBetas(false, true, false, false);
		expect(result).not.toContain(effortBeta);
	});
});

describe("getHeaderCaseInsensitive", () => {
	it("finds header with exact case", () => {
		expect(getHeaderCaseInsensitive({ "Content-Type": "application/json" }, "Content-Type")).toBe("application/json");
	});

	it("finds header with different case", () => {
		expect(getHeaderCaseInsensitive({ "content-type": "application/json" }, "Content-Type")).toBe("application/json");
	});

	it("finds header when query is lowercase", () => {
		expect(getHeaderCaseInsensitive({ "Content-Type": "application/json" }, "content-type")).toBe("application/json");
	});

	it("finds header with mixed case variations", () => {
		expect(getHeaderCaseInsensitive({ "X-Custom-Header": "value" }, "x-custom-header")).toBe("value");
	});

	it("returns undefined for missing header", () => {
		expect(getHeaderCaseInsensitive({ "Content-Type": "application/json" }, "Authorization")).toBeUndefined();
	});

	it("returns undefined for undefined headers", () => {
		expect(getHeaderCaseInsensitive(undefined, "Content-Type")).toBeUndefined();
	});

	it("returns undefined for empty headers object", () => {
		expect(getHeaderCaseInsensitive({}, "Content-Type")).toBeUndefined();
	});

	it("returns first match when multiple case variants exist", () => {
		const headers = { "X-Header": "first", "x-header": "second" };
		const result = getHeaderCaseInsensitive(headers, "X-Header");
		expect(result).toBe("first");
	});
});

describe("isClaudeCodeClientUserAgent", () => {
	it("returns true for claude-cli user agent", () => {
		expect(isClaudeCodeClientUserAgent("claude-cli/1.0")).toBe(true);
	});

	it("returns true for claude-cli with mixed case", () => {
		expect(isClaudeCodeClientUserAgent("Claude-CLI/1.0")).toBe(true);
	});

	it("returns true for CLAUDE-CLI uppercase", () => {
		expect(isClaudeCodeClientUserAgent("CLAUDE-CLI/2.0")).toBe(true);
	});

	it("returns false for undefined", () => {
		expect(isClaudeCodeClientUserAgent(undefined)).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isClaudeCodeClientUserAgent("")).toBe(false);
	});

	it("returns false for non-claude user agent", () => {
		expect(isClaudeCodeClientUserAgent("curl/7.88.1")).toBe(false);
	});

	it("returns false for user agent that contains but doesn't start with claude-cli", () => {
		expect(isClaudeCodeClientUserAgent("myapp claude-cli/1.0")).toBe(false);
	});

	it("narrows type to string when true", () => {
		const ua: string | undefined = "claude-cli/1.0";
		if (isClaudeCodeClientUserAgent(ua)) {
			// TypeScript should know ua is string here
			expect(ua.length).toBeGreaterThan(0);
		}
	});
});

describe("beta constants", () => {
	it("exports expected beta strings", () => {
		expect(midConversationSystemBeta).toBe("mid-conversation-system-2026-04-07");
		expect(contextManagementBeta).toBe("context-management-2025-06-27");
		expect(structuredOutputsBeta).toBe("structured-outputs-2025-12-15");
		expect(fineGrainedToolStreamingBeta).toBe("fine-grained-tool-streaming-2025-05-14");
		expect(interleavedThinkingBeta).toBe("interleaved-thinking-2025-05-14");
		expect(redactThinkingBeta).toBe("redact-thinking-2026-02-12");
		expect(fastModeBeta).toBe("fast-mode-2026-02-01");
		expect(taskBudgetBeta).toBe("task-budgets-2026-03-13");
		expect(effortBeta).toBe("effort-2025-11-24");
		expect(serverSideFallbackBeta).toBe("server-side-fallback-2026-06-01");
	});

	it("utility defaults include expected betas", () => {
		expect(claudeCodeUtilityBetaDefaults).toContain("oauth-2025-04-20");
		expect(claudeCodeUtilityBetaDefaults).toContain(interleavedThinkingBeta);
		expect(claudeCodeUtilityBetaDefaults).toContain(contextManagementBeta);
		expect(claudeCodeUtilityBetaDefaults).toContain(structuredOutputsBeta);
	});

	it("agent defaults include expected betas", () => {
		expect(claudeCodeAgentBetaDefaults).toContain("claude-code-20250219");
		expect(claudeCodeAgentBetaDefaults).toContain(midConversationSystemBeta);
		expect(claudeCodeAgentBetaDefaults).toContain("advanced-tool-use-2025-11-20");
	});

	it("post-effort betas include extended cache ttl", () => {
		expect(claudeCodeAgentPostEffortBetas).toContain("extended-cache-ttl-2025-04-11");
	});
});
