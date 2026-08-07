import { describe, expect, test } from "bun:test";
import { fromBinary } from "@bufbuild/protobuf";
import { ConversationTokenDetailsSchema } from "@veyyon/catalog/discovery/cursor-gen/agent_pb";
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

/**
 * WHY: `ConversationTokenDetails.detailed = 3` is not in the schema Cursor's
 * client ships, so protobuf dropped it silently for as long as it went
 * undeclared. It is the provider measuring our own context composition for us,
 * which no local estimate can do: the gateway knows what the tool schemas cost
 * after its serialization, we only know what we sent.
 *
 * The bytes below are a verbatim `ConversationTokenDetails` lifted out of
 * `~/.cursor/chats/2dd91e628898a0b3a8343c759f96cc77/.../store.db`, so this
 * pins the real wire encoding rather than a round-trip of our own writer. The
 * sum identity is what makes the field trustworthy: the eight buckets add up
 * to `used_tokens` exactly, which is only true if every field number and wire
 * type in the declaration is right.
 */
const RECORDED_TOKEN_DETAILS = Buffer.from(
	"CJNxEIDQDxqdAgiTcRCA0A8aJAoNc3lzdGVtX3Byb21wdBINU3lzdGVtIHByb21wdBjzAyDeDxogCgV0b29scxIQVG9vbCBkZWZpbml0aW9ucxiGQSDUhgIaFAoFcnVsZXMSBVJ1bGVzGKIUIOpRGhYKBnNraWxscxIGU2tpbGxzGKoTIIlOGhwKA21jcBITTUNQICYgZHluYW1pYyB0b29scyAAGicKCXN1YmFnZW50cxIUU3ViYWdlbnQgZGVmaW5pdGlvbnMY/QMgiBAaNAoXc3VtbWFyaXplZF9jb252ZXJzYXRpb24SF1N1bW1hcml6ZWQgY29udmVyc2F0aW9uIAAaIQoMY29udmVyc2F0aW9uEgxDb252ZXJzYXRpb24YUSDIAg==",
	"base64",
);

describe("cursor context composition", () => {
	test("the recorded detailed field decodes to eight buckets that sum to used_tokens", () => {
		const details = fromBinary(ConversationTokenDetailsSchema, RECORDED_TOKEN_DETAILS);

		expect(details.usedTokens).toBe(14_483);
		expect(details.maxTokens).toBe(256_000);
		// The wrapper repeats both totals, and disagreement would mean the field
		// is not the composition of the gauge it sits inside.
		expect(details.detailed?.usedTokens).toBe(14_483);
		expect(details.detailed?.maxTokens).toBe(256_000);

		const buckets = details.detailed?.entry ?? [];
		expect(buckets.map(b => [b.key, b.tokens, b.chars])).toEqual([
			["system_prompt", 499, 2014],
			["tools", 8326, 33_620],
			["rules", 2594, 10_474],
			["skills", 2474, 9993],
			["mcp", 0, 0],
			["subagents", 509, 2056],
			["summarized_conversation", 0, 0],
			["conversation", 81, 328],
		]);
		expect(buckets.reduce((total, b) => total + b.tokens, 0)).toBe(details.usedTokens);
	});

	test("a checkpoint carrying the composition surfaces it on the assistant message", () => {
		const { output, usage } = newTurn();
		const details = fromBinary(ConversationTokenDetailsSchema, RECORDED_TOKEN_DETAILS);

		handleConversationCheckpointUpdate(
			{ tokenDetails: details } as Parameters<typeof handleConversationCheckpointUpdate>[0],
			usage,
		);

		expect(output.providerContextComposition?.find(b => b.key === "tools")).toEqual({
			key: "tools",
			label: "Tool definitions",
			tokens: 8326,
			chars: 33_620,
		});
		// Every bucket the server measured survives, including the two it measured
		// as empty: an absent key must mean "not measured", not "nothing there".
		expect(output.providerContextComposition).toHaveLength(8);
	});

	test("a later checkpoint with no composition leaves the last real reading standing", () => {
		const { output, usage } = newTurn();
		const details = fromBinary(ConversationTokenDetailsSchema, RECORDED_TOKEN_DETAILS);

		handleConversationCheckpointUpdate(
			{ tokenDetails: details } as Parameters<typeof handleConversationCheckpointUpdate>[0],
			usage,
		);
		handleConversationCheckpointUpdate(checkpoint(0, 0), usage);

		expect(output.providerContextComposition).toHaveLength(8);
	});

	test("a turn Cursor never described has no composition rather than an empty one", () => {
		const { output, usage } = newTurn();

		handleConversationCheckpointUpdate(checkpoint(14_483, 256_000), usage);

		expect(output.providerContextComposition).toBeUndefined();
	});
});
