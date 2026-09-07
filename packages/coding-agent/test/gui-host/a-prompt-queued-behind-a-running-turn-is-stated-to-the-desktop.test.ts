/**
 * WHY:
 * A prompt submitted while a turn runs enters the runtime steering or follow-up
 * queue, but without host reporting the desktop cannot state it and has no
 * affordance to take it back. This suite drives a real socket server and asserts
 * that queued prompts are reported in delivery order, dequeued LIFO on request,
 * drained when the running turn completes, and suppressed when redundant.
 *
 * CLASS CLOSED: prompts held by an active session behind a running turn.
 * Observable members are the QueuedPrompts snapshot section on submission,
 * the DequeueQueuedPrompt action outcome and its restored payload, the clear
 * on turn completion, and the suppression of unchanged queue signatures.
 *
 * NOT CAUGHT: the GPUI composer visual presentation and keybinding bindings,
 * which belong to the desktop front end crate.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import type * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@veyyon/ai";
import * as ai from "@veyyon/ai/stream";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import {
	type GuiHostServer,
	type HostEvent,
	type QueuedPromptsView,
	reportQueuedPrompts,
	startGuiHostServer,
} from "../../src/gui-host";
import type { PresentationLedger } from "../../src/gui-host/presentation";
import type { ClientSessionState } from "../../src/gui-host/turns";
import type { AgentSession } from "../../src/session/agent-session";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { TestSocketClient } from "./test-client";

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-chat",
		provider: "openai",
		model: "gpt-4o-mini",
		stopReason: "stop",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function controllableStream(text: string): { stream: AssistantMessageEventStream; finish: () => void } {
	const stream = new AssistantMessageEventStream();
	const message = assistantMessage(text);
	const { promise, resolve } = Promise.withResolvers<void>();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...message, content: [] } });
		stream.push({
			type: "text_start",
			contentIndex: 0,
			partial: { ...message, content: [{ type: "text", text: "" }] },
		});
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		void promise.then(() => {
			stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
			stream.push({ type: "done", reason: "stop", message });
		});
	});
	return { stream, finish: resolve };
}
function completedStream(text: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message = assistantMessage(text);
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...message, content: [] } });
		stream.push({
			type: "text_start",
			contentIndex: 0,
			partial: { ...message, content: [{ type: "text", text: "" }] },
		});
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

describe("a prompt queued behind a running turn is stated to the desktop", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-queued-prompt-"));
		await fs.writeFile(path.join(tempDir, "config.yml"), "modelRoles:\n  default: openai/gpt-4o-mini\n", "utf8");
		const authStorage = await isolatedAuthStorage(tempDir);
		authStorage.upsertCredential("openai", { type: "api_key", key: "test-key" });
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
		});
		client = await TestSocketClient.connect(server.endpoint);
		await client.nextFrame();
		await client.nextFrame();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		client.destroy();
		if (server) {
			await server.close();
			server = null;
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	async function createSession(id: number): Promise<string> {
		const created = await client.request(id, { CreateSession: {} });
		const active = created.frames.find(f => f.Snapshot?.ActiveSession) as
			| { Snapshot: { ActiveSession: { value: { id: string } } } }
			| undefined;
		if (!active) throw new Error("CreateSession emitted no ActiveSession");
		return active.Snapshot.ActiveSession.value.id;
	}

	test("a prompt queued while a turn runs is reported in follow_up and steering queues", async () => {
		const turn1 = controllableStream("First response");
		const turn2 = controllableStream("Second response");
		const streams = [turn1, turn2];
		vi.spyOn(ai, "streamSimple").mockImplementation(() => streams.shift()!.stream);

		const session = await createSession(1);

		const firstTurn = await client.request(2, {
			SubmitPrompt: { session, text: "Run first turn", attachments: [] },
		});
		expect(firstTurn.outcome).toEqual({ RequestSucceeded: { request: 2 } });

		// Submit a follow-up prompt while turn 1 runs
		const followUpReq = await client.request(3, {
			FollowUp: { session, text: "Then run tests", attachments: [] },
		});
		expect(followUpReq.outcome).toEqual({ RequestSucceeded: { request: 3 } });

		const followUpFrame = followUpReq.frames.find(f => f.Snapshot?.QueuedPrompts) as
			| { Snapshot: { QueuedPrompts: QueuedPromptsView } }
			| undefined;
		expect(followUpFrame).toBeDefined();
		expect(followUpFrame?.Snapshot.QueuedPrompts).toEqual({
			session,
			steering: [],
			follow_up: ["Then run tests"],
			restored: null,
		});

		// Submit a steering prompt while turn 1 runs
		const steerReq = await client.request(4, {
			Steer: { session, text: "Focus on unit tests", attachments: [] },
		});
		expect(steerReq.outcome).toEqual({ RequestSucceeded: { request: 4 } });

		const steerFrame = steerReq.frames.find(f => f.Snapshot?.QueuedPrompts) as
			| { Snapshot: { QueuedPrompts: QueuedPromptsView } }
			| undefined;
		expect(steerFrame).toBeDefined();
		expect(steerFrame?.Snapshot.QueuedPrompts).toEqual({
			session,
			steering: ["Focus on unit tests"],
			follow_up: ["Then run tests"],
			restored: null,
		});

		// Clean up running turns
		turn1.finish();
		turn2.finish();
	});

	test("DequeueQueuedPrompt restores prompt text and updates queues in LIFO order", async () => {
		const turn1 = controllableStream("Active reply");
		vi.spyOn(ai, "streamSimple").mockImplementation(() => turn1.stream);

		const session = await createSession(1);

		await client.request(2, {
			SubmitPrompt: { session, text: "Long turn", attachments: [] },
		});

		// Queue follow_up then steer
		await client.request(3, {
			FollowUp: { session, text: "Second step", attachments: [] },
		});
		await client.request(4, {
			Steer: { session, text: "Intervening steer", attachments: [] },
		});

		// First dequeue: steering prompt is popped first
		const dequeue1 = await client.request(5, {
			DequeueQueuedPrompt: { session },
		});
		expect(dequeue1.outcome).toEqual({ RequestSucceeded: { request: 5 } });

		const frame1 = dequeue1.frames.find(f => f.Snapshot?.QueuedPrompts) as
			| { Snapshot: { QueuedPrompts: QueuedPromptsView } }
			| undefined;
		expect(frame1).toBeDefined();
		expect(frame1?.Snapshot.QueuedPrompts).toEqual({
			session,
			steering: [],
			follow_up: ["Second step"],
			restored: "Intervening steer",
		});

		// Second dequeue: follow_up prompt is popped
		const dequeue2 = await client.request(6, {
			DequeueQueuedPrompt: { session },
		});
		expect(dequeue2.outcome).toEqual({ RequestSucceeded: { request: 6 } });

		const frame2 = dequeue2.frames.find(f => f.Snapshot?.QueuedPrompts) as
			| { Snapshot: { QueuedPrompts: QueuedPromptsView } }
			| undefined;
		expect(frame2).toBeDefined();
		expect(frame2?.Snapshot.QueuedPrompts).toEqual({
			session,
			steering: [],
			follow_up: [],
			restored: "Second step",
		});

		turn1.finish();
	});

	test("DequeueQueuedPrompt against empty queue fails and writes no restored frame", async () => {
		const session = await createSession(1);

		const dequeueRes = await client.request(2, {
			DequeueQueuedPrompt: { session },
		});

		expect(dequeueRes.outcome).toMatchObject({
			RequestFailed: {
				request: 2,
				error: {
					scope: "Session",
					code: "NO_QUEUED_PROMPT",
					message: "There is no queued prompt to take back",
					retryable: false,
				},
			},
		});

		const restoredFrames = dequeueRes.frames.filter(f => f.Snapshot?.QueuedPrompts);
		expect(restoredFrames).toEqual([]);
	});

	test("queued prompts are reported empty when the running turn completes and drains them", async () => {
		const turn1 = controllableStream("Reply 1");
		const turn2 = completedStream("Reply 2");
		const streams = [turn1.stream, turn2];
		vi.spyOn(ai, "streamSimple").mockImplementation(() => streams.shift()!);

		const session = await createSession(1);

		await client.request(2, {
			SubmitPrompt: { session, text: "Start initial turn", attachments: [] },
		});

		await client.request(3, {
			FollowUp: { session, text: "Drain me next", attachments: [] },
		});

		// Complete turn 1 to trigger runtime queue draining
		turn1.finish();

		// Wait for the empty QueuedPrompts snapshot frame emitted when the queue is drained
		let drainedFrame: QueuedPromptsView | undefined;
		for (let i = 0; i < 200; i++) {
			const frame = (await client.nextFrame()) as HostEvent;
			if ("Snapshot" in frame && "QueuedPrompts" in frame.Snapshot) {
				drainedFrame = frame.Snapshot.QueuedPrompts;
				if (drainedFrame.steering.length === 0 && drainedFrame.follow_up.length === 0) {
					break;
				}
			}
		}

		expect(drainedFrame).toBeDefined();
		expect(drainedFrame).toEqual({
			session,
			steering: [],
			follow_up: [],
			restored: null,
		});
	});

	test("identical queue reports are suppressed while restored reports are always written", async () => {
		const session = await createSession(1);

		// Connect a mock socket and state
		const writtenFrames: unknown[] = [];
		const mockSocket = {
			write: (data: string) => {
				writtenFrames.push(JSON.parse(data.trim()));
			},
		} as unknown as net.Socket;

		const mockSessionManager = {
			getSessionId: () => session,
		};

		const mockAgentSession = {
			sessionManager: mockSessionManager,
			getQueuedMessages: () => ({
				steering: ["steer-1"],
				followUp: ["follow-1"],
			}),
		};

		const state: ClientSessionState = {
			revision: 1,
			presentationLedger: {} as unknown as PresentationLedger,
			sessionManager: mockSessionManager as unknown as SessionManager,
			agentSession: mockAgentSession as unknown as AgentSession,
		};

		// First report: written
		reportQueuedPrompts(mockSocket, state);
		expect(writtenFrames.length).toBe(1);
		expect(writtenFrames[0]).toEqual({
			Snapshot: {
				QueuedPrompts: {
					session,
					steering: ["steer-1"],
					follow_up: ["follow-1"],
					restored: null,
				},
			},
		});

		// Second identical report: suppressed
		reportQueuedPrompts(mockSocket, state);
		expect(writtenFrames.length).toBe(1);

		// Third report with restored: always written
		reportQueuedPrompts(mockSocket, state, { restored: "popped text" });
		expect(writtenFrames.length).toBe(2);
		expect(writtenFrames[1]).toEqual({
			Snapshot: {
				QueuedPrompts: {
					session,
					steering: ["steer-1"],
					follow_up: ["follow-1"],
					restored: "popped text",
				},
			},
		});
	});
});
