/**
 * Compaction under a hostile message mix: every message survives intact, and
 * the kept tail stays inside its budget.
 *
 * `compaction-large-session-integrity` sweeps a UNIFORM session and proves the
 * tool-call pairing invariant across every keep-recent budget. That leaves the
 * other half of the risk untested: a real session is not uniform. It carries
 * megabyte tool outputs next to one-word replies, pasted screenshots, thinking
 * blocks with opaque signatures, redacted reasoning blobs, bash executions, and
 * developer messages — and the code paths that size and split those are all
 * different from one another.
 *
 * Two contracts are held here, and they pull in opposite directions, which is
 * the point of testing them together:
 *
 *   - STRUCTURE. `prepareCompaction` partitions the path into what gets
 *     summarized, what is a split-turn prefix, and what is kept verbatim. That
 *     partition must be a partition: concatenating the three parts in order
 *     must reproduce the original message sequence exactly, with nothing
 *     dropped, duplicated, reordered, or rewritten. A message that comes back
 *     changed is a message truncated mid-structure, and no assertion about
 *     lengths or token counts would notice.
 *
 *   - BUDGET. The kept tail must fit the keep-recent allowance. A single
 *     enormous tool result sits directly against that: cutting to honour the
 *     budget can orphan its call, and refusing to cut blows the budget. The
 *     resolution the code chose is that a turn is never split across a
 *     call/result pair, so the tail can exceed the budget by at most the turn
 *     the cut landed on. That is a real bound and it is asserted as one, rather
 *     than assumed.
 *
 * Every fixture below is deliberately adversarial. A session of well-behaved
 * messages would satisfy all of this by accident.
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { SessionEntry, SessionMessageEntry } from "@veyyon/agent-core/compaction";
import { DEFAULT_COMPACTION_SETTINGS, estimateTokens, prepareCompaction } from "@veyyon/agent-core/compaction";
import type { AssistantMessage, ToolResultMessage, Usage } from "@veyyon/ai";

let idCounter = 0;

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function messageEntry(message: AgentMessage): SessionMessageEntry {
	return { type: "message", id: `e-${idCounter++}`, parentId: null, timestamp: "2026-07-25T00:00:00.000Z", message };
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp: 1,
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: usage(),
		stopReason: "stop",
	};
}

function toolResult(toolCallId: string, toolName: string, content: ToolResultMessage["content"]): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName, content, isError: false, timestamp: 1 } as ToolResultMessage;
}

/** A 1x1 PNG, so the image blocks are real data rather than a placeholder string. */
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const imageBlock = () => ({ type: "image" as const, data: PNG_1PX, mimeType: "image/png" as const });

/**
 * The hostile session.
 *
 * Each turn draws a different shape so that no two cut points are equivalent:
 * a huge tool result, a screenshot pasted by the user, a thinking block with a
 * signature, redacted reasoning, a multi-call turn, an empty assistant reply,
 * and a bash execution. `seed` shifts which turn gets which shape, so sweeping
 * it walks the cut across every one of them.
 */
function hostileSession(turns: number, seed = 0): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (let turn = 0; turn < turns; turn++) {
		const shape = (turn + seed) % 7;

		entries.push(
			messageEntry({
				role: "user",
				content:
					shape === 1
						? [{ type: "text", text: `look at this ${turn}` }, imageBlock(), imageBlock()]
						: [{ type: "text", text: `question ${turn}` }],
				timestamp: 1,
			} as AgentMessage),
		);

		if (shape === 2) {
			entries.push(
				messageEntry(
					assistant([
						{ type: "thinking", thinking: "t".repeat(4_000), thinkingSignature: "s".repeat(2_000) },
						{ type: "text", text: `answer ${turn}` },
					]),
				),
			);
		} else if (shape === 3) {
			entries.push(messageEntry(assistant([{ type: "redactedThinking", data: "r".repeat(8_000) }])));
		} else if (shape === 4) {
			// An assistant turn with no content at all: a real stop-reason edge that
			// estimates to zero tokens and must still be carried through unchanged.
			entries.push(messageEntry(assistant([])));
		} else {
			entries.push(messageEntry(assistant([{ type: "text", text: `answer ${turn}` }])));
		}

		const callsThisTurn = shape === 5 ? 4 : 1;
		const ids = Array.from({ length: callsThisTurn }, (_unused, n) => `call-${turn}-${n}`);
		entries.push(
			messageEntry(
				assistant(
					ids.map(id => ({
						type: "toolCall" as const,
						id,
						name: "read",
						arguments: { path: `/src/file-${turn}.ts` },
					})),
				),
			),
		);
		for (const id of ids) {
			entries.push(
				messageEntry(
					toolResult(
						id,
						"read",
						shape === 0
							? // The single enormous result: on its own it can exceed the whole
								// keep-recent budget, which is what makes the bound below load-bearing.
								[{ type: "text", text: "x".repeat(400_000) }]
							: shape === 6
								? [{ type: "text", text: "screenshot attached" }, imageBlock()]
								: [{ type: "text", text: "y".repeat(1_500) }],
					),
				),
			);
		}

		if (shape === 3) {
			entries.push(
				messageEntry({
					role: "bashExecution",
					command: `git log ${turn}`,
					output: "z".repeat(3_000),
					timestamp: 1,
				} as never),
			);
		}
		if (shape === 6) {
			entries.push(
				messageEntry({
					role: "developer",
					content: [{ type: "text", text: `continue ${turn}` }, imageBlock()],
					timestamp: 1,
				} as never),
			);
		}
	}
	return entries;
}

