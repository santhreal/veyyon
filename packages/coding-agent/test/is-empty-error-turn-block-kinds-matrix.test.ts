/**
 * isEmptyErrorTurn: only stopReason error with no real content is empty.
 * Unknown block kinds count as content (never silently discard).
 */
import { describe, expect, it } from "bun:test";
import { isEmptyErrorTurn } from "@veyyon/coding-agent/session/messages";

type Content = Parameters<typeof isEmptyErrorTurn>[0]["content"];

function turn(stopReason: string, content: Content) {
	return { stopReason, content } as Parameters<typeof isEmptyErrorTurn>[0];
}

describe("isEmptyErrorTurn block kinds matrix", () => {
	it("empty error turns", () => {
		expect(isEmptyErrorTurn(turn("error", []))).toBe(true);
		expect(isEmptyErrorTurn(turn("error", [{ type: "text", text: "" }]))).toBe(true);
		expect(isEmptyErrorTurn(turn("error", [{ type: "text", text: "   " }]))).toBe(true);
		expect(
			isEmptyErrorTurn(turn("error", [{ type: "thinking", thinking: "  " }])),
		).toBe(true);
		expect(
			isEmptyErrorTurn(turn("error", [{ type: "fallback", data: "x" } as never])),
		).toBe(true);
	});

	it("non-empty error turns", () => {
		expect(
			isEmptyErrorTurn(turn("error", [{ type: "text", text: "partial" }])),
		).toBe(false);
		expect(
			isEmptyErrorTurn(turn("error", [{ type: "thinking", thinking: "r" }])),
		).toBe(false);
		expect(
			isEmptyErrorTurn(
				turn("error", [{ type: "thinking", thinking: "", thinkingSignature: "sig" }]),
			),
		).toBe(false);
		expect(
			isEmptyErrorTurn(turn("error", [{ type: "redactedThinking", data: "enc" }])),
		).toBe(false);
		expect(
			isEmptyErrorTurn(
				turn("error", [{ type: "toolCall", id: "1", name: "bash", arguments: {} }]),
			),
		).toBe(false);
		expect(
			isEmptyErrorTurn(turn("error", [{ type: "futureBlock", x: 1 } as never])),
		).toBe(false);
	});

	for (const reason of ["stop", "aborted", "length", "toolUse"]) {
		it(`non-error stopReason=${reason} never empty`, () => {
			expect(isEmptyErrorTurn(turn(reason, []))).toBe(false);
		});
	}
});
