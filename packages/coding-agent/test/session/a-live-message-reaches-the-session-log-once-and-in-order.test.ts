/**
 * WHY: a live message reaches the session log through one collaborator, `MessagePersistence`, and
 * three defects share its boundary: a message written out of order (a later `message_end` whose
 * display finished first lands ahead of an earlier one), a message written twice (the branch
 * index goes stale or misses an entry that is already there), and a message never written or
 * written when it must not be (a released or failed write stalls the queue, a refusal or a replayed
 * rewind result reaches the log). Each case drives the real collaborator against a real in-memory
 * `SessionManager` and reads the branch it wrote.
 *
 * The class this closes is a live message that reaches the log out of order, more than once, or
 * against the rule that filters it, at the boundary every write passes through.
 *
 * The branch index is a sorted array of message timestamps that only filters: a lookup it reports
 * absent never reads the branch. So the cases that would turn its miss into a second write are
 * pinned here: a timestamp appended out of order, appends past the room the index left, two
 * timestamps that print alike without being the same number, and a message with no timestamp. A
 * fresh process measures the bytes it holds per logged message (`fixtures/persistence-index-heap.ts`).
 *
 * What it does not catch: which `AgentSession` event routes a message here (the session suites
 * `agent-session-persisted-keys-cache` and `session/persistence-fault-recovery` pin that), and the
 * assistant study telemetry filter, whose level table `gran-5-turn-metrics-persistence` and
 * `gran-6-request-params-persistence` pin.
 */
import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@veyyon/ai";
import type { InstrumentationLevel } from "@veyyon/ai/instrumentation";
import type { PendingContextSnapshot } from "@veyyon/coding-agent/session/agent-session-types";
import { MessagePersistence } from "@veyyon/coding-agent/session/runtime/message-persistence";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import type { PersistenceIndexHeap } from "../fixtures/persistence-index-heap";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

const run = promisify(execFile);
const INDEX_HEAP_FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "persistence-index-heap.ts");
/** Messages on the branch the index heap is measured over. */
const INDEXED_MESSAGES = 5_000;

/** Fails the test instead of hanging it when a write or a waiter never settles. */
async function within<T>(promise: Promise<T>, label: string, ms = 1_000): Promise<T> {
	const { promise: timeout, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** Lets every already-queued continuation run. */
async function drain(): Promise<void> {
	for (let turn = 0; turn < 10; turn++) await Promise.resolve();
}

interface HarnessOptions {
	level?: InstrumentationLevel;
	pending?: PendingContextSnapshot;
	rewound?: string[];
}

function harness(options: HarnessOptions = {}) {
	const store = SessionManager.inMemory();
	const rewound = new Set(options.rewound ?? []);
	const ttsrDetails: unknown[] = [];
	const persistence = new MessagePersistence({
		sessionStore: store,
		instrumentationLevel: () => options.level ?? "off",
		pendingContextSnapshot: () => options.pending,
		nonMessageTokens: () => 100,
		consumeRewoundResult: toolCallId => rewound.delete(toolCallId),
		onTtsrInjectionPersisted: details => ttsrDetails.push(details),
	});
	return { store, persistence, rewound, ttsrDetails };
}

function logged(store: SessionManager): AgentMessage[] {
	return store.getBranch().flatMap(entry => (entry.type === "message" ? [entry.message] : []));
}

function labels(store: SessionManager): string[] {
	return logged(store).map(message => {
		if (message.role === "toolResult") return `tool:${message.toolCallId}`;
		if (message.role === "user" || message.role === "assistant") {
			const content = message.content;
			if (typeof content === "string") return `${message.role}:${content}`;
			const text = content.find(block => block.type === "text");
			return `${message.role}:${text?.type === "text" ? text.text : ""}`;
		}
		return message.role;
	});
}

function user(text: string, timestamp: number): UserMessage {
	return { role: "user", content: text, timestamp };
}

function assistant(text: string, timestamp: number, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 400,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 420,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
		...overrides,
	};
}

function toolResult(toolCallId: string, timestamp: number, toolName = "read"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: `result ${toolCallId}` }],
		isError: false,
		timestamp,
	};
}

