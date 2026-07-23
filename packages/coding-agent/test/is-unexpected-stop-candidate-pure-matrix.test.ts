/**
 * isUnexpectedStopCandidate: stopReason==="stop" AND has non-whitespace text
 * AND no toolCall blocks. Pure gate before the classifier LLM call.
 */
import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { isUnexpectedStopCandidate } from "@veyyon/coding-agent/session/unexpected-stop-classifier";

function msg(stopReason: AssistantMessage["stopReason"], content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		provider: "mock",
		model: "m",
		api: "mock" as AssistantMessage["api"],
		content,
		stopReason,
		timestamp: 1,
	} as AssistantMessage;
}

describe("isUnexpectedStopCandidate pure matrix", () => {
	it("true for text-only stop", () => {
		expect(isUnexpectedStopCandidate(msg("stop", [{ type: "text", text: "I should continue." }]))).toBe(true);
	});

	it("true when text mixed with empty thinking", () => {
		expect(
			isUnexpectedStopCandidate(
				msg("stop", [
					{ type: "thinking", thinking: "   " },
					{ type: "text", text: "done" },
				]),
			),
		).toBe(true);
	});

	it("false when only whitespace text", () => {
		expect(isUnexpectedStopCandidate(msg("stop", [{ type: "text", text: "  \n\t" }]))).toBe(false);
		expect(isUnexpectedStopCandidate(msg("stop", [{ type: "text", text: "" }]))).toBe(false);
	});

	it("false when any toolCall present", () => {
		expect(
			isUnexpectedStopCandidate(
				msg("stop", [
					{ type: "text", text: "calling" },
					{ type: "toolCall", id: "1", name: "bash", arguments: {} },
				]),
			),
		).toBe(false);
	});

	for (const reason of ["length", "aborted", "error", "toolUse"] as const) {
		it(`false for stopReason=${reason}`, () => {
			expect(isUnexpectedStopCandidate(msg(reason as never, [{ type: "text", text: "hi" }]))).toBe(false);
		});
	}

	it("false for empty content", () => {
		expect(isUnexpectedStopCandidate(msg("stop", []))).toBe(false);
	});

	it("false for thinking-only stop", () => {
		expect(isUnexpectedStopCandidate(msg("stop", [{ type: "thinking", thinking: "ponder" }]))).toBe(false);
	});
});
