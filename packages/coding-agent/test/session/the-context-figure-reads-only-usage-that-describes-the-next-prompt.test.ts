/**
 * WHY: the context figure the status line shows and every compaction decision reads comes from one
 * collaborator, `ContextAccounting`. It anchors on a provider-reported prompt size and estimates
 * the rest, and the defects at that boundary share one shape: it reads a number that no longer
 * describes the next prompt. Usage from before a compaction or an in-place rewrite measured bytes
 * that are gone; a turn-start usage stacked under a whole-tail estimate counts the turn twice; a
 * prompt snapshot left alone after a rewrite reports the removed bytes; a provider that
 * under-reports its prompt hides the stored conversation from the compaction trigger.
 *
 * The class this closes is a context figure computed from usage that does not describe the prompt
 * the session sends next. Each case drives the real collaborator against a real in-memory
 * `SessionManager` and a live message list, and reads the figure. The resting usage reads the same
 * figure with the non-message size the anchor stamped in place of a measurement, so it obeys the same
 * anchor rules and never asks the host to measure.
 *
 * What it does not catch: whether each history-rewriting pass calls `markHistoryRewritten`
 * (`nothing-to-compact-is-a-dead-end-only-without-headroom` and the compaction suites drive those
 * passes), and the non-message token totals, which the host supplies.
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { estimateTokens } from "@veyyon/agent-core/compaction";
import type { AssistantMessage, UserMessage } from "@veyyon/ai";
import type { InstrumentationLevel } from "@veyyon/ai/instrumentation";
import { ContextAccounting } from "@veyyon/coding-agent/session/runtime/context-accounting";
import { SessionManager } from "@veyyon/kernel/session/session-manager";

const NON_MESSAGE = 1_000;

function harness(level: InstrumentationLevel = "off") {
	const store = SessionManager.inMemory();
	const messages: AgentMessage[] = [];
	/** `measured` counts every time the collaborator asked the host to measure the non-message half. */
	const state = { nonMessage: NON_MESSAGE, measured: 0 };
	const context = new ContextAccounting({
		sessionStore: store,
		model: () => undefined,
		messages: () => messages,
		instrumentationLevel: () => level,
		nonMessageTokens: () => {
			state.measured++;
			return state.nonMessage;
		},
		nonMessageBreakdown: () => {
			state.measured++;
			return { skillsTokens: 0, toolsTokens: 0, systemContextTokens: 0, systemPromptTokens: state.nonMessage };
		},
		storedMessagesTokens: () =>
			messages.reduce((sum, message) => sum + estimateTokens(message, { excludeEncryptedReasoning: true }), 0),
	});
	/** Append to the live context and the branch, as a finished message is. */
	const add = (message: AgentMessage): void => {
		messages.push(message);
		if (message.role === "user" || message.role === "assistant") store.appendMessage(message);
	};
	return { store, messages, state, context, add };
}

function user(text: string, timestamp: number): UserMessage {
	return { role: "user", content: text, timestamp };
}

