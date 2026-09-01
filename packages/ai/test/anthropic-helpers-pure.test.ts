import { describe, expect, it } from "bun:test";
import {
	ANTHROPIC_STOP_SEQUENCES_MAX,
	applyClaudeToolPrefix,
	buildBetaHeader,
	buildClaudeCodeBetas,
	claudeCodeAgentBetaDefaults,
	claudeCodeAgentPostEffortBetas,
	claudeCodeUtilityBetaDefaults,
	cloneAnthropicCacheControl,
	dropAnthropicFastMode,
	dropAnthropicStrictTools,
	effortBeta,
	getHeaderCaseInsensitive,
	hasStrictAnthropicTools,
	interleavedThinkingBeta,
	isClaudeCloakingUserId,
	isClaudeCodeClientUserAgent,
	mapStainlessArch,
	mapStainlessOs,
	normalizeAnthropicBaseUrl,
	redactThinkingBeta,
	stripClaudeToolPrefix,
	structuredOutputsBeta,
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
	it("strips trailing slashes", () => {
		expect(normalizeAnthropicBaseUrl("https://api.anthropic.com/")).toBe("https://api.anthropic.com");
	});
	it("strips /v1 suffix", () => {
		expect(normalizeAnthropicBaseUrl("https://api.anthropic.com/v1")).toBe("https://api.anthropic.com");
	});
	it("strips trailing slashes then /v1", () => {
		expect(normalizeAnthropicBaseUrl("https://api.anthropic.com/v1/")).toBe("https://api.anthropic.com");
	});
	it("preserves URL without /v1", () => {
		expect(normalizeAnthropicBaseUrl("https://custom.example.com/api")).toBe("https://custom.example.com/api");
	});
	it("trims whitespace", () => {
		expect(normalizeAnthropicBaseUrl("  https://api.anthropic.com  ")).toBe("https://api.anthropic.com");
	});
});

describe("buildBetaHeader", () => {
	it("joins base betas with comma", () => {
		expect(buildBetaHeader(["beta1", "beta2"], [])).toBe("beta1,beta2");
	});
	it("joins extra betas with base betas", () => {
		expect(buildBetaHeader(["beta1"], ["beta2", "beta3"])).toBe("beta1,beta2,beta3");
	});
	it("deduplicates betas", () => {
		expect(buildBetaHeader(["beta1", "beta2"], ["beta1", "beta3"])).toBe("beta1,beta2,beta3");
	});
	it("trims whitespace from betas", () => {
		expect(buildBetaHeader(["  beta1  "], ["  beta2  "])).toBe("beta1,beta2");
	});
	it("skips empty betas", () => {
		expect(buildBetaHeader(["beta1", "", "beta2"], [])).toBe("beta1,beta2");
	});
	it("skips whitespace-only betas", () => {
		expect(buildBetaHeader(["beta1", "   ", "beta2"], [])).toBe("beta1,beta2");
	});
	it("returns empty string for no betas", () => {
		expect(buildBetaHeader([], [])).toBe("");
	});
});

describe("buildClaudeCodeBetas", () => {
	it("returns utility defaults for non-agent non-redact non-strict", () => {
		const result = buildClaudeCodeBetas(false, false, false);
		expect(result).toEqual(claudeCodeUtilityBetaDefaults);
	});
	it("returns agent defaults plus post-effort betas for agent request", () => {
		const result = buildClaudeCodeBetas(true, false, false);
		expect(result).toEqual([...claudeCodeAgentBetaDefaults, ...claudeCodeAgentPostEffortBetas]);
	});
	it("includes redact thinking beta after interleaved thinking", () => {
		const result = buildClaudeCodeBetas(false, false, true);
		const interleavedIdx = result.indexOf(interleavedThinkingBeta);
		expect(interleavedIdx).not.toBe(-1);
		expect(result[interleavedIdx + 1]).toBe(redactThinkingBeta);
	});
	it("excludes structured outputs when disableStrictTools", () => {
		const result = buildClaudeCodeBetas(true, false, false, true);
		expect(result).not.toContain(structuredOutputsBeta);
	});
	it("includes effort beta for agent request with thinking", () => {
		const result = buildClaudeCodeBetas(true, true, false);
		expect(result).toContain(effortBeta);
	});
	it("does not include effort beta for agent request without thinking", () => {
		const result = buildClaudeCodeBetas(true, false, false);
		expect(result).not.toContain(effortBeta);
	});
});