function pendingSnapshot(detail: PendingContextSnapshot["detail"]): PendingContextSnapshot {
	return { promptTokens: 400, nonMessageTokens: 100, cutoffCount: 0, submitted: new Set(), detail };
}

describe("the message_end write queue", () => {
	it("writes messages in the order their message_end arrived, whichever display finishes first", async () => {
		const { store, persistence } = harness();
		const first = user("first", 1);
		const second = user("second", 2);
		const firstSlot = persistence.openSlot(first);
		const secondSlot = persistence.openSlot(second);

		const secondWrite = persistence.persistMessageEnd(second, secondSlot, undefined);
		await drain();
		expect(labels(store)).toEqual([]);

		await within(
			Promise.all([persistence.persistMessageEnd(first, firstSlot, undefined), secondWrite]),
			"the two writes",
		);
		expect(labels(store)).toEqual(["user:first", "user:second"]);
	});

	it("lets the next write and every waiter through when a slot is released unwritten", async () => {
		const { store, persistence } = harness();
		const dropped = user("dropped", 1);
		const next = user("next", 2);
		const droppedSlot = persistence.openSlot(dropped);
		const nextSlot = persistence.openSlot(next);
		const waiter = persistence.waitFor(dropped);

		droppedSlot?.release();
		await within(persistence.persistMessageEnd(next, nextSlot, undefined), "the write after a release");
		await within(waiter, "the waiter on a released slot");
		expect(labels(store)).toEqual(["user:next"]);
	});

	it("surfaces a failed write to its caller and still writes the message behind it", async () => {
		const { store, persistence } = harness();
		const failing = user("failing", 1);
		const next = user("next", 2);
		const failingSlot = persistence.openSlot(failing);
		const nextSlot = persistence.openSlot(next);

		const failure = failingSlot?.persist(() => {
			throw new Error("disk full");
		});
		await expect(within(failure ?? Promise.resolve(), "the failing write")).rejects.toThrow("disk full");
		await within(persistence.persistMessageEnd(next, nextSlot, undefined), "the write after a failure");
		await within(persistence.waitFor(failing), "the waiter on a failed slot");
		expect(labels(store)).toEqual(["user:next"]);
	});

	it("resolves a waiter only once the message's entry exists", async () => {
		const { store, persistence } = harness();
		const message = user("pending", 1);
		const slot = persistence.openSlot(message);
		let entriesWhenResolved: number | undefined;
		const waiter = persistence.waitFor(message).then(() => {
			entriesWhenResolved = logged(store).length;
		});

		await drain();
		expect(entriesWhenResolved).toBeUndefined();
		await persistence.persistMessageEnd(message, slot, undefined);
		await within(waiter, "the waiter");
		expect(entriesWhenResolved).toBe(1);
	});

	it("resolves a waiter at once for a message with no queued write", async () => {
		const { persistence } = harness();
		await within(persistence.waitFor(user("never queued", 1)), "the waiter on an unqueued message", 50);
	});

	it("writes custom messages as custom entries and reports a TTSR injection once written", async () => {
		const { store, persistence, ttsrDetails } = harness();
		const injection: AgentMessage = {
			role: "custom",
			customType: "ttsr-injection",
			content: "rule text",
			display: false,
			details: { rules: ["no-console"] },
			timestamp: 1,
		};
		await persistence.persistMessageEnd(injection, persistence.openSlot(injection), undefined);
		const customEntries = store.getBranch().filter(entry => entry.type === "custom_message");
		expect(customEntries.map(entry => (entry.type === "custom_message" ? entry.customType : ""))).toEqual([
			"ttsr-injection",
		]);
		expect(ttsrDetails).toEqual([{ rules: ["no-console"] }]);
	});
});

