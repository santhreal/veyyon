/**
 * WHY: when every summarizer candidate refused, `#runAutoCompaction` used to
 * return COMPACTION_CHECK_NONE ("nothing happened"). Goal mode, a todo reminder
 * and a session_stop continuation all read that result, so a run at zero
 * headroom started another turn, the provider refused the oversized request,
 * recovery compaction failed the same way, and the cycle repeated with the
 * elapsed clock restarting at 0:00 while the whole history was re-serialized
 * for each refused summary.
 *
 * The failure path now runs the local rescue tiers and, if they cannot create
 * room, parks with BLOCK_AUTOMATIC_CONTINUATION (or drains queued input once)
 * and emits one dead-end warning. Idle compaction stays silent: it is not
 * mid-run and has no continuation to block.
 *
 * Mutation gate: restore the catch's `return COMPACTION_CHECK_NONE` and the
 * threshold/overflow cases fail. Drop the idle early-return and the idle case
 * starts emitting a warning the rollback suite never wanted.
 *
 * This suite spies `compact()` to reject (`Connect error invalid_argument: Error`)
 * and does not install the success-path extension short-circuit used by the
 * progress-guard suite, so the catch in `#runAutoCompaction` is the path under
 * test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Agent } from "@veyyon/agent-core";
import * as compactionModule from "@veyyon/agent-core/compaction";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

const NOTICE_SOURCE = "compaction";
const NO_PROGRESS_FRAGMENT = "Compaction freed too little context to make progress";
const SUMMARIZER_ERROR = new Error("Connect error invalid_argument: Error");

describe("a failed compaction parks the run instead of looping", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-failed-compaction-park-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic/claude-sonnet-4-5 to exist");
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };

		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		seedPriorTurns(sessionManager);

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.autoContinue": true,
				"compaction.remote": false,
				"compaction.keepRecentTokens": 200,
				"retry.enabled": false,
			}),
			modelRegistry,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
		}
	});

	function seedPriorTurns(manager: SessionManager): void {
		const bigText = "lorem ipsum ".repeat(4000);
		for (let i = 0; i < 4; i++) {
			manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: bigText }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "stop",
				usage: {
					input: 1000,
					output: 50,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1050,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			});
			manager.appendMessage({ role: "user", content: "next", timestamp: Date.now() });
		}
	}

	function highUsageAssistant() {
		return {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Done." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 190000,
				output: 1000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	function overflowAssistant() {
		return {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "" }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "error" as const,
			errorMessage: "prompt is too long: 250000 tokens > 200000 maximum",
			usage: {
				input: 250000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 250000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	function incompleteAssistant() {
		return {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "I was generating thoughts..." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "length" as const,
			usage: {
				input: 150000,
				output: 64000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 214000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	function collectNotices() {
		const notices: { level: string; message: string; source?: string }[] = [];
		session.subscribe(event => {
			if (event.type === "notice") {
				notices.push({ level: event.level, message: event.message, source: event.source });
			}
		});
		return notices;
	}

	function countCompactionStarts() {
		const reasons: string[] = [];
		session.subscribe(event => {
			if (event.type === "auto_compaction_start") reasons.push(event.reason);
		});
		return () => reasons;
	}

	function waitForCompactionEnd(): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") resolve();
		});
		return promise;
	}

	function refuseSummarizer() {
		return vi.spyOn(compactionModule, "compact").mockRejectedValue(SUMMARIZER_ERROR);
	}

	function nothingToElide() {
		vi.spyOn(session, "shake").mockResolvedValue({
			mode: "elide",
			toolResultsDropped: 0,
			blocksDropped: 0,
			tokensFreed: 0,
		});
		vi.spyOn(session, "dropImages").mockResolvedValue({ removed: 0 });
	}

	it("parks a threshold failure with one warning and no continuation", async () => {
		session.setTodoPhases([{ name: "Work", tasks: [{ content: "Finish task", status: "in_progress" }] }]);
		const todoReminders: unknown[] = [];
		session.subscribe(event => {
			if (event.type === "todo_reminder") todoReminders.push(event);
		});
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 190000, contextWindow: 200000, percent: 95 });
		nothingToElide();
		const compactSpy = refuseSummarizer();

		const notices = collectNotices();
		const startCount = countCompactionStarts();
		const endWait = waitForCompactionEnd();

		const assistantMsg = highUsageAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });
		await endWait;
		await session.waitForIdle();

		expect(compactSpy).toHaveBeenCalled();
		expect(startCount()).toEqual(["threshold"]);
		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();
		expect(todoReminders.length).toBe(0);
		expect(session.isStreaming).toBe(false);

		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(1);
		expect(noProgress[0]!.level).toBe("warning");
		expect(noProgress[0]!.message).toContain("clear large tool output");
	});

	it("does not warn or block continuation when rescue after summarizer failure creates headroom", async () => {
		session.setTodoPhases([{ name: "Work", tasks: [{ content: "Finish task", status: "in_progress" }] }]);
		const todoReminders: unknown[] = [];
		session.subscribe(event => {
			if (event.type === "todo_reminder") todoReminders.push(event);
		});
		const { promise: submitted, resolve: onSubmitted } = Promise.withResolvers<void>();
		const promptSpy = vi.spyOn(session.agent, "prompt").mockImplementation(async () => {
			onSubmitted();
			return undefined as never;
		});
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		let shaken = false;
		vi.spyOn(session, "getContextUsage").mockImplementation(() =>
			shaken
				? { tokens: 1000, contextWindow: 200000, percent: 0.5 }
				: { tokens: 190000, contextWindow: 200000, percent: 95 },
		);
		const shakeSpy = vi.spyOn(session, "shake").mockImplementation(async () => {
			shaken = true;
			return {
				mode: "elide",
				toolResultsDropped: 1,
				blocksDropped: 0,
				tokensFreed: 160000,
				artifactId: "art-1",
			};
		});
		const compactSpy = refuseSummarizer();

		const notices = collectNotices();
		const endWait = waitForCompactionEnd();

		const assistantMsg = highUsageAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });
		await endWait;
		await session.waitForIdle();
		expect(await Promise.race([submitted.then(() => "submitted"), delay(5_000, "timeout")])).toBe("submitted");

		expect(compactSpy).toHaveBeenCalled();
		expect(shakeSpy).toHaveBeenCalledWith("elide", expect.anything());
		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(todoReminders.length).toBe(0);
		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.map(n => n.message)).toEqual([]);
		const recovery = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("dead-end recovery"));
		expect(recovery.length).toBe(1);
		expect(recovery[0]!.level).toBe("info");
	});

	it("parks an overflow failure the same way and does not retry the refused turn", async () => {
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 205000, contextWindow: 200000, percent: 102.5 });
		nothingToElide();
		const compactSpy = refuseSummarizer();

		const notices = collectNotices();
		const startCount = countCompactionStarts();
		const endWait = waitForCompactionEnd();

		const assistantMsg = overflowAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });
		await endWait;
		await session.waitForIdle();

		expect(compactSpy).toHaveBeenCalled();
		expect(startCount()).toEqual(["overflow"]);
		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();
		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(1);
	});

	it("parks an incomplete response failure the same way and does not retry the truncated turn", async () => {
		session.setTodoPhases([{ name: "Work", tasks: [{ content: "Finish task", status: "in_progress" }] }]);
		const todoReminders: unknown[] = [];
		session.subscribe(event => {
			if (event.type === "todo_reminder") todoReminders.push(event);
		});
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 190000, contextWindow: 200000, percent: 95 });
		nothingToElide();
		const compactSpy = refuseSummarizer();

		const notices = collectNotices();
		const startCount = countCompactionStarts();
		const endWait = waitForCompactionEnd();

		const assistantMsg = incompleteAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });
		await endWait;
		await session.waitForIdle();

		expect(compactSpy).toHaveBeenCalled();
		expect(startCount()).toEqual(["incomplete"]);
		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();
		expect(todoReminders.length).toBe(0);
		expect(session.isStreaming).toBe(false);
		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(1);
	});

	it("still drains queued operator input when the summarizer fails", async () => {
		session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "Queued while compacting" }],
			display: false,
			timestamp: Date.now(),
		});

		const continueSpy = vi.spyOn(session.agent, "continue").mockImplementation(async () => {
			session.agent.clearAllQueues();
		});
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 190000, contextWindow: 200000, percent: 95 });
		nothingToElide();
		refuseSummarizer();

		const notices = collectNotices();
		const endWait = waitForCompactionEnd();

		const assistantMsg = highUsageAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });
		await endWait;
		await session.waitForIdle();

		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress.length).toBe(1);
	});

	it("keeps an idle compaction failure silent", async () => {
		nothingToElide();
		refuseSummarizer();
		const notices = collectNotices();
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);

		await session.runIdleCompaction();
		await session.waitForIdle();

		const noProgress = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
		expect(noProgress).toEqual([]);
		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();
	});
});
