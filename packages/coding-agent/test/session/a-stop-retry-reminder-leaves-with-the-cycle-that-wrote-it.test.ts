/**
 * WHY: two recovery cycles continue a turn the model ended early. The empty-stop cycle drops an
 * assistant turn with nothing in it and retries; the unexpected-stop cycle continues a reply the
 * classifier reads as announcing an action it never took. Each retry appends a developer reminder
 * ("Attempt #n/max") that describes the turn being retried. One collaborator, `StopRetries`, holds
 * both budgets, the reminders, and the per-prompt flag that accepts a terminal empty stop, and the
 * defects at that boundary share one shape: state a cycle wrote outlives the cycle. A reminder left
 * in context after the cycle gives up tells every later turn to finish a turn that no longer exists;
 * a budget left spent makes the next cycle cap on its first retry and report attempts it never made;
 * a timer left armed aborts a classifier call that already answered; an accepted terminal empty stop
 * left in the log replays on resume, and the custom prompt that produced it replays with it.
 *
 * The class this closes is cycle state that survives the end of its cycle, in either cycle. The
 * cycle table is keyed by every cycle the collaborator runs, so a cycle added to the table without
 * its trigger and reminder fails to type-check, and every contract below runs for each one.
 * Reminders are removed by identity: a developer message the cycle did not write survives even when
 * its bytes equal a reminder's.
 *
 * What it does not catch: whether `AgentSession` calls `resetForPrompt` at every prompt start and
 * `onEmptyStop`/`onUnexpectedStop` at every settle (the session suites `agent-session-empty-stop-guard`,
 * `agent-session-unexpected-stop-guard` and `agent-session-yield-empty-stop-suppression` drive both
 * through a real `AgentSession`), and the classifier's own verdicts, which
 * `unexpected-stop-classifier` owns.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import type { ScheduledAgentContinueOptions } from "@veyyon/coding-agent/session/agent-session-types";
import { createCustomMessage } from "@veyyon/coding-agent/session/messages";
import {
	EMPTY_STOP_MAX_RETRIES,
	StopRetries,
	type StopRetriesAgent,
	UNEXPECTED_STOP_MAX_RETRIES,
	UNEXPECTED_STOP_TIMEOUT_MS,
} from "@veyyon/coding-agent/session/runtime/stop-retries";
import { SessionManager } from "@veyyon/kernel/session/session-manager";

/** An agent slice that holds the live context the cycles edit. */
class ContextAgent implements StopRetriesAgent {
	readonly state: { messages: AgentMessage[] } = { messages: [] };
	appendMessage(message: AgentMessage): void {
		this.state.messages.push(message);
	}
	replaceMessages(messages: AgentMessage[]): void {
		this.state.messages = messages;
	}
	drop(message: AgentMessage): void {
		this.state.messages = this.state.messages.filter(kept => kept !== message);
	}
}

type Classify = (text: string, signal: AbortSignal) => Promise<boolean | undefined>;

interface Harness {
	readonly retries: StopRetries;
	readonly agent: ContextAgent;
	readonly store: SessionManager;
	readonly scheduled: ScheduledAgentContinueOptions[];
	readonly discarded: AssistantMessage[];
	readonly removed: { message: AssistantMessage; reason: string }[];
	readonly endedWaits: string[];
	readonly caps: { attempts: number; finalError: string }[];
	readonly classified: string[];
	classify: Classify;
	detection: boolean;
	generation: number;
}

function harness(): Harness {
	const agent = new ContextAgent();
	const store = SessionManager.inMemory("/repo");
	const h: Omit<Harness, "retries"> = {
		agent,
		store,
		scheduled: [],
		discarded: [],
		removed: [],
		endedWaits: [],
		caps: [],
		classified: [],
		classify: async () => true,
		detection: true,
		generation: 7,
	};
	const retries = new StopRetries({
		agent,
		sessionStore: store,
		unexpectedStopDetection: () => h.detection,
		classifyUnexpectedStop: (text, signal) => {
			h.classified.push(text);
			return h.classify(text, signal);
		},
		promptGeneration: () => h.generation,
		scheduleAgentContinue: options => {
			h.scheduled.push(options);
		},
		discardAssistantTurn: message => {
			h.discarded.push(message);
			agent.drop(message);
		},
		removeAssistantFromActiveContext: (message, reason) => {
			h.removed.push({ message, reason });
			agent.drop(message);
		},
		endAnnouncedContinuationWait: async finalError => {
			h.endedWaits.push(finalError);
		},
		failAtEmptyStopCap: async (attempts, finalError) => {
			h.caps.push({ attempts, finalError });
		},
	});
	return Object.assign(h, { retries });
}

