import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentMessage, type AgentTool } from "@veyyon/agent-core";
import { type StopReason, z } from "@veyyon/ai";
import { createMockModel, type MockModel, type MockResponse } from "@veyyon/ai/providers/mock";
import { AutoLearnController } from "@veyyon/coding-agent/autolearn/controller";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { type SettingPath, Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

const recordToolSchema = z.object({ value: z.string() });

type Harness = {
	session: AgentSession;
	authStorage: AuthStorage;
	tempDir: TempDir;
};
type SettingsOverrides = Partial<Record<SettingPath, unknown>>;

const activeHarnesses: Harness[] = [];

const recordTool: AgentTool<typeof recordToolSchema, { value: string }> = {
	name: "record",
	label: "Record",
	description: "Record a value",
	parameters: recordToolSchema,
	async execute(_toolCallId, params) {
		return {
			content: [{ type: "text", text: `recorded:${params.value}` }],
			details: { value: params.value },
		};
	},
};

function recordCall(value: string, id: string): MockResponse {
	return {
		content: [{ type: "toolCall", id, name: "record", arguments: { value } }],
		stopReason: "toolUse",
	};
}

function emptyStop(): MockResponse {
	return {
		content: [],
		stopReason: "stop",
		usage: { output: 1, cacheRead: 100 },
	};
}

function orphanedToolUseStop(): MockResponse {
	return {
		content: [{ type: "thinking", thinking: "I should call a tool next." }],
		stopReason: "toolUse",
		usage: { output: 1, cacheRead: 100 },
	};
}

function thinkingOnlyStop(): MockResponse {
	return {
		content: [{ type: "thinking", thinking: "I should inspect the next file." }],
		stopReason: "stop",
		usage: { output: 1, cacheRead: 100 },
	};
}

async function createHarness(
	responses: MockResponse[],
	settingsOverrides: SettingsOverrides = {},
	persistSession = false,
): Promise<Harness & { mock: MockModel }> {
	const tempDir = TempDir.createSync("@pi-empty-stop-guard-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("mock", "test-key");

	const mock = createMockModel({ responses });
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.eager": "default",
		"todo.reminders": false,
		...settingsOverrides,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);

	const sessionManager = persistSession
		? SessionManager.create(tempDir.path(), tempDir.path())
		: SessionManager.inMemory(tempDir.path());
	const tools = [recordTool as AgentTool];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: mock,
			systemPrompt: ["Test"],
			tools,
			messages: [],
		},
		convertToLlm,
		streamFn: mock.stream,
	});

	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
	});
	const harness = { session, authStorage, tempDir };
	activeHarnesses.push(harness);
	return { ...harness, mock };
}

function assistantText(messages: AgentMessage[]): string {
	return messages
		.filter((message): message is Extract<AgentMessage, { role: "assistant" }> => message.role === "assistant")
		.flatMap(message => message.content.flatMap(content => (content.type === "text" ? [content.text] : [])))
		.join("\n");
}

function emptyAssistantStops(messages: AgentMessage[]): AgentMessage[] {
	return messages.filter(
		message =>
			message.role === "assistant" &&
			message.stopReason === "stop" &&
			!message.content.some(content => {
				if (content.type === "text") return content.text.trim().length > 0;
				return content.type === "toolCall";
			}),
	);
}
function reminderMessages(messages: AgentMessage[]): AgentMessage[] {
	const isEmptyStopRetryReminder = (text: string): boolean =>
		text.includes("<system-reminder>") || text.includes("<system-injection>");

	return messages.filter(message => {
		if (message.role !== "developer") return false;
		return typeof message.content === "string"
			? isEmptyStopRetryReminder(message.content)
			: message.content.some(content => content.type === "text" && isEmptyStopRetryReminder(content.text));
	});
}

async function expectPromptCompletes(prompt: Promise<boolean>): Promise<void> {
	await Promise.race([
		prompt,
		Bun.sleep(1_000).then(() => {
			throw new Error("Expected session prompt to settle after empty-stop retry cap");
		}),
	]);
}

afterEach(async () => {
	for (const harness of activeHarnesses.splice(0)) {
		await harness.session.dispose();
		harness.authStorage.close();
		harness.tempDir.removeSync();
	}
	vi.restoreAllMocks();
});

