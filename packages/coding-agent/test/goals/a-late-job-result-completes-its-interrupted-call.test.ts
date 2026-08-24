/**
 * WHY: an interrupted tool call whose job outlived the split came back as a NEW autonomous
 * turn. A continuation, abort or crash can separate a tool call from its result: the branch
 * ends on the assistant's `toolCall` block, the session resumes with that call pending, and
 * when the background job's result finally arrived it was queued as an `async-result`
 * follow-up — a full recap turn asking the model to reason over an arrival the transcript
 * could have recorded directly. Under a long goal this repeated: every split produced one
 * extra low-value reasoning cycle.
 *
 * The class this closes: late async results must attach to their original tool call whenever
 * that call is still pending in the live context, and only the cases where the call can
 * no longer be completed — answered already, or gone from the context — may take the recap
 * follow-up. The suite drives the real delivery path: a real `AgentSession` whose agent holds
 * the shape an interrupted turn leaves in-process (the assistant's `toolCall` block with no
 * `toolResult`, mirrored on the persisted branch exactly as `collectPendingToolCalls` reports
 * it), a real `AsyncJobManager` whose `onJobComplete` is wired exactly as the SDK wires it,
 * and a real registered job carrying the pending call's id.
 *
 * What it does not catch: the provider-side orphan-placeholder repair itself
 * (`ORPHAN_TOOL_CALL_PLACEHOLDER` in `@veyyon/ai`), which is request-time grammar repair and
 * unchanged; this suite pins the delivery decision that keeps that repair as the fallback
 * rather than the only outcome.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage, ToolResultMessage } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { AsyncJobManager } from "@veyyon/coding-agent/async";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { collectPendingToolCalls } from "@veyyon/coding-agent/session/exit-diagnostics";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

const CALL_ID = "call_cooldown";

function interruptedBashCall(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: CALL_ID,
				name: "bash",
				arguments: { command: "sleep 900 && curl -sf https://target.example/health" },
			},
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function toolResultText(messages: AgentMessage[], toolCallId: string): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "toolResult" || message.toolCallId !== toolCallId) continue;
		return message.content.find(block => block.type === "text")?.text;
	}
	return undefined;
}

describe("a late job result completes its interrupted call", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let agent: Agent;
	let manager: AsyncJobManager;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-late-tool-result-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic test model");

		// Interrupted-turn shape: the assistant's toolCall block sits in the live
		// context with no toolResult, and the persisted branch ends the same way —
		// what an abort or crash mid-tool leaves behind.
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const userMessage: AgentMessage = { role: "user", content: "watch the target", timestamp: Date.now() };
		const callMessage = interruptedBashCall();
		sessionManager.appendMessage(userMessage);
		sessionManager.appendMessage(callMessage);

		agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [userMessage, callMessage] },
		});
		// Production wiring (sdk.ts): the manager's completion callback delivers
		// through the session, which decides attach-vs-recap.
		manager = new AsyncJobManager({
			onJobComplete: (jobId, text, job) => {
				session.deliverAsyncJobResult(jobId, text, job);
			},
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "goal.enabled": true }),
			modelRegistry,
			asyncJobManager: manager,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await manager?.dispose();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("attaches the result to the still-pending call and enqueues no model turn", async () => {
		// Precondition: the persisted branch really is the interrupted shape the
		// resume warning reports.
		expect(collectPendingToolCalls(session.sessionManager.getBranch()).map(call => call.toolCallId)).toEqual([
			CALL_ID,
		]);
		const promptSpy = vi.spyOn(agent, "prompt");

		manager.register("bash", "bash: sleep 900 && curl target", async () => "cooldown over; endpoint answers", {
			toolCallId: CALL_ID,
		});
		await manager.waitForAll();
		expect(await manager.drainDeliveries({ timeoutMs: 2_000 })).toBe(true);

		// The original call is complete: the result message sits in the live context
		// and on the persisted branch, paired with its call.
		const resultText = toolResultText(agent.state.messages, CALL_ID);
		expect(resultText).toContain("cooldown over; endpoint answers");
		expect(collectPendingToolCalls(session.sessionManager.getBranch())).toEqual([]);

		// No recap turn: nothing prompted the model, and nothing was queued as an
		// async-result follow-up.
		expect(promptSpy).not.toHaveBeenCalled();
		expect(session.yieldQueue.has()).toBe(false);
	});

	it("keeps the recap follow-up for a call that already has its result", async () => {
		// Same job, but the call was answered before the result arrived: attaching a
		// second result would duplicate the pair, so the ordinary follow-up delivers.
		session.deliverAsyncJobResult("bg_early", "first delivery", {
			id: "bg_early",
			type: "bash",
			status: "completed",
			startTime: Date.now(),
			label: "bash: early",
			abortController: new AbortController(),
			promise: Promise.resolve(),
			toolCallId: CALL_ID,
		});
		session.yieldQueue.register<{ jobId: string }>("async-result", {
			build: survivors => ({
				role: "custom",
				customType: "async-result",
				content: survivors.map(entry => entry.jobId).join(","),
				display: true,
				timestamp: Date.now(),
			}),
		});

		const outcome = session.deliverAsyncJobResult("bg_late", "second delivery", {
			id: "bg_late",
			type: "bash",
			status: "completed",
			startTime: Date.now(),
			label: "bash: late",
			abortController: new AbortController(),
			promise: Promise.resolve(),
			toolCallId: CALL_ID,
		});

		expect(outcome).toBe("queued");
		expect(session.yieldQueue.has("async-result")).toBe(true);
		// Exactly one result for the call: the attach from the first delivery stands alone.
		const results = agent.state.messages.filter(
			message => message.role === "toolResult" && message.toolCallId === CALL_ID,
		);
		expect(results).toHaveLength(1);
		expect(toolResultText(agent.state.messages, CALL_ID)).toBe("first delivery");
	});

	it("keeps the recap follow-up when the call is gone from the context", () => {
		session.yieldQueue.register<{ jobId: string }>("async-result", {
			build: survivors => ({
				role: "custom",
				customType: "async-result",
				content: survivors.map(entry => entry.jobId).join(","),
				display: true,
				timestamp: Date.now(),
			}),
		});

		// The session moved past the call: no toolCall block names it, so there is
		// nothing to complete and the result must reach the model the way
		// it always has. The provider-side orphan-placeholder repair covers any
		// still-unanswered call at request time.
		const outcome = session.deliverAsyncJobResult("bg_orphan", "orphaned output", {
			id: "bg_orphan",
			type: "bash",
			status: "completed",
			startTime: Date.now(),
			label: "bash: gone",
			abortController: new AbortController(),
			promise: Promise.resolve(),
			toolCallId: "call_that_left_the_branch",
		});

		expect(outcome).toBe("queued");
		expect(session.yieldQueue.has("async-result")).toBe(true);
		expect(toolResultText(agent.state.messages, "call_that_left_the_branch")).toBeUndefined();
	});

	it("keeps the recap follow-up for a job that never named its call", () => {
		session.yieldQueue.register<{ jobId: string }>("async-result", {
			build: survivors => ({
				role: "custom",
				customType: "async-result",
				content: survivors.map(entry => entry.jobId).join(","),
				display: true,
				timestamp: Date.now(),
			}),
		});

		const outcome = session.deliverAsyncJobResult("bg_plain", "plain output", undefined);

		expect(outcome).toBe("queued");
		expect(session.yieldQueue.has("async-result")).toBe(true);
	});

	it("attaches a failed job result with isError and failed async state to the pending call", () => {
		const outcome = session.deliverAsyncJobResult("bg_fail", "command failed with exit code 1", {
			id: "bg_fail",
			type: "bash",
			status: "failed",
			startTime: Date.now(),
			label: "bash: failing",
			abortController: new AbortController(),
			promise: Promise.resolve(),
			toolCallId: CALL_ID,
		});

		expect(outcome).toBe("attached");
		const msg = agent.state.messages.find(
			m => m.role === "toolResult" && m.toolCallId === CALL_ID,
		) as ToolResultMessage;
		expect(msg).toBeDefined();
		expect(msg.isError).toBe(true);
		expect(msg.details).toEqual({ async: { state: "failed", jobId: "bg_fail" } });
		expect(toolResultText(agent.state.messages, CALL_ID)).toBe("command failed with exit code 1");
		expect(collectPendingToolCalls(session.sessionManager.getBranch())).toEqual([]);
	});

	it("attaches multiple interrupted tool calls independently and out-of-order", () => {
		const CALL_1 = "call_task_1";
		const CALL_2 = "call_task_2";
		const multiCallMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: CALL_1,
					name: "task",
					arguments: { prompt: "run task 1" },
				},
				{
					type: "toolCall",
					id: CALL_2,
					name: "task",
					arguments: { prompt: "run task 2" },
				},
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};

		agent.appendMessage(multiCallMessage);
		session.sessionManager.appendMessage(multiCallMessage);

		expect(collectPendingToolCalls(session.sessionManager.getBranch()).map(call => call.toolCallId)).toContain(
			CALL_1,
		);
		expect(collectPendingToolCalls(session.sessionManager.getBranch()).map(call => call.toolCallId)).toContain(
			CALL_2,
		);

		// Complete CALL_2 first, then CALL_1
		const outcome2 = session.deliverAsyncJobResult("job_2", "task 2 result", {
			id: "job_2",
			type: "task",
			status: "completed",
			startTime: Date.now(),
			label: "task: 2",
			abortController: new AbortController(),
			promise: Promise.resolve(),
			toolCallId: CALL_2,
		});
		expect(outcome2).toBe("attached");
		expect(toolResultText(agent.state.messages, CALL_2)).toBe("task 2 result");
		expect(collectPendingToolCalls(session.sessionManager.getBranch()).map(call => call.toolCallId)).not.toContain(
			CALL_2,
		);
		expect(collectPendingToolCalls(session.sessionManager.getBranch()).map(call => call.toolCallId)).toContain(
			CALL_1,
		);

		const outcome1 = session.deliverAsyncJobResult("job_1", "task 1 result", {
			id: "job_1",
			type: "task",
			status: "completed",
			startTime: Date.now(),
			label: "task: 1",
			abortController: new AbortController(),
			promise: Promise.resolve(),
			toolCallId: CALL_1,
		});
		expect(outcome1).toBe("attached");
		expect(toolResultText(agent.state.messages, CALL_1)).toBe("task 1 result");
		expect(collectPendingToolCalls(session.sessionManager.getBranch())).toEqual([]);
	});

	it("ensures one-time delivery to the pending call and does not duplicate on re-delivery", () => {
		const outcome1 = session.deliverAsyncJobResult("job_once", "initial completion", {
			id: "job_once",
			type: "bash",
			status: "completed",
			startTime: Date.now(),
			label: "bash: once",
			abortController: new AbortController(),
			promise: Promise.resolve(),
			toolCallId: CALL_ID,
		});
		expect(outcome1).toBe("attached");

		session.yieldQueue.register<{ jobId: string }>("async-result", {
			build: survivors => ({
				role: "custom",
				customType: "async-result",
				content: survivors.map(entry => entry.jobId).join(","),
				display: true,
				timestamp: Date.now(),
			}),
		});

		const outcome2 = session.deliverAsyncJobResult("job_once", "duplicate completion", {
			id: "job_once",
			type: "bash",
			status: "completed",
			startTime: Date.now(),
			label: "bash: once",
			abortController: new AbortController(),
			promise: Promise.resolve(),
			toolCallId: CALL_ID,
		});
		expect(outcome2).toBe("queued");

		const results = agent.state.messages.filter(m => m.role === "toolResult" && m.toolCallId === CALL_ID);
		expect(results).toHaveLength(1);
		expect(toolResultText(agent.state.messages, CALL_ID)).toBe("initial completion");
	});

	it("drains in-flight deliveries through manager.waitForAll and attaches to the pending call", async () => {
		const { promise: jobPromise, resolve: finishJob } = Promise.withResolvers<string>();

		manager.register("bash", "bash: async wait", async () => jobPromise, {
			toolCallId: CALL_ID,
		});

		// Job is running; call is pending
		expect(collectPendingToolCalls(session.sessionManager.getBranch()).map(c => c.toolCallId)).toEqual([CALL_ID]);

		// Finish the job and wait for manager drain
		finishJob("late async finished");
		await manager.waitForAll();
		expect(await manager.drainDeliveries({ timeoutMs: 2_000 })).toBe(true);

		expect(toolResultText(agent.state.messages, CALL_ID)).toBe("late async finished");
		expect(collectPendingToolCalls(session.sessionManager.getBranch())).toEqual([]);
	});
});