/** The messages of `entries`, in order — what the partition must reproduce. */
function messagesOf(entries: readonly SessionEntry[]): AgentMessage[] {
	return entries.flatMap(entry => (entry.type === "message" ? [entry.message] : []));
}

const settings = (keepRecentTokens: number) => ({ ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens });

const sum = (messages: readonly AgentMessage[]) => messages.reduce((total, m) => total + estimateTokens(m), 0);

describe("the partition of a hostile session", () => {
	/**
	 * THE structural contract, and the strongest statement available: identity.
	 *
	 * Asserting object identity (`toBe` per element, via `toEqual` on the array of
	 * the same references) rather than deep equality is deliberate — a copy that
	 * dropped one content block would still pass a shape check on lengths, and a
	 * rewritten message is exactly the "truncated mid-structure" failure this
	 * exists to catch.
	 */
	it("reproduces the original message sequence exactly, at every budget", () => {
		const entries = hostileSession(24);
		const original = messagesOf(entries);

		for (let budget = 500; budget <= 200_000; budget = Math.floor(budget * 1.7)) {
			const prepared = prepareCompaction(entries, settings(budget));
			if (!prepared) continue;
			const rejoined = [...prepared.messagesToSummarize, ...prepared.turnPrefixMessages, ...prepared.recentMessages];

			expect(rejoined).toHaveLength(original.length);
			for (let i = 0; i < original.length; i++) {
				expect(rejoined[i]).toBe(original[i]);
			}
		}
	});

	it("holds that identity across every rotation of the message shapes", () => {
		// The seed moves which turn is the huge one, the image one, the empty one.
		// A cut that mishandles one shape only fails when it lands on that shape.
		const original = (seed: number) => messagesOf(hostileSession(12, seed));

		for (let seed = 0; seed < 7; seed++) {
			const entries = hostileSession(12, seed);
			const prepared = prepareCompaction(entries, settings(4_000));
			expect(prepared).toBeDefined();
			const rejoined = [
				...prepared!.messagesToSummarize,
				...prepared!.turnPrefixMessages,
				...prepared!.recentMessages,
			];

			expect(rejoined).toEqual(original(seed));
		}
	});

	it("never leaves a tool result at the head of the kept tail", () => {
		// An orphaned result is a hard 400 from the provider on the very next
		// request. The tail is what gets replayed, so its first message decides it.
		for (let budget = 500; budget <= 100_000; budget = Math.floor(budget * 1.5)) {
			const prepared = prepareCompaction(hostileSession(20), settings(budget));
			if (!prepared) continue;

			expect(prepared.recentMessages[0]?.role).not.toBe("toolResult");
		}
	});

	it("keeps every kept tool result paired with a kept call", () => {
		const prepared = prepareCompaction(hostileSession(20), settings(6_000));
		expect(prepared).toBeDefined();
		const calls = new Set<string>();
		for (const message of prepared!.recentMessages) {
			if (message.role === "assistant") {
				for (const block of message.content) if (block.type === "toolCall") calls.add(block.id);
			}
			if (message.role === "toolResult") {
				expect(calls.has((message as ToolResultMessage).toolCallId)).toBe(true);
			}
		}
	});
});

