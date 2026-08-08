/**
 * The tail bound holds across adversarial session shapes, measured the way
 * the engine measures, and under estimate-vs-actual scaling.
 *
 * Defect class: the elision loop's stop condition is only honest if it holds
 * for every shape the cut can leave behind — multi-call turns, bash
 * executions, empty replies, a huge result at any position — and if the
 * budget it enforces is the SCALED one: when the provider charged more for
 * the same messages than the local estimate predicted, `prepareCompaction`
 * divides `keepRecentTokens` by that ratio, and the tail must respect the
 * divided figure, not the configured one.
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { SessionEntry, SessionMessageEntry } from "@veyyon/agent-core/compaction";
import { DEFAULT_COMPACTION_SETTINGS, estimateTokens, prepareCompaction } from "@veyyon/agent-core/compaction";
import type { AssistantMessage, ToolResultMessage, Usage } from "@veyyon/ai";

let idCounter = 0;

const zeroUsage = (): Usage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function entry(message: AgentMessage): SessionMessageEntry {
	return { type: "message", id: `e-${idCounter++}`, parentId: null, timestamp: "2026-08-06T00:00:00.000Z", message };
}

const user = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });

const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
	role: "assistant",
	content,
	timestamp: 1,
	provider: "mock",
	model: "mock",
	api: "mock",
	usage: zeroUsage(),
	stopReason: "stop",
});

const result = (toolCallId: string, text: string): ToolResultMessage => ({
	role: "toolResult",
	toolCallId,
	toolName: "read",
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 1,
});

/**
 * The adversarial generator, in the spirit of compaction-large-session-
 * integrity: mixed call fan-out, a bash execution, an empty assistant reply,
 * and one enormous result whose position the seed moves.
 */
function hostileSession(turns: number, seed: number): SessionEntry[] {
	idCounter = 0;
	const entries: SessionEntry[] = [];
	for (let turn = 0; turn < turns; turn++) {
		const shape = (turn + seed) % 5;
		entries.push(entry(user(`question ${turn}`)));
		if (shape === 2) {
			entries.push(entry(assistant([])));
		} else {
			entries.push(entry(assistant([{ type: "text", text: `answer ${turn}` }])));
		}
		const calls = shape === 3 ? 3 : 1;
		const ids = Array.from({ length: calls }, (_u, n) => `call-${turn}-${n}`);
		entries.push(
			entry(assistant(ids.map(id => ({ type: "toolCall" as const, id, name: "read", arguments: { path: id } })))),
		);
		for (const id of ids) {
			entries.push(entry(result(id, shape === 0 ? "x".repeat(400_000) : "y".repeat(2_000))));
		}
		if (shape === 4) {
			entries.push(
				entry({
					role: "bashExecution",
					command: `git log ${turn}`,
					output: "z".repeat(3_000),
					timestamp: 1,
				} as never),
			);
		}
	}
	return entries;
}

function messageOf(e: SessionEntry): AgentMessage {
	if (e.type !== "message") throw new Error("fixture entries are all message entries");
	return e.message;
}

const settings = (keepRecentTokens: number) => ({ ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens });

const sum = (messages: readonly AgentMessage[]) => messages.reduce((total, m) => total + estimateTokens(m), 0);

/** Marker size floor, kept in sync with TAIL_ELISION_MIN_TOKENS in compaction.ts. */
const ELISION_FLOOR = 100;

describe("the bound across adversarial shapes and budgets", () => {
	it("the tail only exceeds budget when nothing elidable remains", () => {
		// The loop's exact postcondition, swept: elision stops when the tail
		// fits OR when every non-error result left in it is too small to be
		// worth a marker. A tail over budget WITH elidable bulk still in it is
		// the defect this suite exists to catch.
		for (let seed = 0; seed < 5; seed++) {
			for (let budget = 500; budget <= 200_000; budget = Math.floor(budget * 1.9)) {
				// Fresh fixture per point: the elision rewrites the entries it is given.
				const prepared = prepareCompaction(hostileSession(16, seed), settings(budget));
				if (!prepared) continue;
				const tail = sum(prepared.recentMessages);
				if (tail <= budget) continue;
				const elidableLeft = prepared.recentMessages.filter(
					m => m.role === "toolResult" && !m.isError && estimateTokens(m) > ELISION_FLOOR,
				);
				expect(
					elidableLeft,
					`seed ${seed} budget ${budget}: tail ${tail} over budget with elidable results left`,
				).toEqual([]);
			}
		}
	});

	it("a kept huge result is elided down to the budget wherever the cut lands", () => {
		// The direct statement of the acceptance bound: shapes with a 400k-char
		// result in the kept span end with the tail at or under budget.
		for (let seed = 0; seed < 5; seed++) {
			const prepared = prepareCompaction(hostileSession(16, seed), settings(10_000));
			expect(prepared).toBeDefined();
			expect(sum(prepared!.recentMessages)).toBeLessThanOrEqual(10_000);
		}
	});
});

describe("estimate-vs-actual scaling", () => {
	it("the tail respects the budget divided by the provider/local ratio", () => {
		// The provider charged four times the local estimate for the SAME
		// messages. Keeping "10000 estimated tokens" would keep ~40000 real
		// ones, so the budget is divided by the ratio — and the elision must
		// enforce the divided figure, or the tail blows the real budget by the
		// same factor the scaling exists to correct.
		const entries = hostileSession(16, 0);
		const estimatedTotal = sum(entries.map(messageOf));
		const promptTokens = estimatedTotal * 4;
		const last = entries[entries.length - 2]!; // final assistant message
		const lastMessage = messageOf(last);
		if (lastMessage.role !== "assistant") throw new Error("fixture ends with a result");
		lastMessage.usage = { ...zeroUsage(), input: promptTokens, totalTokens: promptTokens };

		const prepared = prepareCompaction(entries, settings(10_000), { nonMessageTokens: 0 });

		expect(prepared).toBeDefined();
		// floor(10_000 / 4) = 2_500, enforced against the same estimator.
		expect(sum(prepared!.recentMessages)).toBeLessThanOrEqual(2_500);
		expect(prepared!.tailElisions!.length).toBeGreaterThan(0);
	});

	it("without a usage report the configured budget is enforced as-is", () => {
		// The control: no scaling signal, no division — the tail may use the
		// whole configured budget and no elision beyond it may fire.
		const entries = hostileSession(16, 0);
		const prepared = prepareCompaction(entries, settings(10_000));

		expect(prepared).toBeDefined();
		expect(sum(prepared!.recentMessages)).toBeLessThanOrEqual(10_000);
	});
});
