/**
 * WHY THIS SUITE EXISTS.
 *
 * Incident class: "basic behavior tool call failures" — the operator hits Esc
 * while a tool is mid-flight. The required end state, each half of which has
 * regressed before (the `__skipped` discriminator and the `entered` flag
 * exist because an aborted call used to reach the model as the bare word
 * "aborted", with no statement that the tool may have half-run):
 *
 *  1. The cut-short tool call gets a terminal tool-result — not a dangling
 *     pending entry — so the transcript keeps its tool_use/tool_result
 *     pairing and the session file stays loadable.
 *  2. That result says the tool HAD started (`entered: true`), because a
 *     verbatim retry of a half-run tool can double-apply side effects.
 *  3. The session settles: streaming flag down, pending-tool ledger empty,
 *     and the NEXT prompt runs a real turn. A session that wedges after Esc
 *     is the operator-visible form of this bug.
 *
 * This drives the REAL AgentSession (AgentSession.prompt → Agent loop →
 * executeToolCalls → a real registered tool that blocks until its signal
 * fires), not a re-implementation of the abort path: the pending-state
 * assertions only mean something against the production session machinery.
 *
 * MUTATION PLAN (traced through packages/agent/src/agent-loop.ts and
 * agent.ts):
 *
 *  1. Drop the `abortedDuringExecution` branch in `runTool` so the raw thrown
 *     abort error is emitted as the result: the `__skipped` / entered
 *     assertions and the "run being cancelled" text assertion go red (this
 *     exact regression shipped once — see the comment above
 *     `createSkippedToolResult`).
 *  2. Stop clearing `pendingToolCalls` at run end in agent.ts: the
 *     `pendingToolCalls.size).toBe(0)` assertion goes red.
 *  3. Make the loop swallow the abort and keep streaming: `isStreaming` stays
 *     true and `waitForIdle` never returns — the test times out.
 *  4. Lose the tool-result on abort (return without emitting): the follow-up
 *     prompt cannot pair the pending call; the transcript assertion on the
 *     skipped result goes red.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentMessage, type AgentTool } from "@veyyon/agent-core";
import type { ToolResultMessage } from "@veyyon/ai";
import { createMockModel, type MockResponse } from "@veyyon/ai/providers/mock";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";
import { type } from "arktype";

// AgentSession schedules post-abort recovery through `scheduler.wait` with
// blind settle delays. Collapsing them to a macrotask hop (same convention as
// agent-session-concurrent.test.ts) keeps the abort continuation
// deterministic without changing abort-signal semantics.
const originalSchedulerWait = scheduler.wait.bind(scheduler);

/** Scripted plain-text assistant turn that ends the loop. */
function stopReply(text: string): MockResponse {
	return {
		content: [{ type: "text", text }],
		stopReason: "stop",
	};
}

/** Find the persisted tool result for one call id in the live transcript. */
function findToolResult(messages: AgentMessage[], callId: string): ToolResultMessage | undefined {
	for (const message of messages) {
		if (message.role === "toolResult" && message.toolCallId === callId) return message;
	}
	return undefined;
}

/** Join the text blocks of a tool result for assertion. */
function toolResultText(message: ToolResultMessage): string {
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") parts.push(block.text);
	}
	return parts.join("\n");
}