describe("getHeaderCaseInsensitive", () => {
	it("returns value for exact match", () => {
		expect(getHeaderCaseInsensitive({ "Content-Type": "json" }, "Content-Type")).toBe("json");
	});
	it("returns value for case-insensitive match", () => {
		expect(getHeaderCaseInsensitive({ "Content-Type": "json" }, "content-type")).toBe("json");
	});
	it("returns value for uppercase query", () => {
		expect(getHeaderCaseInsensitive({ "content-type": "json" }, "CONTENT-TYPE")).toBe("json");
	});
	it("returns undefined for missing header", () => {
		expect(getHeaderCaseInsensitive({ "Content-Type": "json" }, "Authorization")).toBeUndefined();
	});
	it("returns undefined for undefined headers", () => {
		expect(getHeaderCaseInsensitive(undefined, "Content-Type")).toBeUndefined();
	});
	it("returns undefined for empty headers", () => {
		expect(getHeaderCaseInsensitive({}, "Content-Type")).toBeUndefined();
	});
});

describe("isClaudeCodeClientUserAgent", () => {
	it("returns true for claude-cli prefix", () => {
		expect(isClaudeCodeClientUserAgent("claude-cli/1.0")).toBe(true);
	});
	it("returns true for CLAUDE-CLI prefix (case insensitive)", () => {
		expect(isClaudeCodeClientUserAgent("CLAUDE-CLI/1.0")).toBe(true);
	});
	it("returns false for non-matching prefix", () => {
		expect(isClaudeCodeClientUserAgent("other-agent/1.0")).toBe(false);
	});
	it("returns false for undefined", () => {
		expect(isClaudeCodeClientUserAgent(undefined)).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(isClaudeCodeClientUserAgent("")).toBe(false);
	});
});

describe("mapStainlessOs", () => {
	it("maps darwin to MacOS", () => {
		expect(mapStainlessOs("darwin")).toBe("MacOS");
	});
	it("maps win32 to Windows", () => {
		expect(mapStainlessOs("win32")).toBe("Windows");
	});
	it("maps windows to Windows", () => {
		expect(mapStainlessOs("windows")).toBe("Windows");
	});
	it("maps linux to Linux", () => {
		expect(mapStainlessOs("linux")).toBe("Linux");
	});
	it("maps freebsd to FreeBSD", () => {
		expect(mapStainlessOs("freebsd")).toBe("FreeBSD");
	});
	it("maps unknown to Other::", () => {
		expect(mapStainlessOs("unknown")).toBe("Other::unknown");
	});
	it("handles case insensitivity", () => {
		expect(mapStainlessOs("DARWIN")).toBe("MacOS");
	});
});

describe("mapStainlessArch", () => {
	it("maps amd64 to x64", () => {
		expect(mapStainlessArch("amd64")).toBe("x64");
	});
	it("maps x64 to x64", () => {
		expect(mapStainlessArch("x64")).toBe("x64");
	});
	it("maps arm64 to arm64", () => {
		expect(mapStainlessArch("arm64")).toBe("arm64");
	});
	it("maps aarch64 to arm64", () => {
		expect(mapStainlessArch("aarch64")).toBe("arm64");
	});
	it("maps 386 to x86", () => {
		expect(mapStainlessArch("386")).toBe("x86");
	});
	it("maps ia32 to x86", () => {
		expect(mapStainlessArch("ia32")).toBe("x86");
	});
	it("maps unknown to other::", () => {
		expect(mapStainlessArch("unknown")).toBe("other::unknown");
	});
	it("handles case insensitivity", () => {
		expect(mapStainlessArch("AMD64")).toBe("x64");
	});
});

