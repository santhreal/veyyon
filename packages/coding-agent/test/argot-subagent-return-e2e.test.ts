/**
 * TRUE end-to-end coverage of the Argot subagent RETURN boundary, driven through
 * the real `runSubprocess` executor — not a unit call to `expandSubagentReturn`.
 *
 * These tests exist because unit-testing the seam function proves the function,
 * not the WIRING. The bug the user kept flagging ("it's still broken") is exactly
 * a wiring bug class: the seam can be perfect and still never run if the executor
 * captures the child's text before the seam, or reads the wrong session's codec,
 * or clears the active session before the terminal events drain. So here we run
 * the actual executor:
 *
 *   runSubprocess(options)
 *     → createSubagentRunMonitor  (the real monitor)
 *       → monitor.attach(childSession)  (real event subscription)
 *         → child emits `message_end` / `agent_end` carrying `§handle` text
 *           → monitor's handler calls expandChildOutput → expandSubagentReturn
 *             → child codec (childSession.getArgotSession()) decodes it
 *   → result.output is what the PARENT receives
 *
 * The child session is a scripted mock (same technique as
 * executor-subagent-reminders.test.ts), but crucially it carries a REAL loaded
 * `ArgotSession` as its codec, so the expansion path is genuine. If the executor
 * fix is reverted to capturing raw `block.text`, `result.output` contains the bare
 * `§dbconn` and every positive test here fails — that is the regression lock.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { CreateAgentSessionResult } from "@veyyon/coding-agent/sdk";
import * as sdkModule from "@veyyon/coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@veyyon/coding-agent/session/agent-session";
import { runSubprocess } from "@veyyon/coding-agent/task/executor";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { ArgotSession, type Vocabulary } from "argot";

const DBCONN = "packages/server/src/database/connection.ts";
const SVC = "packages/server/src/checkout/service.ts";

/** A real, loaded child codec: the shorthand a `fresh`/`inherit` child would hold. */
function childCodec(): ArgotSession {
	const vocab: Vocabulary = {
		version: 1,
		sigil: "§",
		handles: new Map([
			["dbconn", DBCONN],
			["svc", SVC],
		]),
		meta: new Map(),
	};
	const s = new ArgotSession();
	s.loadVocab(vocab);
	return s;
}

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
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

/**
 * A scripted child session that (optionally) exposes a real Argot codec via
 * `getArgotSession()` — the accessor the executor's return-boundary seam reads.
 * Omitting the codec models an `off` subagent (no codec at all).
 */
function mockChildSession(args: {
	codec?: ArgotSession;
	onPrompt: (p: {
		promptIndex: number;
		emit: (event: AgentSessionEvent) => void;
		state: { messages: AssistantMessage[] };
	}) => void;
}): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as AssistantMessage[] };
	let promptIndex = 0;
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	const session = {
		state,
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		setActiveToolsByName: async () => {},
		// The seam under test reads this. `off` children return undefined here.
		getArgotSession: () => args.codec,
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const i = listeners.indexOf(listener);
				if (i >= 0) listeners.splice(i, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			promptIndex += 1;
			args.onPrompt({ promptIndex, emit, state });
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => state.messages[state.messages.length - 1],
		abort: async () => {},
		dispose: async () => {},
	};
	return session as unknown as AgentSession;
}

function sessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: {} as unknown as CreateAgentSessionResult["extensionsResult"],
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

const baseAgent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };

function baseOptions(id: string) {
	return {
		cwd: "/tmp",
		agent: baseAgent,
		task: "do work",
		index: 0,
		id,
		settings: Settings.isolated(),
		modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
		enableLsp: false,
	};
}

describe("Argot subagent return boundary through the real runSubprocess executor", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("expands a §handle in the child's message_end text before it becomes the parent's output", async () => {
		// The exact line the fix changed: outputChunks.push(expandChildOutput(block.text)).
		// The child (fresh/inherit) emits its own shorthand; the parent must receive
		// the full path, never the raw handle. Never yields → missing-yield path
		// surfaces the accumulated (expanded) output.
		const session = mockChildSession({
			codec: childCodec(),
			onPrompt: ({ promptIndex, emit, state }) => {
				if (promptIndex === 1) {
					const msg = assistantText(`opened §dbconn and edited §svc`);
					state.messages.push(msg);
					emit({ type: "message_end", message: msg } as AgentSessionEvent);
				}
			},
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(sessionResult(session));

		const result = await runSubprocess(baseOptions("ret-msgend"));

		expect(result.output).toContain(DBCONN);
		expect(result.output).toContain(SVC);
		expect(result.output).not.toContain("§dbconn");
		expect(result.output).not.toContain("§svc");
	});

	it("expands a §handle in the child's agent_end final messages", async () => {
		// The other line the fix changed: finalOutputChunks.push(expandChildOutput(block.text)).
		// finalOutputChunks take priority in rawOutput(), so this proves the terminal
		// agent_end capture is expanded too.
		const session = mockChildSession({
			codec: childCodec(),
			onPrompt: ({ promptIndex, emit, state }) => {
				if (promptIndex === 1) {
					const msg = assistantText(`final answer: the entrypoint is §dbconn`);
					state.messages.push(msg);
					emit({ type: "agent_end", messages: [msg] } as unknown as AgentSessionEvent);
				}
			},
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(sessionResult(session));

		const result = await runSubprocess(baseOptions("ret-agentend"));

		expect(result.output).toContain(DBCONN);
		expect(result.output).not.toContain("§dbconn");
	});

	it("leaves text untouched for an `off` child that has no codec (identity, no corruption)", async () => {
		// An `off` subagent returns undefined from getArgotSession(). It never wrote a
		// real handle, but even if handle-shaped text appears it must pass through
		// verbatim — the seam must be a pure no-op, never throw, never half-expand.
		const session = mockChildSession({
			codec: undefined,
			onPrompt: ({ promptIndex, emit, state }) => {
				if (promptIndex === 1) {
					const msg = assistantText(`literal token §dbconn stays literal`);
					state.messages.push(msg);
					emit({ type: "message_end", message: msg } as AgentSessionEvent);
				}
			},
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(sessionResult(session));

		const result = await runSubprocess(baseOptions("ret-off"));

		expect(result.output).toContain("§dbconn");
		expect(result.output).not.toContain(DBCONN);
	});

	it("only decodes handles the CHILD's codec defines; an unknown §handle passes through in the open", async () => {
		// A stray handle the child was never taught is a model error, not a decode
		// target. It must survive to the parent as a visible `§unknown` (fails in the
		// open), while the known handle beside it still expands.
		const session = mockChildSession({
			codec: childCodec(),
			onPrompt: ({ promptIndex, emit, state }) => {
				if (promptIndex === 1) {
					const msg = assistantText(`§dbconn is known but §mystery is not`);
					state.messages.push(msg);
					emit({ type: "message_end", message: msg } as AgentSessionEvent);
				}
			},
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(sessionResult(session));

		const result = await runSubprocess(baseOptions("ret-unknown"));

		expect(result.output).toContain(DBCONN);
		expect(result.output).toContain("§mystery");
		expect(result.output).not.toContain("§dbconn");
	});
});