describe("AgentSession empty stop guard", () => {
	it("retries an empty assistant stop after a tool result", async () => {
		const { session, mock } = await createHarness([
			recordCall("alpha", "call-record-alpha"),
			emptyStop(),
			{ content: ["finished after retry"], stopReason: "stop" },
		]);

		await session.prompt("record alpha");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(3);
		expect(assistantText(session.agent.state.messages)).toContain("finished after retry");
		expect(emptyAssistantStops(session.agent.state.messages)).toHaveLength(0);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(1);

		const activeBranchMessages = session.sessionManager
			.getBranch()
			.filter(entry => entry.type === "message")
			.map(entry => entry.message as AgentMessage);
		expect(emptyAssistantStops(activeBranchMessages)).toHaveLength(0);
		expect(
			emptyAssistantStops(
				session.sessionManager
					.getEntries()
					.filter(entry => entry.type === "message")
					.map(entry => entry.message as AgentMessage),
			),
		).toHaveLength(1);
	});

	it("retries a tool-use stop that has no tool call or text", async () => {
		const { session, mock } = await createHarness([
			recordCall("orphan", "call-record-orphan"),
			orphanedToolUseStop(),
			{ content: ["finished after orphaned tool-use retry"], stopReason: "stop" },
		]);

		await session.prompt("record orphan");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(3);
		expect(assistantText(session.agent.state.messages)).toContain("finished after orphaned tool-use retry");
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(1);
	});

	it("retries a stop that only contains thinking", async () => {
		const { session, mock } = await createHarness([
			recordCall("thinking", "call-record-thinking"),
			thinkingOnlyStop(),
			{ content: ["finished after thinking-only retry"], stopReason: "stop" },
		]);

		await session.prompt("record thinking");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(3);
		expect(assistantText(session.agent.state.messages)).toContain("finished after thinking-only retry");
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(1);
		expect(emptyAssistantStops(session.agent.state.messages)).toHaveLength(0);
	});

	it("removes orphaned tool-use stops even when retry cap is hit", async () => {
		const { session, mock } = await createHarness([
			recordCall("gamma", "call-record-gamma"),
			orphanedToolUseStop(),
			orphanedToolUseStop(),
			orphanedToolUseStop(),
			orphanedToolUseStop(),
		]);
		await session.prompt("record gamma");
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(5);
		// The reminders exist only to nudge a stalled turn. Once the cycle gives up
		// they describe an assistant turn that has been discarded, so they go too.
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
		const activeBranchMessages = session.sessionManager
			.getBranch()
			.filter(entry => entry.type === "message")
			.map(entry => entry.message as AgentMessage);
		const orphanedToolUseStops = activeBranchMessages.filter(
			message =>
				message.role === "assistant" &&
				message.stopReason === "toolUse" &&
				!message.content.some(content => content.type === "toolCall"),
		);
		expect(orphanedToolUseStops).toHaveLength(0);
	});
	it("caps empty stop retries at three attempts", async () => {
		const { session, mock } = await createHarness([
			recordCall("beta", "call-record-beta"),
			emptyStop(),
			emptyStop(),
			emptyStop(),
			emptyStop(),
		]);

		await session.prompt("record beta");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(5);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
		expect(emptyAssistantStops(session.agent.state.messages)).toHaveLength(0);

		const activeBranchMessages = session.sessionManager
			.getBranch()
			.filter(entry => entry.type === "message")
			.map(entry => entry.message as AgentMessage);
		// The cap used to keep the empty turn in the branch, so reloading the
		// session replayed it and re-sent the context that produced it.
		expect(emptyAssistantStops(activeBranchMessages)).toHaveLength(0);
	});

	it("emits failed auto-retry end when repeated empty stops exhaust the retry cap", async () => {
		const { session, mock } = await createHarness([emptyStop(), emptyStop(), emptyStop(), emptyStop()]);
		const retryEndEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") {
				retryEndEvents.push(event);
			}
		});

		await expectPromptCompletes(session.prompt("answer without tools"));
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(4);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({
			type: "auto_retry_end",
			success: false,
			attempt: 3,
		});
		expect(retryEndEvents[0]?.finalError).toContain("empty stop");
	});

	it("ends auto-retry state when empty stop retries hit the cap", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { session, mock } = await createHarness(
			[{ throw: "503 service unavailable: overloaded_error" }, emptyStop(), emptyStop(), emptyStop(), emptyStop()],
			{
				"retry.enabled": true,
				"retry.baseDelayMs": 5,
				"retry.maxDelayMs": 5_000,
				"retry.maxRetries": 2,
			},
		);
		const retryStartEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_start" }>> = [];
		const retryEndEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") {
				retryStartEvents.push(event);
			}
			if (event.type === "auto_retry_end") {
				retryEndEvents.push(event);
			}
		});

		await expectPromptCompletes(session.prompt("recover from transient error"));
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(5);
		expect(session.isRetrying).toBe(false);
		expect(session.retryAttempt).toBe(0);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]?.attempt).toBe(1);
		expect(retryEndEvents.filter(event => event.success)).toEqual([]);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({
			type: "auto_retry_end",
			success: false,
			attempt: 1,
		});
		expect(retryEndEvents[0]?.finalError).toContain("empty stop");
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
		expect(emptyAssistantStops(session.agent.state.messages)).toHaveLength(0);

		mock.push({ content: ["fresh unrelated success"], stopReason: "stop" });
		await session.prompt("start unrelated turn after cap");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(6);
		expect(retryEndEvents).toHaveLength(1);
		expect(session.isRetrying).toBe(false);
		expect(session.retryAttempt).toBe(0);
		expect(assistantText(session.agent.state.messages)).toContain("fresh unrelated success");

		mock.push({ throw: "503 service unavailable: overloaded_error" });
		mock.push({ content: ["fresh retry success"], stopReason: "stop" });
		await expectPromptCompletes(session.prompt("recover with fresh retry budget"));
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(8);
		expect(retryStartEvents).toHaveLength(2);
		expect(retryStartEvents[1]?.attempt).toBe(1);
		expect(retryEndEvents).toHaveLength(2);
		expect(retryEndEvents[1]).toMatchObject({
			type: "auto_retry_end",
			success: true,
			attempt: 1,
		});
		expect(session.isRetrying).toBe(false);
		expect(session.retryAttempt).toBe(0);
	});

	it("preserves auto-retry budget across empty stop continuations", async () => {
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const { session, mock } = await createHarness(
			[
				{ throw: "503 service unavailable: overloaded_error" },
				emptyStop(),
				{ throw: "503 service unavailable: overloaded_error" },
				{ throw: "503 service unavailable: overloaded_error" },
			],
			{
				"retry.enabled": true,
				"retry.baseDelayMs": 5,
				"retry.maxDelayMs": 5_000,
				"retry.maxRetries": 2,
			},
		);
		const retryEndEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") {
				retryEndEvents.push(event);
			}
		});

		await expectPromptCompletes(session.prompt("recover without replenishing retries"));
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(4);
		expect(retryEndEvents.filter(event => event.success)).toEqual([]);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({
			type: "auto_retry_end",
			success: false,
			attempt: 2,
		});
		expect(session.isRetrying).toBe(false);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(1);
	});

	it("accepts an auto-learn capture turn that ends with an empty terminal stop", async () => {
		const { session, mock, tempDir } = await createHarness(
			[
				recordCall("learn-alpha", "call-record-learn-alpha"),
				recordCall("learn-beta", "call-record-learn-beta"),
				{ content: ["normal turn complete"], stopReason: "stop" },
				emptyStop(),
			],
			{
				"autolearn.enabled": true,
				"autolearn.autoContinue": true,
				"autolearn.minToolCalls": 2,
			},
			true,
		);
		const retryEndEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});
		new AutoLearnController({ session, settings: session.settings });

		await session.prompt("record enough facts for auto-learn");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(4);
		expect(assistantText(session.agent.state.messages)).toContain("normal turn complete");
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
		expect(retryEndEvents.filter(event => event.success === false)).toEqual([]);
		expect(emptyAssistantStops(session.agent.state.messages)).toHaveLength(0);

		const branchMessagesAfterCapture = session.sessionManager
			.getBranch()
			.filter(entry => entry.type === "message")
			.map(entry => entry.message as AgentMessage);
		expect(emptyAssistantStops(branchMessagesAfterCapture)).toHaveLength(0);
		expect(
			session.sessionManager
				.getBranch()
				.some(entry => entry.type === "custom_message" && entry.customType === "autolearn-nudge"),
		).toBe(false);

		await session.sessionManager.flush();
		const sessionFile = session.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persistent Auto-Learn test session");
		const reloadedSession = await SessionManager.open(sessionFile, tempDir.path());
		const reloadedBranchMessages = reloadedSession
			.getBranch()
			.filter(entry => entry.type === "message")
			.map(entry => entry.message as AgentMessage);
		expect(emptyAssistantStops(reloadedBranchMessages)).toHaveLength(0);
		expect(
			reloadedSession
				.getBranch()
				.some(entry => entry.type === "custom_message" && entry.customType === "autolearn-nudge"),
		).toBe(false);

		const captureCall = mock.calls[3];
		if (!captureCall) throw new Error("Expected auto-learn capture turn to call the model");
		const messageHasText = (message: (typeof captureCall.context.messages)[number], text: string): boolean => {
			const { content } = message;
			if (typeof content === "string") return content.includes(text);
			return (
				Array.isArray(content) &&
				content.some(block => "text" in block && typeof block.text === "string" && block.text.includes(text))
			);
		};
		const autoLearnNudgeText = "If your previous turn produced anything reusable";
		expect(captureCall.context.messages.some(message => messageHasText(message, autoLearnNudgeText))).toBe(true);

		mock.push({ content: ["next real turn complete"], stopReason: "stop" });
		await session.prompt("next real prompt after auto-learn no-op");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(5);
		const nextPromptCall = mock.calls[4];
		if (!nextPromptCall) throw new Error("Expected next real prompt to call the model");
		expect(nextPromptCall.context.messages.some(message => messageHasText(message, autoLearnNudgeText))).toBe(false);
		expect(assistantText(session.agent.state.messages)).toContain("next real turn complete");
		expect(emptyAssistantStops(session.agent.state.messages)).toHaveLength(0);

		const branchMessagesAfterNextPrompt = session.sessionManager
			.getBranch()
			.filter(entry => entry.type === "message")
			.map(entry => entry.message as AgentMessage);
		expect(emptyAssistantStops(branchMessagesAfterNextPrompt)).toHaveLength(0);
		expect(
			session.sessionManager
				.getBranch()
				.some(entry => entry.type === "custom_message" && entry.customType === "autolearn-nudge"),
		).toBe(false);
	});

	it("does not let a non-opt-in custom turn inherit auto-learn terminal empty-stop acceptance", async () => {
		const { session, mock } = await createHarness(
			[
				recordCall("learn-alpha", "call-record-learn-alpha"),
				recordCall("learn-beta", "call-record-learn-beta"),
				{ content: ["normal turn complete"], stopReason: "stop" },
				{ content: ["auto-learn captured non-empty text"], stopReason: "stop" },
				emptyStop(),
				emptyStop(),
				emptyStop(),
				emptyStop(),
			],
			{
				"autolearn.enabled": true,
				"autolearn.autoContinue": true,
				"autolearn.minToolCalls": 2,
			},
		);
		const retryEndEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});
		new AutoLearnController({ session, settings: session.settings });

		await session.prompt("record enough facts for auto-learn");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(4);
		expect(assistantText(session.agent.state.messages)).toContain("auto-learn captured non-empty text");
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);

		await expectPromptCompletes(
			session.sendCustomMessage(
				{
					customType: "advisor",
					content: "check",
					display: false,
					attribution: "agent",
				},
				{ triggerTurn: true },
			),
		);
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(8);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({
			type: "auto_retry_end",
			success: false,
			attempt: 3,
		});
		expect(retryEndEvents[0]?.finalError).toContain("empty stop");
	});

	it("does not retry normal stop or tool-use turns", async () => {
		const normal = await createHarness([{ content: ["already done"], stopReason: "stop" }]);

		await normal.session.prompt("answer normally");
		await normal.session.waitForIdle();

		expect(normal.mock.calls).toHaveLength(1);
		expect(reminderMessages(normal.session.agent.state.messages)).toHaveLength(0);

		const withTool = await createHarness([
			recordCall("gamma", "call-record-gamma"),
			{ content: ["tool path complete"], stopReason: "stop" },
		]);

		await withTool.session.prompt("record gamma");
		await withTool.session.waitForIdle();

		expect(withTool.mock.calls).toHaveLength(2);
		expect(reminderMessages(withTool.session.agent.state.messages)).toHaveLength(0);
		expect(assistantText(withTool.session.agent.state.messages)).toContain("tool path complete");
	});
});

