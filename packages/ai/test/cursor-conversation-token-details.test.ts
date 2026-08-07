import { describe, expect, test } from "bun:test";
import { emptyUsage } from "@veyyon/catalog/models";
import { handleConversationCheckpointUpdate } from "../src/providers/cursor";
import type { AssistantMessage } from "../src/types";

/**
 * WHY: Cursor's `ConversationTokenDetails` is a gauge for the WHOLE
 * conversation (`used_tokens` out of `max_tokens`), not a count for the turn
 * being streamed.
 *
 * It used to be folded in as if it were the completion: `used_tokens` was
 * written to `usage.output` and `max_tokens` was dropped on the floor. Two
 * things broke at once. The turn was billed at output rates for the entire
 * conversation, and every consumer that reads the prompt side saw zero and fell
 * back to the total, so the context gauge measured the conversation against a
 * window nobody had checked. That window is a guess for any model the catalog
 * predates (discovery has no window field and substitutes a default), and the
 * real one arrives in this very message. With a 1M-window model reporting 210k
 * used, the guess of 200k pinned the footer at "0% left" and asked to compact on
 * every turn while the provider considered the conversation a fifth full.
 */

function emptyOutput(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "cursor",
		provider: "cursor",
		model: "cursor-grok-4.5-medium",
		timestamp: Date.now(),
		usage: emptyUsage(),
		stopReason: "stop",
	} as AssistantMessage;
}

function checkpoint(usedTokens: number, maxTokens: number) {
	return { tokenDetails: { usedTokens, maxTokens } } as Parameters<typeof handleConversationCheckpointUpdate>[0];
}

describe("cursor conversation checkpoint token details", () => {
	test("used_tokens is the conversation's prompt side, not this turn's completion", () => {
		const output = emptyOutput();
		handleConversationCheckpointUpdate(checkpoint(210_000, 1_000_000), output);

		expect(output.usage.input).toBe(210_000);
		expect(output.usage.output).toBe(0);
		expect(output.usage.totalTokens).toBe(210_000);
	});

	test("max_tokens is adopted as the provider-reported context window", () => {
		const output = emptyOutput();
		handleConversationCheckpointUpdate(checkpoint(210_000, 1_000_000), output);

		expect(output.providerContextWindow).toBe(1_000_000);
	});

	test("the prompt count is recorded even when token deltas already counted the output", () => {
		// Token deltas carry the COMPLETION only; they never carry a prompt count.
		// A guard that skipped the whole fold once any delta had arrived therefore
		// zeroed the prompt on every turn that streamed a single token: across the
		// recorded sessions 311 of 311 Cursor turns billed 2.05M output tokens
		// against no prompt at all, and the context gauge read them as empty.
		const output = emptyOutput();
		output.usage.output = 512;
		output.usage.totalTokens = 512;

		handleConversationCheckpointUpdate(checkpoint(210_000, 1_000_000), output);

		expect(output.providerContextWindow).toBe(1_000_000);
		expect(output.usage.output).toBe(512);
		expect(output.usage.input).toBe(210_000);
		expect(output.usage.totalTokens).toBe(210_512);
	});

	test("a checkpoint that reports no window leaves the catalog value alone", () => {
		const output = emptyOutput();
		handleConversationCheckpointUpdate(checkpoint(1_000, 0), output);

		expect(output.providerContextWindow).toBeUndefined();
		expect(output.usage.input).toBe(1_000);
	});

	test("the completion count survives a later checkpoint", () => {
		// Deltas for this turn's output must not be overwritten by the
		// conversation gauge arriving afterwards.
		const output = emptyOutput();
		output.usage.output = 4_096;
		output.usage.totalTokens = 4_096;

		handleConversationCheckpointUpdate(checkpoint(210_000, 1_000_000), output);

		expect(output.usage.output).toBe(4_096);
		expect(output.usage.input).toBe(210_000);
		expect(output.usage.totalTokens).toBe(214_096);
	});
});
