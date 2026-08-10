/**
 * Contract: `estimateTokens` answers about the content a message holds NOW, and
 * pays the tokenizer only when that content moved.
 *
 * Both halves are load-bearing and they pull against each other. The estimate
 * decides when compaction triggers, how pruning spends its budget, what the
 * post-compaction headroom and retry-fit checks measure, and what the operator's
 * context meter reads, and it is re-walked over the whole stored conversation on
 * every pre-prompt and post-turn check (`#estimateStoredContextTokens`,
 * `#estimatePrePromptContextTokens`, BACKLOG P5). That is why the cache exists.
 * But the compaction rewrites edit a stored message IN PLACE: `applyShakeRegion`
 * assigns a placeholder over `message.content` and stamps `prunedAt`,
 * `pruneToolOutputs` blanks a result the same way, and the image drop splices
 * blocks out of one. A cache keyed on object identity alone therefore kept
 * answering with the size a message had BEFORE the bytes were removed, for the
 * rest of the session.
 *
 * Since the compaction decision floors the provider figure with this estimate
 * (`compactionContextTokens`), an estimate that cannot fall means a dedup or a
 * prune can never bring a session back under the trigger: the "maintenance
 * alone fixed it, skip the summarization" path could not fire, the dead-end
 * rescue measured a residual that was already gone, and the meter reported
 * elided bytes as live.
 *
 * WHAT THESE ROWS CLOSE. The invariant is asserted at the choke point every
 * mutator passes through: once a message has been estimated, the answer after an
 * in-place edit must equal the answer for a fresh copy of that same content.
 * Rows drive the real rewrites (the shake/dedup elision and the overflow prune,
 * plus an image splice) and then every role the estimator counts, so no mutator
 * of any of them can be believed stale.
 *
 * WHAT THEY DO NOT CATCH. An in-place edit that leaves the fragment sequence and
 * every fragment's length unchanged (swapping two same-length texts) reads as
 * unchanged, and a role added to the estimator needs a row added here. Neither
 * can move the estimate by more than rounding, and neither can bring the
 * identity-only staleness back: validity is derived from the content itself.
 */
import { describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { SessionEntry, SessionMessageEntry } from "@veyyon/agent-core/compaction";
import {
	AGGRESSIVE_SHAKE_CONFIG,
	applyShakeRegions,
	collectRedundantToolResultRegions,
	estimateTokens,
	pruneToolOutputs,
} from "@veyyon/agent-core/compaction";
import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage } from "@veyyon/ai";

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

let idCounter = 0;

