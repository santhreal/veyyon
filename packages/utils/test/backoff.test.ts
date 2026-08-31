import { describe, expect, it } from "bun:test";
import { type ExponentialBackoffOptions, exponentialBackoffDelay } from "../src/backoff";

describe("exponentialBackoffDelay", () => {
	it("returns base delay for attempt 0 with no jitter", () => {
		const opts: ExponentialBackoffOptions = { baseMs: 1000, jitter: 0, random: () => 0.5 };
		expect(exponentialBackoffDelay(0, opts)).toBe(1000);
	});

	it("doubles delay for each attempt", () => {
		const opts: ExponentialBackoffOptions = { baseMs: 1000, jitter: 0, random: () => 0.5 };
		expect(exponentialBackoffDelay(0, opts)).toBe(1000);
		expect(exponentialBackoffDelay(1, opts)).toBe(2000);
		expect(exponentialBackoffDelay(2, opts)).toBe(4000);
		expect(exponentialBackoffDelay(3, opts)).toBe(8000);
	});

	it("caps at maxMs", () => {
		const opts: ExponentialBackoffOptions = { baseMs: 1000, maxMs: 5000, jitter: 0, random: () => 0.5 };
		expect(exponentialBackoffDelay(0, opts)).toBe(1000);
		expect(exponentialBackoffDelay(1, opts)).toBe(2000);
		expect(exponentialBackoffDelay(2, opts)).toBe(4000);
		expect(exponentialBackoffDelay(3, opts)).toBe(5000);
		expect(exponentialBackoffDelay(10, opts)).toBe(5000);
	});

	it("applies jitter symmetrically around the capped value", () => {
		const jitter = 0.25;
		const random = () => 0.5; // middle of jitter range
		const opts: ExponentialBackoffOptions = { baseMs: 1000, jitter, random };
		// With random=0.5, the jitter factor is (1 - jitter + 0.5 * 2 * jitter) = 1
		expect(exponentialBackoffDelay(0, opts)).toBe(1000);
	});

	it("jitter at random=0 gives minimum delay", () => {
		const jitter = 0.25;
		const random = () => 0;
		const opts: ExponentialBackoffOptions = { baseMs: 1000, jitter, random };
		// factor = 1 - 0.25 + 0 * 0.5 = 0.75
		expect(exponentialBackoffDelay(0, opts)).toBe(750);
	});

	it("jitter at random=1 gives maximum delay", () => {
		const jitter = 0.25;
		const random = () => 1;
		const opts: ExponentialBackoffOptions = { baseMs: 1000, jitter, random };
		// factor = 1 - 0.25 + 1 * 0.5 = 1.25
		expect(exponentialBackoffDelay(0, opts)).toBe(1250);
	});

	it("uses default baseMs of 1000", () => {
		const opts: ExponentialBackoffOptions = { jitter: 0, random: () => 0.5 };
		expect(exponentialBackoffDelay(0, opts)).toBe(1000);
	});

	it("uses default maxMs of 30000", () => {
		const opts: ExponentialBackoffOptions = { jitter: 0, random: () => 0.5 };
		expect(exponentialBackoffDelay(20, opts)).toBe(30000);
	});

	it("uses default jitter of 0.25", () => {
		const opts: ExponentialBackoffOptions = { random: () => 0.5 };
		// With default jitter 0.25 and random 0.5, factor = 1
		expect(exponentialBackoffDelay(0, opts)).toBe(1000);
	});

	it("uses Math.random by default", () => {
		const result = exponentialBackoffDelay(0);
		// With default jitter, result should be between 750 and 1250
		expect(result).toBeGreaterThanOrEqual(750);
		expect(result).toBeLessThanOrEqual(1250);
	});

	it("handles zero jitter", () => {
		const opts: ExponentialBackoffOptions = { baseMs: 500, jitter: 0, random: () => 0.5 };
		expect(exponentialBackoffDelay(5, opts)).toBe(16000);
	});

	it("handles custom baseMs", () => {
		const opts: ExponentialBackoffOptions = { baseMs: 100, jitter: 0, random: () => 0.5 };
		expect(exponentialBackoffDelay(0, opts)).toBe(100);
		expect(exponentialBackoffDelay(1, opts)).toBe(200);
	});

	it("handles large attempt numbers", () => {
		const opts: ExponentialBackoffOptions = { baseMs: 1000, maxMs: 30000, jitter: 0, random: () => 0.5 };
		expect(exponentialBackoffDelay(100, opts)).toBe(30000);
	});

	it("handles zero baseMs", () => {
		const opts: ExponentialBackoffOptions = { baseMs: 0, jitter: 0, random: () => 0.5 };
		expect(exponentialBackoffDelay(5, opts)).toBe(0);
	});

	it("jitter factor stays within [1-jitter, 1+jitter]", () => {
		const baseMs = 1000;
		const jitter = 0.3;
		const minDelay = exponentialBackoffDelay(0, { baseMs, jitter, random: () => 0 });
		const maxDelay = exponentialBackoffDelay(0, { baseMs, jitter, random: () => 1 });
		expect(minDelay).toBeCloseTo(baseMs * (1 - jitter));
		expect(maxDelay).toBeCloseTo(baseMs * (1 + jitter));
	});
});
