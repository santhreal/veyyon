/**
 * Regression lock for the streaming DISPLAY seam (seam 3 in argot's integration
 * manual): the live subagent preview a user watches must NEVER show a raw
 * `§handle`, even when the model streams a handle split across two token deltas.
 *
 * The contract is absolute: users never see handles, veyyon intercepts at every
 * display seam. The finished message and the live streamed preview are two
 * different seams, and the streamed one is the hard case, because a handle can
 * arrive as `§db` then `conn` and expanding each delta alone would flash a raw
 * `§db…` on screen or resolve the shorter `§db` before the longer `§dbconn` name
 * completes. veyyon routes every delta through `session.streamDecoder()` (argot's
 * StreamDecoder, exhaustively tested in argot itself); these tests prove the
 * WIRING: that the executor feeds deltas through the decoder and renders only its
 * output into `progress.recentOutput`, the array the TUI shows live.
 *
 * The discriminating power: if the wiring were reverted to appending the raw
 * delta, `progress.recentOutput` would contain `§dbconn` and every assertion here
 * fails. The run is driven through the REAL `runSubprocess` executor with a
 * scripted child that carries a real loaded codec, exactly like
 * argot-subagent-return-e2e.test.ts.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { CreateAgentSessionResult } from "@veyyon/coding-agent/sdk";
import * as sdkModule from "@veyyon/coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@veyyon/coding-agent/session/agent-session";
import { runSubprocess } from "@veyyon/coding-agent/task/executor";
import type { AgentDefinition, AgentProgress } from "@veyyon/coding-agent/task/types";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { ArgotSession, type Vocabulary } from "argot";

const DBCONN = "packages/server/src/database/connection.ts";

/** A real, loaded child codec: the shorthand a `fresh`/`inherit` child holds. */
function childCodec(): ArgotSession {
	const vocab: Vocabulary = {
		version: 1,
		sigil: "§",
		handles: new Map([
			["db", "src/db.ts"],
			["dbconn", DBCONN],
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

/** Emit a streamed assistant text delta, the event the executor decodes for the preview. */
function textDelta(delta: string): AgentSessionEvent {
	return {
		type: "message_update",
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta },
	} as unknown as AgentSessionEvent;
}

function mockChildSession(args: {
	codec?: ArgotSession;
	onPrompt: (p: { promptIndex: number; emit: (event: AgentSessionEvent) => void }) => void;
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
			args.onPrompt({ promptIndex, emit });
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

function baseOptions(id: string, onProgress: (p: AgentProgress) => void) {
	return {
		cwd: "/tmp",
		agent: baseAgent,
		task: "do work",
		index: 0,
		id,
		settings: Settings.isolated(),
		modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
		enableLsp: false,
		onProgress,
	};
}

/** All non-empty recentOutput snapshots the run reported, newest last. */
function collectPreviews() {
	const snapshots: string[][] = [];
	const onProgress = (p: AgentProgress) => {
		snapshots.push([...p.recentOutput]);
	};
	return { snapshots, onProgress };
}

describe("Argot subagent streaming display seam through the real runSubprocess executor", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("never shows a raw handle in the live preview when a handle is split across two deltas", async () => {
		// `§dbconn` arrives as `§db` then `conn`; a naive per-delta expand would flash
		// raw `§db` or resolve the shorter `§db`. The decoder must hold until the name
		// completes, then show the full path. Finalize with a content-less message_end
		// so the preview comes purely from the streamed+flushed decoder path.
		const { snapshots, onProgress } = collectPreviews();
		const session = mockChildSession({
			codec: childCodec(),
			onPrompt: ({ promptIndex, emit }) => {
				if (promptIndex === 1) {
					emit(textDelta("opened §db"));
					emit(textDelta("conn and moved on"));
					emit({ type: "message_end", message: { role: "assistant" } } as unknown as AgentSessionEvent);
				}
			},
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(sessionResult(session));

		await runSubprocess(baseOptions("stream-split", onProgress));

		// No snapshot at any point held the raw handle...
		for (const snap of snapshots) {
			const joined = snap.join("\n");
			expect(joined).not.toContain("§db");
			expect(joined).not.toContain("§dbconn");
		}
		// ...and the final preview shows the full expansion (longest match: dbconn, not db).
		const last = snapshots[snapshots.length - 1].join("\n");
		expect(last).toContain(DBCONN);
		expect(last).not.toContain("src/db.ts");
	});

	it("shows the short handle when the boundary arrives before the longer name (streamed)", async () => {
		// `§db ` (space) resolves to the short handle across the delta boundary.
		const { snapshots, onProgress } = collectPreviews();
		const session = mockChildSession({
			codec: childCodec(),
			onPrompt: ({ promptIndex, emit }) => {
				if (promptIndex === 1) {
					emit(textDelta("file is §db"));
					emit(textDelta(" then done"));
					emit({ type: "message_end", message: { role: "assistant" } } as unknown as AgentSessionEvent);
				}
			},
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(sessionResult(session));

		await runSubprocess(baseOptions("stream-short", onProgress));

		const last = snapshots[snapshots.length - 1].join("\n");
		expect(last).toContain("src/db.ts");
		expect(last).not.toContain("§db");
		expect(last).not.toContain(DBCONN);
	});

	it("decodes a handle in a finished full-content snapshot too (the message_end refresh)", async () => {
		// The other display path: a message_end carrying complete content. It must be
		// expanded whole, so the preview shows the full path, never the raw handle.
		const { snapshots, onProgress } = collectPreviews();
		const session = mockChildSession({
			codec: childCodec(),
			onPrompt: ({ promptIndex, emit }) => {
				if (promptIndex === 1) {
					const msg = assistantText("the entrypoint is §dbconn for sure");
					emit({ type: "message_end", message: msg } as AgentSessionEvent);
				}
			},
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(sessionResult(session));

		await runSubprocess(baseOptions("stream-fullcontent", onProgress));

		const last = snapshots[snapshots.length - 1].join("\n");
		expect(last).toContain(DBCONN);
		expect(last).not.toContain("§dbconn");
	});

	it("streams an `off` child (no codec) verbatim, holding nothing", async () => {
		// No codec: the decoder is a pass-through. Handle-shaped text is literal and
		// must appear as-is, never expanded and never dropped.
		const { snapshots, onProgress } = collectPreviews();
		const session = mockChildSession({
			codec: undefined,
			onPrompt: ({ promptIndex, emit }) => {
				if (promptIndex === 1) {
					emit(textDelta("literal §db"));
					emit(textDelta("conn text"));
					emit({ type: "message_end", message: { role: "assistant" } } as unknown as AgentSessionEvent);
				}
			},
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(sessionResult(session));

		await runSubprocess(baseOptions("stream-off", onProgress));

		const last = snapshots[snapshots.length - 1].join("\n");
		expect(last).toContain("§dbconn");
		expect(last).not.toContain(DBCONN);
	});
});
