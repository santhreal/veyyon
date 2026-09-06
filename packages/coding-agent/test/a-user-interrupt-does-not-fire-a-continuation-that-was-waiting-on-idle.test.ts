// WHY: a hidden continuation (`sendCustomMessage` with `deliverAs: "nextTurn"`
// and `triggerTurn: true`) sent from an `agent_end` handler reaches
// `#promptWithMessage` while the turn it reacts to is still unwinding, so its
// first `agent.prompt` is refused as busy and it waits for the agent to go idle.
// A user interrupt is one way the agent goes idle. The wait woke on that settle
// and prompted the continuation into the session the user had just stopped:
// the autoresearch stall nudge restarted the loop three milliseconds after
// Escape ended it.
//
// Class closed: any agent-initiated continuation that was waiting on idle when
// `abort()` bumped the prompt generation. The suite drives the real
// `AgentSession` and asserts on the provider calls it makes, so a retry that
// re-prompts after the wait, whatever queued it, turns the suite red.
//
// Not caught: a continuation that reaches `agent.prompt` the first time without
// being refused (the agent already idle) races the interrupt on its own, and a
// continuation queued AFTER the interrupt settled is a new cycle by design.
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, AgentBusyError, type AgentMessage, type AgentPromptOptions } from "@veyyon/agent-core";
import type { Message } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { getBundledModel } from "@veyyon/catalog/models";
import { AsyncJobManager } from "@veyyon/coding-agent/async";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@veyyon/coding-agent/session/messages";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const CONTINUATION_TYPE = "autoresearch-stall-nudge";
const CONTINUATION_TEXT = "The loop advanced by nothing. Continue the experiment.";

const originalSchedulerWait = scheduler.wait.bind(scheduler);

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await originalSchedulerWait(1);
	}
	throw new Error("Timed out waiting for condition");
}

function messageText(message: AgentMessage | Message): string {
	if (!("content" in message)) return "";
	const content: unknown = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: { type: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : ""))
		.join("\n");
}

describe("a user interrupt does not fire a continuation that was waiting on idle", () => {
	let session: AgentSession;
	let agent: Agent;
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	/** One entry per provider call: the messages that call was given. */
	let providerCalls: Message[][];
	let openStream: AssistantMessageEventStream | undefined;

	beforeEach(async () => {
		vi.spyOn(scheduler, "wait").mockImplementation((_delayMs, options) => originalSchedulerWait(0, options));
		tempDir = await TempDir.create("veyyon-idle-continuation");
		providerCalls = [];
		openStream = undefined;

		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: (_model, context, options) => {
				providerCalls.push([...context.messages]);
				const stream = new AssistantMessageEventStream();
				const signal = options?.signal;
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					if (providerCalls.length > 1) {
						stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Resumed") });
						return;
					}
					signal?.addEventListener(
						"abort",
						() => stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") }),
						{ once: true },
					);
				});
				if (providerCalls.length === 1) openStream = stream;
				return stream;
			},
		});

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
		AsyncJobManager.resetForTests();
	});

	/**
	 * Start a turn, queue a triggering continuation while it streams, and hold
	 * until that continuation has been refused as busy once -- the point where
	 * it is waiting on idle. Returns the in-flight prompt and the refusal count.
	 */
	async function queueContinuationWaitingOnIdle(): Promise<{
		firstPrompt: Promise<unknown>;
		busyRefusals: () => number;
	}> {
		const firstPrompt = session.prompt("First message");
		await waitFor(() => session.isStreaming && openStream !== undefined && providerCalls.length === 1);

		let refusals = 0;
		// The session prompts with a message array; the spy keeps that overload and counts
		// the busy refusal that puts the continuation into its idle wait.
		const realPrompt: (messages: AgentMessage[], options?: AgentPromptOptions) => Promise<void> =
			agent.prompt.bind(agent);
		vi.spyOn(agent, "prompt").mockImplementation(async (input, options) => {
			if (typeof input === "string" || !Array.isArray(input) || Array.isArray(options)) {
				throw new Error("the session prompts the agent with a message array");
			}
			try {
				await realPrompt(input, options);
			} catch (error) {
				if (error instanceof AgentBusyError) refusals += 1;
				throw error;
			}
		});

		const startedTurn = await session.sendCustomMessage(
			{ customType: CONTINUATION_TYPE, content: CONTINUATION_TEXT, display: false, attribution: "agent" },
			{ deliverAs: "nextTurn", triggerTurn: true },
		);
		expect(startedTurn).toBe(false);
		await waitFor(() => refusals === 1);
		return { firstPrompt, busyRefusals: () => refusals };
	}

	it("drops the waiting continuation when Escape ends the turn", async () => {
		const { firstPrompt, busyRefusals } = await queueContinuationWaitingOnIdle();

		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await firstPrompt;
		await session.waitForIdle();
		// Bound: the settle is terminal. A prompt that woke on it would make the
		// second provider call within this window; none may arrive at all.
		await originalSchedulerWait(50);

		expect(providerCalls).toHaveLength(1);
		expect(busyRefusals()).toBe(1);
		expect(session.isStreaming).toBe(false);
		expect(session.messages.at(-1)?.role).toBe("assistant");
		expect(
			session.messages.some(message => message.role === "custom" && messageText(message) === CONTINUATION_TEXT),
		).toBe(false);
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [] });
	});

	it("still delivers the waiting continuation when the turn ends on its own", async () => {
		const { firstPrompt } = await queueContinuationWaitingOnIdle();

		openStream?.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
		await firstPrompt;
		await waitFor(() => providerCalls.length === 2);
		await session.waitForIdle();

		expect(providerCalls[1]?.some(message => messageText(message).includes(CONTINUATION_TEXT))).toBe(true);
		expect(session.messages.at(-1)?.role).toBe("assistant");
		expect(messageText(session.messages.at(-1)!)).toBe("Resumed");
	});
});
