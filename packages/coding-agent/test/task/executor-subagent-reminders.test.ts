import { afterEach, describe, expect, it, vi } from "bun:test";
import { AgentBusyError, type AgentTelemetryConfig, type Tracer } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { Effort } from "@veyyon/catalog/effort";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ExtensionActions } from "@veyyon/coding-agent/extensibility/extensions/types";
import * as sdkModule from "@veyyon/coding-agent/sdk";
import type { AgentSession, PromptOptions } from "@veyyon/coding-agent/session/agent-session";
import type { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import {
	finalizeSubprocessOutput,
	runSubprocess,
	SUBAGENT_WARNING_MISSING_YIELD,
} from "@veyyon/coding-agent/task/executor";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";
import { logger } from "@veyyon/utils";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
import {
	createAssistantStopMessage,
	createMockSession,
	createMockSessionHandle,
	createSessionResult,
} from "../helpers/subagent-session";

// Spawning a task writes a session (and, for worktree runs, a checkout) under the
// ACTIVE PROFILE's agent dir, so without this the suite creates them inside the
// developer's real `~/.veyyon/profiles/<profile>/agent`.
useIsolatedAgentDir();

function mockCreateAgentSession(session: AgentSession) {
	return vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
}

describe("runSubprocess yield reminders", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const baseAgent: AgentDefinition = {
		name: "task",
		description: "test",
		systemPrompt: "test",
		source: "bundled",
	};

	const baseOptions = {
		cwd: "/tmp",
		agent: baseAgent,
		task: "do work",
		index: 0,
		id: "subagent-1",
		settings: Settings.isolated(),
		modelRegistry: {
			refresh: async () => {},
		} as unknown as import("@veyyon/coding-agent/config/model-registry").ModelRegistry,
		enableLsp: false,
	};

	it("waits for session_start extension user messages before prompting the subagent", async () => {
		let extensionSendUserMessage: ExtensionActions["sendUserMessage"] | undefined;
		let messageInFlight = false;
		let sendStarted = false;

		const session = createMockSession(({ emit }) => {
			if (messageInFlight) {
				throw new AgentBusyError();
			}
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-extension-session-start",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});
		const mutableSession = session as unknown as {
			extensionRunner: NonNullable<AgentSession["extensionRunner"]>;
			sendUserMessage: AgentSession["sendUserMessage"];
		};
		mutableSession.sendUserMessage = async () => {
			sendStarted = true;
			messageInFlight = true;
			await Bun.sleep(20);
			messageInFlight = false;
		};
		mutableSession.extensionRunner = {
			initialize: (actions: ExtensionActions) => {
				extensionSendUserMessage = actions.sendUserMessage;
			},
			onError: () => {},
			emit: async (event: { type: string }) => {
				if (event.type === "session_start") {
					extensionSendUserMessage?.("hello from session_start", { deliverAs: "followUp" });
				}
				return undefined;
			},
		} as unknown as NonNullable<AgentSession["extensionRunner"]>;

		mockCreateAgentSession(session);

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-session-start-extension",
		});

		expect(sendStarted).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.error).toBeUndefined();
	});

	it("skips modelRegistry.refresh when reusing the parent registry", async () => {
		const session = createMockSession(({ emit }) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-skip-refresh",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});
		const createAgentSessionSpy = mockCreateAgentSession(session);
		const modelRegistry = {
			refresh: async () => {},
		} as unknown as import("@veyyon/coding-agent/config/model-registry").ModelRegistry;
		const refreshSpy = vi.spyOn(modelRegistry, "refresh");

		await runSubprocess({ ...baseOptions, id: "subagent-skip-refresh", modelRegistry });

		expect(refreshSpy).not.toHaveBeenCalled();
		expect(createAgentSessionSpy).toHaveBeenCalledTimes(1);
	});

	it("splices the subagent role prompt before the trailing system section", async () => {
		let userPrompt = "";
		const session = createMockSession(({ text, emit }) => {
			userPrompt = text;
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-context-system",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});
		const createAgentSessionSpy = mockCreateAgentSession(session);

		await runSubprocess({
			...baseOptions,
			id: "subagent-context-system",
			task: "Your assignment is below.\nBe thorough and complete fully before yielding.\n\nDo the task.",
		});

		const systemPromptBuilder = createAgentSessionSpy.mock.calls[0]?.[0]?.systemPrompt;
		expect(systemPromptBuilder).toBeFunction();
		if (typeof systemPromptBuilder !== "function") throw new Error("Expected system prompt builder");
		const systemPrompt = systemPromptBuilder(["system", "project", "now"]);

		expect(systemPrompt).toHaveLength(4);
		expect(systemPrompt?.[0]).toBe("system");
		expect(systemPrompt?.[1]).toBe("project");
		expect(systemPrompt?.[2]).toMatch(/ROLE\n=+\n\ntest/);
		expect(systemPrompt?.[2]).toContain("# IRC Coordination");
		expect(systemPrompt?.[2]).toContain('call `irc` with `op:"list"`');
		expect(systemPrompt?.[2]).not.toContain("subagent-context-system");
		// The parent-conversation CONTEXT section is gone: subagents get their
		// background inside the assignment (or a local:// file), never a dump.
		expect(systemPrompt?.[2]).not.toMatch(/CONTEXT\n=+/);
		expect(systemPrompt?.[3]).toBe("now");
		expect(userPrompt).not.toMatch(/CONTEXT\n=+/);
	});

	it("sends reminder prompt when subagent stops without yield", async () => {
		const prompts: string[] = [];
		const promptOptions: Array<PromptOptions | undefined> = [];
		const session = createMockSession(({ text, options, promptIndex, emit, state }) => {
			prompts.push(text);
			promptOptions.push(options);
			if (promptIndex === 1) {
				const assistant = createAssistantStopMessage("did some work");
				state.messages.push(assistant);
				emit({ type: "message_end", message: assistant });
				return;
			}
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { done: true } },
				},
				isError: false,
			});
		});

		mockCreateAgentSession(session);

		const result = await runSubprocess(baseOptions);
		expect(prompts.length).toBe(2);
		expect(promptOptions).toHaveLength(2);
		expect(promptOptions[0]?.attribution).toBe("agent");
		expect(promptOptions[1]?.attribution).toBe("agent");
		expect(result.output).toContain('"done": true');
		expect(result.output.includes("SYSTEM WARNING")).toBe(false);
	});

	it("keeps null yield warning when subagent submits success without data", async () => {
		const session = createMockSession(({ promptIndex, emit, state }) => {
			if (promptIndex === 1) {
				const assistant = createAssistantStopMessage("partial output");
				state.messages.push(assistant);
				emit({ type: "message_end", message: assistant });
				return;
			}
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-2",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success" },
				},
				isError: false,
			});
		});

		mockCreateAgentSession(session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-2" });
		expect(result.output).toContain("SYSTEM WARNING: Subagent called yield with null data.");
	});

	it("retries when yield tool returns an error before succeeding", async () => {
		const prompts: string[] = [];
		const session = createMockSession(({ text, promptIndex, emit, state }) => {
			prompts.push(text);
			if (promptIndex === 1) {
				const assistant = createAssistantStopMessage("attempted yield");
				state.messages.push(assistant);
				emit({ type: "message_end", message: assistant });
				emit({
					type: "tool_execution_end",
					toolCallId: "tool-error",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "Output does not match schema" }],
						details: { status: "error", error: "Output does not match schema" },
					},
					isError: true,
				});
				return;
			}
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-success",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});

		mockCreateAgentSession(session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-err-then-success" });
		expect(prompts).toHaveLength(2);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('"ok": true');
	});

	it("waits for yield-triggered abort cleanup before resolving the subagent", async () => {
		const promptCleanup = Promise.withResolvers<void>();
		const abortCleanup = Promise.withResolvers<void>();
		const validYieldEmitted = Promise.withResolvers<void>();
		let abortCalls = 0;
		const session = createMockSession(async ({ promptIndex, emit, state }) => {
			if (promptIndex === 1) {
				const assistant = createAssistantStopMessage("malformed yield attempt");
				state.messages.push(assistant);
				emit({ type: "message_end", message: assistant });
				emit({
					type: "tool_execution_end",
					toolCallId: "tool-malformed",
					toolName: "yield",
					result: {
						content: [{ type: "text", text: "result must be an object containing either data or error" }],
						details: { status: "error", error: "result must be an object containing either data or error" },
					},
					isError: true,
				});
				return;
			}

			emit({
				type: "tool_execution_end",
				toolCallId: "tool-success-after-malformed",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
			validYieldEmitted.resolve();
			await promptCleanup.promise;
		});
		(session as unknown as { abort: () => Promise<void> }).abort = async () => {
			abortCalls += 1;
			promptCleanup.resolve();
			await abortCleanup.promise;
		};

		mockCreateAgentSession(session);

		let settled = false;
		const resultPromise = runSubprocess({ ...baseOptions, id: "subagent-yield-abort-cleanup" }).finally(() => {
			settled = true;
		});

		await validYieldEmitted.promise;
		await Bun.sleep(20);
		expect(abortCalls).toBe(1);
		expect(settled).toBe(false);

		abortCleanup.resolve();
		const result = await resultPromise;
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain('"ok": true');
	});

	it("keeps a real run failure from being masked by a successful yield", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "partial output",
			exitCode: 1,
			stderr: "Provider returned error finish_reason",
			doneAborted: false,
			signalAborted: false,
			yieldItems: [{ status: "success", data: { ok: true } }],
			outputSchema: undefined,
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("Provider returned error finish_reason");
		expect(result.rawOutput).toContain('"ok": true');
	});

	it("lets a valid yield clear internal termination without stderr", () => {
		const result = finalizeSubprocessOutput({
			rawOutput: "",
			exitCode: 1,
			stderr: "",
			doneAborted: true,
			signalAborted: false,
			yieldItems: [{ status: "success", data: { ok: true } }],
			outputSchema: undefined,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.rawOutput).toContain('"ok": true');
	});
	it("uses provided thinking level when model override has no explicit suffix", async () => {
		vi.clearAllMocks();
		const session = createMockSession(({ emit }) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-thinking-fallback",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});

		const createAgentSessionSpy = mockCreateAgentSession(session);

		const modelRegistry = {
			refresh: async () => {},
			getAvailable: () => [{ provider: "openai", id: "gpt-4o", name: "GPT-4o" }],
		} as unknown as import("@veyyon/coding-agent/config/model-registry").ModelRegistry;

		await runSubprocess({
			...baseOptions,
			id: "subagent-thinking-fallback",
			modelOverride: "openai/gpt-4o",
			thinkingLevel: Effort.High,
			modelRegistry,
		});

		expect(createAgentSessionSpy).toHaveBeenCalledTimes(1);
		expect(createAgentSessionSpy.mock.calls[0]?.[0]?.thinkingLevel).toBe(Effort.High);
	});
	it("fails after 3 reminders when yield is never called for a structured task", async () => {
		const prompts: string[] = [];
		const session = createMockSession(({ text, promptIndex, emit, state }) => {
			prompts.push(text);
			const assistant = createAssistantStopMessage(promptIndex === 1 ? "did work" : "still no yield");
			state.messages.push(assistant);
			emit({ type: "message_end", message: assistant });
		});

		mockCreateAgentSession(session);

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-3",
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		});
		expect(prompts).toHaveLength(4);
		expect(result.exitCode).toBe(1);
		expect(result.aborted).toBe(false);
		expect(result.stderr).toBe(SUBAGENT_WARNING_MISSING_YIELD);
		expect(result.abortReason).toBeUndefined();
	});

	it("surfaces abort reason when yield reports aborted status", async () => {
		const session = createMockSession(({ promptIndex, emit, state }) => {
			if (promptIndex === 1) {
				const assistant = createAssistantStopMessage("cannot proceed");
				state.messages.push(assistant);
				emit({ type: "message_end", message: assistant });
			}
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-abort",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Task aborted: blocked by permissions" }],
					details: { status: "aborted", error: "blocked by permissions" },
				},
				isError: false,
			});
		});

		mockCreateAgentSession(session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-aborted-yield" });
		expect(result.aborted).toBe(true);
		expect(result.abortReason).toBe("blocked by permissions");
	});

	it("marks pre-aborted subprocess with a concrete reason", async () => {
		const abortController = new AbortController();
		abortController.abort("caller cancelled task");

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-cancelled-before-start",
			signal: abortController.signal,
		});

		expect(result.aborted).toBe(true);
		expect(result.abortReason).toBe("Cancelled before start");
		expect(result.stderr).toBe("Cancelled before start");
	});

	it("surfaces the assistant abort message instead of 'Cancelled by caller' on an internal turn abort", async () => {
		// No caller signal and no runtime limit: the subagent's own turn ended with
		// stopReason "aborted" (e.g. a merged request-signal abort). abortReason is
		// undefined, so the executor must report the assistant's real errorMessage,
		// not the generic caller-cancellation fallback. This is also what the eval
		// agent() bridge re-raises, so a blank/misleading reason here surfaces as an
		// opaque "bridge call '__agent__' failed".
		const session = createMockSession(({ emit, state }) => {
			const aborted: AssistantMessage = {
				...createAssistantStopMessage(""),
				stopReason: "aborted",
				errorMessage: "Request was aborted",
			};
			state.messages.push(aborted);
			emit({ type: "message_end", message: aborted });
		});

		mockCreateAgentSession(session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-internal-abort" });

		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBe(1);
		expect(result.abortReason).toBe("Request was aborted");
		expect(result.abortReason).not.toBe("Cancelled by caller");
		expect(result.error).toBeUndefined();
		expect(result.stderr).toBe("");
	});

	/**
	 * A model error is a FAILURE, not a cancellation, and it must carry the provider's own words.
	 *
	 * The two are told apart by the terminal stop reason: `aborted` above is a cancellation and reports
	 * as aborted, `error` here is a failure and reports as one. Getting that backwards is what turns a
	 * rate-limit cap into a mysterious "cancelled" run with no reason to act on, and an on-call
	 * engineer cannot tell those apart from the outside.
	 *
	 * Also pins that the reminder ladder does NOT run: re-prompting a subagent whose provider just
	 * refused would hit the same wall three more times and multiply the failure noise.
	 */
	it("fails with the provider's message when the subagent's turn ended in an error", async () => {
		const handle = createMockSessionHandle(({ emit, state }) => {
			const failed: AssistantMessage = {
				...createAssistantStopMessage(""),
				stopReason: "error",
				errorMessage: "rate limit reached for this model",
			};
			state.messages.push(failed);
			emit({ type: "message_end", message: failed });
		});
		mockCreateAgentSession(handle.session);

		const result = await runSubprocess({ ...baseOptions, id: "subagent-model-error" });

		expect(result.exitCode).toBe(1);
		expect(result.aborted).toBe(false);
		expect(result.abortReason).toBeUndefined();
		expect(result.stderr).toBe("rate limit reached for this model");
		// One prompt: the task. No reminders were sent to a subagent whose provider had just refused.
		expect(handle.prompts).toHaveLength(1);
	});

	it("uses modelRegistry.authStorage when only options.modelRegistry is provided", async () => {
		const session = createMockSession(({ emit }) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-registry-only",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});
		const createAgentSessionSpy = mockCreateAgentSession(session);
		const fakeAuthStorage = { sentinel: "registry-storage" } as unknown as AuthStorage;
		const modelRegistry = {
			authStorage: fakeAuthStorage,
			refresh: async () => {},
		} as unknown as import("@veyyon/coding-agent/config/model-registry").ModelRegistry;

		await runSubprocess({ ...baseOptions, id: "subagent-registry-only", modelRegistry });

		expect(createAgentSessionSpy).toHaveBeenCalledTimes(1);
		expect(createAgentSessionSpy.mock.calls[0]?.[0]?.authStorage).toBe(fakeAuthStorage);
	});

	it("rejects when options.authStorage and options.modelRegistry.authStorage are different instances", async () => {
		// Mismatch fails via runSubprocess's standard catch path (exitCode=1 + stderr), not a thrown promise.
		const createAgentSessionSpy = vi.spyOn(sdkModule, "createAgentSession");
		const registryStorage = { sentinel: "registry" } as unknown as AuthStorage;
		const otherStorage = { sentinel: "other" } as unknown as AuthStorage;
		const modelRegistry = {
			authStorage: registryStorage,
			refresh: async () => {},
		} as unknown as import("@veyyon/coding-agent/config/model-registry").ModelRegistry;

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-mismatch",
			authStorage: otherStorage,
			modelRegistry,
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/options\.authStorage.*modelRegistry\.authStorage/);
		expect(createAgentSessionSpy).not.toHaveBeenCalled();
	});

	it("logs reminder-loop aborts at debug, not error (issue #1623)", async () => {
		// Repro: user ^C or compaction aborts pending operations while the
		// yield-reminder loop is awaiting session.prompt. awaitAbortable rejects
		// with ToolAbortError, which previously surfaced as logger.error and
		// polluted operator dashboards.
		const abortController = new AbortController();
		const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

		const session = createMockSession(({ promptIndex, emit, state }) => {
			if (promptIndex === 1) {
				// Initial prompt: stop without yielding so the reminder loop kicks in.
				const assistant = createAssistantStopMessage("no yield yet");
				state.messages.push(assistant);
				emit({ type: "message_end", message: assistant });
				return;
			}
			// Reminder prompt: abort the run while it is in flight. The follow-up
			// awaitAbortable(session.waitForIdle()) then throws ToolAbortError into
			// the catch we are guarding.
			abortController.abort();
		});

		mockCreateAgentSession(session);

		const result = await runSubprocess({
			...baseOptions,
			id: "subagent-abort-during-reminder",
			signal: abortController.signal,
		});

		expect(result.aborted).toBe(true);
		expect(errorSpy).not.toHaveBeenCalledWith("Subagent prompt failed", expect.anything());
		expect(debugSpy).toHaveBeenCalledWith("Subagent prompt aborted");
	});
});

