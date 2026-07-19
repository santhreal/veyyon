/**
 * Bounds + property tests for calculateAnthropicRetryDelayMs.
 *
 * The backoff is `min(0.5s * 2^attempt, 8s)` scaled by jitter `1 - random*0.25`,
 * returned in milliseconds. Jitter is live randomness, so these pin the exact
 * contract by its bounds instead of a single value: exponential doubling until
 * the 8s cap, jitter always in (0.75, 1], and the delay never exceeding the cap.
 * A regression to linear growth, a missing cap, or an out-of-range jitter all
 * break at least one bound.
 */
import { describe, expect, it } from "bun:test";
import { calculateAnthropicRetryDelayMs } from "@veyyon/ai/providers/anthropic-client";

// Documented base delay (seconds) per attempt: 0.5 * 2^attempt, capped at 8.
const BASE_SECONDS_BY_ATTEMPT = [0.5, 1, 2, 4, 8, 8, 8, 8];
const MAX_DELAY_MS = 8_000;
const SAMPLES = 3_000;

describe("calculateAnthropicRetryDelayMs", () => {
	it("keeps every sample within (base*0.75, base] * 1000 for each attempt", () => {
		BASE_SECONDS_BY_ATTEMPT.forEach((baseSeconds, attempt) => {
			const upper = baseSeconds * 1_000; // jitter can reach 1 (random == 0)
			const lower = baseSeconds * 0.75 * 1_000; // jitter approaches but never reaches 0.75
			for (let i = 0; i < SAMPLES; i++) {
				const delay = calculateAnthropicRetryDelayMs(attempt);
				expect(delay).toBeLessThanOrEqual(upper);
				expect(delay).toBeGreaterThan(lower);
			}
		});
	});

	it("doubles the base delay each attempt until the cap", () => {
		// The upper bound (jitter == 1) is the base itself, so the observed maximum
		// across many samples must approach base*1000 and double per attempt.
		const maxFor = (attempt: number): number => {
			let max = 0;
			for (let i = 0; i < SAMPLES; i++) max = Math.max(max, calculateAnthropicRetryDelayMs(attempt));
			return max;
		};
		// Each observed max sits just under its base ceiling; comparing maxes proves
		// the base grew, without depending on hitting the exact jitter==1 draw.
		expect(maxFor(1)).toBeGreaterThan(maxFor(0)); // 1s ceiling vs 0.5s
		expect(maxFor(2)).toBeGreaterThan(maxFor(1)); // 2s vs 1s
		expect(maxFor(3)).toBeGreaterThan(maxFor(2)); // 4s vs 2s
		// Base ceilings are 500 / 1000 / 2000 / 4000 ms; each max must clear
		// three-quarters of its own ceiling (the jitter floor).
		expect(maxFor(0)).toBeGreaterThan(375);
		expect(maxFor(1)).toBeGreaterThan(750);
		expect(maxFor(2)).toBeGreaterThan(1_500);
		expect(maxFor(3)).toBeGreaterThan(3_000);
	});

	it("caps at 8s and never exceeds it, even for large attempts", () => {
		for (const attempt of [4, 5, 10, 50, 1_000]) {
			for (let i = 0; i < SAMPLES; i++) {
				const delay = calculateAnthropicRetryDelayMs(attempt);
				expect(delay).toBeLessThanOrEqual(MAX_DELAY_MS);
				// At the cap the base is 8s, so the jitter floor is 6s.
				expect(delay).toBeGreaterThan(6_000);
			}
		}
	});

	it("applies jitter rather than returning a constant", () => {
		// Across many samples at one attempt the values must vary; a fixed return
		// (jitter dropped) would collapse min and max to a single value.
		let min = Number.POSITIVE_INFINITY;
		let max = 0;
		for (let i = 0; i < SAMPLES; i++) {
			const delay = calculateAnthropicRetryDelayMs(0);
			min = Math.min(min, delay);
			max = Math.max(max, delay);
		}
		expect(max).toBeGreaterThan(min);
	});
});
