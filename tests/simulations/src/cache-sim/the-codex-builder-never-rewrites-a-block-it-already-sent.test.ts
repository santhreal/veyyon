/**
 * On the Codex surface a caller holds exactly one lever, and it is not a marker:
 * the bytes before the newest item must be the bytes that were sent last turn.
 * `an-implicit-cache-forgives-appending-and-nothing-else.test.ts` prices what
 * breaking that costs. This file asks the prior question nothing else asks —
 * whether the SHIPPED builder keeps the promise at all.
 *
 * WHY THIS FILE EXISTS. The corpus scan behind the sibling scenario attributes
 * most of its fast-miss loss to a class whose shape is a rewritten history: the
 * system-and-tools token count did not change, the prompt did not shrink, and the
 * read still came back zero. That shape has two possible authors. One is the
 * provider (eviction, a key it did not honour), which no offline suite can reach.
 * The other is this repository: a builder that re-serializes an item it already
 * sent forfeits every item behind it, on a prompt of identical size, and leaves
 * exactly that signature. `buildTransformedCodexRequestBody` is pure and
 * exported, so the second author is checkable here, without a network, at every
 * content shape a message is allowed to carry.
 *
 * WHAT IS PROVEN. The subject is REAL: every row drives the shipped builder, so
 * the item boundaries, the instruction split, the tool-call pairing and the
 * cross-provider stripping rules are the product's own. There is no modelled
 * cache in this file and no price — a block that changes identity is reported as
 * a divergence, not billed, because the billing argument is the sibling's job and
 * repeating it here would only restate it. That makes this the one file in the
 * family whose verdict does not depend on a modelled multiplier.
 *
 * HOW THE VARIANT SPACE IS CLOSED. `PartKind` is derived from the content unions
 * in `@veyyon/ai/types` rather than listed, and the builder table is a
 * `Record<PartKind, ...>`, so adding a member to `UserMessage["content"]`,
 * `AssistantMessage["content"]` or `ToolResultMessage["content"]` fails the type
 * check until someone records a decision for it. A kind that cannot reach the
 * wire is pinned by exact equality in `STRIPPED_BEFORE_THE_WIRE`, never counted,
 * so a second kind cannot join the exemption unnoticed.
 *
 * WHAT THIS DOES NOT CATCH.
 *   - Provider-side loss. Eviction, a key the provider ignored, and a rewrite
 *     that happens above this builder (in session storage, compaction, or a
 *     transcript rebuild) all leave the corpus signature this file cannot see.
 *     Green here narrows the author to those; it does not exonerate the product.
 *   - The websocket append path. `canAppendBeforeRequest` chains a request onto a
 *     live socket instead of resending the prefix, and the chained body is built
 *     elsewhere (`buildCodexChainedRequestBody`). This file covers the body every
 *     transport starts from.
 *   - Whether a stable prefix was READ. Byte stability is necessary and not
 *     sufficient; the sibling scenario prices what a match is worth.
 *   - Ordering across a provider hop mid-session. History that switches provider
 *     is covered as one row, not as a sweep of every hop pairing.
 *   - Any provider but this one. The same class is live on the Google path and is
 *     not priced anywhere yet: `thoughtSignatureRetention`, `thinkingRetention`
 *     and `thoughtSignatureMaxLength` resolve through
 *     `firstRetainedAssistantIndex` (`google-shared.ts:247-255, 316`), which is a
 *     distance-from-the-end window. As history grows the boundary moves, so a
 *     message that was inside it falls outside it and its bytes change — a
 *     rewrite of a block already sent, on every turn, by construction. All three
 *     settings default to `-1` (unset), so nothing is lost today; an operator who
 *     turns one on to save uploaded signature bytes buys that with the cached
 *     prefix from the boundary back, which is the trade this family exists to
 *     price and has not priced.
 *
 * RED-PROOFS (mutation, each observed failing, each restored byte-identical,
 * verified with an empty `git diff --numstat -- packages/ai`):
 *   M16 in `convertMessages`, drop `thinkingSignature` from assistant messages
 *       more than four from the end — the retention shape described above. Both
 *       divergence rows fail, on both replay paths (3 pass / 3 fail).
 *   M17 the same mutation against a divergence search degraded to compare block
 *       LENGTHS instead of bytes. It still failed, so it proves nothing: dropping
 *       a signature also shortens the block. Recorded because a mutation that
 *       fails to isolate what it claims is worth naming, not quietly replacing.
 *   M18 a same-SIZE rewrite instead: uppercase the `summary_text` of items more
 *       than six from the end of the list `convertMessages` returns, which keeps
 *       every byte count and changes every byte — the corpus signature exactly.
 *       Against byte identity: 3 pass / 3 fail. Against the length-only search:
 *       5 pass / 1 fail, with BOTH divergence rows green. That pair is what earns
 *       the byte comparison its place.
 *   Also recorded, because it is the trap a later reader would fall into:
 *       uppercasing `block.thinking` is INERT here. On this surface the reasoning
 *       text on the wire is rebuilt from the parsed `thinkingSignature`, not from
 *       the block, so that mutation leaves the body unchanged and both arms stay
 *       green while proving nothing.
 */