/**
 * WHY: the empty-stop retry cycle used to leave its own wreckage behind when it
 * gave up. Ground truth from a live session (2026-08-08, session 019fdb42,
 * cursor/cursor-grok-4.5-medium): four empty completions capped the cycle at
 * 00:20:03 reporting `attempts: 3`; the todo-completion nudge started the next
 * turn three seconds later; that turn capped on its FIRST empty completion and
 * reported `attempts: 4` — a count for requests it never made, and no retry
 * budget at all for a turn that had asked for none. Cause: the cap reset
 * `#retryAttempt` but not `#emptyStopRetryCount`, and only a user prompt runs the
 * per-prompt reset. On top of that the cap kept the empty assistant turn (for
 * stopReason "stop") and the three developer reminders, so every later turn
 * carried instructions about a turn that had already been discarded, and a reload
 * replayed the empty turn that provoked them.
 *
 * The class: no path may inherit a spent empty-stop budget, and no ending of the
 * cycle may leave the cycle's scaffolding behind, for ANY stop reason the guard
 * treats as empty. `EMPTY_STOP_TREATMENT` is keyed by `StopReason`, so a new
 * member of that union fails type checking until it records a decision here.
 *
 * What this does NOT catch: a nudge that starts a turn without going through
 * `prompt`/`sendCustomMessage`, and cost — a fresh budget per turn means a model
 * that empty-stops forever still burns four requests for every turn something
 * triggers.
 */
