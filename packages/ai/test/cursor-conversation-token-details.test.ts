import { describe, expect, test } from "bun:test";
import { emptyUsage } from "@veyyon/catalog/models";
import {
	type CursorUsageAccount,
	createCursorUsageAccount,
	handleConversationCheckpointUpdate,
} from "../src/providers/cursor";
import type { AssistantMessage, Model } from "../src/types";

/**
 * WHY: Cursor reports two token quantities and neither one is a usage object.
 *
 * `TokenDeltaUpdate.tokens` increments THIS turn's completion.
 * `ConversationTokenDetails` gauges the WHOLE conversation against the model's
 * window: `used_tokens` is the sum of the system prompt, tool schemas, rules,
 * skills, subagent definitions and the conversation, and the server samples it
 * with this turn's reply already appended. Nothing on the wire reports a
 * prompt-cache breakdown, so `cacheRead` and `cacheWrite` are zero because
 * Cursor does not say, not because the provider forgot to read them.
 *
 * Folding those two where each happened to arrive shipped three defects in a
 * row: `used_tokens` written to `usage.output` (the conversation billed at
 * completion rates), `max_tokens` dropped (the context gauge measured against a
 * catalog guess), and a delta guard that skipped the prompt fold entirely (311
 * of 311 recorded turns reported `input: 0`). One account now holds the raw
 * readings and one fold turns them into usage.
 */

function cursorModel(): Model<"cursor-agent"> {
	return {
		id: "cursor-grok-4.5-medium",
		provider: "cursor",
		api: "cursor-agent",
		// Cursor publishes no pricing; a reference-backed model inherits real rates.
		cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
	} as Model<"cursor-agent">;
}

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

function newTurn(): { output: AssistantMessage; usage: CursorUsageAccount } {
	const output = emptyOutput();
	return { output, usage: createCursorUsageAccount(cursorModel(), output) };
}

function checkpoint(usedTokens: number, maxTokens: number) {
	return { tokenDetails: { usedTokens, maxTokens } } as Parameters<typeof handleConversationCheckpointUpdate>[0];
}

describe("cursor turn accounting", () => {
	test("the conversation gauge is the prompt side once this turn's completion comes out of it", () => {
		const { output, usage } = newTurn();
		usage.completionTokens = 4_096;

		handleConversationCheckpointUpdate(checkpoint(210_000, 1_000_000), usage);

		// used_tokens already contains the 4,096 tokens this turn generated, so
		// billing it as the prompt AND adding the completion counts them twice.
		expect(output.usage.input).toBe(205_904);
		expect(output.usage.output).toBe(4_096);
		expect(output.usage.totalTokens).toBe(210_000);
	});

	test("the total never exceeds what Cursor says the conversation weighs", () => {
		const { output, usage } = newTurn();
		usage.completionTokens = 98_234;

		handleConversationCheckpointUpdate(checkpoint(150_000, 256_000), usage);

		expect(output.usage.totalTokens).toBe(150_000);
		expect(output.usage.totalTokens).toBeLessThanOrEqual(output.providerContextWindow ?? 0);
	});

	test("max_tokens is adopted as the provider-reported context window", () => {
		const { output, usage } = newTurn();

		handleConversationCheckpointUpdate(checkpoint(210_000, 1_000_000), usage);

		expect(output.providerContextWindow).toBe(1_000_000);
	});

	test("an empty token_details leaves the previous reading standing", () => {
		// Most checkpoints report nothing. Zero means "not reported", so an empty
		// one must not blank the window or the prompt the populated one supplied.
		const { output, usage } = newTurn();
		handleConversationCheckpointUpdate(checkpoint(210_000, 1_000_000), usage);

		handleConversationCheckpointUpdate(checkpoint(0, 0), usage);

		expect(output.providerContextWindow).toBe(1_000_000);
		expect(output.usage.input).toBe(210_000);
	});

	test("a checkpoint that reports no window leaves the catalog value alone", () => {
		const { output, usage } = newTurn();

		handleConversationCheckpointUpdate(checkpoint(1_000, 0), usage);

		expect(output.providerContextWindow).toBeUndefined();
		expect(output.usage.input).toBe(1_000);
	});

	test("completion tokens that arrive after the gauge do not re-inflate the total", () => {
		// The gauge and the deltas race. Whichever lands last, the numbers must
		// still describe one conversation rather than a conversation plus a reply.
		const { output, usage } = newTurn();
		handleConversationCheckpointUpdate(checkpoint(210_000, 1_000_000), usage);

		usage.completionTokens += 4_096;
		usage.fold();

		expect(output.usage.input).toBe(205_904);
		expect(output.usage.output).toBe(4_096);
		expect(output.usage.totalTokens).toBe(210_000);
	});

	test("cost is folded as usage moves, so an abandoned turn still reports what it spent", () => {
		// Cost used to be calculated once, at the end of a clean turn. 175 of 326
		// recorded Cursor turns were aborted, and a reference-backed model carries
		// real rates, so every one of those reported spending nothing.
		const { output, usage } = newTurn();

		usage.completionTokens = 1_000_000;
		usage.fold();

		expect(output.usage.cost.output).toBeCloseTo(15, 6);
		expect(output.usage.cost.total).toBeCloseTo(15, 6);
	});

	test("cursor reports no cache breakdown, so both cache counters stay zero", () => {
		const { output, usage } = newTurn();
		usage.completionTokens = 512;

		handleConversationCheckpointUpdate(checkpoint(210_000, 1_000_000), usage);

		expect(output.usage.cacheRead).toBe(0);
		expect(output.usage.cacheWrite).toBe(0);
	});
});
