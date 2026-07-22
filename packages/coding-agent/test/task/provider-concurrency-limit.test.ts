import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { getProviderConcurrencyLimit } from "@veyyon/coding-agent/task/provider-concurrency";

/**
 * getProviderConcurrencyLimit resolves the per-provider LLM concurrency ceiling that brackets each
 * streaming request. Its mapping is deliberately different from the map-phase clamp
 * (normalizeConcurrencyLimit, which returns 0 for "unlimited"): here a configured value <= 0 maps to
 * `Number.POSITIVE_INFINITY`, because getProviderSemaphore passes the result straight into a Semaphore
 * and needs a *tracked* infinite ceiling (so an in-flight run still holds a slot and a later finite
 * resize can count work started while unlimited). Two rules matter and had no direct test: a provider
 * with no cap concept returns undefined (the wrapper then passes straight through, never allocating a
 * semaphore), and a positive value is truncated toward zero. A regression returning 0 instead of
 * Infinity for the unlimited case would make `new Semaphore(0)` unbounded by a different code path, and
 * returning a finite default for an uncapped provider would wrongly throttle it.
 */
describe("getProviderConcurrencyLimit", () => {
	function withOllama(value: number | undefined): Settings {
		return value === undefined
			? Settings.isolated({})
			: Settings.isolated({ "providers.ollama-cloud.maxConcurrency": value });
	}

	it("returns undefined for a provider that has no cap concept, so the wrapper passes through", () => {
		expect(getProviderConcurrencyLimit(withOllama(2), "anthropic")).toBeUndefined();
	});

	it("returns the configured positive limit for a capped provider", () => {
		expect(getProviderConcurrencyLimit(withOllama(2), "ollama-cloud")).toBe(2);
	});

	it("truncates a fractional configured limit toward zero", () => {
		expect(getProviderConcurrencyLimit(withOllama(3.9), "ollama-cloud")).toBe(3);
	});

	it("maps a zero configured limit to Infinity (a tracked unlimited ceiling, not 0)", () => {
		expect(getProviderConcurrencyLimit(withOllama(0), "ollama-cloud")).toBe(Number.POSITIVE_INFINITY);
	});

	it("maps a negative configured limit to Infinity as well", () => {
		expect(getProviderConcurrencyLimit(withOllama(-5), "ollama-cloud")).toBe(Number.POSITIVE_INFINITY);
	});
});