import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Context, Message, ToolResultMessage, UserMessage } from "@veyyon/ai/types";
import { emptyUsage } from "@veyyon/catalog/models";
import { captureImplicitBody, implicitBlocksOf, padding, systemPrompt } from "./harness";

/**
 * Every content part a message is allowed to carry, taken from the unions
 * themselves. A new member makes `PART_SENTINEL` and `MESSAGES_CARRYING` fail to
 * type check, which is the fail-by-default gate: the long tail of this class is
 * the shape nobody thought to add a row for.
 */
type AnyContentPart =
	| Exclude<UserMessage["content"], string>[number]
	| AssistantMessage["content"][number]
	| ToolResultMessage["content"][number];
type PartKind = AnyContentPart["type"];

/**
 * A byte string unique to each kind, carried in the part's own payload so the
 * run can prove the kind reached the wire rather than assuming it did. The value
 * is arbitrary; that it is unique per kind is the whole requirement.
 */
const PART_SENTINEL: Record<PartKind, string> = {
	text: "SENTINEL_TEXT_9f21",
	image: "U0VOVElORUxfSU1BR0VfN2ExMw==",
	thinking: "SENTINEL_THINKING_4c07",
	redactedThinking: "SENTINEL_REDACTED_be55",
	fallback: "SENTINEL_FALLBACK_02da",
	toolCall: "SENTINEL_TOOLCALL_71bc",
};

/**
 * Kinds the shipped code removes on the way to a Codex request, so their
 * sentinel cannot appear on the wire and their absence is correct rather than a
 * hole. Pinned by exact equality below.
 *
 * `fallback` is an Anthropic-only boundary marker that `transformMessages`
 * strips on every cross-provider hop, documented on the interface
 * (`AnthropicFallbackContent` in `@veyyon/ai/types`). `redactedThinking` has no
 * Responses-family equivalent: reasoning replays as a `reasoning` item rebuilt
 * from the signature, and an opaque redacted block cannot be turned into one.
 */
const STRIPPED_BEFORE_THE_WIRE: readonly PartKind[] = ["fallback", "redactedThinking"];

/**
 * The fields every assistant turn in this file shares. `usage` is required on the
 * interface and irrelevant to a byte comparison, so it comes from `emptyUsage`,
 * which is the one owner of a zeroed usage literal in this repository.
 */
const CODEX_ASSISTANT = {
	api: "openai-codex-responses",
	provider: "openai-codex",
	model: "gpt-5.1-codex",
	stopReason: "toolUse",
	usage: emptyUsage(),
} as const;

/**
 * A reasoning item as the receive path stores one: `block.thinkingSignature =
 * JSON.stringify(item)` (`openai-codex-responses.ts:2018`), so the signature is
 * the whole item and the replay path reconstructs from it. A signature that is
 * not a serialized reasoning item is dropped, which is why a fixture carrying
 * `"sig_1"` proves nothing about this surface.
 */
function reasoningSignature(index: number, summary: string): string {
	return JSON.stringify({
		type: "reasoning",
		id: `rs_${index}`,
		summary: [{ type: "summary_text", text: summary }],
		encrypted_content: `enc_${index}_${padding(20)}`,
	});
}