describe("a message offered for the log", () => {
	it("is written once however many times it is offered", () => {
		const { store, persistence } = harness();
		const message = user("once", 1);
		persistence.persistIfMissing(message);
		persistence.persistIfMissing(message);
		persistence.persistIfMissing({ ...message });
		expect(labels(store)).toEqual(["user:once"]);
	});

	it("is a second message when it shares a key with a logged one but not its content", () => {
		const { store, persistence } = harness();
		persistence.persistIfMissing(user("left", 1));
		persistence.persistIfMissing(user("right", 1));
		expect(labels(store)).toEqual(["user:left", "user:right"]);
	});

	it("is found when it reached the branch by a write the key index did not see", () => {
		const { store, persistence } = harness();
		persistence.persistIfMissing(user("indexed", 1));
		const restored = assistant("restored", 2);
		store.appendMessage(restored);
		persistence.persistIfMissing(restored);
		expect(labels(store)).toEqual(["user:indexed", "assistant:restored"]);
	});

	it("is written again after a rewind abandoned the branch that held it", () => {
		const { store, persistence } = harness();
		const kept = user("kept", 1);
		const abandoned = user("abandoned", 2);
		persistence.persistIfMissing(kept);
		persistence.persistIfMissing(abandoned);
		const keptEntry = store.getBranch().find(entry => entry.type === "message");
		store.branch(keptEntry?.id ?? "");
		persistence.persistIfMissing(abandoned);
		expect(labels(store)).toEqual(["user:kept", "user:abandoned"]);
		expect(store.getBranch().filter(entry => entry.type === "message")).toHaveLength(2);
	});

	it("never reaches the log as a classifier refusal or an empty error turn, but does as an error that streamed text", () => {
		const { store, persistence } = harness();
		persistence.persistIfMissing(
			assistant("I cannot help with that", 1, { stopReason: "error", stopDetails: { type: "refusal" } }),
		);
		persistence.persistIfMissing(
			assistant("flagged partial", 2, { stopReason: "error", stopDetails: { type: "sensitive" } }),
		);
		persistence.persistIfMissing(assistant("", 3, { stopReason: "error" }));
		persistence.persistIfMissing(assistant("partial answer", 4, { stopReason: "error" }));
		expect(labels(store)).toEqual(["assistant:partial answer"]);
	});

	it("skips a rewind result whose rewind already rewrote the branch, and only that one", () => {
		const { store, persistence, rewound } = harness({ rewound: ["call-1"] });
		persistence.persistIfMissing(toolResult("call-1", 1, "read"));
		expect(rewound.has("call-1")).toBe(true);
		persistence.persistIfMissing(toolResult("call-1", 2, "rewind"));
		persistence.persistIfMissing(toolResult("call-2", 3, "rewind"));
		expect(labels(store)).toEqual(["tool:call-1", "tool:call-2"]);
		expect(rewound.size).toBe(0);
	});

	it("keeps tool metrics only at a level that allows them, and never edits the live message", () => {
		const metrics = { level: "basic" as const, startedAt: 10, endedAt: 12, durationMs: 2, status: "ok" as const };
		const off = harness({ level: "off" });
		const liveOff = { ...toolResult("call-off", 1), metrics };
		off.persistence.persistIfMissing(liveOff);
		const loggedOff = logged(off.store)[0];
		expect(loggedOff?.role === "toolResult" ? loggedOff.metrics : "wrong role").toBeUndefined();
		expect(liveOff.metrics).toBe(metrics);

		const basic = harness({ level: "basic" });
		basic.persistence.persistIfMissing({ ...toolResult("call-basic", 1), metrics });
		const loggedBasic = logged(basic.store)[0];
		expect(loggedBasic?.role === "toolResult" ? loggedBasic.metrics?.durationMs : undefined).toBe(2);
	});
});