type EmptyStopTreatment = "cleans-up-at-the-cap" | "never-an-empty-stop";

const EMPTY_STOP_TREATMENT: Record<StopReason, EmptyStopTreatment> = {
	stop: "cleans-up-at-the-cap",
	toolUse: "cleans-up-at-the-cap",
	// A truncated, failed, or aborted turn is not a stalled turn: retrying it with
	// a "you produced nothing" reminder would hide a real failure.
	length: "never-an-empty-stop",
	error: "never-an-empty-stop",
	aborted: "never-an-empty-stop",
};

function zeroContentStop(reason: StopReason): MockResponse {
	return { content: [], stopReason: reason, usage: { output: 1, cacheRead: 100 } };
}

function zeroContentStops(messages: AgentMessage[], reason: StopReason): AgentMessage[] {
	return messages.filter(
		message =>
			message.role === "assistant" &&
			message.stopReason === reason &&
			!message.content.some(
				content => content.type === "toolCall" || (content.type === "text" && content.text.trim().length > 0),
			),
	);
}

function branchMessages(session: AgentSession): AgentMessage[] {
	return session.sessionManager
		.getBranch()
		.filter(entry => entry.type === "message")
		.map(entry => entry.message as AgentMessage);
}

/** Start a turn the way a maintenance nudge does: no user prompt, so none of the
 *  per-prompt reset that hid this defect from every existing test. */
