import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, agentLoop } from "@veyyon/agent-core";
import type {
	AgentContext,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	SteeringQueueState,
} from "@veyyon/agent-core/types";
import type { AssistantMessage, Message, TextContent, ToolCall, ToolResultMessage, UserMessage } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { normalizeCustomMessagePayload } from "@veyyon/coding-agent/session/messages";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { type } from "arktype";
import { loopSource, unionMembers } from "../../agent/test/support/invented-tool-result-sources";

/**
 * An interrupted `todo` call is not a verdict on the payload, whatever interrupted
 * it.
 *
 * The session keeps one string, `#lastTodoFailureText`, and compares the next
 * failure against it. That is text classification, and interrupt placeholders are
 * built to defeat it: the headline is FIXED PER SOURCE, so two unrelated interrupts
 * arrive byte-identical, the comparison says "same failure again", and the model is
 * told to treat todo as unusable for the rest of the turn over an event that never
 * happened. Field data from 778 session transcripts has runs of up to 52
 * consecutive identical skip headlines in a single turn, so this is the normal
 * shape of an interrupted turn rather than an edge case.
 *
 * These tests do not hand-write the placeholder. They run the REAL `agentLoop`, take
 * the results it emitted, and feed those exact messages to a real `AgentSession`.
 * Both halves of the contract are then under test at once: the loop stamping a
 * discriminator, and the session reading it instead of the bytes. Neuter either one
 * and these go red.
 *
 * MUTATION PLAN, both directions:
 *  - Producer: drop `__skipped` from `createSkippedToolResult` (or from
 *    `createToolSignalAbortedResult`) in `packages/agent/src/agent-loop.ts`.
 *  - Consumer: in `agent-session.ts`, force `const todoCallDidNotFail = false;`
 *    (the text-classifying behaviour the discriminator replaced).
 */

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

const todoSchema = type({ op: "string" });

type SkipSource = "user" | "system" | "unknown" | "irc" | "cancelled-run";

/**
 * Drive the real loop until it answers `siblings` `todo` calls with interrupt
 * placeholders, and hand back exactly those messages.
 *
 * The first call is the one that triggers the interrupt; the rest are the queued
 * siblings, which is where the long identical runs come from. `exclusive`
 * concurrency is what puts them behind it.
 */
async function realSkippedTodoResults(source: SkipSource, siblings: number): Promise<ToolResultMessage[]> {
	const controller = new AbortController();
	let interruptArmed = false;
	const tool: AgentTool<typeof todoSchema, { op: string }> = {
		name: "todo",
		label: "Todo",
		description: "writes the board",
		parameters: todoSchema,
		concurrency: "exclusive",
		async execute(_id, params, signal) {
			if (!interruptArmed) {
				interruptArmed = true;
				if (source === "cancelled-run") {
					controller.abort(new Error("Interrupted by user"));
					const error = new Error("aborted");
					error.name = "AbortError";
					throw error;
				}
			}
			if (signal?.aborted) {
				const error = new Error("aborted");
				error.name = "AbortError";
				throw error;
			}
			return { content: [{ type: "text", text: "board written" }], details: params };
		},
	};
	const calls = Array.from({ length: siblings + 1 }, (_unused, index) => ({
		type: "toolCall" as const,
		id: `skip_${source}_${index}`,
		name: "todo",
		arguments: { op: "set" },
	}));
	const mock = createMockModel({ responses: [{ content: calls, stopReason: "toolUse" }, { content: ["done"] }] });
	const steeringSource = source === "unknown" ? undefined : source === "system" ? "system" : "user";
	const config: AgentLoopConfig = {
		model: mock.model,
		convertToLlm: identityConverter,
		...(source === "user" || source === "system" || source === "unknown"
			? {
					hasSteeringMessages: (): SteeringQueueState => ({
						queued: interruptArmed,
						...(steeringSource ? { source: steeringSource } : {}),
					}),
				}
			: {}),
		...(source === "irc" ? { hasIrcInterrupts: (): boolean => interruptArmed } : {}),
	};
	const user: UserMessage = { role: "user", content: "go", timestamp: Date.now() };
	const context: AgentContext = { systemPrompt: ["T"], messages: [], tools: [tool as AgentTool] };
	const produced = await agentLoop([user], context, config, controller.signal, mock.stream)
		.result()
		.catch(() => [] as AgentMessage[]);
	// The call that triggered the interrupt is dropped: for `cancelled-run` it was
	// mid-execute, for the rest it succeeded. Only the placeholders are of interest.
	const skips = produced.filter(
		(m): m is ToolResultMessage => m.role === "toolResult" && m.toolCallId !== `skip_${source}_0`,
	);
	if (skips.length !== siblings) {
		throw new Error(`expected ${siblings} placeholders for ${source}, got ${skips.length}`);
	}
	return skips;
}