describe("the branch index a lookup reads", () => {
	it("finds a message an append placed before, between and after the timestamps it holds", () => {
		const { store, persistence } = harness();
		const offered = [user("a", 500), assistant("b", 100), toolResult("c", 900), user("d", 300), toolResult("e", 300)];
		for (const message of offered) persistence.persistIfMissing(message);
		for (const message of offered) persistence.persistIfMissing({ ...message });
		persistence.persistIfMissing(user("f", 300));
		expect(labels(store)).toEqual(["user:a", "assistant:b", "tool:c", "user:d", "tool:e", "user:f"]);
	});

	it("finds every message once appends outgrow the room the index left", () => {
		const { store, persistence } = harness();
		const offered = Array.from({ length: 300 }, (_, index) => user(`m${index}`, 10_000 - index * 7));
		for (const message of offered) persistence.persistIfMissing(message);
		for (const message of offered) persistence.persistIfMissing({ ...message });
		expect(labels(store)).toEqual(offered.map((_, index) => `user:m${index}`));
	});

	it("finds every message of a branch logged out of timestamp order before the index was built", () => {
		const { store, persistence } = harness();
		const loggedAt = [900, 100, 500, 300, 700, 200];
		for (const [index, at] of loggedAt.entries()) store.appendMessage(user(`m${index}`, at));
		for (const [index, at] of loggedAt.entries()) persistence.persistIfMissing(user(`m${index}`, at));
		expect(labels(store)).toEqual(loggedAt.map((_, index) => `user:m${index}`));
	});

	for (const [name, loggedAt, offeredAt] of [
		["negative zero against zero", -0, 0],
		["a string timestamp from a hand-edited log against its number", "1700" as unknown as number, 1700],
		["a number against the string timestamp a hand-edited log offers", 1700, "1700" as unknown as number],
	] as const) {
		it(`finds a message the store logged whose timestamp prints like the offered one: ${name}`, () => {
			const { store, persistence } = harness();
			persistence.persistIfMissing(user("indexed", 1));
			store.appendMessage(user("same", loggedAt));
			persistence.persistIfMissing(user("same", offeredAt));
			expect(labels(store)).toEqual(["user:indexed", "user:same"]);
		});

		it(`finds a message it logged itself whose timestamp prints like the offered one: ${name}`, () => {
			const { store, persistence } = harness();
			persistence.persistIfMissing(user("indexed", 1));
			persistence.persistIfMissing(user("same", loggedAt));
			persistence.persistIfMissing(user("same", offeredAt));
			expect(labels(store)).toEqual(["user:indexed", "user:same"]);
		});
	}

	it("finds a logged message that has no timestamp", () => {
		const { store, persistence } = harness();
		const untimed = { role: "user", content: "untimed" } as unknown as UserMessage;
		persistence.persistIfMissing(user("indexed", 1));
		persistence.persistIfMissing(untimed);
		persistence.persistIfMissing({ ...untimed });
		expect(labels(store)).toEqual(["user:indexed", "user:untimed"]);
	});

	it("holds a few bytes a logged message, not a key string each", async () => {
		const { env, cleanup } = hermeticSpawnEnv();
		let heap: PersistenceIndexHeap;
		try {
			const { stdout, stderr } = await run(process.execPath, [INDEX_HEAP_FIXTURE, String(INDEXED_MESSAGES)], {
				// A file run earlier may leave the runner in a deleted directory, which the child would inherit.
				cwd: import.meta.dirname,
				env,
				timeout: 25_000,
				killSignal: "SIGKILL",
			});
			expect(stderr).toBe("");
			heap = JSON.parse(stdout) as PersistenceIndexHeap;
		} finally {
			cleanup();
		}
		expect(heap.messages).toBe(INDEXED_MESSAGES);
		// A sorted array of numbers measured 25 bytes a message; a set of key strings, 242.
		expect(heap.retained).toBeLessThan(INDEXED_MESSAGES * 64);
	}, 30_000);
});

describe("the context snapshot a logged assistant turn carries", () => {
	function stampedSnapshot(options: HarnessOptions, message = assistant("answer", 5)) {
		const { store, persistence } = harness(options);
		store.appendMessage(user("before compaction", 1));
		const firstKept = store.getLeafId() ?? "";
		store.appendCompaction("summary", undefined, firstKept, 1000);
		persistence.persistIfMissing(message);
		const loggedMessage = logged(store).at(-1);
		return {
			snapshot: loggedMessage?.role === "assistant" ? loggedMessage.contextSnapshot : undefined,
			live: message,
		};
	}

	it("uses the lower of the run's level and the current level", () => {
		const raisedMidRun = stampedSnapshot({ level: "ultra", pending: pendingSnapshot("rich") }).snapshot;
		expect(raisedMidRun?.storedMessagesTokens).toBe(300);
		expect(raisedMidRun?.compactionEntryId).toBeUndefined();

		const ultraThroughout = stampedSnapshot({ level: "ultra", pending: pendingSnapshot("ultra") }).snapshot;
		expect(ultraThroughout?.compactionEntryId).toBeString();

		const loweredMidRun = stampedSnapshot({ level: "basic", pending: pendingSnapshot("ultra") }).snapshot;
		expect(loweredMidRun).toEqual({ promptTokens: 400, nonMessageTokens: 100 });
	});

	it("is absent on an aborted turn and never written onto the live message", () => {
		const aborted = stampedSnapshot(
			{ level: "rich", pending: pendingSnapshot("rich") },
			assistant("partial", 5, { stopReason: "aborted" }),
		);
		expect(aborted.snapshot).toBeUndefined();

		const completed = stampedSnapshot({ level: "rich", pending: pendingSnapshot("rich") });
		expect(completed.snapshot?.promptTokens).toBe(400);
		expect(completed.live.contextSnapshot).toBeUndefined();
	});
});

