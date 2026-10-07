/**
 * A replayed assistant turn reaches the Responses API (OpenAI Responses and Codex both replay
 * through `convertResponsesAssistantMessage`) carrying the reasoning items its thinking blocks
 * signed, and server item ids only where the API accepts them: the server rejects a replayed item
 * id whose reasoning item is absent (#4173), and a tool-call item id from another model.
 *
 * Invariants checked on every generated turn, under every combination of the replay flags:
 * - The reasoning items sent are the reasoning envelopes the thinking signatures hold, each once, in
 *   block order; none when signatures are excluded or the turn errored.
 * - A message item carries an id only beside a replayed reasoning item or when ids are preserved,
 *   every message item carries one beside a replayed reasoning item, no two share one, and none
 *   is longer than 64 chars.
 * - A tool call carries its item id when, and only when, the turn replays a reasoning item and the
 *   turn came from the model it is replayed to, whatever the id's prefix (`fc_`, `fcr_`, `ctc_`).
 * - Every replayed call id is recorded as known, and a custom call's id as custom.
 *
 * The class this closes: a thinking block that replays a sibling's reasoning item, an errored turn
 * whose reasoning replays, an id prefix the drop rule misses, a drop rule that ignores the model,
 * unsigned text blocks that share an id, and an over-long id sent unhashed.
 *
 * Not covered: the order of non-reasoning items, `arguments` serialization, and the custom tool
 * name mapping, which `apply-patch-freeform.test.ts` covers.
 */
import { describe, expect, it } from "bun:test";
import { convertResponsesAssistantMessage } from "@veyyon/ai/providers/openai-shared";
import type { AssistantMessage, Model, ModelSpec } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

const TURNS_PER_ARM = 600;

const MODEL: Model<"openai-responses"> = buildModel({
	id: "gpt-5",
	name: "GPT-5",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
} satisfies ModelSpec<"openai-responses">);

const USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Thinking signatures that hold no reasoning envelope. */
const NON_ENVELOPES: readonly (string | undefined)[] = [
	undefined,
	"",
	"not json",
	"null",
	"[]",
	JSON.stringify({ type: "reasoning", id: 7 }),
	JSON.stringify({ type: "summary", id: "rs_other" }),
	JSON.stringify({ id: "rs_untyped" }),
];

const TOOL_ITEM_PREFIXES = ["fc", "fcr", "ctc"] as const;

/** A deterministic xorshift generator, so a failure names a reproducible turn. */
function generator(seed: number): () => number {
	let state = seed;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 0x100000000;
	};
}

interface GeneratedTurn {
	message: AssistantMessage;
	/** The ids of the reasoning envelopes the thinking blocks hold, in block order. */
	envelopeIds: string[];
}

function generateTurn(random: () => number, turn: number): GeneratedTurn {
	const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)];
	const envelopeIds: string[] = [];
	const content: AssistantMessage["content"] = [];
	const blocks = Math.floor(random() * 7);
	for (let i = 0; i < blocks; i++) {
		const unique = `${turn}_${i}`;
		const kind = random();
		if (kind < 0.3) {
			let signature = pick(NON_ENVELOPES);
			if (random() < 0.5) {
				envelopeIds.push(`rs_${unique}`);
				signature = JSON.stringify({ type: "reasoning", id: `rs_${unique}`, summary: [], encrypted_content: "e" });
			}
			content.push({ type: "thinking", thinking: "t", thinkingSignature: signature });
		} else if (kind < 0.65) {
			const textSignature = pick([
				undefined,
				"",
				`msg_s${unique}`,
				`msg_s${unique}_${"x".repeat(70)}`,
				JSON.stringify({ v: 1, id: `msg_v${unique}` }),
				JSON.stringify({ v: 1, id: `msg_v${unique}_${"y".repeat(70)}`, phase: "commentary" }),
				JSON.stringify({ v: 1, id: "" }),
			]);
			content.push({ type: "text", text: "step", textSignature });
		} else {
			const id = random() < 0.2 ? `call_${unique}` : `call_${unique}|${pick(TOOL_ITEM_PREFIXES)}_${unique}`;
			const custom = random() < 0.4;
			content.push(
				custom
					? { type: "toolCall", id, name: "apply_patch", customWireName: "apply_patch", arguments: { input: "p" } }
					: { type: "toolCall", id, name: "read", arguments: { path: "a.ts" } },
			);
		}
	}
	return {
		message: {
			role: "assistant",
			content,
			api: pick(["openai-responses", "openai-codex-responses"] as const),
			provider: pick(["openai", "openrouter"]),
			model: pick(["gpt-5", "gpt-5-mini"]),
			usage: USAGE,
			stopReason: pick(["toolUse", "stop", "length", "error"] as const),
			timestamp: turn,
		},
		envelopeIds,
	};
}

