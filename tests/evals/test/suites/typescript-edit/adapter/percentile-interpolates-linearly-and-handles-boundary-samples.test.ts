/**
 * WHY:
 * Benchmark summaries report p1, median (p50), and p99 token distributions over task runs.
 * Statistical error or off-by-one interpolation produces distorted cost numbers.
 *
 * This suite verifies:
 * 1. percentile() performs exact NumPy type-7 linear interpolation on ascending samples.
 * 2. Boundary samples (empty, single-element, duplicate values, 0th/100th percentiles) resolve correctly.
 * 3. diffTokenStats computes net input tokens after deducting fixed system prompt overhead.
 * 4. isBetterRun enforces stable preference: success > non-ghost > lowest tokens > earlier run index.
 *
 * What this does not catch:
 * Flakiness in underlying model pricing calculations.
 */

import { describe, expect, it } from "bun:test";
import {
	diffTokenStats,
	isBetterRun,
	isGhostRun,
	isTransportFailure,
	percentile,
	pickBestRunIndex,
	summarizeTokenDistribution,
} from "../../../../suites/typescript-edit/runner/stats";
import type { TaskRunResult } from "../../../../suites/typescript-edit/runner/types";

describe("percentile linear interpolation", () => {
	it("handles empty and single-element samples without division errors", () => {
		expect(percentile([], 50)).toBe(0);
		expect(percentile([42], 0)).toBe(42);
		expect(percentile([42], 50)).toBe(42);
		expect(percentile([42], 100)).toBe(42);
	});

	it("interpolates linearly on multi-element ascending samples (NumPy type-7)", () => {
		const sample = [10, 20, 30, 40, 50];
		expect(percentile(sample, 0)).toBe(10);
		expect(percentile(sample, 25)).toBe(20);
		expect(percentile(sample, 50)).toBe(30);
		expect(percentile(sample, 75)).toBe(40);
		expect(percentile(sample, 100)).toBe(50);
		// rank for p=10: 0.1 * 4 = 0.4 -> 10 + 0.4*(20 - 10) = 14
		expect(percentile(sample, 10)).toBeCloseTo(14, 5);
		// rank for p=90: 0.9 * 4 = 3.6 -> 40 + 0.6*(50 - 40) = 46
		expect(percentile(sample, 90)).toBeCloseTo(46, 5);
	});

	it("summarizes token distributions at median, p1, and p99", () => {
		const makeRun = (tokens: number): TaskRunResult => ({
			runIndex: 0,
			success: true,
			patchApplied: true,
			verificationPassed: true,
			tokens: { input: tokens, output: tokens * 2, reasoning: 0, total: tokens * 3 },
			duration: 100,
			toolCalls: {
				read: 1,
				edit: 1,
				write: 0,
				editSuccesses: 1,
				editFailures: 0,
				editWarnings: 0,
				editAutocorrects: 0,
				totalInputChars: 100,
			},
			editFailures: [],
			editWarnings: [],
			editAutocorrectCount: 0,
		});

		const runs = [makeRun(100), makeRun(200), makeRun(300), makeRun(400), makeRun(500)];
		const dist = summarizeTokenDistribution(runs);
		expect(dist.median.input).toBe(300);
		expect(dist.median.output).toBe(600);
		expect(dist.median.total).toBe(900);
		expect(dist.p1.input).toBeGreaterThanOrEqual(100);
		expect(dist.p99.input).toBeLessThanOrEqual(500);
	});
});

describe("diffTokenStats overhead deduction", () => {
	it("deducts system prompt overhead per assistant turn from total input tokens", () => {
		const before = {
			tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 500, cacheWrite: 200 },
			assistantMessages: 1,
		};
		const after = {
			tokens: { input: 300, output: 150, reasoning: 20, cacheRead: 1500, cacheWrite: 400 },
			assistantMessages: 3,
		};
		const systemPromptTokens = 250;
		// Before prompt = 100 + 500 + 200 = 800
		// After prompt = 300 + 1500 + 400 = 2200
		// Delta prompt = 2200 - 800 = 1400
		// Overhead = (3 - 1) * 250 = 500
		// Expected net input = 1400 - 500 = 900
		// Expected output = 150 - 50 = 100
		// Expected reasoning = 20 - 0 = 20
		const stats = diffTokenStats(before, after, systemPromptTokens);
		expect(stats.input).toBe(900);
		expect(stats.output).toBe(100);
		expect(stats.reasoning).toBe(20);
		expect(stats.total).toBe(1000);
	});
});

describe("best run selection ordering invariants", () => {
	const baseRun: TaskRunResult = {
		runIndex: 0,
		success: false,
		patchApplied: false,
		verificationPassed: false,
		tokens: { input: 100, output: 50, reasoning: 0, total: 150 },
		duration: 1000,
		toolCalls: {
			read: 1,
			edit: 1,
			write: 0,
			editSuccesses: 0,
			editFailures: 1,
			editWarnings: 0,
			editAutocorrects: 0,
			totalInputChars: 100,
		},
		editFailures: [],
		editWarnings: [],
		editAutocorrectCount: 0,
	};

	it("prefers success over failure", () => {
		const failed = { ...baseRun, success: false };
		const successful = { ...baseRun, success: true };
		expect(isBetterRun(successful, failed)).toBe(true);
		expect(isBetterRun(failed, successful)).toBe(false);
	});

	it("prefers non-ghost runs over ghost stalls", () => {
		const ghost = {
			...baseRun,
			tokens: { input: 0, output: 0, reasoning: 0, total: 0 },
			toolCalls: { ...baseRun.toolCalls, read: 0, edit: 0 },
		};
		expect(isGhostRun(ghost)).toBe(true);
		expect(isBetterRun(baseRun, ghost)).toBe(true);
	});

	it("identifies timeout-exhausted transport failures as ghost runs", () => {
		const timeoutExhausted = {
			...baseRun,
			error: "Timeout exhausted after 3 retries",
		};
		expect(isTransportFailure(timeoutExhausted)).toBe(true);
		expect(isGhostRun(timeoutExhausted)).toBe(true);
	});

	it("picks the index of the best run across an ordered list", () => {
		const run0 = { ...baseRun, runIndex: 0, tokens: { input: 500, output: 500, reasoning: 0, total: 1000 } };
		const run1 = {
			...baseRun,
			runIndex: 1,
			success: true,
			tokens: { input: 300, output: 300, reasoning: 0, total: 600 },
		};
		const run2 = {
			...baseRun,
			runIndex: 2,
			success: true,
			tokens: { input: 200, output: 200, reasoning: 0, total: 400 },
		};
		expect(pickBestRunIndex([run0, run1, run2])).toBe(2);
	});
});
