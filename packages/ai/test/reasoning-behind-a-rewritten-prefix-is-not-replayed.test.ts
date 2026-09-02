import { describe, expect, it } from "bun:test";
import { transformMessages } from "@veyyon/ai/providers/transform-messages";
import type { AssistantMessage, Message, Model, ModelSpec, ToolResultMessage } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

/**
 * WHY: Claude Fable 5.1 binds every thinking block's signature to the exact
 * bytes that preceded it — the system prompt, the tool set, and every earlier
 * message. A client that rewrites history and then replays the reasoning
 * recorded against the old prefix gets a 400 (`The block is bound to a
 * different conversation`) or, once the request opts into `drop_block`, a
 * silent server-side drop. Veyyon rewrites history routinely: a compaction or
 * branch summary REPLACES the turns it summarizes, and the prune passes blank
 * a tool result in place.
 *
 * The class this closes: reasoning that outlives the prefix it was produced
 * against must never reach a prefix-binding model, whichever rewrite orphaned
 * it and whichever thinking block type carries it. The rewrite markers are
 * enumerated from {@link REWRITE_MARKERS} rather than spot-checked, so a new
 * kind of in-place rewrite that forgets to mark itself fails here.
 *
 * What it does NOT catch: a rewrite that mutates message bytes without
 * recording a marker at all (an edit in place that sets neither
 * `historyRewriteAt` nor `prunedAt`) is invisible to `transformMessages` and
 * to this suite. Nor does it cover a catalog row that declares no effort
 * ladder: such a row carries no thinking config at all, so it carries no
 * flag either. It also says nothing about the server-side
 * `prefix_mismatch_behavior` retry, which veyyon does not send.
 * @see https://platform.claude.com/docs/en/build-with-claude/preserved-thinking
 */

const REWRITE_AT = 2_000;

function anthropicModel(id: string): Model<"anthropic-messages"> {
	return buildModel({
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		id,
		name: id,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 200_000,
		reasoning: true,
		// Mirrors the shape every catalogued Claude row carries: the declared
		// ladder is what makes the build backfill wire facts onto `thinking`.
		thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high"] },
	} as ModelSpec<"anthropic-messages">);
}

function assistant(content: AssistantMessage["content"], timestamp: number, model: string): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

/** Every way a rewrite announces itself to the transform, keyed by the message that carries it. */
const REWRITE_MARKERS: readonly { readonly name: string; readonly message: Message }[] = [
	{
		name: "compaction summary (user)",
		message: {
			role: "user",
			content: "<summary>…</summary>",
			attribution: "agent",
			historyRewriteAt: REWRITE_AT,
			timestamp: REWRITE_AT,
		},
	},
	{
		name: "branch summary (developer)",
		message: {
			role: "developer",
			content: "<branch-summary>…</branch-summary>",
			attribution: "agent",
			historyRewriteAt: REWRITE_AT,
			timestamp: REWRITE_AT,
		},
	},
	{
		name: "pruned tool result",
		message: {
			role: "toolResult",
			toolCallId: "toolu_pruned",
			toolName: "read",
			content: [{ type: "text", text: "[Output truncated]" }],
			isError: false,
			prunedAt: REWRITE_AT,
			timestamp: 1_500,
		} satisfies ToolResultMessage,
	},
];

/**
 * The shape a rewrite leaves behind: the marker carries the moment history was
 * rewritten, and the turns kept across it keep their ORIGINAL timestamps. A
 * kept turn therefore sits after the marker in the array while predating it in
 * time, which is the turn whose reasoning was minted against the replaced
 * prefix.
 */
function historyAround(marker: Message, model: string): Message[] {
	return [
		{ role: "user", content: "Fix the failing test.", timestamp: 1_000 },
		marker,
		assistant(
			[
				{ type: "thinking", thinking: "Read the test first.", thinkingSignature: "sig_before" },
				{ type: "redactedThinking", data: "redacted_before" },
				{ type: "text", text: "Reading it now." },
			],
			1_100,
			model,
		),
		{ role: "user", content: "Continue.", timestamp: 3_000 },
		assistant(
			[
				{ type: "thinking", thinking: "The summary says the fix is in auth.ts.", thinkingSignature: "sig_after" },
				{ type: "text", text: "Patching auth.ts." },
			],
			3_100,
			model,
		),
	];
}