/** The native items a Codex turn stores on its assistant message. */
function nativeItems(index: number, summary: string): Array<Record<string, unknown>> {
	return [
		{
			type: "reasoning",
			id: `rs_${index}`,
			summary: [{ type: "summary_text", text: summary }],
			encrypted_content: `enc_${index}_${padding(20)}`,
		},
		{
			type: "function_call",
			id: `fc_${index}`,
			call_id: `call_${index}`,
			name: "read",
			arguments: JSON.stringify({ path: `file-${index}.ts` }),
		},
	];
}

/** One history whose parts cover every kind, ordered as a real session orders them. */
function messagesCarryingEveryKind(): Message[] {
	return [
		{
			role: "user",
			content: [
				{ type: "text", text: `open the audit ${PART_SENTINEL.text}` },
				{ type: "image", data: PART_SENTINEL.image, mimeType: "image/png" },
			],
			timestamp: 0,
		},
		{
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: `weighing it ${PART_SENTINEL.thinking}`,
					thinkingSignature: reasoningSignature(0, `weighing it ${PART_SENTINEL.thinking}`),
				},
				{ type: "redactedThinking", data: PART_SENTINEL.redactedThinking },
				{ type: "fallback", from: { model: "a" }, to: { model: "b" } },
				{
					type: "toolCall",
					id: "call_0",
					name: "read",
					arguments: { path: `audit-${PART_SENTINEL.toolCall}.ts` },
				},
			],
			...CODEX_ASSISTANT,
			timestamp: 1,
		},
		{
			role: "toolResult",
			toolCallId: "call_0",
			toolName: "read",
			content: [{ type: "text", text: `audit contents\n${padding(300)}` }],
			isError: false,
			timestamp: 2,
		},
	];
}

/**
 * The (assistant tool call, tool result) pair a completed step appends.
 *
 * `nativeReplay` is the difference between the two paths this file sweeps. With a
 * payload the builder replays the stored items and never re-encodes the blocks
 * (`convertMessages`, `openai-codex-responses.ts:4096-4117`); without one — which
 * is what a mid-session model switch leaves behind, since reasoning is bound to
 * the model that minted it — it re-encodes from the blocks. Both run in
 * production and only one was covered before.
 */
function stepPair(index: number, options: { nativeReplay: boolean }): Message[] {
	const summary = `step ${index}`;
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: summary, thinkingSignature: reasoningSignature(index, summary) },
			{ type: "toolCall", id: `call_${index}`, name: "read", arguments: { path: `file-${index}.ts` } },
		],
		...CODEX_ASSISTANT,
		timestamp: index * 2 + 1,
	};
	if (options.nativeReplay) {
		assistant.providerPayload = {
			type: "openaiResponsesHistory",
			provider: "openai-codex",
			dt: true,
			items: nativeItems(index, summary),
		};
	}
	return [
		assistant,
		{
			role: "toolResult",
			toolCallId: `call_${index}`,
			toolName: "read",
			content: [{ type: "text", text: `contents of file-${index}.ts\n${padding(300)}` }],
			isError: false,
			timestamp: index * 2 + 2,
		},
	];
}

const TURNS = 6;

/** Turn N sends the every-kind history plus N completed steps. Append-only by construction. */
function growingHistory(turn: number, options: { nativeReplay: boolean }): Message[] {
	const messages = messagesCarryingEveryKind();
	for (let index = 1; index <= turn; index++) messages.push(...stepPair(index, options));
	return messages;
}

function contextFor(messages: Message[]): Context {
	return { systemPrompt: systemPrompt(), messages, tools: [] };
}

/**
 * The index of the first block whose identity changed between two turns, or `-1`
 * when the earlier turn's blocks all survive unchanged. Identity is the
 * serialized block itself: a same-size rewrite has to count as a divergence,
 * because that is precisely the corpus signature under investigation.
 */
function firstDivergence(before: readonly string[], after: readonly string[]): number {
	const shared = Math.min(before.length, after.length);
	for (let index = 0; index < shared; index++) {
		if (before[index] !== after[index]) return index;
	}
	return before.length > after.length ? shared : -1;
}