describe("aborting mid-tool settles the session with no dangling pending state", () => {
	let tempDir: string;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession;
	let mock: ReturnType<typeof createMockModel>;
	let scriptedResponses: MockResponse[];
	let toolEntered: Promise<void>;
	let markToolEntered: () => void;

	beforeEach(async () => {
		vi.spyOn(scheduler, "wait").mockImplementation((_delayMs, options) => originalSchedulerWait(0, options));

		tempDir = path.join(os.tmpdir(), `pi-tcinv-abort-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });

		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir });

		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected claude-sonnet-4-5 to be bundled");

		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"todo.eager": "default",
			"todo.reminders": false,
			"async.enabled": false,
		});
		const sessionManager = SessionManager.inMemory(tempDir);

		({ promise: toolEntered, resolve: markToolEntered } = Promise.withResolvers<void>());

		// A tool that behaves like a real side-effecting one: it starts, then
		// runs until its signal fires, at which point it rejects the way real
		// tools reject on abort. Until the abort it never settles on its own.
		const blockingTool: AgentTool = {
			name: "long_task",
			label: "Long Task",
			description: "A tool that runs until aborted",
			parameters: type({}),
			strict: true,
			async execute(_toolCallId, _args, signal) {
				markToolEntered();
				const aborted = Promise.withResolvers<never>();
				signal?.addEventListener(
					"abort",
					() => aborted.reject(new DOMException("The operation was aborted", "AbortError")),
					{ once: true },
				);
				return aborted.promise;
			},
		};

		scriptedResponses = [];
		mock = createMockModel({
			handler: () => scriptedResponses.shift() ?? stopReply("fallback reply"),
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [blockingTool],
				messages: [],
			},
			convertToLlm,
			streamFn: mock.stream,
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map([[blockingTool.name, blockingTool]]),
		});
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		authStorage = undefined;
		if (fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
		vi.restoreAllMocks();
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	it("a tool cut short by Esc gets a skipped result, the session settles, and the next prompt runs", async () => {
		const callId = "call_blocked";
		// Only the first turn is scripted; every later call (any post-abort
		// continuation the session schedules, and the explicit follow-up below)
		// gets the same fallback reply, so the assertions do not depend on how
		// many recovery turns fire.
		scriptedResponses = [
			{
				content: [{ type: "toolCall", id: callId, name: "long_task", arguments: {} }],
			},
		];

		const running = session.prompt("start the long task");
		// The tool is inside execute() — side effects may be partial — before
		// the abort lands. This ordering is the whole point of the test.
		await toolEntered;
		await session.abort();
		await session.waitForIdle();
		// An aborted prompt rejects; the settlement assertions below are the test.
		await running.catch(() => {});

		// 1. The call has a terminal result — the transcript is not left with a
		// dangling tool_use that no tool_result pairs with.
		const result = findToolResult(session.agent.state.messages, callId);
		expect(result, "expected a toolResult for the aborted call").toBeDefined();
		if (!result) throw new Error("unreachable");
		expect(result.isError).toBe(true);

		// 2. It says the tool had STARTED. `entered: true` is what stops a
		// downstream consumer from telling the model a verbatim retry is safe.
		const details = result.details;
		if (details === null || typeof details !== "object") {
			throw new Error("expected a details bag on the skipped result");
		}
		expect("__skipped" in details && details.__skipped).toBe(true);
		expect("entered" in details && details.entered).toBe(true);
		expect("source" in details && details.source).toBe("cancelled-run");
		const text = toolResultText(result);
		expect(text).toContain("Skipped due to the run being cancelled.");
		expect(text).toContain("may have applied partial side effects");

		// 3. The session settled: nothing pending, not streaming.
		expect(session.agent.state.pendingToolCalls.size).toBe(0);
		expect(session.isStreaming).toBe(false);

		// 4. The next prompt runs a real turn — the session is not wedged.
		const callsBefore = mock.calls.length;
		await expect(session.prompt("are you still there")).resolves.toBe(true);
		await session.waitForIdle();
		expect(mock.calls.length).toBe(callsBefore + 1);
		expect(session.agent.state.pendingToolCalls.size).toBe(0);
		expect(session.isStreaming).toBe(false);
		const last = session.agent.state.messages.at(-1);
		expect(last?.role).toBe("assistant");
		if (last?.role === "assistant") {
			const texts: string[] = [];
			for (const block of last.content) {
				if (block.type === "text") texts.push(block.text);
			}
			expect(texts.join("\n")).toContain("fallback reply");
		}
	});
});
