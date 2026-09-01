import { describe, expect, it } from "bun:test";
import {
	PROVIDER_FINISH_ERROR_PATTERN,
	PROVIDER_RESPONSE_RETRYABLE,
	providerFinishErrorMessage,
} from "../src/error/provider-helpers";

describe("PROVIDER_RESPONSE_RETRYABLE", () => {
	it("incomplete-stream is retryable", () => {
		expect(PROVIDER_RESPONSE_RETRYABLE["incomplete-stream"]).toBe(true);
	});
	it("empty-body is retryable", () => {
		expect(PROVIDER_RESPONSE_RETRYABLE["empty-body"]).toBe(true);
	});
	it("envelope is not retryable", () => {
		expect(PROVIDER_RESPONSE_RETRYABLE.envelope).toBe(false);
	});
	it("output is not retryable", () => {
		expect(PROVIDER_RESPONSE_RETRYABLE.output).toBe(false);
	});
	it("content-blocked is not retryable", () => {
		expect(PROVIDER_RESPONSE_RETRYABLE["content-blocked"]).toBe(false);
	});
	it("runtime is not retryable", () => {
		expect(PROVIDER_RESPONSE_RETRYABLE.runtime).toBe(false);
	});
});

describe("providerFinishErrorMessage", () => {
	it("formats message with reason", () => {
		expect(providerFinishErrorMessage("stop")).toBe("Provider finish_reason: stop");
	});
	it("uses 'unknown' for undefined", () => {
		expect(providerFinishErrorMessage(undefined)).toBe("Provider finish_reason: unknown");
	});
	it("uses 'unknown' for empty string", () => {
		expect(providerFinishErrorMessage("")).toBe("Provider finish_reason: unknown");
	});
});

describe("PROVIDER_FINISH_ERROR_PATTERN", () => {
	it("matches 'Provider returned error finish_reason'", () => {
		expect(PROVIDER_FINISH_ERROR_PATTERN.test("Provider returned error finish_reason")).toBe(true);
	});
	it("matches 'Provider finish_reason: error'", () => {
		expect(PROVIDER_FINISH_ERROR_PATTERN.test("Provider finish_reason: error")).toBe(true);
	});
	it("matches 'Generation failed with stop reason: error'", () => {
		expect(PROVIDER_FINISH_ERROR_PATTERN.test("Generation failed with stop reason: error")).toBe(true);
	});
	it("matches 'Generation failed with finish reason: error'", () => {
		expect(PROVIDER_FINISH_ERROR_PATTERN.test("Generation failed with finish reason: error")).toBe(true);
	});
	it("is case-insensitive", () => {
		expect(PROVIDER_FINISH_ERROR_PATTERN.test("PROVIDER FINISH_REASON: ERROR")).toBe(true);
	});
	it("does not match unrelated text", () => {
		expect(PROVIDER_FINISH_ERROR_PATTERN.test("some other error")).toBe(false);
	});
});
