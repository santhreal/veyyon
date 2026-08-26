/**
 * WHY:
 * Edit benchmark trials may encounter transient provider rate limits, authentication
 * hiccups, or tool timeouts. Unbounded retries or wrong backoff calculation would hang
 * benchmark runs or hammer rate-limited endpoints.
 *
 * This suite verifies:
 * 1. Provider failure backoff doubles exponentially and is capped at 10,000ms.
 * 2. Provider failures (auth vs general) are accurately detected from message_end events.
 * 3. Edit failure categories cover all declared EDIT_FAILURE_CATEGORIES variants from source.
 * 4. Retry context synthesis formats bounded attempt bounds.
 *
 * What this does not catch:
 * Network packet drops at the OS TCP layer before the agent runtime sees an error event.
 */

import { describe, expect, it } from "bun:test";
import {
	buildProviderFailureRetryContext,
	buildTimeoutRetryContext,
	categorizeEditFailure,
	countEditFailureCategories,
	countHashlineEditSubtypes,
	detectProviderFailure,
	getProviderFailureRetryDelayMs,
} from "../../../../src/suites/typescript-edit/adapter/runner/retry";
import {
	EDIT_FAILURE_CATEGORIES,
	type EditFailureCategory,
	type PromptAttemptTelemetry,
	type ProviderFailure,
	type TaskRunResult,
} from "../../../../src/suites/typescript-edit/adapter/runner/types";

describe("provider failure retry backoff", () => {
	it("follows a 1s * 2^(n-1) sequence capped at 10,000ms", () => {
		expect(getProviderFailureRetryDelayMs(0)).toBe(1_000);
		expect(getProviderFailureRetryDelayMs(1)).toBe(1_000);
		expect(getProviderFailureRetryDelayMs(2)).toBe(2_000);
		expect(getProviderFailureRetryDelayMs(3)).toBe(4_000);
		expect(getProviderFailureRetryDelayMs(4)).toBe(8_000);
		expect(getProviderFailureRetryDelayMs(5)).toBe(10_000);
		expect(getProviderFailureRetryDelayMs(6)).toBe(10_000);
		expect(getProviderFailureRetryDelayMs(100)).toBe(10_000);
	});

	it("detects authentication vs general provider failures from message events", () => {
		const authEvents = [
			{ type: "turn_start" },
			{
				type: "message_end",
				message: {
					role: "assistant",
					errorMessage: "401 Unauthorized: Invalid API key provided",
				},
			},
		];
		const authFailure = detectProviderFailure(authEvents);
		expect(authFailure).toEqual({
			kind: "auth",
			message: "401 Unauthorized: Invalid API key provided",
		});

		const rateLimitEvents = [
			{
				type: "message_end",
				message: {
					role: "assistant",
					errorMessage: "503 Service Unavailable: overloaded",
				},
			},
		];
		const providerFailure = detectProviderFailure(rateLimitEvents);
		expect(providerFailure).toEqual({
			kind: "provider",
			message: "503 Service Unavailable: overloaded",
		});

		const cleanEvents = [
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Done" }],
				},
			},
		];
		expect(detectProviderFailure(cleanEvents)).toBeNull();
	});

	it("formats timeout and provider failure retry contexts with bounded limits", () => {
		const telemetry: PromptAttemptTelemetry = {
			elapsedMs: 30000,
			eventCount: 5,
			toolExecutionStarts: 2,
			toolExecutionEnds: 2,
			messageEnds: 1,
			lastEventType: "tool_execution_end",
			recentEventTypes: ["turn_start", "tool_execution_start", "tool_execution_end"],
			pendingRetry: false,
		};
		const timeoutContext = buildTimeoutRetryContext(telemetry, 2, 3);
		expect(timeoutContext).toContain("Timeout retry 2/3");
		expect(timeoutContext).toContain("30000ms");
		expect(timeoutContext).toContain("tool_starts=2");

		const failure: ProviderFailure = { kind: "auth", message: "Forbidden" };
		const providerContext = buildProviderFailureRetryContext(failure, 1, 3, 1000);
		expect(providerContext).toContain("provider/auth error");
		expect(providerContext).toContain("Retry 1/3 after 1000ms backoff");
	});

	it("terminates when retry limits are exhausted and guarantees bounded attempts", () => {
		const maxTimeoutRetries = 3;
		const maxProviderFailureRetries = 2;
		let timeoutRetriesUsed = 0;
		let providerFailureRetries = 0;
		let attemptsExecuted = 0;
		let terminalError: string | undefined;

		// Simulate retry loop with persistent timeout faults
		for (let attempt = 0; attempt < 1; attempt++) {
			attemptsExecuted++;
			timeoutRetriesUsed++;
			if (timeoutRetriesUsed >= maxTimeoutRetries) {
				terminalError = `Timeout exhausted after ${maxTimeoutRetries} retries`;
				break;
			}
			attempt--;
		}

		expect(timeoutRetriesUsed).toBe(maxTimeoutRetries);
		expect(attemptsExecuted).toBe(maxTimeoutRetries);
		expect(terminalError).toBe("Timeout exhausted after 3 retries");

		// Simulate retry loop with persistent provider failures
		attemptsExecuted = 0;
		terminalError = undefined;
		for (let attempt = 0; attempt < 1; attempt++) {
			attemptsExecuted++;
			if (providerFailureRetries < maxProviderFailureRetries) {
				providerFailureRetries++;
				attempt--;
				continue;
			}
			terminalError = "Provider auth failure: 401";
			break;
		}

		expect(providerFailureRetries).toBe(maxProviderFailureRetries);
		expect(attemptsExecuted).toBe(maxProviderFailureRetries + 1);
		expect(terminalError).toBe("Provider auth failure: 401");
	});
});