function assistant(text: string, timestamp: number, promptTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: promptTokens,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: promptTokens + 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

/** A response stamped with the non-message size its prompt measured, as `MessagePersistence` stamps it. */
function stamped(text: string, timestamp: number, promptTokens: number, nonMessageTokens: number): AssistantMessage {
	return { ...assistant(text, timestamp, promptTokens), contextSnapshot: { promptTokens, nonMessageTokens } };
}

function tokens(...messages: AgentMessage[]): number {
	return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

describe("the context figure", () => {
	it("anchors on the newest provider usage and estimates only what came after it", () => {
		const { context, add } = harness();
		add(user("first question", 1));
		add(assistant("first answer", 2, 50_000));
		const tail = user("a follow-up that has not been sent yet", 3);
		add(tail);

		const breakdown = context.breakdown();
		expect(breakdown.anchored).toBe(true);
		expect(breakdown.usedTokens).toBe(50_000 + tokens(tail));
	});

	it("ignores provider usage from before the latest compaction", () => {
		const { store, messages, context, add } = harness();
		add(user("question", 1));
		add(assistant("answer", 2, 50_000));
		store.appendCompaction("summary", undefined, store.getLeafId() ?? "", 50_000);
		add(user("after the compaction", 3));

		const breakdown = context.breakdown();
		expect(breakdown.anchored).toBe(false);
		expect(breakdown.usedTokens).toBe(NON_MESSAGE + tokens(...messages));
	});

	it("stops reading usage measured before an in-place rewrite, and reads the first usage after it", () => {
		const { messages, context, add } = harness();
		add(user("question", 1));
		add(assistant("answer", 2, 50_000));
		context.markHistoryRewritten();

		const afterRewrite = context.breakdown();
		expect(afterRewrite.anchored).toBe(false);
		expect(afterRewrite.usedTokens).toBe(NON_MESSAGE + tokens(...messages));

		add(assistant("answer over the rewritten history", 3, 30_000));
		expect(context.breakdown().usedTokens).toBe(30_000);
	});

	it("never reads below the local estimate of the stored conversation", () => {
		const { context, add } = harness();
		add(user("stored context ".repeat(4_000), 1));
		add(assistant("answer", 2, 10));

		const breakdown = context.breakdown();
		expect(breakdown.usedTokens).toBe(context.estimateStoredTokens());
		expect(breakdown.usedTokens).toBeGreaterThan(10);
	});

	it("anchors on the live context when the session has no branch", () => {
		const { messages, context } = harness();
		const tail = user("tail", 3);
		messages.push(user("question", 1), assistant("answer", 2, 50_000), tail);

		const breakdown = context.breakdown();
		expect(breakdown.anchored).toBe(true);
		expect(breakdown.usedTokens).toBe(50_000 + tokens(tail));
	});

	it("reports a percentage only against a finite, positive window", () => {
		const { context, add } = harness();
		add(user("question", 1));
		add(assistant("answer", 2, 50_000));
		expect(context.usage({ contextWindow: 200_000 })).toEqual({
			tokens: 50_000,
			contextWindow: 200_000,
			percent: 25,
		});
		expect(context.usage({ contextWindow: 0 }).percent).toBe(0);
		expect(context.usage({ contextWindow: Number.POSITIVE_INFINITY })).toEqual({
			tokens: 50_000,
			contextWindow: 0,
			percent: 0,
		});
	});
});

describe("the prompt snapshot of a run in flight", () => {
	it("stands in for the prompt until a response of this run reports usage", () => {
		const { state, context, add } = harness();
		add(user("question", 1));
		add(assistant("answer", 2, 50_000));
		const submitted = user("next question", 3);
		context.beginPrompt([submitted]);
		add(submitted);
		// The system prompt grew after submission: only the snapshot measured the old size.
		state.nonMessage = NON_MESSAGE + 500;

		expect(context.breakdown().usedTokens).toBe(50_000 + tokens(submitted) + 500);

		add(assistant("next answer", 4, 70_000));
		expect(context.breakdown().usedTokens).toBe(70_000);
	});

	it("counts a submitted message once and a message that arrived since in full", () => {
		const { context, add } = harness();
		add(user("question", 1));
		add(assistant("answer", 2, 50_000));
		const submitted = user("next question", 3);
		context.beginPrompt([submitted]);
		add(submitted);
		const steering = user("a steering message typed during the run", 4);
		add(steering);

		expect(context.breakdown().usedTokens).toBe(50_000 + tokens(submitted) + tokens(steering));
	});

	it("is re-measured over the current messages after a rewrite", () => {
		const { messages, context, add } = harness();
		add(user("question", 1));
		add(assistant("answer", 2, 50_000));
		const submitted = user("next question", 3);
		context.beginPrompt([submitted]);
		add(submitted);
		messages.splice(0, 2);

		context.rebaseAfterHistoryRewrite();
		expect(context.pending?.promptTokens).toBe(NON_MESSAGE + tokens(submitted));
		expect(context.pending?.cutoffCount).toBe(1);
		expect(context.breakdown().usedTokens).toBe(NON_MESSAGE + tokens(submitted));
	});

	it("changes the revision on every set and clear, and not on a rewrite with no run in flight", () => {
		const { context } = harness();
		const start = context.revision;
		context.rebaseAfterHistoryRewrite();
		expect(context.revision).toBe(start);
		expect(context.pending).toBeUndefined();

		context.beginPrompt([user("question", 1)]);
		expect(context.revision).toBe(start + 1);
		context.rebaseAfterHistoryRewrite();
		expect(context.revision).toBe(start + 2);
		context.endPrompt();
		expect(context.revision).toBe(start + 3);
		expect(context.pending).toBeUndefined();
	});

	it("records attribution at rich and ultra, and the compaction entry only at ultra", () => {
		const snapshotAt = (level: InstrumentationLevel) => {
			const { store, context, add } = harness(level);
			add(user("question", 1));
			const compactionId = store.appendCompaction("summary", undefined, store.getLeafId() ?? "", 1_000);
			context.beginPrompt([user("next question", 2)]);
			return { snapshot: context.pending, compactionId };
		};

		const basic = snapshotAt("basic").snapshot;
		expect(basic?.detail).toBe("none");
		expect(basic?.storedMessagesTokens).toBeUndefined();

		const rich = snapshotAt("rich").snapshot;
		expect(rich?.detail).toBe("rich");
		expect(rich?.tailTokens).toBe(tokens(user("next question", 2)));
		expect(rich?.compactionEntryId).toBeUndefined();

		const ultra = snapshotAt("ultra");
		expect(ultra.snapshot?.compactionEntryId).toBe(ultra.compactionId);
	});
});

describe("the resting usage", () => {
	it("takes the stamped non-message size in place of measuring and estimates the tail", () => {
		const { state, context, add } = harness();
		add(user("question", 1));
		add(stamped("answer", 2, 50_000, NON_MESSAGE - 300));
		const tail = user("a follow-up that has not been sent yet", 3);
		add(tail);

		const resting = context.restingUsage();

		expect(state.measured).toBe(0);
		expect(resting?.tokens).toBe(50_000 + tokens(tail));
		// The measurement sees the 300 tokens the non-message half grew by since the stamp.
		expect(context.usage().tokens).toBe(50_000 + 300 + tokens(tail));
	});

	it("never reads below the stored conversation, counted with the stamped size", () => {
		const { state, context, add } = harness();
		add(user("stored context ".repeat(4_000), 1));
		add(stamped("answer", 2, 10, NON_MESSAGE - 300));

		const resting = context.restingUsage();

		expect(state.measured).toBe(0);
		expect(resting?.tokens).toBe(context.estimateStoredTokens() - 300);
	});

	it("states nothing when the anchor stamped no size", () => {
		const { state, context, add } = harness();
		add(user("question", 1));
		add(assistant("answer", 2, 50_000));

		expect(context.restingUsage()).toBeUndefined();
		expect(state.measured).toBe(0);
	});

	it("states nothing when the only stamped response predates the latest compaction", () => {
		const { store, context, add } = harness();
		add(user("question", 1));
		add(stamped("answer", 2, 50_000, NON_MESSAGE));
		store.appendCompaction("summary", undefined, store.getLeafId() ?? "", 50_000);
		add(user("after the compaction", 3));

		expect(context.restingUsage()).toBeUndefined();
	});

	it("states nothing while a prompt is in flight", () => {
		const { context, add } = harness();
		add(user("question", 1));
		add(stamped("answer", 2, 50_000, NON_MESSAGE));
		const submitted = user("next question", 3);
		context.beginPrompt([submitted]);
		add(submitted);

		expect(context.restingUsage()).toBeUndefined();
		context.endPrompt();
		expect(context.restingUsage()?.tokens).toBe(50_000 + tokens(submitted));
	});
});