describe("runSubprocess telemetry propagation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const baseAgent: AgentDefinition = {
		name: "reviewer",
		description: "code review specialist",
		systemPrompt: "you are a reviewer",
		source: "bundled",
	};

	const baseOptions = {
		cwd: "/tmp",
		agent: baseAgent,
		task: "do work",
		index: 0,
		id: "subagent-telemetry",
		settings: Settings.isolated(),
		modelRegistry: {
			refresh: async () => {},
		} as unknown as import("@veyyon/coding-agent/config/model-registry").ModelRegistry,
		enableLsp: false,
	};

	function buildSession() {
		return createMockSession(({ emit }) => {
			emit({
				type: "tool_execution_end",
				toolCallId: "tool-telemetry",
				toolName: "yield",
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data: { ok: true } },
				},
				isError: false,
			});
		});
	}

	it("derives subagent telemetry from parent: keeps tracer/hooks, swaps agent identity, clears conversationId", async () => {
		const createAgentSessionSpy = mockCreateAgentSession(buildSession());
		const onSpanStart = () => {};
		const onSpanEnd = () => {};
		const costEstimator = () => undefined;
		const tracer = { startSpan: () => undefined } as unknown as Tracer;
		const parentTelemetry: AgentTelemetryConfig = {
			tracer,
			captureMessageContent: true,
			attributes: { "deployment.id": "prod" },
			agent: { id: "0-Main", name: "main", description: "primary agent" },
			conversationId: "parent-conversation",
			onSpanStart,
			onSpanEnd,
			costEstimator,
		};

		await runSubprocess({ ...baseOptions, id: "subagent-telemetry-derive", parentTelemetry });

		expect(createAgentSessionSpy).toHaveBeenCalledTimes(1);
		const forwarded = createAgentSessionSpy.mock.calls[0]?.[0]?.telemetry;
		expect(forwarded).toBeDefined();
		if (!forwarded) throw new Error("expected telemetry on createAgentSession call");
		expect(forwarded.tracer).toBe(tracer);
		expect(forwarded.captureMessageContent).toBe(true);
		expect(forwarded.attributes).toEqual({ "deployment.id": "prod" });
		expect(forwarded.onSpanStart).toBe(onSpanStart);
		expect(forwarded.onSpanEnd).toBe(onSpanEnd);
		expect(forwarded.costEstimator).toBe(costEstimator);
		expect(forwarded.agent).toEqual({
			id: "subagent-telemetry-derive",
			name: baseAgent.name,
			description: baseAgent.description,
		});
		// Child loop falls back to its own session id for gen_ai.conversation.id.
		expect(forwarded.conversationId).toBeUndefined();
	});

	it("forwards no telemetry when the parent has none", async () => {
		const createAgentSessionSpy = mockCreateAgentSession(buildSession());

		await runSubprocess({ ...baseOptions, id: "subagent-telemetry-none" });

		expect(createAgentSessionSpy).toHaveBeenCalledTimes(1);
		expect(createAgentSessionSpy.mock.calls[0]?.[0]?.telemetry).toBeUndefined();
	});
});
