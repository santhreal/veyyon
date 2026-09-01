import { describe, expect, it } from "bun:test";
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
	it("returns trimmed detail when within limit", () => {
		expect(boundProviderErrorDetail("  some error  ")).toBe("some error");
	});
	it("returns NO_PROVIDER_ERROR_DETAIL for empty string", () => {
		expect(boundProviderErrorDetail("")).toBe(NO_PROVIDER_ERROR_DETAIL);
	});
	it("returns NO_PROVIDER_ERROR_DETAIL for whitespace-only string", () => {
		expect(boundProviderErrorDetail("   \n\t  ")).toBe(NO_PROVIDER_ERROR_DETAIL);
	});
	it("returns detail as-is when exactly at limit", () => {
		const exact = "a".repeat(MAX_PROVIDER_ERROR_DETAIL_CHARS);
		expect(boundProviderErrorDetail(exact)).toBe(exact);
	});
	it("truncates and appends suffix when over limit", () => {
		const long = "a".repeat(MAX_PROVIDER_ERROR_DETAIL_CHARS + 100);
		const result = boundProviderErrorDetail(long);
		expect(result.length).toBeLessThan(long.length);
		expect(result).toContain("[truncated");
		expect(result).toContain(`${MAX_PROVIDER_ERROR_DETAIL_CHARS + 100} chars total`);
	});
	it("preserves content within limit after truncation", () => {
		const long = "b".repeat(MAX_PROVIDER_ERROR_DETAIL_CHARS + 10);
		const result = boundProviderErrorDetail(long);
		expect(result.startsWith("b".repeat(MAX_PROVIDER_ERROR_DETAIL_CHARS))).toBe(true);
	});
});