function toolResultMessage(text: string): ToolResultMessage {
	idCounter += 1;
	return {
		role: "toolResult",
		toolCallId: `call-${idCounter}`,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function messageEntry(message: AgentMessage): SessionMessageEntry {
	idCounter += 1;
	return {
		type: "message",
		id: `entry-${idCounter}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		message,
	};
}

/** The oracle: what the estimator says about this content with no cache behind it. */
function freshEstimate(message: AgentMessage, options?: { excludeEncryptedReasoning?: boolean }): number {
	return estimateTokens(structuredClone(message), options);
}

const IMAGE_BLOCK: ImageContent = { type: "image", data: "AAAA", mimeType: "image/png" };

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

describe("estimateTokens after an in-place rewrite", () => {
	test("the shake/dedup elision is visible to the next estimate", () => {
		const older = toolResultMessage(LONG_TEXT);
		const newer = toolResultMessage(LONG_TEXT);
		const entries: SessionEntry[] = [messageEntry(older), messageEntry(newer)];
		// Warm the cache exactly the way production does: the dedup's own region
		// collection estimates every candidate before it rewrites any of them.
		const before = estimateTokens(older);

		const regions = collectRedundantToolResultRegions(entries, AGGRESSIVE_SHAKE_CONFIG);
		expect(regions.length).toBe(1);
		applyShakeRegions(regions.map(region => ({ region, replacement: "[shaken ~3600 tokens]" })));

		const after = estimateTokens(older);
		expect(after).toBe(freshEstimate(older));
		expect(after).toBeLessThan(before / 10);
		// The copy that stayed live is untouched, so its warm answer is still right.
		expect(estimateTokens(newer)).toBe(freshEstimate(newer));
	});

	test("the overflow prune blanking a tool result is visible to the next estimate", () => {
		const victim = toolResultMessage(LONG_TEXT);
		const entries: SessionEntry[] = [messageEntry(victim), messageEntry(toolResultMessage("tail"))];
		const before = estimateTokens(victim);

		const result = pruneToolOutputs(entries, { protectTokens: 0, minimumSavings: 0, protectedTools: [] });
		expect(result.prunedCount).toBeGreaterThan(0);

		const after = estimateTokens(victim);
		expect(after).toBe(freshEstimate(victim));
		expect(after).toBeLessThan(before / 10);
	});

	test("splicing an image block out of a message is visible to the next estimate", () => {
		const message: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "look" }, IMAGE_BLOCK],
			timestamp: Date.now(),
		};
		const before = estimateTokens(message);

		// What `dropImages` / `stripImagesFromMessage` do: rewrite the block array
		// on the stored message, same object.
		message.content = [{ type: "text", text: "look" }];

		const after = estimateTokens(message);
		expect(after).toBe(freshEstimate(message));
		expect(before - after).toBe(1_200);
	});

	test("an in-place edit costs exactly one re-tokenize, not one per read", () => {
		const message = toolResultMessage(LONG_TEXT);
		estimateTokens(message);
		message.content = [{ type: "text", text: "[shaken]" }];

		const byteLengthSpy = vi.spyOn(Buffer, "byteLength");
		const first = estimateTokens(message);
		const callsAfterRewrite = byteLengthSpy.mock.calls.length;
		expect(callsAfterRewrite).toBeGreaterThan(0);
		// The revalidation walk reads lengths; it must not re-enter the tokenizer
		// once the new shape is cached, or every context read would pay for the
		// whole conversation.
		expect(estimateTokens(message)).toBe(first);
		expect(byteLengthSpy.mock.calls.length).toBe(callsAfterRewrite);
		byteLengthSpy.mockRestore();
	});

	test("shrinking only the encrypted reasoning payload moves the default estimate and not the floor", () => {
		const message = assistantMessage([
			{ type: "thinking", thinking: "hidden reasoning", thinkingSignature: "s".repeat(4000) },
			{ type: "text", text: "visible answer" },
		]);
		const beforeDefault = estimateTokens(message);
		const beforeFloor = estimateTokens(message, { excludeEncryptedReasoning: true });

		const thinking = message.content[0];
		if (thinking.type !== "thinking") throw new Error("fixture lost its thinking block");
		thinking.thinkingSignature = "s";

		// Each option variant keeps its own shape, so the variant that never looked
		// at the signature is not invalidated by it changing, and stays correct.
		expect(estimateTokens(message)).toBe(freshEstimate(message));
		expect(estimateTokens(message)).toBeLessThan(beforeDefault);
		expect(estimateTokens(message, { excludeEncryptedReasoning: true })).toBe(beforeFloor);
		expect(estimateTokens(message, { excludeEncryptedReasoning: true })).toBe(
			freshEstimate(message, { excludeEncryptedReasoning: true }),
		);
	});

	/**
	 * Every role the estimator counts, edited in place. The estimate a warm
	 * message reports has to equal what a fresh copy of that same content
	 * reports; a role that reads its cache instead fails here rather than in
	 * whichever compaction decision consumed the stale number.
	 */
	const ROLES: Array<{ label: string; make: () => AgentMessage; shrink: (message: AgentMessage) => void }> = [
		{
			label: "user with string content",
			make: () => ({ role: "user", content: LONG_TEXT, timestamp: Date.now() }),
			shrink: message => {
				(message as { content: string }).content = "short";
			},
		},
		{
			label: "user with text blocks",
			make: () => ({ role: "user", content: [{ type: "text", text: LONG_TEXT }], timestamp: Date.now() }),
			shrink: message => {
				(message as { content: TextContent[] }).content = [{ type: "text", text: "short" }];
			},
		},
		{
			label: "assistant text",
			make: () => assistantMessage([{ type: "text", text: LONG_TEXT }]),
			shrink: message => {
				(message as AssistantMessage).content = [{ type: "text", text: "short" }];
			},
		},
		{
			label: "assistant tool-call arguments",
			make: () => assistantMessage([{ type: "toolCall", id: "c1", name: "read", arguments: { body: LONG_TEXT } }]),
			shrink: message => {
				(message as AssistantMessage).content = [{ type: "toolCall", id: "c1", name: "read", arguments: {} }];
			},
		},
		{
			label: "developer",
			make: () => ({ role: "developer", content: [{ type: "text", text: LONG_TEXT }], timestamp: Date.now() }),
			shrink: message => {
				(message as { content: TextContent[] }).content = [{ type: "text", text: "short" }];
			},
		},
		{
			label: "custom",
			make: () => ({
				role: "custom",
				customType: "note",
				content: [{ type: "text", text: LONG_TEXT }],
				display: true,
				timestamp: Date.now(),
			}),
			shrink: message => {
				(message as { content: TextContent[] }).content = [{ type: "text", text: "short" }];
			},
		},
		{
			label: "hookMessage",
			make: () => ({
				role: "hookMessage",
				customType: "hook",
				content: LONG_TEXT,
				display: true,
				timestamp: Date.now(),
			}),
			shrink: message => {
				(message as { content: string }).content = "short";
			},
		},
		{
			label: "toolResult",
			make: () => toolResultMessage(LONG_TEXT),
			shrink: message => {
				(message as ToolResultMessage).content = [{ type: "text", text: "short" }];
			},
		},
		{
			label: "branchSummary",
			make: () => ({ role: "branchSummary", summary: LONG_TEXT, fromId: "entry-0", timestamp: Date.now() }),
			shrink: message => {
				(message as { summary: string }).summary = "short";
			},
		},
		{
			label: "compactionSummary",
			make: () => ({
				role: "compactionSummary",
				summary: LONG_TEXT,
				tokensBefore: 1_000,
				blocks: [{ type: "text", text: LONG_TEXT }, IMAGE_BLOCK],
				timestamp: Date.now(),
			}),
			shrink: message => {
				const summary = message as { summary: string; blocks: (TextContent | ImageContent)[] };
				summary.summary = "short";
				summary.blocks = [{ type: "text", text: "short" }];
			},
		},
		{
			// `bashExecution` is contributed by the coding-agent's declaration
			// merging, so this package can only build it structurally. The estimator
			// reads it by role string for the same reason.
			label: "bashExecution",
			make: () =>
				({
					role: "bashExecution",
					command: "ls",
					output: LONG_TEXT,
					timestamp: Date.now(),
				}) as unknown as AgentMessage,
			shrink: message => {
				(message as unknown as { output: string }).output = "short";
			},
		},
	];

	for (const role of ROLES) {
		test(`${role.label} reports its current content after an in-place edit`, () => {
			const message = role.make();
			const before = estimateTokens(message);
			expect(before).toBeGreaterThan(100);

			role.shrink(message);

			const after = estimateTokens(message);
			expect(after).toBe(freshEstimate(message));
			expect(after).toBeLessThan(before);
		});
	}
});