/** The blocks each turn would send, turn 0 through `TURNS`, on one replay path. */
async function blocksPerTurn(options: { nativeReplay: boolean }): Promise<string[][]> {
	const perTurn: string[][] = [];
	for (let turn = 0; turn <= TURNS; turn++) {
		perTurn.push(implicitBlocksOf(await captureImplicitBody(contextFor(growingHistory(turn, options)))));
	}
	return perTurn;
}

/** Every (turn, block) pair whose bytes changed from one turn to the next. */
function rewrittenBlocks(perTurn: readonly string[][]): Array<Record<string, unknown>> {
	return (
		perTurn
			.slice(0, -1)
			.map((before, index) => ({ turn: index, at: firstDivergence(before, perTurn[index + 1] as string[]) }))
			.filter(row => row.at !== -1)
			// Reported as the pair and the block, because a bare boolean would say a
			// rewrite happened without saying which item to go and look at.
			.map(row => ({
				turn: row.turn,
				block: row.at,
				before: (perTurn[row.turn] as string[])[row.at]?.slice(0, 160),
				after: (perTurn[row.turn + 1] as string[])[row.at]?.slice(0, 160),
			}))
	);
}

/**
 * Both replay paths, swept the same way. A row per path rather than one row on
 * whichever path the fixture happened to take: the paths diverge at
 * `convertMessages`, and the corpus cannot say which one a lost turn was on.
 */
const PATHS = [
	{ name: "native replay (a payload the model minted)", nativeReplay: true },
	{ name: "block re-encode (no payload, as a model switch leaves it)", nativeReplay: false },
] as const;

describe("the Codex builder never rewrites a block it already sent", () => {
	for (const path of PATHS) {
		describe(path.name, () => {
			it("keeps every block of turn N byte-identical in turn N+1", async () => {
				const perTurn = await blocksPerTurn(path);

				expect(rewrittenBlocks(perTurn)).toEqual([]);
			});

			it("grows by appending, so a stable prefix is a real prefix and not a shorter list", async () => {
				const counts = (await blocksPerTurn(path)).map(blocks => blocks.length);

				// Strictly increasing: a turn that sent FEWER blocks would make the
				// identity check above vacuous over the blocks that vanished.
				expect(counts.every((count, index) => index === 0 || count > (counts[index - 1] as number))).toBe(true);
				// And the growth is bounded by what a step appends, so the sweep
				// cannot pass by rebuilding the history into one giant block.
				expect(counts.at(-1) as number).toBeGreaterThan(TURNS);
			});
		});
	}

	it("puts every content kind on the wire except the ones documented as stripped", async () => {
		// The re-encode path is the one that reads the blocks, so it is the path
		// where a kind failing to reach the wire is a fact about the kind rather
		// than a fact about the fixture's stored payload.
		const wire = JSON.stringify(
			await captureImplicitBody(contextFor(growingHistory(TURNS, { nativeReplay: false }))),
		);
		const missing = (Object.keys(PART_SENTINEL) as PartKind[])
			.filter(kind => !wire.includes(PART_SENTINEL[kind]))
			.sort();

		// Exact equality, not a count: a kind that silently stopped reaching the
		// wire would otherwise be absorbed by the exemption and the sweep would
		// keep claiming to cover it.
		expect(missing).toEqual([...STRIPPED_BEFORE_THE_WIRE].sort());
	});

	it("replays a stored reasoning item rather than dropping it", async () => {
		// The signature IS the item (`openai-codex-responses.ts:2018`), so a
		// builder that ignored it would send a history with the reasoning gone —
		// stable, and missing the largest item class on this surface.
		const wire = JSON.stringify(await captureImplicitBody(contextFor(growingHistory(TURNS, { nativeReplay: true }))));

		expect(wire).toContain('"type":"reasoning"');
		// `encrypted_content` is the whole point: the sanitizer drops the item's
		// `id` on purpose (`utils.ts:216-227`), so the encrypted side-channel is
		// what carries a turn's reasoning across the boundary.
		expect(wire).toContain("enc_1");
	});
});
