import { describe, expect, it } from "bun:test";
import { extractMessages, type ReadonlySessionManagerLike } from "@veyyon/coding-agent/hindsight/transcript";
import type { SessionEntry } from "@veyyon/coding-agent/session/session-entries";

/**
 * extractMessages flattens a session into the {role, content} records the Hindsight retain/recall
 * API consumes. It had no direct test. The filtering is load-bearing for memory quality: it must
 * drop tool calls, tool results, thinking blocks, non-conversational entry types, and empty turns,
 * or recall gets primed on internal monologue and noise. These pin exactly what survives and what
 * each surviving message's text becomes.
 */

const manager = (entries: unknown[]): ReadonlySessionManagerLike => ({
	getEntries: () => entries as SessionEntry[],
});

describe("extractMessages", () => {
	it("keeps a plain user string message verbatim", () => {
		expect(extractMessages(manager([{ type: "message", message: { role: "user", content: "hello" } }]))).toEqual([
			{ role: "user", content: "hello" },
		]);
	});

	it("keeps only text blocks of an assistant message, dropping thinking and tool calls", () => {
		expect(
			extractMessages(
				manager([
					{
						type: "message",
						message: {
							role: "assistant",
							content: [
								{ type: "text", text: "hi" },
								{ type: "thinking", thinking: "secret" },
								{ type: "toolCall", id: "1", name: "x", input: {} },
							],
						},
					},
				]),
			),
		).toEqual([{ role: "assistant", content: "hi" }]);
	});

	it("joins multiple text blocks with newlines (assistant and user array content)", () => {
		expect(
			extractMessages(
				manager([
					{
						type: "message",
						message: {
							role: "assistant",
							content: [
								{ type: "text", text: "a" },
								{ type: "text", text: "b" },
							],
						},
					},
					{
						type: "message",
						message: {
							role: "user",
							content: [
								{ type: "text", text: "x" },
								{ type: "text", text: "y" },
							],
						},
					},
				]),
			),
		).toEqual([
			{ role: "assistant", content: "a\nb" },
			{ role: "user", content: "x\ny" },
		]);
	});

	it("drops non-substantive (no-alphanumeric) turns, non-conversational roles, and non-message entries", () => {
		expect(
			extractMessages(
				manager([
					{ type: "message", message: { role: "user", content: "!!!" } },
					{ type: "message", message: { role: "toolResult", content: "r" } },
					{ type: "compaction", summary: "s" },
				]),
			),
		).toEqual([]);
	});

	it("preserves conversational order while filtering interleaved noise", () => {
		expect(
			extractMessages(
				manager([
					{ type: "message", message: { role: "user", content: "q1" } },
					{ type: "compaction", summary: "s" },
					{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "a1" }] } },
					{ type: "message", message: { role: "user", content: "   " } },
				]),
			),
		).toEqual([
			{ role: "user", content: "q1" },
			{ role: "assistant", content: "a1" },
		]);
	});
});
