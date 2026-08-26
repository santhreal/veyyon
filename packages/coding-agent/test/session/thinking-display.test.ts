import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import {
	canonicalizeMessage,
	hasVisibleContent,
	messageHasDisplayableThinking,
} from "@veyyon/coding-agent/utils/thinking-display";

describe("canonicalizeMessage", () => {
	it("returns empty string for undefined, empty, or whitespace-only", () => {
		expect(canonicalizeMessage(undefined)).toBe("");
		expect(canonicalizeMessage("")).toBe("");
		expect(canonicalizeMessage("   ")).toBe("");
		expect(canonicalizeMessage("\n\n")).toBe("");
	});

	it("returns empty string for dot-only content", () => {
		expect(canonicalizeMessage(".")).toBe("");
		expect(canonicalizeMessage("...")).toBe("");
		expect(canonicalizeMessage(" . ")).toBe("");
		expect(canonicalizeMessage("\n.")).toBe("");
		expect(canonicalizeMessage("…")).toBe("");
	});

	it("returns normal canonical content for actual prose", () => {
		expect(canonicalizeMessage("hello")).toBe("hello");
		expect(canonicalizeMessage("hello.")).toBe("hello.");
		expect(canonicalizeMessage(". hello .")).toBe(". hello .");
		expect(canonicalizeMessage("a")).toBe("a");
	});
});

describe("hasVisibleContent", () => {
	// WHY: hasVisibleContent is the zero-allocation boolean counterpart of
	// canonicalizeMessage used in the per-token visibleBlockCount loop. It must
	// agree with `canonicalizeMessage(text) !== ""` on every input, including
	// edge cases that distinguish "dot-only" from "real prose" content.
	it("returns false for undefined, empty, or whitespace-only", () => {
		expect(hasVisibleContent(undefined)).toBe(false);
		expect(hasVisibleContent("")).toBe(false);
		expect(hasVisibleContent("   ")).toBe(false);
		expect(hasVisibleContent("\n\n")).toBe(false);
	});

	it("returns false for dot-only content", () => {
		expect(hasVisibleContent(".")).toBe(false);
		expect(hasVisibleContent("...")).toBe(false);
		expect(hasVisibleContent(" . ")).toBe(false);
		expect(hasVisibleContent("\n.")).toBe(false);
		expect(hasVisibleContent("…")).toBe(false);
	});

	it("returns true for actual prose", () => {
		expect(hasVisibleContent("hello")).toBe(true);
		expect(hasVisibleContent("hello.")).toBe(true);
		expect(hasVisibleContent(". hello .")).toBe(true);
		expect(hasVisibleContent("a")).toBe(true);
	});

	it("agrees with canonicalizeMessage on a range of inputs", () => {
		const cases = [
			"",
			"   ",
			"\n\n",
			".",
			"...",
			" . ",
			"\n.",
			"…",
			"hello",
			"hello.",
			". hello .",
			"a",
			"  hello  ",
			"  .  ",
			"hello world",
			"…hello",
			".\n.\n.",
		];
		for (const text of cases) {
			expect(hasVisibleContent(text)).toBe(canonicalizeMessage(text) !== "");
		}
	});
});

/**
 * messageHasDisplayableThinking decides whether an assistant message carries a thinking block worth
 * showing (used to gate the "thinking" affordance in the transcript). It had no direct test. The
 * contracts pinned here are the ones a transcript-rendering regression would break:
 *   - only assistant messages qualify; a user/other-role message is never "thinking";
 *   - an assistant with no thinking block (text only) is false;
 *   - a thinking block with real prose content is true, and a message with mixed text + real thinking
 *     is still true (any qualifying block suffices);
 *   - an empty or whitespace-only thinking block is false (nothing to display, so the affordance stays
 *     hidden rather than opening onto blank content).
 */
describe("messageHasDisplayableThinking", () => {
	const assistant = (content: unknown): AgentMessage => ({ role: "assistant", content }) as unknown as AgentMessage;

	it("is false for a non-assistant message", () => {
		expect(messageHasDisplayableThinking({ role: "user", content: "hi" } as unknown as AgentMessage, false)).toBe(
			false,
		);
	});

	it("is false for an assistant message with no thinking block", () => {
		expect(messageHasDisplayableThinking(assistant([{ type: "text", text: "hello" }]), false)).toBe(false);
	});

	it("is true when a thinking block carries real content", () => {
		expect(
			messageHasDisplayableThinking(
				assistant([{ type: "thinking", thinking: "I am reasoning about this." }]),
				false,
			),
		).toBe(true);
	});

	it("is true for a mixed message whose thinking block has content", () => {
		expect(
			messageHasDisplayableThinking(
				assistant([
					{ type: "text", text: "answer" },
					{ type: "thinking", thinking: "real reasoning" },
				]),
				false,
			),
		).toBe(true);
	});

	it("is false for an empty or whitespace-only thinking block", () => {
		expect(messageHasDisplayableThinking(assistant([{ type: "thinking", thinking: "" }]), false)).toBe(false);
		expect(messageHasDisplayableThinking(assistant([{ type: "thinking", thinking: "   \n  " }]), false)).toBe(false);
	});
});