let clock = 1_000;
function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: clock++,
	};
}

const ANNOUNCED = "I'll run the test suite now.";
const NOT_AWAITING = { awaitingUserAnswer: false };

type Cycle = "empty" | "unexpected";

interface CycleSpec {
	readonly max: number;
	/** The reminder's opening line, which states what the cycle retries. */
	readonly headline: string;
	/** Land one turn this cycle retries, the way the agent lands it, and settle it. */
	trigger(h: Harness): Promise<boolean>;
	/** Land one turn that ends the cycle without a retry. */
	settleWithoutRetry(h: Harness): Promise<boolean>;
}

const CYCLES: Record<Cycle, CycleSpec> = {
	empty: {
		max: EMPTY_STOP_MAX_RETRIES,
		headline: "You stopped without completing the task. Continue.",
		async trigger(h) {
			const message = assistant([{ type: "thinking", thinking: "..." }]);
			h.agent.appendMessage(message);
			return h.retries.onEmptyStop(message);
		},
		async settleWithoutRetry(h) {
			const message = assistant([{ type: "text", text: "Done." }]);
			h.agent.appendMessage(message);
			return h.retries.onEmptyStop(message);
		},
	},
	unexpected: {
		max: UNEXPECTED_STOP_MAX_RETRIES,
		headline: "You said you would continue with a tool call or action but stopped. Continue now.",
		async trigger(h) {
			h.classify = async () => true;
			const message = assistant([{ type: "text", text: ANNOUNCED }]);
			h.agent.appendMessage(message);
			return h.retries.onUnexpectedStop(message, NOT_AWAITING);
		},
		async settleWithoutRetry(h) {
			h.classify = async () => false;
			const message = assistant([{ type: "text", text: "All tests pass." }]);
			h.agent.appendMessage(message);
			return h.retries.onUnexpectedStop(message, NOT_AWAITING);
		},
	},
};