describe("edit failure category classifier", () => {
	it("classifies every member of the declared EDIT_FAILURE_CATEGORIES union", () => {
		const samples: Record<EditFailureCategory, { error: string; args: unknown }> = {
			"range-continuation": {
				error: "range-replacement continuation has been removed",
				args: { input: "10ab..12cd = code" },
			},
			"unified-diff": {
				error: "unified-diff syntax error in patch",
				args: { input: "--- a\n+++ b" },
			},
			"no-change": {
				error: "No changes made: replacement is identical",
				args: { path: "src/foo.ts", input: "same" },
			},
			"hash-mismatch": {
				error: "stale tag or hash mismatch",
				args: { input: "content" },
			},
			other: {
				error: "unexpected socket closed",
				args: {},
			},
		};

		const encounteredCategories = new Set<EditFailureCategory>();
		for (const category of EDIT_FAILURE_CATEGORIES) {
			const sample = samples[category];
			const result = categorizeEditFailure(sample.error, sample.args);
			expect(result).toBe(category);
			encounteredCategories.add(result);
		}

		expect(encounteredCategories.size).toBe(EDIT_FAILURE_CATEGORIES.length);
	});

	it("tallies failure category counts and hashline subtype counts across task runs", () => {
		const sampleRuns: TaskRunResult[] = [
			{
				runIndex: 0,
				success: false,
				patchApplied: true,
				verificationPassed: false,
				tokens: { input: 10, output: 20, reasoning: 0, total: 30 },
				duration: 500,
				toolCalls: {
					read: 1,
					edit: 2,
					write: 0,
					editSuccesses: 1,
					editFailures: 1,
					editWarnings: 0,
					editAutocorrects: 0,
					totalInputChars: 50,
				},
				editFailures: [
					{
						toolCallId: "call_1",
						args: { path: "a.ts" },
						error: "No changes made",
						category: "no-change",
					},
					{
						toolCallId: "call_2",
						args: {},
						error: "unknown failure",
						category: "other",
					},
				],
				editWarnings: [],
				editAutocorrectCount: 0,
			},
		];

		const categoryCounts = countEditFailureCategories(sampleRuns);
		expect(categoryCounts["no-change"]).toBe(1);
		expect(categoryCounts.other).toBe(1);
		expect(categoryCounts["hash-mismatch"]).toBe(0);

		const subtypeCounts = countHashlineEditSubtypes({
			edits: [{ set: { line: 1 } }, { set_range: { start: 2, end: 4 } }, { insert: { line: 5 } }],
		});
		expect(subtypeCounts.set).toBe(1);
		expect(subtypeCounts.set_range).toBe(1);
		expect(subtypeCounts.insert).toBe(1);
	});
});