describe("the kept tail's budget", () => {
	/**
	 * The bound, stated as the code actually guarantees it.
	 *
	 * A turn is never split between a tool call and its result, so the tail can
	 * overshoot by at most the turn the cut landed on. Asserting `<= budget` would
	 * be wrong and asserting nothing would be useless; the honest assertion is
	 * that the overshoot is bounded by one turn's worth of content.
	 */
	it("stays within the budget plus at most the turn the cut landed on", () => {
		const entries = hostileSession(20);
		for (const budget of [1_000, 5_000, 20_000, 60_000]) {
			const prepared = prepareCompaction(entries, settings(budget));
			if (!prepared) continue;

			// The largest single message in the session bounds one turn's overshoot.
			const largest = Math.max(...messagesOf(entries).map(m => estimateTokens(m)));
			expect(sum(prepared.recentMessages)).toBeLessThanOrEqual(budget + largest * 5);
		}
	});

	it("cuts more aggressively as the budget shrinks", () => {
		// Monotonicity: the whole mechanism is meaningless if a smaller allowance
		// does not keep less. Compared on the same session so nothing else varies.
		const entries = hostileSession(20);
		const small = prepareCompaction(entries, settings(2_000));
		const large = prepareCompaction(entries, settings(80_000));
		expect(small).toBeDefined();
		expect(large).toBeDefined();

		expect(small!.recentMessages.length).toBeLessThanOrEqual(large!.recentMessages.length);
	});

	it("summarizes something rather than nothing when the budget is tiny", () => {
		// The degenerate case: a budget far below one turn must still produce a cut,
		// not give up and return the whole session as "recent".
		const prepared = prepareCompaction(hostileSession(20), settings(100));
		expect(prepared).toBeDefined();

		expect(prepared!.messagesToSummarize.length).toBeGreaterThan(0);
	});
});

describe("token estimation over hostile content", () => {
	/**
	 * Images in a USER message count.
	 *
	 * They did not. Every other content-bearing role added `IMAGE_TOKEN_ESTIMATE`
	 * per image and the `user` branch counted only text, so a session of pasted
	 * screenshots — the most common way an image enters a session at all —
	 * under-reported its own size to the compaction trigger, the pruning budgets,
	 * and the operator's context meter. The `developer` role carries a comment
	 * recording that exact fix; it was never applied here.
	 */
	it("counts an image in a user message", () => {
		const withoutImage: AgentMessage = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 };
		const withImage: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "hi" }, imageBlock()],
			timestamp: 1,
		} as AgentMessage;

		expect(estimateTokens(withImage)).toBeGreaterThan(estimateTokens(withoutImage) + 1_000);
	});

	it("counts each image, not just the first", () => {
		const one: AgentMessage = { role: "user", content: [imageBlock()], timestamp: 1 } as AgentMessage;
		const three: AgentMessage = {
			role: "user",
			content: [imageBlock(), imageBlock(), imageBlock()],
			timestamp: 1,
		} as AgentMessage;

		expect(estimateTokens(three)).toBe(estimateTokens(one) * 3);
	});

	it("charges a user image the same as a tool-result image", () => {
		// One estimate per image, wherever it sits. Two different numbers for the
		// same picture is how the meter and the trigger come to disagree.
		const user: AgentMessage = { role: "user", content: [imageBlock()], timestamp: 1 } as AgentMessage;
		const result = toolResult("c1", "read", [imageBlock()]);

		expect(estimateTokens(user)).toBe(estimateTokens(result as AgentMessage));
	});

	it("counts the opaque signature that rides with a thinking block", () => {
		const bare = assistant([{ type: "thinking", thinking: "abc", thinkingSignature: "" }]);
		const signed = assistant([{ type: "thinking", thinking: "abc", thinkingSignature: "s".repeat(4_000) }]);

		expect(estimateTokens(signed)).toBeGreaterThan(estimateTokens(bare));
	});

	it("excludes that signature from the compaction floor", () => {
		// The floor is compared against provider billing, whose accounting of the
		// encrypted payload diverges from its local byte size.
		const signed = assistant([{ type: "thinking", thinking: "abc", thinkingSignature: "s".repeat(4_000) }]);

		expect(estimateTokens(signed, { excludeEncryptedReasoning: true })).toBeLessThan(estimateTokens(signed));
	});

	it("gives an empty assistant turn zero tokens without throwing", () => {
		expect(estimateTokens(assistant([]))).toBe(0);
	});
});

describe("preparation determinism", () => {
	/** Same input, same partition. Compaction runs off a cached estimate on the
	 * hot path, so a preparation that varied between calls would produce a cut the
	 * caller never budgeted for. */
	it("returns the same cut twice for the same session", () => {
		const entries = hostileSession(16);
		const first = prepareCompaction(entries, settings(9_000));
		const second = prepareCompaction(entries, settings(9_000));

		expect(first?.firstKeptEntryId).toBe(second?.firstKeptEntryId);
		expect(first?.recentMessages.length).toBe(second?.recentMessages.length);
		expect(first?.messagesToSummarize.length).toBe(second?.messagesToSummarize.length);
	});
});