describe("a finished turn before mid-run compaction", () => {
	it("is written in turn order when none of it is on the branch", async () => {
		const { store, persistence } = harness();
		const message = assistant("calling tools", 1);
		const results = [toolResult("call-1", 2), toolResult("call-2", 3)];
		expect(
			await persistence.persistTurnForMidRunCompaction({ message, toolResults: results, willContinue: true }),
		).toBe(true);
		expect(labels(store)).toEqual(["assistant:calling tools", "tool:call-1", "tool:call-2"]);
	});

	it("is refused, and nothing written, when a later message is on the branch and an earlier one is not", async () => {
		const { store, persistence } = harness();
		const message = assistant("calling tools", 1);
		const results = [toolResult("call-1", 2), toolResult("call-2", 3)];
		persistence.persistIfMissing(results[1]);
		expect(
			await persistence.persistTurnForMidRunCompaction({ message, toolResults: results, willContinue: true }),
		).toBe(false);
		expect(labels(store)).toEqual(["tool:call-2"]);
	});

	it("waits for the turn's queued writes before it plans", async () => {
		const { store, persistence } = harness();
		const message = assistant("calling tools", 1);
		const results = [toolResult("call-1", 2)];
		const slot = persistence.openSlot(message);
		let planned = false;
		const planning = persistence
			.persistTurnForMidRunCompaction({ message, toolResults: results, willContinue: true })
			.then(result => {
				planned = true;
				return result;
			});

		await drain();
		expect(planned).toBe(false);
		await persistence.persistMessageEnd(message, slot, undefined);
		expect(await within(planning, "the mid-run plan")).toBe(true);
		expect(labels(store)).toEqual(["assistant:calling tools", "tool:call-1"]);
	});
});

describe("the branch around a logged assistant turn", () => {
	it("reports whether the latest compaction came after the turn", () => {
		const { store, persistence } = harness();
		const beforeCompaction = assistant("before", 1);
		persistence.persistIfMissing(beforeCompaction);
		store.appendCompaction("summary", undefined, store.getLeafId() ?? "", 1000);
		const afterCompaction = assistant("after", 2);
		persistence.persistIfMissing(afterCompaction);

		expect(persistence.assistantPredatesLatestCompaction(beforeCompaction)).toBe(true);
		expect(persistence.assistantPredatesLatestCompaction(afterCompaction)).toBe(false);
		expect(persistence.assistantPredatesLatestCompaction(assistant("never logged", 3))).toBe(false);
	});

	it("drops the turn by moving the leaf to its parent, and to the root when it has none", () => {
		const { store, persistence } = harness();
		const prompt = user("question", 1);
		const reply = assistant("reply", 2);
		persistence.persistIfMissing(prompt);
		const promptLeaf = store.getLeafId();
		persistence.persistIfMissing(reply);

		persistence.dropAssistantFromBranch(assistant("never logged", 3));
		expect(labels(store)).toEqual(["user:question", "assistant:reply"]);

		persistence.dropAssistantFromBranch(reply);
		expect(store.getLeafId()).toBe(promptLeaf);
		expect(labels(store)).toEqual(["user:question"]);

		const root = harness();
		const firstReply = assistant("first reply", 1);
		root.persistence.persistIfMissing(firstReply);
		root.persistence.dropAssistantFromBranch(firstReply);
		expect(root.store.getLeafId()).toBeNull();
		expect(labels(root.store)).toEqual([]);
	});
});
