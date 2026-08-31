import { describe, expect, it } from "bun:test";
import { renderDemotedThinking } from "../src/dialect/demotion";
import {
	boundProviderErrorDetail,
	MAX_PROVIDER_ERROR_DETAIL_CHARS,
	NO_PROVIDER_ERROR_DETAIL,
} from "../src/error/detail-bounds";

describe("MAX_PROVIDER_ERROR_DETAIL_CHARS", () => {
	it("is 4096", () => {
		expect(MAX_PROVIDER_ERROR_DETAIL_CHARS).toBe(4096);
	});
});

describe("NO_PROVIDER_ERROR_DETAIL", () => {
	it("is '(no detail)'", () => {
		expect(NO_PROVIDER_ERROR_DETAIL).toBe("(no detail)");
	});
});

describe("boundProviderErrorDetail", () => {
	it("returns '(no detail)' for empty string", () => {
		expect(boundProviderErrorDetail("")).toBe(NO_PROVIDER_ERROR_DETAIL);
	});
	it("returns '(no detail)' for whitespace-only string", () => {
		expect(boundProviderErrorDetail("   \n\t  ")).toBe(NO_PROVIDER_ERROR_DETAIL);
	});
	it("returns trimmed short string as-is", () => {
		expect(boundProviderErrorDetail("  error message  ")).toBe("error message");
	});
	it("returns string at exactly the cap", () => {
		const exact = "a".repeat(MAX_PROVIDER_ERROR_DETAIL_CHARS);
		expect(boundProviderErrorDetail(exact)).toBe(exact);
	});
	it("truncates string exceeding cap with suffix", () => {
		const long = "a".repeat(MAX_PROVIDER_ERROR_DETAIL_CHARS + 100);
		const result = boundProviderErrorDetail(long);
		expect(result.length).toBeLessThan(long.length);
		expect(result).toContain("[truncated");
		expect(result).toContain(`${MAX_PROVIDER_ERROR_DETAIL_CHARS + 100} chars total]`);
	});
	it("truncates and includes correct char count", () => {
		const long = "x".repeat(5000);
		const result = boundProviderErrorDetail(long);
		expect(result).toContain("5000 chars total");
	});
	it("trims before checking length", () => {
		const padded = "  " + "a".repeat(10) + "  ";
		expect(boundProviderErrorDetail(padded)).toBe("a".repeat(10));
	});
});

describe("renderDemotedThinking", () => {
	it("returns empty string for empty text", () => {
		expect(renderDemotedThinking("claude-sonnet-4", "")).toBe("");
	});
	it("returns text as-is for anthropic dialect", () => {
		expect(renderDemotedThinking("claude-sonnet-4", "thinking text")).toBe("thinking text");
	});
	it("returns text as-is for anthropic haiku", () => {
		expect(renderDemotedThinking("claude-3-5-haiku", "reasoning")).toBe("reasoning");
	});
	it("wraps harmony dialect in think tags", () => {
		const result = renderDemotedThinking("gpt-5-harmony", "reasoning");
		expect(result).toContain("reasoning");
		expect(result).toContain("<think>");
		expect(result).toContain("</think>");
	});
	it("wraps gemma dialect in think tags", () => {
		const result = renderDemotedThinking("gemma-3", "reasoning");
		expect(result).toContain("reasoning");
		expect(result).toContain("<think>");
		expect(result).toContain("</think>");
	});
	it("normalizes ill-formed text", () => {
		// Text with lone surrogates should be normalized
		const result = renderDemotedThinking("claude-sonnet-4", "hello\u{D800}world");
		expect(result).toBe("hello\u{FFFD}world");
	});
});
