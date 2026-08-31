import { describe, expect, it } from "bun:test";
import {
	applyClaudeToolPrefix,
	buildBetaHeader,
	buildClaudeCodeBetas,
	cloneAnthropicCacheControl,
	dropAnthropicFastMode,
	dropAnthropicStrictTools,
	encodeAnthropicToolName,
	extractClaudeMetadataSessionId,
	getHeaderCaseInsensitive,
	hasStrictAnthropicTools,
	isClaudeCloakingUserId,
	isClaudeCodeClientUserAgent,
	mapStainlessArch,
	mapStainlessOs,
	normalizeAnthropicBaseUrl,
	stripClaudeToolPrefix,
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
	it("strips trailing /v1", () => {
		expect(normalizeAnthropicBaseUrl("https://api.anthropic.com/v1")).toBe("https://api.anthropic.com");
	});
	it("strips trailing slashes before /v1 check", () => {
		expect(normalizeAnthropicBaseUrl("https://api.anthropic.com/v1/")).toBe("https://api.anthropic.com");
	});
	it("does not strip /v1 from middle of URL", () => {
		expect(normalizeAnthropicBaseUrl("https://api.anthropic.com/v1/chat")).toBe("https://api.anthropic.com/v1/chat");
	});
	it("preserves URL without /v1", () => {
		expect(normalizeAnthropicBaseUrl("https://api.anthropic.com")).toBe("https://api.anthropic.com");
	});
	it("strips trailing slashes from non-/v1 URL", () => {
		expect(normalizeAnthropicBaseUrl("https://example.com/")).toBe("https://example.com");
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
		expect(buildBetaHeader([" a ", "b"], ["c"])).toBe("a,b,c");
	});
	it("skips empty betas", () => {
		expect(buildBetaHeader(["a", "", "b"], ["c"])).toBe("a,b,c");
	});
	it("returns empty string for no betas", () => {
		expect(buildBetaHeader([], [])).toBe("");
	});
	it("handles only base betas", () => {
		expect(buildBetaHeader(["a", "b"], [])).toBe("a,b");
	});
	it("handles only extra betas", () => {
		expect(buildBetaHeader([], ["x", "y"])).toBe("x,y");
	});
});

describe("buildClaudeCodeBetas", () => {
	it("returns utility defaults for non-agent non-redact non-strict", () => {
		const result = buildClaudeCodeBetas(false, false, false);
		expect(result.length).toBeGreaterThan(0);
	});
	it("includes redact-thinking after interleaved-thinking when redactThinking is true", () => {
		const result = buildClaudeCodeBetas(false, false, true);
		const redactIdx = result.indexOf("redact-thinking-2026-02-12");
		const interleavedIdx = result.indexOf("interleaved-thinking-2025-05-14");
		expect(redactIdx).toBeGreaterThan(interleavedIdx);
	});
	it("excludes structured-outputs when disableStrictTools is true", () => {
		const result = buildClaudeCodeBetas(true, false, false, true);
		expect(result).not.toContain("structured-outputs-2025-12-15");
	});
	it("includes effort beta when agent and thinking request", () => {
		const result = buildClaudeCodeBetas(true, true, false);
		expect(result).toContain("effort-2025-11-24");
	});
	it("does not include effort beta when agent but no thinking request", () => {
		const result = buildClaudeCodeBetas(true, false, false);
		expect(result).not.toContain("effort-2025-11-24");
	});
	it("includes post-effort betas for agent request", () => {
		const result = buildClaudeCodeBetas(true, false, false);
		expect(result).toContain("extended-cache-ttl-2025-04-11");
	});
});

describe("getHeaderCaseInsensitive", () => {
	it("returns value for exact match", () => {
		expect(getHeaderCaseInsensitive({ "X-Foo": "bar" }, "X-Foo")).toBe("bar");
	});
	it("returns value for case-insensitive match", () => {
		expect(getHeaderCaseInsensitive({ "X-Foo": "bar" }, "x-foo")).toBe("bar");
	});
	it("returns value for different case key", () => {
		expect(getHeaderCaseInsensitive({ "x-FOO": "bar" }, "X-Foo")).toBe("bar");
	});
	it("returns undefined for missing header", () => {
		expect(getHeaderCaseInsensitive({ "X-Foo": "bar" }, "X-Bar")).toBeUndefined();
	});
	it("returns undefined for undefined headers", () => {
		expect(getHeaderCaseInsensitive(undefined, "X-Foo")).toBeUndefined();
	});
});