for (const includeThinkingSignatures of [true, false]) {
	for (const preserveMessageIds of [false, true]) {
		for (const supportsCustomToolCalls of [true, false]) {
			const arm = `signatures ${includeThinkingSignatures ? "included" : "excluded"}, message ids ${preserveMessageIds ? "preserved" : "not preserved"}, custom tool calls ${supportsCustomToolCalls ? "supported" : "unsupported"}`;
			describe(`a replayed Responses turn with ${arm}`, () => {
				const random = generator(
					0x5eed +
						Number(includeThinkingSignatures) * 4 +
						Number(preserveMessageIds) * 2 +
						Number(supportsCustomToolCalls),
				);
				const turns = Array.from({ length: TURNS_PER_ARM }, (_, turn) => generateTurn(random, turn));
				const convert = ({ message }: GeneratedTurn, index: number) => {
					const knownCallIds = new Set<string>();
					const customCallIds = new Set<string>();
					const items = convertResponsesAssistantMessage(
						message,
						MODEL,
						index,
						knownCallIds,
						includeThinkingSignatures,
						customCallIds,
						preserveMessageIds,
						supportsCustomToolCalls,
					);
					// The items as they go on the wire.
					const rows: Record<string, unknown>[] = JSON.parse(JSON.stringify(items));
					return { rows, knownCallIds, customCallIds };
				};

				it("sends each reasoning envelope its thinking blocks hold, once and in order, and none for an errored turn", () => {
					turns.forEach((turn, index) => {
						const { rows } = convert(turn, index);
						const sent = rows.filter(row => row.type === "reasoning").map(row => row.id);
						const expected =
							includeThinkingSignatures && turn.message.stopReason !== "error" ? turn.envelopeIds : [];
						expect({ turn: index, sent }).toEqual({ turn: index, sent: expected });
					});
				});

				it("gives message items distinct ids of at most 64 chars, and only beside a reasoning item or when preserved", () => {
					turns.forEach((turn, index) => {
						const { rows } = convert(turn, index);
						const replaysReasoning = rows.some(row => row.type === "reasoning");
						const messages = rows.filter(row => row.type === "message");
						const ids = messages.flatMap(row => (row.id === undefined ? [] : [String(row.id)]));
						expect({ turn: index, duplicated: ids.length - new Set(ids).size }).toEqual({
							turn: index,
							duplicated: 0,
						});
						expect({ turn: index, overLong: ids.filter(id => id.length > 64) }).toEqual({
							turn: index,
							overLong: [],
						});
						if (replaysReasoning) {
							expect({ turn: index, withoutId: messages.length - ids.length }).toEqual({
								turn: index,
								withoutId: 0,
							});
						} else if (!preserveMessageIds) {
							expect({ turn: index, ids }).toEqual({ turn: index, ids: [] });
						}
					});
				});

				it("sends a tool call's item id only beside a reasoning item from the model it is replayed to", () => {
					turns.forEach((turn, index) => {
						const { rows } = convert(turn, index);
						const { message } = turn;
						const differentModel =
							message.model !== MODEL.id && message.provider === MODEL.provider && message.api === MODEL.api;
						const keepsItemIds = rows.some(row => row.type === "reasoning") && !differentModel;
						const calls = rows.filter(row => row.type === "function_call" || row.type === "custom_tool_call");
						expect(calls).toHaveLength(message.content.filter(block => block.type === "toolCall").length);
						const withId = calls.filter(row => row.id !== undefined).length;
						expect({ turn: index, withId }).toEqual({ turn: index, withId: keepsItemIds ? calls.length : 0 });
					});
				});

				it("records every replayed call id as known, and a custom call's id as custom", () => {
					turns.forEach((turn, index) => {
						const { rows, knownCallIds, customCallIds } = convert(turn, index);
						const calls = rows.filter(row => row.type === "function_call" || row.type === "custom_tool_call");
						const customIds = calls.filter(row => row.type === "custom_tool_call").map(row => row.call_id);
						const known: unknown[] = [...knownCallIds];
						const custom: unknown[] = [...customCallIds];
						expect({ turn: index, known }).toEqual({
							turn: index,
							known: [...new Set(calls.map(row => row.call_id))],
						});
						expect({ turn: index, custom }).toEqual({ turn: index, custom: customIds });
						if (!supportsCustomToolCalls) expect(customIds).toEqual([]);
					});
				});
			});
		}
	}
}