async function nudgeTurn(session: AgentSession, content: string): Promise<void> {
	await expectPromptCompletes(
		session.sendCustomMessage(
			{ customType: "advisor", content, display: false, attribution: "agent" },
			{ triggerTurn: true },
		),
	);
	await session.waitForIdle();
}

describe("AgentSession empty stop retry cap cleanup", () => {
	it("hands the next turn a whole retry budget even when no user prompt intervenes", async () => {
		const { session, mock } = await createHarness(Array.from({ length: 8 }, () => emptyStop()));
		const failures: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end" && !event.success) failures.push(event);
		});

		await expectPromptCompletes(session.prompt("a turn the model answers with nothing"));
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(4);

		await nudgeTurn(session, "maintenance nudge after the cap");

		// Four more requests: one attempt plus the three retries the cap allows.
		// Inheriting the spent budget made this turn a single request.
		expect(mock.calls).toHaveLength(8);
		expect(failures.map(event => event.attempt)).toEqual([3, 3]);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
		expect(emptyAssistantStops(session.agent.state.messages)).toHaveLength(0);
	});

	it("does not carry a recovered cycle's reminder into a later prompt", async () => {
		const { session, mock } = await createHarness([
			emptyStop(),
			{ content: ["recovered on the retry"], stopReason: "stop" },
			{ content: ["a later unrelated answer"], stopReason: "stop" },
		]);

		await expectPromptCompletes(session.prompt("a turn that stalls once"));
		await session.waitForIdle();
		// The reminder earned its place in the turn it rescued: the assistant text
		// after it is a reply to it, so this cycle keeps it.
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(1);

		await session.prompt("an unrelated later turn");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(3);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
		const laterCall = mock.calls[2];
		if (!laterCall) throw new Error("Expected the later prompt to reach the model");
		expect(JSON.stringify(laterCall.context.messages)).not.toContain("You stopped without completing the task");
	});

	it("never reports more attempts than the cap allows, however many cycles run back to back", async () => {
		const cycles = 3;
		const { session, mock } = await createHarness(Array.from({ length: cycles * 4 }, () => emptyStop()));
		const failures: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end" && !event.success) failures.push(event);
		});

		for (let cycle = 0; cycle < cycles; cycle++) {
			await nudgeTurn(session, `nudge ${cycle}`);
		}

		expect(mock.calls).toHaveLength(cycles * 4);
		expect(failures).toHaveLength(cycles);
		expect(failures.map(event => event.attempt)).toEqual([3, 3, 3]);
	});

	it("names the model in the failure the operator reads", async () => {
		const { session, mock } = await createHarness(Array.from({ length: 4 }, () => emptyStop()));
		const failures: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end" && !event.success) failures.push(event);
		});

		await expectPromptCompletes(session.prompt("a turn the model answers with nothing"));
		await session.waitForIdle();

		expect(failures).toHaveLength(1);
		expect(failures[0]?.finalError).toContain("empty stop");
		expect(failures[0]?.finalError).toContain(`${mock.provider}/${mock.id}`);
	});

	it("leaves nothing behind when the capped turns carried only thinking", async () => {
		// A zero-block turn and a thinking-only turn are different shapes reaching
		// the same branch: a cleanup keyed on `content.length === 0` would keep this
		// one and put reasoning-only turns back into every later request.
		const { session, mock } = await createHarness([
			...Array.from({ length: 4 }, () => thinkingOnlyStop()),
			...Array.from({ length: 4 }, () => thinkingOnlyStop()),
		]);

		await expectPromptCompletes(session.prompt("a turn that only thinks"));
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(4);
		expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
		expect(zeroContentStops(session.agent.state.messages, "stop")).toHaveLength(0);
		expect(zeroContentStops(branchMessages(session), "stop")).toHaveLength(0);

		await nudgeTurn(session, "nudge after the thinking-only cap");
		expect(mock.calls).toHaveLength(8);
	});

	for (const [stopReason, treatment] of Object.entries(EMPTY_STOP_TREATMENT) as Array<
		[StopReason, EmptyStopTreatment]
	>) {
		if (treatment === "cleans-up-at-the-cap") {
			it(`leaves nothing behind when a zero-content ${stopReason} stop exhausts the cap`, async () => {
				const { session, mock } = await createHarness([
					...Array.from({ length: 4 }, () => zeroContentStop(stopReason)),
					...Array.from({ length: 4 }, () => zeroContentStop(stopReason)),
				]);
				const failures: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
				session.subscribe(event => {
					if (event.type === "auto_retry_end" && !event.success) failures.push(event);
				});

				await expectPromptCompletes(session.prompt(`a ${stopReason} turn with no content`));
				await session.waitForIdle();

				expect(mock.calls).toHaveLength(4);
				expect(failures.map(event => event.attempt)).toEqual([3]);
				expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
				expect(zeroContentStops(session.agent.state.messages, stopReason)).toHaveLength(0);
				expect(zeroContentStops(branchMessages(session), stopReason)).toHaveLength(0);

				await nudgeTurn(session, `nudge after the ${stopReason} cap`);
				expect(mock.calls).toHaveLength(8);
				expect(failures.map(event => event.attempt)).toEqual([3, 3]);
				expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
			});
			continue;
		}

		it(`does not run the empty-stop cycle for a zero-content ${stopReason} stop`, async () => {
			const { session } = await createHarness([zeroContentStop(stopReason)]);
			const failures: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];
			session.subscribe(event => {
				if (event.type === "auto_retry_end" && !event.success) failures.push(event);
			});

			await expectPromptCompletes(session.prompt(`a ${stopReason} turn with no content`));
			await session.waitForIdle();

			expect(failures.filter(event => (event.finalError ?? "").includes("empty stop"))).toEqual([]);
			expect(reminderMessages(session.agent.state.messages)).toHaveLength(0);
		});
	}
});