describe("isClaudeCodeClientUserAgent", () => {
	it("returns true for 'claude-cli' prefix", () => {
		expect(isClaudeCodeClientUserAgent("claude-cli/1.0")).toBe(true);
	});
	it("returns true for 'Claude-CLI' case-insensitive", () => {
		expect(isClaudeCodeClientUserAgent("Claude-CLI/1.0")).toBe(true);
	});
	it("returns false for unrelated user agent", () => {
		expect(isClaudeCodeClientUserAgent("curl/7.0")).toBe(false);
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
	it("maps linux to Linux", () => {
		expect(mapStainlessOs("linux")).toBe("Linux");
	});
	it("maps freebsd to FreeBSD", () => {
		expect(mapStainlessOs("freebsd")).toBe("FreeBSD");
	});
	it("maps unknown to Other::", () => {
		expect(mapStainlessOs("solaris")).toBe("Other::solaris");
	});
	it("is case-insensitive", () => {
		expect(mapStainlessOs("Darwin")).toBe("MacOS");
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
		expect(mapStainlessArch("riscv")).toBe("other::riscv");
	});
	it("is case-insensitive", () => {
		expect(mapStainlessArch("AMD64")).toBe("x64");
	});
});

describe("applyClaudeToolPrefix", () => {
	it("prefixes non-builtin tool names", () => {
		expect(applyClaudeToolPrefix("my_tool")).toBe("_my_tool");
	});
	it("does not prefix builtin tool names", () => {
		expect(applyClaudeToolPrefix("computer")).toBe("computer");
	});
});

describe("stripClaudeToolPrefix", () => {
	it("strips prefix from prefixed name", () => {
		expect(stripClaudeToolPrefix("_my_tool")).toBe("my_tool");
	});
	it("does not strip from non-prefixed name", () => {
		expect(stripClaudeToolPrefix("my_tool")).toBe("my_tool");
	});
	it("is case-insensitive for prefix matching", () => {
		expect(stripClaudeToolPrefix("_My_Tool")).toBe("My_Tool");
	});
});

describe("encodeAnthropicToolName", () => {
	it("returns name unchanged when useUmansGatewayWebSearch and name is web search", () => {
		expect(encodeAnthropicToolName("web_search", false, false, true)).toBe("web_search");
	});
	it("prefixes with claudeToolPrefix when escapeBuiltinToolNames is true", () => {
		expect(encodeAnthropicToolName("my_tool", false, true)).toBe("_my_tool");
	});
	it("applies claude prefix when isOAuthToken is true", () => {
		expect(encodeAnthropicToolName("my_tool", true, false)).toBe("_my_tool");
	});
	it("returns name unchanged when not OAuth and not escape", () => {
		expect(encodeAnthropicToolName("my_tool", false, false)).toBe("my_tool");
	});
});

describe("cloneAnthropicCacheControl", () => {
	it("creates a shallow copy", () => {
		const original = { type: "ephemeral" as const };
		const clone = cloneAnthropicCacheControl(original);
		expect(clone).toEqual(original);
		expect(clone).not.toBe(original);
	});
});

describe("hasStrictAnthropicTools", () => {
	it("returns true when at least one tool is strict", () => {
		expect(hasStrictAnthropicTools({ tools: [{ name: "a", strict: true }] })).toBe(true);
	});
	it("returns false when no tools are strict", () => {
		expect(hasStrictAnthropicTools({ tools: [{ name: "a", strict: false }] })).toBe(false);
	});
	it("returns false when tools is undefined", () => {
		expect(hasStrictAnthropicTools({})).toBe(false);
	});
	it("returns false for empty tools array", () => {
		expect(hasStrictAnthropicTools({ tools: [] })).toBe(false);
	});
});

describe("dropAnthropicFastMode", () => {
	it("deletes speed property", () => {
		const params: { speed?: string } = { speed: "fast" };
		dropAnthropicFastMode(params);
		expect(params.speed).toBeUndefined();
	});
	it("does nothing when speed is undefined", () => {
		const params: Record<string, unknown> = {};
		dropAnthropicFastMode(params);
		expect("speed" in params).toBe(false);
	});
});

describe("dropAnthropicStrictTools", () => {
	it("deletes strict from all tools", () => {
		const params = {
			tools: [
				{ name: "a", strict: true },
				{ name: "b", strict: true },
			],
		};
		dropAnthropicStrictTools(params);
		expect(params.tools![0]!.strict).toBeUndefined();
		expect(params.tools![1]!.strict).toBeUndefined();
	});
	it("does nothing when tools is undefined", () => {
		const params: { tools?: unknown[] } = {};
		dropAnthropicStrictTools(params);
		expect(params.tools).toBeUndefined();
	});
});

describe("isClaudeCloakingUserId", () => {
	it("returns true for valid cloaking user id", () => {
		const userId =
			"user_" +
			"a".repeat(64) +
			"_account_" +
			"b".repeat(8) +
			"-bbbb-bbbb-bbbb-bbbbbbbbbbbb" +
			"_session_" +
			"c".repeat(8) +
			"-cccc-cccc-cccc-cccccccccccc";
		expect(isClaudeCloakingUserId(userId)).toBe(true);
	});
	it("returns false for invalid format", () => {
		expect(isClaudeCloakingUserId("user_abc")).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(isClaudeCloakingUserId("")).toBe(false);
	});
});

describe("extractClaudeMetadataSessionId", () => {
	it("returns undefined for non-object metadata", () => {
		expect(extractClaudeMetadataSessionId("string")).toBeUndefined();
		expect(extractClaudeMetadataSessionId(42)).toBeUndefined();
		expect(extractClaudeMetadataSessionId(undefined)).toBeUndefined();
	});
	it("returns undefined for empty metadata", () => {
		expect(extractClaudeMetadataSessionId({})).toBeUndefined();
	});
});