function textOf(message: AgentMessage): string {
	if (!("content" in message) || !Array.isArray(message.content)) return "";
	return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

/** The developer messages in the live context that carry this cycle's reminder text. */
function reminders(h: Harness, spec: CycleSpec): AgentMessage[] {
	return h.agent.state.messages.filter(
		message => message.role === "developer" && textOf(message).includes(spec.headline),
	);
}

function attemptLines(h: Harness, spec: CycleSpec): string[] {
	return reminders(h, spec).map(message => /Attempt #\d+\/\d+/.exec(textOf(message))?.[0] ?? "");
}

/** A developer message the cycle did not write, byte-identical to a reminder it did. */
function foreignCopyOf(message: AgentMessage): AgentMessage {
	return { ...message, timestamp: 0 } as AgentMessage;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("a stop-retry cycle keeps no state past its end", () => {
	for (const [cycle, spec] of Object.entries(CYCLES) as [Cycle, CycleSpec][]) {
		describe(`${cycle} stop`, () => {
			it("retries up to its cap, each retry scheduled for the prompt that ran it", async () => {
				const h = harness();
				for (let attempt = 1; attempt <= spec.max; attempt++) {
					expect(await spec.trigger(h)).toBe(true);
				}
				expect(attemptLines(h, spec)).toEqual(
					Array.from({ length: spec.max }, (_, index) => `Attempt #${index + 1}/${spec.max}`),
				);
				expect(h.scheduled).toEqual(Array.from({ length: spec.max }, () => ({ generation: 7 })));
			});

			it("takes every reminder it wrote out of the context when it gives up, and only those", async () => {
				const h = harness();
				for (let attempt = 1; attempt <= spec.max; attempt++) await spec.trigger(h);
				const foreign = foreignCopyOf(reminders(h, spec)[0]);
				h.agent.appendMessage(foreign);

				expect(await spec.trigger(h)).toBe(false);

				expect(reminders(h, spec)).toStrictEqual([foreign]);
				expect(reminders(h, spec)[0]).toBe(foreign);
				expect(h.scheduled).toHaveLength(spec.max);
			});

			it("hands the cycle after the cap a whole budget", async () => {
				const h = harness();
				for (let attempt = 0; attempt <= spec.max; attempt++) await spec.trigger(h);

				expect(await spec.trigger(h)).toBe(true);

				expect(attemptLines(h, spec)).toEqual([`Attempt #1/${spec.max}`]);
			});

			it("restarts the budget when a turn settles without a retry", async () => {
				const h = harness();
				await spec.trigger(h);
				await spec.trigger(h);

				expect(await spec.settleWithoutRetry(h)).toBe(false);
				expect(await spec.trigger(h)).toBe(true);

				expect(attemptLines(h, spec).at(-1)).toBe(`Attempt #1/${spec.max}`);
			});

			it("starts the next prompt with no reminder in context and a whole budget", async () => {
				const h = harness();
				await spec.trigger(h);
				await spec.trigger(h);
				const foreign = foreignCopyOf(reminders(h, spec)[0]);
				h.agent.appendMessage(foreign);

				h.retries.resetForPrompt();

				expect(reminders(h, spec)).toStrictEqual([foreign]);
				expect(reminders(h, spec)[0]).toBe(foreign);
				await spec.trigger(h);
				expect(attemptLines(h, spec)).toEqual([`Attempt #1/${spec.max}`, `Attempt #1/${spec.max}`]);
			});
		});
	}

	it("clears both cycles' reminders at a prompt start, whichever cycle wrote them", async () => {
		const h = harness();
		await CYCLES.empty.trigger(h);
		await CYCLES.unexpected.trigger(h);

		h.retries.resetForPrompt();

		expect(h.agent.state.messages.filter(message => message.role === "developer")).toEqual([]);
	});
});

describe("the empty-stop cycle", () => {
	it("reports the cap with the attempts it made and the model behind the turn", async () => {
		const h = harness();
		for (let attempt = 0; attempt <= EMPTY_STOP_MAX_RETRIES; attempt++) await CYCLES.empty.trigger(h);

		expect(h.caps).toEqual([
			{
				attempts: EMPTY_STOP_MAX_RETRIES,
				finalError: "Assistant returned empty stop after retry cap (openai/test-model)",
			},
		]);
		expect(h.agent.state.messages.filter(message => message.role === "assistant")).toEqual([]);
	});

	it("ends a prompt that accepts a terminal empty stop, pruning the stop and the custom prompt behind it", async () => {
		const h = harness();
		const user: AgentMessage = { role: "user", content: [{ type: "text", text: "start" }], timestamp: clock++ };
		const userId = h.store.appendMessage(user);
		const capture = createCustomMessage("capture", "Record what you learned.", false, undefined, "t");
		const captureId = h.store.appendCustomMessageEntry("capture", "Record what you learned.", false);
		const stop = assistant([]);
		const stopId = h.store.appendMessage(stop);
		h.agent.replaceMessages([user, capture, stop]);
		h.retries.acceptTerminalEmptyStop = true;

		expect(await h.retries.onEmptyStop(stop)).toBe(false);

		expect(h.scheduled).toEqual([]);
		expect(h.endedWaits).toEqual(["Continued turn returned an empty completion"]);
		expect(h.removed).toEqual([{ message: stop, reason: "accepted-terminal-empty-stop" }]);
		expect(h.agent.state.messages).toEqual([user]);
		const branch = h.store.getBranch();
		const ids = branch.map(entry => entry.id);
		expect(ids).not.toContain(captureId);
		expect(ids).not.toContain(stopId);
		const marker = branch.at(-1);
		expect(marker?.type === "custom" ? marker.customType : marker?.type).toBe("accepted-terminal-empty-stop");
		expect(marker?.parentId).toBe(userId);
		expect(h.retries.acceptTerminalEmptyStop).toBe(false);
	});

	it("keeps the prompt when the accepted stop answered the user, pruning only the stop", async () => {
		const h = harness();
		const user: AgentMessage = { role: "user", content: [{ type: "text", text: "start" }], timestamp: clock++ };
		const userId = h.store.appendMessage(user);
		const stop = assistant([]);
		h.store.appendMessage(stop);
		h.agent.replaceMessages([user, stop]);
		h.retries.acceptTerminalEmptyStop = true;

		await h.retries.onEmptyStop(stop);

		expect(h.agent.state.messages).toEqual([user]);
		expect(h.store.getBranch().at(-1)?.parentId).toBe(userId);
	});

	it("roots the marker when the accepted stop was the first entry", async () => {
		const h = harness();
		const stop = assistant([]);
		h.store.appendMessage(stop);
		h.agent.replaceMessages([stop]);
		h.retries.acceptTerminalEmptyStop = true;

		await h.retries.onEmptyStop(stop);

		const branch = h.store.getBranch();
		expect(branch.map(entry => entry.type)).toEqual(["custom"]);
		expect(branch[0]?.parentId).toBeNull();
	});

	it("accepts one terminal empty stop per prompt, then retries the next", async () => {
		const h = harness();
		h.retries.acceptTerminalEmptyStop = true;
		const first = assistant([]);
		h.agent.appendMessage(first);
		await h.retries.onEmptyStop(first);

		expect(await CYCLES.empty.trigger(h)).toBe(true);
	});

	it("retries an empty tool-use stop even when the prompt accepts a terminal empty stop", async () => {
		const h = harness();
		h.retries.acceptTerminalEmptyStop = true;
		const stop = assistant([], "toolUse");
		h.agent.appendMessage(stop);

		expect(await h.retries.onEmptyStop(stop)).toBe(true);

		expect(h.endedWaits).toEqual([]);
		expect(h.retries.acceptTerminalEmptyStop).toBe(true);
	});
});

describe("the unexpected-stop cycle", () => {
	it("asks no classifier and restarts the budget when the reply waits on the user", async () => {
		const h = harness();
		await CYCLES.unexpected.trigger(h);
		const asked = h.classified.length;
		const question = assistant([{ type: "text", text: "Should I run the migration next?" }]);
		h.agent.appendMessage(question);

		expect(await h.retries.onUnexpectedStop(question, { awaitingUserAnswer: true })).toBe(false);
		expect(h.classified).toHaveLength(asked);

		await CYCLES.unexpected.trigger(h);
		expect(attemptLines(h, CYCLES.unexpected).at(-1)).toBe(`Attempt #1/${UNEXPECTED_STOP_MAX_RETRIES}`);
	});

	it("asks no classifier when detection is off", async () => {
		const h = harness();
		h.detection = false;
		const message = assistant([{ type: "text", text: ANNOUNCED }]);

		expect(await h.retries.onUnexpectedStop(message, NOT_AWAITING)).toBe(false);
		expect(h.classified).toEqual([]);
	});

	it("aborts a classifier that has not answered by the timeout and continues nothing", async () => {
		vi.useFakeTimers();
		const h = harness();
		let seen: AbortSignal | undefined;
		const message = assistant([{ type: "text", text: ANNOUNCED }]);
		h.classify = (_text, signal) => {
			seen = signal;
			const { promise, resolve } = Promise.withResolvers<boolean | undefined>();
			signal.addEventListener("abort", () => resolve(undefined), { once: true });
			return promise;
		};

		const settled = h.retries.onUnexpectedStop(message, NOT_AWAITING);
		vi.advanceTimersByTime(UNEXPECTED_STOP_TIMEOUT_MS - 1);
		expect(seen?.aborted).toBe(false);
		vi.advanceTimersByTime(1);

		expect(await settled).toBe(false);
		expect(seen?.aborted).toBe(true);
		expect(h.scheduled).toEqual([]);
	});

	it("disarms the timeout once the classifier answers", async () => {
		vi.useFakeTimers();
		const h = harness();
		let seen: AbortSignal | undefined;
		h.classify = async (_text, signal) => {
			seen = signal;
			return true;
		};
		const message = assistant([{ type: "text", text: ANNOUNCED }]);

		expect(await h.retries.onUnexpectedStop(message, NOT_AWAITING)).toBe(true);
		vi.advanceTimersByTime(UNEXPECTED_STOP_TIMEOUT_MS * 2);

		expect(seen?.aborted).toBe(false);
	});
});
