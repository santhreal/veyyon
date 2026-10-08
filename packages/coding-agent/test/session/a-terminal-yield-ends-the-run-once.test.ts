/**
 * WHY: a successful `yield` is the run's terminal result. Two hooks see every tool result, the
 * executor's `afterToolCall` and the loop's `tool_execution_end`, and the session aborts the run on
 * whichever reports it first. The decision of which results end the run, and the rule that the second
 * hook does not report a result the first already did, are both in `YieldTracker`; the settle then
 * reads the recorded call to suppress retries and continuations on the trailing stop.
 *
 * The class is "a tool result is misread as ending the run, or as not ending it, or is reported
 * twice". The suite sweeps every built-in and hidden tool name from `TOOL` at run time, so a new tool
 * is checked on arrival, and drives every branch of the `yield` details rule. The settle side is
 * driven through the real session in `agent-session-yield-empty-stop-suppression.test.ts`.
 *
 * WHAT THIS DOES NOT CATCH: a third hook that reports tool results without going through the tracker,
 * and a caller that ignores a `true` report instead of aborting.
 */
import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { YieldTracker } from "@veyyon/coding-agent/session/runtime/yield-tracker";
import { TOOL } from "@veyyon/coding-agent/tools/core/builtin-names";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantCalling(...calls: Array<[name: string, id: string]>): AssistantMessage {
	return {
		role: "assistant",
		content: calls.map(([name, id]) => ({ type: "toolCall" as const, id, name, arguments: {} })),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "toolUse",
		usage,
		timestamp: 0,
	};
}

/** `yield` results by details shape, and whether each ends the run. */
const YIELD_RESULTS: Array<[label: string, result: { details?: unknown } | undefined, terminal: boolean]> = [
	["no result", undefined, true],
	["no details", {}, true],
	["non-object details", { details: "done" }, true],
	["details without a status", { details: { type: ["report"] } }, true],
	["a failed status with a type list", { details: { status: "failed", type: ["report"] } }, true],
	["a success status with an empty type list", { details: { status: "success", type: [] } }, true],
	["a success status with a non-string type", { details: { status: "success", type: ["report", 1] } }, true],
	["a success status with a type string, not a list", { details: { status: "success", type: "report" } }, true],
	["a success status with a type list of strings", { details: { status: "success", type: ["report"] } }, false],
];

describe("a terminal yield ends the run once", () => {
	describe("which results end the run", () => {
		const others = Object.values(TOOL).filter(name => name !== TOOL.yield);

		for (const name of others) {
			it(`does not end the run on a ${name} result from either hook`, () => {
				const tracker = new YieldTracker();
				expect(tracker.noteAfterToolCall("call-1", { toolName: name })).toBe(false);
				expect(tracker.noteExecutionEnd({ toolCallId: "call-2", toolName: name })).toBe(false);
				expect(tracker.terminationPending).toBe(false);
				expect(tracker.endedWithYield(assistantCalling([name, "call-2"]))).toBe(false);
			});
		}

		it("does not end the run on a yield that failed", () => {
			const tracker = new YieldTracker();
			expect(tracker.noteAfterToolCall("call-1", { toolName: TOOL.yield, isError: true })).toBe(false);
			expect(tracker.noteExecutionEnd({ toolCallId: "call-1", toolName: TOOL.yield, isError: true })).toBe(false);
			expect(tracker.terminationPending).toBe(false);
		});

		for (const [label, result, terminal] of YIELD_RESULTS) {
			it(`${terminal ? "ends" : "does not end"} the run on a yield with ${label}, from either hook`, () => {
				const afterCall = new YieldTracker();
				expect(afterCall.noteAfterToolCall("call-1", { toolName: TOOL.yield, result })).toBe(terminal);
				expect(afterCall.terminationPending).toBe(terminal);

				const executionEnd = new YieldTracker();
				expect(executionEnd.noteExecutionEnd({ toolCallId: "call-1", toolName: TOOL.yield, result })).toBe(
					terminal,
				);
				expect(executionEnd.terminationPending).toBe(terminal);
			});
		}
	});

	describe("reporting", () => {
		it("reports a yield `afterToolCall` saw once, not again at its execution end", () => {
			const tracker = new YieldTracker();
			expect(tracker.noteAfterToolCall("call-1", { toolName: TOOL.yield })).toBe(true);
			expect(tracker.noteExecutionEnd({ toolCallId: "call-1", toolName: TOOL.yield })).toBe(false);
			expect(tracker.endedWithYield(assistantCalling([TOOL.yield, "call-1"]))).toBe(true);
		});

		it("reports a yield only its execution end saw", () => {
			const tracker = new YieldTracker();
			expect(tracker.noteAfterToolCall("call-1", { toolName: TOOL.yield })).toBe(true);
			expect(tracker.noteExecutionEnd({ toolCallId: "call-2", toolName: TOOL.yield })).toBe(true);
			expect(tracker.endedWithYield(assistantCalling([TOOL.yield, "call-2"]))).toBe(true);
			expect(tracker.endedWithYield(assistantCalling([TOOL.yield, "call-1"]))).toBe(false);
		});
	});

	describe("the recorded call", () => {
		it("matches the newest message whose last call is the recorded yield", () => {
			const tracker = new YieldTracker();
			tracker.noteExecutionEnd({ toolCallId: "call-y", toolName: TOOL.yield });
			const older = assistantCalling([TOOL.read, "call-r"], [TOOL.yield, "call-y"]);
			const newer = assistantCalling([TOOL.yield, "call-y"]);
			const trailing = assistantCalling();
			expect(tracker.findYieldMessage([older, newer, trailing])).toBe(newer);
		});

		it("does not match a message that calls another tool after the yield", () => {
			const tracker = new YieldTracker();
			tracker.noteExecutionEnd({ toolCallId: "call-y", toolName: TOOL.yield });
			const message = assistantCalling([TOOL.yield, "call-y"], [TOOL.read, "call-r"]);
			expect(tracker.findYieldMessage([message])).toBeUndefined();
			expect(tracker.endedWithYield(message)).toBe(false);
		});

		it("is forgotten by a settle, while the run stays terminal until the next prompt", () => {
			const tracker = new YieldTracker();
			tracker.noteExecutionEnd({ toolCallId: "call-y", toolName: TOOL.yield });
			const message = assistantCalling([TOOL.yield, "call-y"]);

			tracker.clear();
			expect(tracker.findYieldMessage([message])).toBeUndefined();
			expect(tracker.endedWithYield(message)).toBe(false);
			expect(tracker.terminationPending).toBe(true);

			tracker.resetForPrompt();
			expect(tracker.terminationPending).toBe(false);
		});
	});
});