describe("an interrupted todo call is not a payload refusal", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let todoErrorReminders: string[];

	/** Emit the assistant turn a tool result answers, so the session sees a pair. */
	function emitCall(toolCallId: string): void {
		const toolCall: ToolCall = { type: "toolCall", id: toolCallId, name: "todo", arguments: {} };
		const assistantMsg: AssistantMessage = {
			role: "assistant",
			content: [toolCall],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
			usage: {
				input: 50,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 60,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
	}

	/** Replay a result the real loop produced, verbatim. */
	function replay(result: ToolResultMessage): void {
		emitCall(result.toolCallId);
		session.agent.emitExternalEvent({ type: "message_end", message: result });
	}

	/** A genuine tool-side refusal: the tool ran, read the payload, and rejected it. */
	function emitTodoFailure(errorText: string): void {
		const toolCallId = `fail_${todoErrorReminders.length}_${Math.random()}`;
		emitCall(toolCallId);
		const content: TextContent[] = [{ type: "text", text: errorText }];
		session.agent.emitExternalEvent({
			type: "message_end",
			message: { role: "toolResult", toolCallId, toolName: "todo", content, isError: true, timestamp: Date.now() },
		});
	}

	/** A landed write. */
	function emitTodoSuccess(): void {
		const toolCallId = `ok_${Math.random()}`;
		emitCall(toolCallId);
		session.agent.emitExternalEvent({
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId,
				toolName: "todo",
				content: [{ type: "text", text: "board written" }],
				isError: false,
				details: {},
				timestamp: Date.now(),
			},
		});
	}

	function emitTextOnlyStop(): void {
		const msg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "paused" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [msg] });
	}

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-skip-not-refusal-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"todo.enabled": true,
				"todo.reminders.max": 3,
			}),
			modelRegistry,
		});

		todoErrorReminders = [];
		const sendCustomMessage = session.sendCustomMessage.bind(session);
		vi.spyOn(session, "sendCustomMessage").mockImplementation(async (message, options) => {
			const normalized = normalizeCustomMessagePayload(message);
			if (normalized.customType === "todo-error-reminder" && typeof normalized.content === "string") {
				todoErrorReminders.push(normalized.content);
			}
			return sendCustomMessage(message, options);
		});
		session.subscribe((_event: AgentSessionEvent) => {});
		vi.spyOn(session.agent, "continue").mockResolvedValue();

		session.setTodoPhases([
			{ name: "Exercise", tasks: [{ content: "Run real-world usage scenarios", status: "pending" }] },
		]);
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	const FAILURE = 'Validation failed for tool "todo":\n  - op: op must be operation to apply (was missing)';
	const OTHER_FAILURE = 'Validation failed for tool "todo":\n  - task: no task matches "Ship it"';

	const SOURCES: ReadonlyArray<SkipSource> = ["user", "system", "unknown", "irc", "cancelled-run"];

	/**
	 * The list above is checked against the declaration rather than trusted.
	 *
	 * A new interrupt source is a new byte-identical headline, and the session would
	 * classify it as a payload refusal on the day it lands. This is red until the
	 * new member is either driven here or recorded as unreachable, which is the only
	 * way the long tail stays closed after today.
	 *
	 * `"steering"` is `createSkippedToolResult`'s default for an absent source and
	 * the loop never passes one; see the note in
	 * `agent/test/synthetic-tool-results-carry-a-discriminator.test.ts`.
	 */
	it("covers every interrupt source the loop can stamp", async () => {
		const declared = await unionMembers(await loopSource(), "SkippedToolResultDetails", "source");
		expect(declared.slice().sort()).toEqual([...SOURCES, "steering"].sort());
	});

	/**
	 * The reported bug, checked against every source rather than the one that was
	 * reported. Two placeholders from the same interrupt source are byte-identical,
	 * which is exactly what a text comparison reads as a repeat.
	 */
	for (const source of SOURCES) {
		it(`says nothing about the payload after two ${source} skips`, async () => {
			const skips = await realSkippedTodoResults(source, 2);
			for (const skip of skips) replay(skip);
			emitTextOnlyStop();
			await session.waitForIdle();

			expect(todoErrorReminders).toEqual([]);
		});
	}

	/**
	 * The run, not the pair. 52 is the longest run measured in the field, and it is
	 * a livelock signature: every call in the batch skipped, so the model retries
	 * and they all skip again. The turn must come out of it able to use the tool.
	 */
	it("does not retire todo after a run of 52 identical skips, and lands a write afterwards", async () => {
		const skips = await realSkippedTodoResults("irc", 52);
		const texts = new Set(skips.slice(1).map(s => (s.content[0]?.type === "text" ? s.content[0].text : "")));
		// The premise: the model really is handed one line 51 times over.
		expect(texts.size).toBe(1);

		for (const skip of skips) replay(skip);
		emitTodoSuccess();
		emitTextOnlyStop();
		await session.waitForIdle();

		expect(todoErrorReminders).toEqual([]);
	});

	/**
	 * A skip is neither a landed write nor a refusal, so it must leave the failure
	 * memory exactly as it found it. Clearing it would let one broken payload be
	 * ordered forever, one interrupt apart: fail, skip, fail, skip, and every
	 * reminder reads like the first.
	 */
	for (const source of SOURCES) {
		it(`remembers a real failure across a ${source} skip`, async () => {
			const [skip] = await realSkippedTodoResults(source, 1);
			emitTodoFailure(FAILURE);
			replay(skip);
			emitTodoFailure(FAILURE);
			emitTextOnlyStop();
			await session.waitForIdle();

			expect(todoErrorReminders).toHaveLength(2);
			expect(todoErrorReminders[0]).toContain("Fix the todo payload and call todo again before continuing.");
			expect(todoErrorReminders[1]).toContain("cannot succeed");
		});
	}

	/**
	 * The other direction, and the reason the memory cannot simply be pinned: a
	 * landed write makes the board authoritative again, so the next failure is a new
	 * one. Without this a turn that retired todo could never get it back, and
	 * "unusable for the rest of this turn" would be a one-way door.
	 */
	it("lets a landed write bring todo back within the same turn", async () => {
		emitTodoFailure(FAILURE);
		emitTodoFailure(FAILURE);
		emitTodoSuccess();
		emitTodoFailure(FAILURE);
		emitTextOnlyStop();
		await session.waitForIdle();

		expect(todoErrorReminders).toHaveLength(3);
		expect(todoErrorReminders[1]).toContain("unusable");
		// The same payload again, but the board landed in between, so the previous
		// verdict is stale and the model is asked to fix it rather than to give up.
		expect(todoErrorReminders[2]).toContain("Fix the todo payload and call todo again before continuing.");
		expect(todoErrorReminders[2]).not.toContain("unusable");
	});

	/**
	 * Negative control for every test above. Two genuinely different refusals must
	 * still both ask for a fix, and two identical ones must still be caught. If the
	 * session ever answered "not a refusal" unconditionally these would go red while
	 * the skip tests stayed green, which is the failure mode a discriminator invites.
	 */
	it("still distinguishes real todo refusals from each other", async () => {
		emitTodoFailure(FAILURE);
		emitTodoFailure(OTHER_FAILURE);
		emitTodoFailure(OTHER_FAILURE);
		emitTextOnlyStop();
		await session.waitForIdle();

		expect(todoErrorReminders).toHaveLength(3);
		expect(todoErrorReminders[0]).toContain("Fix the todo payload and call todo again before continuing.");
		expect(todoErrorReminders[1]).toContain("Fix the todo payload and call todo again before continuing.");
		expect(todoErrorReminders[2]).toContain("cannot succeed");
	});
});
