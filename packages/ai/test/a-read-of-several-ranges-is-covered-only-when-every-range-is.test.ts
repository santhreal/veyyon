/**
 * A multi-range read is a repeat only when every one of its ranges was already read.
 *
 * WHY THIS SUITE EXISTS. `parseRangeSelector` split `:5-16,960-973` on the comma
 * and validated every chunk, then returned the FIRST one and discarded the rest.
 * Two independent things went wrong from that one line, in opposite directions:
 *
 *   1. Subsumption was decided on the first chunk alone. A history holding lines
 *      1-20 judged `:5-10,960-973` already read, so a read that asks for nearly a
 *      thousand lines nobody has seen counted toward the redundant-read streak and
 *      steered the model away from content it did not have.
 *   2. History recorded the first chunk alone. The trailing ranges never entered
 *      `history.ranges`, so a later read genuinely inside one of them was treated
 *      as new.
 *
 * THE CLASS, not the incident. The defect is "a selector carries N ranges and the
 * guard reasons about one of them", so pinning `:5-16,960-973` closes nothing. The
 * cases below drive both directions — a chunk that is NOT covered must keep the
 * read out of the streak, and a chunk that IS covered must be in history for the
 * next read — because a fix that only widened the subsumption test would leave
 * half the defect, and each direction fails the other's assertion.
 *
 * The repeat threshold is set far above the subsumption threshold on purpose. The
 * guard counts identical-argument repetition separately, and at its default that
 * counter fires first and hides which path actually tripped.
 *
 * WHAT THIS SUITE DOES NOT CATCH. Whether the ranges a selector expands to match
 * the ones the read tool actually returns; the guard parses the selector string and
 * never sees the file. A range recorded from a read that was truncated or clamped
 * is recorded as asked for, not as served.
 */
import { describe, expect, test } from "bun:test";
import type { AssistantMessage, ToolResultMessage } from "@veyyon/ai/types";
import { ToolCallLoopGuard, type ToolCallLoopTurn } from "@veyyon/ai/utils/tool-call-loop-guard";

let seq = 0;

function readTurn(path: string, text: string): ToolCallLoopTurn {
	const id = `call-${seq++}`;
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: { path } }],
		timestamp: Date.now(),
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
	};
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
	return { message, toolResults: [toolResult] };
}

/**
 * `threshold: 99` keeps the identical-argument counter out of the way; every
 * detection below therefore comes from the read-subsumption streak. That streak's
 * length is pinned here rather than taken from the default, because this suite is
 * about which ranges count as covered, and it must not go red when the default
 * number of covered reads before steering is retuned.
 */
function freshGuard(): ToolCallLoopGuard {
	return new ToolCallLoopGuard({ threshold: 99, readSubsumptionThreshold: 2, exemptTools: [] });
}

describe("multi-range read subsumption", () => {
	test("a range nobody has read keeps the call out of the redundant-read streak", () => {
		const guard = freshGuard();
		guard.recordTurn(readTurn("src/app.ts:1-20", "first twenty lines"));

		// 5-10 is inside the recorded 1-20; 960-973 is not, so neither call is a repeat.
		expect(guard.recordTurn(readTurn("src/app.ts:5-10,960-973", "two windows"))).toBeNull();
		expect(guard.recordTurn(readTurn("src/app.ts:6-8,2000-2010", "two more windows"))).toBeNull();
	});

	test("every range of a read enters history, so a later read inside a trailing one is a repeat", () => {
		const guard = freshGuard();
		guard.recordTurn(readTurn("src/app.ts:100-200,400-500", "two windows"));

		expect(guard.recordTurn(readTurn("src/app.ts:450-460", "inside the trailing window"))).toBeNull();

		const detection = guard.recordTurn(readTurn("src/app.ts:455-458", "inside it again"));
		expect(detection?.kind).toBe("repeated_tool_call");
		expect(detection?.toolName).toBe("read");
	});

	test("a single range still covers a narrower later read", () => {
		const guard = freshGuard();
		guard.recordTurn(readTurn("src/app.ts:1-100", "first hundred lines"));

		expect(guard.recordTurn(readTurn("src/app.ts:10-20", "a slice"))).toBeNull();
		expect(guard.recordTurn(readTurn("src/app.ts:30-40", "another slice"))?.kind).toBe("repeated_tool_call");
	});

	test("a read whose ranges are all covered by separate earlier reads is a repeat", () => {
		const guard = freshGuard();
		guard.recordTurn(readTurn("src/app.ts:1-50", "head"));
		guard.recordTurn(readTurn("src/app.ts:900-1000", "tail"));

		// Both chunks are covered, each by a different earlier read.
		expect(guard.recordTurn(readTurn("src/app.ts:10-20,950-960", "one from each"))).toBeNull();
		expect(guard.recordTurn(readTurn("src/app.ts:11-21,951-961", "one from each again"))?.kind).toBe(
			"repeated_tool_call",
		);
	});
});
