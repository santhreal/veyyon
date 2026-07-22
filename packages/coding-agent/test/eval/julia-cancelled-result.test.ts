import { describe, expect, it } from "bun:test";
import { createCancelledJuliaResult } from "@veyyon/coding-agent/eval/jl/executor";

/**
 * Regression coverage for a lost-timeout-signal bug in the Julia executor. The
 * outer cancellation catch calls createCancelledJuliaResult(timedOut) with only
 * the flag, no timeoutMs. The function used to ignore that flag and key solely on
 * timeoutMs (always undefined here), so EVERY cancelled Julia cell rendered
 * "[execution cancelled]" and a real timeout was indistinguishable from a plain
 * abort. Julia keeps its own bracketed wording (its kernel-recovery model differs
 * from the python/ruby interrupt+reset flow); these tests pin that a timeout now
 * reads as a timeout while a plain cancellation stays a cancellation.
 */
describe("createCancelledJuliaResult", () => {
	it("labels a plain (non-timeout) cancellation as cancelled", () => {
		const result = createCancelledJuliaResult(false);
		expect(result.output).toBe("[execution cancelled]\n");
		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
	});

	it("labels a timeout without a known budget as a timeout, not a cancellation", () => {
		const result = createCancelledJuliaResult(true);
		expect(result.output).toBe("[cell timed out]\n");
		expect(result.output).not.toBe("[execution cancelled]\n");
		expect(result.cancelled).toBe(true);
	});

	it("includes the whole-second budget when a timeout duration is known", () => {
		const result = createCancelledJuliaResult(true, 30_000);
		expect(result.output).toBe("[cell timed out after 30s]");
		expect(result.cancelled).toBe(true);
	});
});