function thinkingSignatures(messages: Message[]): string[] {
	const signatures: string[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "thinking") signatures.push(block.thinkingSignature ?? "");
			if (block.type === "redactedThinking") signatures.push(`redacted:${block.data}`);
		}
	}
	return signatures;
}

function visibleText(messages: Message[]): string[] {
	const texts: string[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "text") texts.push(block.text);
		}
	}
	return texts;
}

describe("reasoning behind a rewritten prefix", () => {
	const bound = anthropicModel("claude-fable-5-1");
	const unbound = anthropicModel("claude-fable-5");

	it("marks exactly the models the API enforces the check on", () => {
		// The floor is a version compare, not an id list: Fable 5.1 enforces
		// today and every later generation inherits it. A model catalogued
		// below the floor must not pay for the drop.
		expect(bound.thinking?.prefixBinding).toBe(true);
		expect(unbound.thinking?.prefixBinding).toBeUndefined();
		expect(anthropicModel("claude-opus-4-8").thinking?.prefixBinding).toBeUndefined();
		expect(anthropicModel("claude-mythos-5-1").thinking?.prefixBinding).toBe(true);
	});

	for (const { name, message } of REWRITE_MARKERS) {
		it(`drops thinking and redacted thinking orphaned by a ${name}`, () => {
			const transformed = transformMessages(historyAround(message, bound.id), bound);

			// The reasoning produced against the replaced prefix is gone; the
			// reasoning produced after it — whose prefix is intact — replays.
			expect(thinkingSignatures(transformed)).toEqual(["sig_after"]);
			// Only the reasoning goes. The turn's visible output and its place
			// in the conversation are untouched, so the model still sees what
			// it said and did before the rewrite.
			expect(visibleText(transformed)).toEqual(["Reading it now.", "Patching auth.ts."]);
		});

		it(`keeps that same reasoning for a model without prefix binding after a ${name}`, () => {
			const transformed = transformMessages(historyAround(message, unbound.id), unbound);

			expect(thinkingSignatures(transformed)).toEqual(["sig_before", "redacted:redacted_before", "sig_after"]);
		});
	}

	it("keeps reasoning when no rewrite marker precedes it", () => {
		const untouched: Message[] = [
			{ role: "user", content: "Fix the failing test.", timestamp: 1_000 },
			assistant(
				[
					{ type: "thinking", thinking: "Read the test first.", thinkingSignature: "sig_before" },
					{ type: "text", text: "Reading it now." },
				],
				1_100,
				bound.id,
			),
			{ role: "user", content: "Continue.", timestamp: 3_000 },
		];

		expect(thinkingSignatures(transformMessages(untouched, bound))).toEqual(["sig_before"]);
	});

	it("keeps reasoning recorded after the last rewrite when an earlier one also rewrote history", () => {
		// Two compactions in one session: only the turns behind the LATEST
		// rewrite are orphaned, and a stale earlier marker must not resurrect
		// the reasoning the later one invalidated.
		const messages: Message[] = [
			{ role: "user", content: "Start.", timestamp: 500 },
			{ role: "user", content: "<summary>first</summary>", historyRewriteAt: 1_000, timestamp: 1_000 },
			assistant([{ type: "thinking", thinking: "one", thinkingSignature: "sig_1" }], 600, bound.id),
			{ role: "user", content: "<summary>second</summary>", historyRewriteAt: REWRITE_AT, timestamp: REWRITE_AT },
			// Recorded after the first compaction and kept across the second, so
			// its prefix was replaced too.
			assistant([{ type: "thinking", thinking: "two", thinkingSignature: "sig_2" }], 1_100, bound.id),
			assistant([{ type: "thinking", thinking: "three", thinkingSignature: "sig_3" }], 2_100, bound.id),
		];

		expect(thinkingSignatures(transformMessages(messages, bound))).toEqual(["sig_3"]);
	});
});
