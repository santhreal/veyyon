/**
 * WHY: a recovery wait announces itself with `auto_retry_start` before it creates the abort
 * controller its sleep listens to. `isRetrying` is already true while the announcement drains, so a
 * cancel that lands there (escape, `abort_retry` over RPC, a subscriber or extension reacting to
 * the start) reaches `abortRetry()` with no controller to abort. The retry ladder re-checks its gate
 * after creating the controller; the unreplayable-batch continuation did not, so the cancel was
 * lost: the continuation slept, re-requested the turn and reported a recovery the caller had
 * cancelled.
 *
 * Class closed: a cancel landing inside the announcement of every recovery wait that
 * `auto_retry_start` reports. The table is keyed by `RetryRecoveryMode`, so a new mode fails the type
 * check until it gets a row, and each row asserts its start event reports that mode, so a row that
 * reaches the wrong wait fails too.
 *
 * Gap: the cancel is delivered from a session subscriber, the last listener the announcement
 * reaches. A cancel during the extension forward that precedes it hits the same window and is not
 * exercised separately.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@veyyon/agent-core";
import type { AssistantMessage, Model, ToolCall } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { RetryRecoveryMode } from "@veyyon/coding-agent/modes/retry-display";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

type AutoRetryStartEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;
type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

/** Bound on a prompt whose recovery was cancelled; every wait below resolves at once. */
const SETTLE_BOUND_MS = 2_000;

const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!bundled) throw new Error("missing bundled model anthropic/claude-sonnet-4-5");
const model = bundled as Model;
const TIMEOUT = "The operation timed out.";

interface RecoveryCase {
	/** Context the session starts from. */
	seed(agent: Agent): void;
	/** The content of the failed first request: what decides which recovery the failure gets. */
	failedContent(): AssistantMessage["content"];
	/** The `auto_retry_end` text a cancelled wait of this recovery reports. */
	cancelled: string;
}

const writeCall: ToolCall = {
	type: "toolCall",
	id: "tc-write-ran",
	name: "write",
	arguments: { path: "doc/report.md", content: "report chunk" },
};

/** One row per recovery that waits behind `auto_retry_start`. */
const RECOVERIES: Record<RetryRecoveryMode, RecoveryCase> = {
	// A timeout before any output is resent as is.
	retry: {
		seed: () => {},
		failedContent: () => [],
		cancelled: "Retry cancelled",
	},
	// A timeout after the batch's call already ran cannot be resent, so the turn is continued.
	continue: {
		seed: agent =>
			agent.appendMessage({
				role: "toolResult",
				toolCallId: writeCall.id,
				toolName: writeCall.name,
				content: [{ type: "text", text: "wrote doc/report.md" }],
				isError: false,
				timestamp: Date.now(),
			}),
		failedContent: () => [writeCall],
		cancelled: "Continuation cancelled",
	},
};

let tempDir: TempDir;
let authStorage: AuthStorage;
let registry: ModelRegistry;

beforeAll(async () => {
	tempDir = TempDir.createSync("@recovery-wait-cancel-");
	authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
	registry = new ModelRegistry(authStorage);
});

afterAll(() => {
	authStorage.close();
	tempDir.removeSync();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("a cancel that lands while a recovery wait is announced cancels it", () => {
	for (const [mode, recovery] of Object.entries(RECOVERIES)) {
		it(
			mode,
			async () => {
				// Every sleep ends at once unless its signal was aborted before it began, which is the
				// one fact this suite observes: whether the cancel reached the sleep.
				vi.spyOn(scheduler, "wait").mockImplementation((_delay, options) =>
					options?.signal?.aborted ? Promise.reject(options.signal.reason) : Promise.resolve(),
				);
				let requests = 0;
				const agent = new Agent({
					getApiKey: requested => `${requested.provider}-test-key`,
					initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
					streamFn: () => {
						requests += 1;
						const first = requests === 1;
						const stream = new AssistantMessageEventStream();
						queueMicrotask(() => {
							if (first) {
								const partial = assistant(recovery.failedContent());
								stream.push({ type: "start", partial });
								for (const [contentIndex, block] of partial.content.entries()) {
									if (block.type === "toolCall")
										stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
								}
								stream.push({
									type: "error",
									reason: "error",
									error: { ...partial, stopReason: "error", errorMessage: TIMEOUT },
								});
								return;
							}
							const done = assistant([{ type: "text", text: "recovered" }]);
							stream.push({ type: "start", partial: done });
							stream.push({ type: "done", reason: "stop", message: done });
						});
						return stream;
					},
				});
				recovery.seed(agent);
				const settings = Settings.isolated({
					"compaction.enabled": false,
					"retry.baseDelayMs": 5,
					"retry.maxRetries": 2,
				});
				settings.setModelRole("default", `${model.provider}/${model.id}`);
				const session = new AgentSession({
					agent,
					sessionManager: SessionManager.inMemory(),
					settings,
					modelRegistry: registry,
				});
				const starts: AutoRetryStartEvent[] = [];
				const ends: AutoRetryEndEvent[] = [];
				session.subscribe(event => {
					if (event.type === "auto_retry_start") {
						starts.push(event);
						session.abortRetry();
					}
					if (event.type === "auto_retry_end") ends.push(event);
				});

				try {
					await session.prompt("Write the report");
					await session.waitForIdle();

					expect(starts.map((event): string => event.mode ?? "retry")).toEqual([mode]);
					// The cancelled wait never re-requested the turn.
					expect(requests).toBe(1);
					expect(ends.map(event => ({ success: event.success, finalError: event.finalError }))).toEqual([
						{ success: false, finalError: recovery.cancelled },
					]);
					expect(session.isRetrying).toBe(false);
					expect(session.retryAttempt).toBe(0);
				} finally {
					await session.dispose();
				}
			},
			SETTLE_BOUND_MS,
		);
	}
});