describe("cloneAnthropicCacheControl", () => {
	it("creates a shallow copy", () => {
		const original = { type: "ephemeral" as const };
		const clone = cloneAnthropicCacheControl(original);
		expect(clone).toEqual(original);
		expect(clone).not.toBe(original);
	});
	it("preserves ttl property", () => {
		const original = { type: "ephemeral" as const, ttl: "1h" as const };
		const clone = cloneAnthropicCacheControl(original);
		expect(clone.ttl).toBe("1h");
	});
});

describe("hasStrictAnthropicTools", () => {
	it("returns false when no tools", () => {
		expect(hasStrictAnthropicTools({} as never)).toBe(false);
	});
	it("returns false when no strict tools", () => {
		expect(hasStrictAnthropicTools({ tools: [{ name: "test" }] } as never)).toBe(false);
	});
	it("returns true when at least one strict tool", () => {
		expect(hasStrictAnthropicTools({ tools: [{ name: "test", strict: true }] } as never)).toBe(true);
	});
	it("returns false when strict is false", () => {
		expect(hasStrictAnthropicTools({ tools: [{ name: "test", strict: false }] } as never)).toBe(false);
	});
});

describe("dropAnthropicFastMode", () => {
	it("deletes speed property", () => {
		const params = { speed: "fast" } as never;
		dropAnthropicFastMode(params);
		expect((params as { speed?: unknown }).speed).toBeUndefined();
	});
	it("does nothing when speed not present", () => {
		const params = {} as Record<string, unknown>;
		dropAnthropicFastMode(params);
		expect(params).toEqual({});
	});
});

describe("dropAnthropicStrictTools", () => {
	it("deletes strict from all tools", () => {
		const params = {
			tools: [
				{ name: "a", strict: true },
				{ name: "b", strict: true },
			],
		} as Record<string, unknown>;
		dropAnthropicStrictTools(params);
		expect(((params.tools as unknown[])[0] as { strict?: unknown }).strict).toBeUndefined();
		expect(((params.tools as unknown[])[1] as { strict?: unknown }).strict).toBeUndefined();
	});
	it("does nothing when no tools", () => {
		const params = {} as Record<string, unknown>;
		dropAnthropicStrictTools(params);
		expect(params).toEqual({});
	});
});

describe("isClaudeCloakingUserId", () => {
	it("returns true for valid cloaking user id", () => {
		const validId =
			"user_" +
			"a".repeat(64) +
			"_account_" +
			"12345678-1234-1234-1234-123456789012" +
			"_session_" +
			"12345678-1234-1234-1234-123456789012";
		expect(isClaudeCloakingUserId(validId)).toBe(true);
	});
	it("returns false for invalid format", () => {
		expect(isClaudeCloakingUserId("invalid")).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(isClaudeCloakingUserId("")).toBe(false);
	});
});

describe("applyClaudeToolPrefix", () => {
	it("prepends underscore prefix", () => {
		expect(applyClaudeToolPrefix("myTool")).toBe("_myTool");
	});
	it("handles empty string", () => {
		expect(applyClaudeToolPrefix("")).toBe("_");
	});
});

describe("stripClaudeToolPrefix", () => {
	it("strips leading underscore", () => {
		expect(stripClaudeToolPrefix("_myTool")).toBe("myTool");
	});
	it("returns as-is when no underscore prefix", () => {
		expect(stripClaudeToolPrefix("myTool")).toBe("myTool");
	});
	it("handles empty string", () => {
		expect(stripClaudeToolPrefix("")).toBe("");
	});
	it("only strips first underscore", () => {
		expect(stripClaudeToolPrefix("__myTool")).toBe("_myTool");
	});
});

describe("ANTHROPIC_STOP_SEQUENCES_MAX", () => {
	it("is 4", () => {
		expect(ANTHROPIC_STOP_SEQUENCES_MAX).toBe(4);
	});
});
