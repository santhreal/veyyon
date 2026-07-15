/**
 * Contract: `estimateTokens` caches its per-message result by object identity.
 *
 * `#estimatePrePromptContextTokens` / `#estimateStoredContextTokens` in
 * agent-session re-walk the full stored conversation on every pre-prompt and
 * post-turn compaction check (BACKLOG P5). Agent messages are replaced
 * wholesale rather than mutated in place while streaming (`agent-loop.ts`
 * assigns `context.messages[i] = partialMessage`), so the same message object
 * reaching `estimateTokens` twice must never re-tokenize its content.
 */
import { describe, expect, test, vi } from "bun:test";
import { estimateTokens } from "@veyyon/pi-agent-core/compaction";
import type { AssistantMessage } from "@veyyon/pi-ai";

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
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
		stopReason: "stop",
	};
}

const LONG_TEXT = "the quick brown fox jumps over the lazy dog. ".repeat(400);

describe("estimateTokens memoization", () => {
	test("does not re-tokenize an unchanged message object on a second call", () => {
		const message = assistantMessage([{ type: "text", text: LONG_TEXT }]);
		const byteLengthSpy = vi.spyOn(Buffer, "byteLength");

		const first = estimateTokens(message);
		const callsAfterFirst = byteLengthSpy.mock.calls.length;
		expect(callsAfterFirst).toBeGreaterThan(0);

		const second = estimateTokens(message);
		expect(second).toBe(first);
		expect(byteLengthSpy.mock.calls.length).toBe(callsAfterFirst);

		byteLengthSpy.mockRestore();
	});

	test("keeps default and excludeEncryptedReasoning estimates independently cached and correct", () => {
		const message = assistantMessage([
			{ type: "thinking", thinking: "hidden reasoning", thinkingSignature: "s".repeat(2000) },
			{ type: "text", text: "visible answer" },
		]);

		const withSignature = estimateTokens(message);
		const withoutSignature = estimateTokens(message, { excludeEncryptedReasoning: true });
		expect(withoutSignature).toBeLessThan(withSignature);

		const byteLengthSpy = vi.spyOn(Buffer, "byteLength");
		// Both variants are already warm; repeating either must hit its own cache slot.
		expect(estimateTokens(message)).toBe(withSignature);
		expect(estimateTokens(message, { excludeEncryptedReasoning: true })).toBe(withoutSignature);
		expect(byteLengthSpy.mock.calls.length).toBe(0);
		byteLengthSpy.mockRestore();
	});

	test("does not share a cache slot across distinct message objects with identical content", () => {
		const a = assistantMessage([{ type: "text", text: LONG_TEXT }]);
		const b = assistantMessage([{ type: "text", text: LONG_TEXT }]);

		const byteLengthSpy = vi.spyOn(Buffer, "byteLength");
		estimateTokens(a);
		const callsAfterA = byteLengthSpy.mock.calls.length;
		estimateTokens(b);
		// A distinct object must still be tokenized on its own first call — proves the
		// cache keys on identity, not on serialized/structural equality.
		expect(byteLengthSpy.mock.calls.length).toBeGreaterThan(callsAfterA);
		expect(estimateTokens(a)).toBe(estimateTokens(b));
		byteLengthSpy.mockRestore();
	});
});
