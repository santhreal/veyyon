/**
 * WHY:
 *
 * The GUI desktop client interacts with the coding-agent engine through line-delimited
 * JSON wire requests. Fabricating success without running a real turn or returning fake
 * empty transcript snapshots leaves the desktop user with a dead UI where prompts
 * never invoke the model and turns cannot be aborted.
 *
 * This suite defends:
 * 1. `SubmitPrompt` executes a real AgentSession turn and delivers streaming and
 *    appended transcript frames with monotonically increasing revisions before replying
 *    `RequestSucceeded`.
 * 2. `AbortTurn` with an active streaming turn aborts it and answers `RequestSucceeded`.
 * 3. `AbortTurn` with nothing in flight is refused with `RequestFailed` (scope: Session, code: NOT_RUNNING).
 * 4. `OpenSession` switches the active session manager so a subsequent `SubmitPrompt`
 *    continues appending to the opened transcript.
 * 5. `LoadTranscript` with no session open is refused with `RequestFailed` (scope: Transcript).
 * 6. `LoadTranscript` with unsupported `before` paging is refused with `RequestFailed`.
 *
 * What this does NOT catch:
 * - Real remote model API token billing (stubbed at provider streamSimple boundary).
 * - GPU hardware acceleration inside the Rust desktop UI.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import * as ai from "@veyyon/ai/stream";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { getAgentDbPath, TempDir } from "@veyyon/utils";
import { type GuiHostServer, type HostEvent, startGuiHostServer, type TranscriptEntry } from "../src/gui-host";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { computeDefaultSessionDir } from "../src/session/session-paths";
import { FileSessionStorage } from "../src/session/session-storage";

class TestSocketClient {
	#socket: net.Socket;
	#buffer = Buffer.alloc(0);
	#frames: unknown[] = [];
	#waiters: Array<{ resolve: (frame: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }> = [];

	constructor(socket: net.Socket) {
		this.#socket = socket;
		this.#socket.on("data", chunk => {
			this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
			while (this.#buffer.length > 0) {
				const newlineIndex = this.#buffer.indexOf(0x0a);
				if (newlineIndex === -1) break;
				const line = this.#buffer.subarray(0, newlineIndex).toString("utf8");
				this.#buffer = this.#buffer.subarray(newlineIndex + 1);
				if (line.trim().length === 0) continue;
				try {
					const frame = JSON.parse(line);
					if (this.#waiters.length > 0) {
						const waiter = this.#waiters.shift()!;
						clearTimeout(waiter.timer);
						waiter.resolve(frame);
					} else {
						this.#frames.push(frame);
					}
				} catch {
					// ignore json parse error in test collector
				}
			}
		});
	}

	static async connect(endpoint: string, timeoutMs = 2000): Promise<TestSocketClient> {
		const socketPath = endpoint.startsWith("unix:") ? endpoint.slice(5) : endpoint;
		const socket = net.createConnection(socketPath);
		const { promise, resolve, reject } = Promise.withResolvers<TestSocketClient>();
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`Timeout connecting to ${endpoint}`));
		}, timeoutMs);

		socket.on("connect", () => {
			clearTimeout(timer);
			resolve(new TestSocketClient(socket));
		});
		socket.on("error", err => {
			clearTimeout(timer);
			reject(err);
		});

		return await promise;
	}

	async nextFrame(timeoutMs = 5000): Promise<unknown> {
		if (this.#frames.length > 0) {
			return this.#frames.shift()!;
		}
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const timer = setTimeout(() => {
			const index = this.#waiters.findIndex(w => w.resolve === resolve);
			if (index !== -1) this.#waiters.splice(index, 1);
			reject(new Error(`Timeout waiting for frame after ${timeoutMs}ms`));
		}, timeoutMs);

		this.#waiters.push({ resolve, reject, timer });
		return await promise;
	}

	send(value: unknown): void {
		this.#socket.write(`${JSON.stringify(value)}\n`, "utf8");
	}

	destroy(): void {
		this.#socket.destroy();
	}
}

describe("a prompt submitted from the desktop runs a real turn", () => {
	let tempDir: TempDir;
	let server: GuiHostServer | null = null;
	let endpoint: string;
	let originalApiKey: string | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-gui-host-prompt-");
		const socketPath = path.join(tempDir.path(), "test.sock");
		endpoint = `unix:${socketPath}`;
		originalApiKey = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "test-key";

		// Initialize auth storage with key in agent database
		const authStorage = await AuthStorage.create(getAgentDbPath(tempDir.path()));
		authStorage.upsertCredential("openai", { type: "api_key", key: "test-key" });
		authStorage.close();

		// Write config.yml with default model
		await fs.writeFile(
			path.join(tempDir.path(), "config.yml"),
			"modelRoles:\n  default: openai/gpt-4o-mini\n",
			"utf8",
		);
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		if (server) {
			await server.close();
			server = null;
		}
		if (originalApiKey !== undefined) {
			process.env.OPENAI_API_KEY = originalApiKey;
		} else {
			delete process.env.OPENAI_API_KEY;
		}
		await tempDir.remove();
	});

	function createMockStream(deltaText: string, fullText: string): AssistantMessageEventStream {
		const stream = new AssistantMessageEventStream();
		const baseMessage: ai.AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: fullText }],
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

		queueMicrotask(() => {
			stream.push({
				type: "start",
				partial: {
					...baseMessage,
					content: [],
				},
			});
			stream.push({
				type: "text_start",
				contentIndex: 0,
				partial: {
					...baseMessage,
					content: [{ type: "text", text: "" }],
				},
			});
			stream.push({
				type: "text_delta",
				contentIndex: 0,
				delta: deltaText,
				partial: {
					...baseMessage,
					content: [{ type: "text", text: deltaText }],
				},
			});
			stream.push({
				type: "text_end",
				contentIndex: 0,
				content: fullText,
				partial: baseMessage,
			});
			stream.push({
				type: "done",
				reason: "stop",
				message: baseMessage,
			});
		});
		return stream;
	}

	test("SubmitPrompt runs a real turn, emits transcript frames with increasing revisions, and replies RequestSucceeded", async () => {
		// Mock provider stream at the boundary
		vi.spyOn(ai, "streamSimple").mockImplementation((_model, _ctx, _options) => {
			return createMockStream("Hello from engine!", "Hello from engine!");
		});

		server = await startGuiHostServer({
			endpoint,
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
		});

		const client = await TestSocketClient.connect(server.endpoint);

		// Frame 1: Greeting
		await client.nextFrame();
		// Frame 2: Capabilities
		await client.nextFrame();

		// Submit prompt
		client.send({
			id: 101,
			action: {
				SubmitPrompt: {
					session: "s1",
					text: "Hello assistant",
					attachments: [],
				},
			},
		});

		const receivedFrames: HostEvent[] = [];
		let foundSuccess = false;
		let lastRevision = 0;

		while (!foundSuccess) {
			const frame = (await client.nextFrame()) as HostEvent;
			receivedFrames.push(frame);

			if ("RequestFailed" in frame) {
				throw new Error(`Unexpected RequestFailed: ${JSON.stringify(frame.RequestFailed)}`);
			}
			if ("TranscriptAppended" in frame) {
				const rev = frame.TranscriptAppended.revision;
				expect(rev).toBeGreaterThan(lastRevision);
				lastRevision = rev;
			}
			if ("StreamingChanged" in frame && frame.StreamingChanged !== null) {
				const rev = frame.StreamingChanged.revision;
				expect(rev).toBeGreaterThanOrEqual(lastRevision);
			}
			if ("RequestSucceeded" in frame && frame.RequestSucceeded.request === 101) {
				foundSuccess = true;
			}
		}
		expect(foundSuccess).toBeTrue();

		// Verify user message appended
		const userAppends = receivedFrames.filter(
			(f): f is { TranscriptAppended: { revision: number; entries: TranscriptEntry[] } } =>
				"TranscriptAppended" in f && f.TranscriptAppended.entries.some(e => e.role === "User"),
		);
		expect(userAppends.length).toBeGreaterThan(0);

		// Verify assistant message appended
		const assistantAppends = receivedFrames.filter(
			(f): f is { TranscriptAppended: { revision: number; entries: TranscriptEntry[] } } =>
				"TranscriptAppended" in f && f.TranscriptAppended.entries.some(e => e.role === "Assistant"),
		);
		expect(assistantAppends.length).toBeGreaterThan(0);
		const assistantEntry = assistantAppends[0].TranscriptAppended.entries.find(e => e.role === "Assistant");
		expect(assistantEntry?.content).toEqual([{ Text: { text: "Hello from engine!" } }]);

		client.destroy();
	});

	test("AbortTurn with nothing in flight is refused with RequestFailed (scope: Session, code: NOT_RUNNING)", async () => {
		server = await startGuiHostServer({
			endpoint,
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
		});

		const client = await TestSocketClient.connect(server.endpoint);

		// Drain greeting and capabilities
		await client.nextFrame();
		await client.nextFrame();

		client.send({
			id: 202,
			action: { AbortTurn: { session: "s1" } },
		});

		const responseFrame = (await client.nextFrame()) as {
			RequestFailed: {
				request: number;
				error: {
					scope: string;
					code: string;
					message: string;
				};
			};
		};

		expect(responseFrame.RequestFailed).toBeDefined();
		expect(responseFrame.RequestFailed.request).toBe(202);
		expect(responseFrame.RequestFailed.error.scope).toBe("Session");
		expect(responseFrame.RequestFailed.error.code).toBe("NOT_RUNNING");
		expect(responseFrame.RequestFailed.error.message).toContain("No turn is currently in flight");

		client.destroy();
	});

	test("AbortTurn during active streaming turn aborts execution and answers RequestSucceeded", async () => {
		vi.spyOn(ai, "streamSimple").mockImplementation((_model, _ctx, options) => {
			const stream = new AssistantMessageEventStream();
			const baseMessage: ai.AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "Thinking deeply..." }],
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

			options?.signal?.addEventListener("abort", () => {
				stream.push({
					type: "error",
					reason: "aborted",
					error: {
						...baseMessage,
						stopReason: "aborted",
					},
				});
			});

			queueMicrotask(() => {
				stream.push({
					type: "start",
					partial: { ...baseMessage, content: [] },
				});
				stream.push({
					type: "text_start",
					contentIndex: 0,
					partial: { ...baseMessage, content: [{ type: "text", text: "" }] },
				});
				stream.push({
					type: "text_delta",
					contentIndex: 0,
					delta: "Thinking deeply...",
					partial: { ...baseMessage, content: [{ type: "text", text: "Thinking deeply..." }] },
				});
			});
			return stream;
		});

		server = await startGuiHostServer({
			endpoint,
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
		});

		const client = await TestSocketClient.connect(server.endpoint);

		// Drain greeting and capabilities
		await client.nextFrame();
		await client.nextFrame();

		// Submit long-running prompt
		client.send({
			id: 301,
			action: {
				SubmitPrompt: {
					session: "s1",
					text: "Do heavy reasoning",
					attachments: [],
				},
			},
		});

		// Wait for first streaming message update
		let receivedStreaming = false;
		while (!receivedStreaming) {
			const frame = (await client.nextFrame()) as HostEvent;
			if ("StreamingChanged" in frame && frame.StreamingChanged !== null) {
				receivedStreaming = true;
			}
		}

		// Now send AbortTurn
		client.send({
			id: 302,
			action: { AbortTurn: { session: "s1" } },
		});

		let abortSuccess = false;
		let promptSettled = false;

		while (!abortSuccess || !promptSettled) {
			const frame = (await client.nextFrame()) as HostEvent;
			if ("RequestSucceeded" in frame && frame.RequestSucceeded.request === 302) {
				abortSuccess = true;
			}
			if ("RequestSucceeded" in frame && frame.RequestSucceeded.request === 301) {
				promptSettled = true;
			}
		}

		expect(abortSuccess).toBeTrue();
		expect(promptSettled).toBeTrue();

		client.destroy();
	});

	test("OpenSession continues an existing session on subsequent SubmitPrompt", async () => {
		const sessionDir = computeDefaultSessionDir(
			tempDir.path(),
			new FileSessionStorage(),
			path.join(tempDir.path(), "sessions"),
		);
		const existingSm = SessionManager.create(tempDir.path(), sessionDir);
		existingSm.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Initial question" }],
		});
		existingSm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Initial answer" }],
			api: "openai-chat",
			provider: "openai",
			model: "gpt-4o-mini",
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 500,
		});
		await existingSm.flush();
		const sessionFile = existingSm.getSessionFile();
		const sessionId = existingSm.getSessionId();
		vi.spyOn(ai, "streamSimple").mockImplementation((_model, _ctx, _options) => {
			return createMockStream("Continued response", "Continued response");
		});

		server = await startGuiHostServer({
			endpoint,
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
		});

		const client = await TestSocketClient.connect(server.endpoint);

		// Drain greeting and capabilities
		await client.nextFrame();
		await client.nextFrame();

		// Open existing session
		client.send({
			id: 401,
			action: { OpenSession: { session: sessionId } },
		});

		let openSuccess = false;
		let initialTranscriptEntries: TranscriptEntry[] = [];

		while (!openSuccess) {
			const frame = (await client.nextFrame()) as HostEvent;
			if ("Snapshot" in frame && "Transcript" in frame.Snapshot) {
				const transcriptSnapshot = frame.Snapshot.Transcript as { value: TranscriptEntry[] };
				initialTranscriptEntries = transcriptSnapshot.value;
			}
			if ("RequestSucceeded" in frame && frame.RequestSucceeded.request === 401) {
				openSuccess = true;
			}
		}

		expect(openSuccess).toBeTrue();
		expect(initialTranscriptEntries.length).toBe(2);

		// Submit prompt on this open session
		client.send({
			id: 402,
			action: {
				SubmitPrompt: {
					session: sessionId,
					text: "Follow up question",
					attachments: [],
				},
			},
		});

		let promptSuccess = false;
		while (!promptSuccess) {
			const frame = (await client.nextFrame()) as HostEvent;
			if ("RequestSucceeded" in frame && frame.RequestSucceeded.request === 402) {
				promptSuccess = true;
			}
		}

		expect(promptSuccess).toBeTrue();
		// Reopen session from disk and verify it has all 4 entries (initial 2 + user + assistant)
		const reloaded = await SessionManager.open(sessionFile!);
		const reloadedEntries = reloaded.getEntries();
		const messageEntries = reloadedEntries.filter(e => e.type === "message");
		expect(messageEntries.length).toBe(4);
		client.destroy();
	});

	test("LoadTranscript with no open session replies RequestFailed (scope: Transcript)", async () => {
		server = await startGuiHostServer({
			endpoint,
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
		});

		const client = await TestSocketClient.connect(server.endpoint);

		// Drain greeting and capabilities
		await client.nextFrame();
		await client.nextFrame();

		client.send({
			id: 501,
			action: { LoadTranscript: { session: "none", before: null } },
		});

		const frame = (await client.nextFrame()) as {
			RequestFailed: {
				request: number;
				error: { scope: string; code: string; message: string };
			};
		};

		expect(frame.RequestFailed).toBeDefined();
		expect(frame.RequestFailed.request).toBe(501);
		expect(frame.RequestFailed.error.scope).toBe("Transcript");
		expect(frame.RequestFailed.error.code).toBe("NO_ACTIVE_SESSION");

		client.destroy();
	});

	test("LoadTranscript with unsupported 'before' paging replies RequestFailed", async () => {
		// Create an in-memory session first
		const sessionDir = computeDefaultSessionDir(
			tempDir.path(),
			new FileSessionStorage(),
			path.join(tempDir.path(), "sessions"),
		);
		const sm = SessionManager.create(tempDir.path(), sessionDir);
		sm.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() });
		await sm.flush();
		server = await startGuiHostServer({
			endpoint,
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
		});

		const client = await TestSocketClient.connect(server.endpoint);

		// Drain greeting and capabilities
		await client.nextFrame();
		await client.nextFrame();

		// Open session
		client.send({
			id: 601,
			action: { OpenSession: { session: sm.getSessionId() } },
		});

		let openSuccess = false;
		while (!openSuccess) {
			const frame = (await client.nextFrame()) as HostEvent;
			if ("RequestSucceeded" in frame && frame.RequestSucceeded.request === 601) {
				openSuccess = true;
			}
		}

		// Send LoadTranscript with non-null before
		client.send({
			id: 602,
			action: { LoadTranscript: { session: sm.getSessionId(), before: "msg-123" } },
		});

		const frame = (await client.nextFrame()) as {
			RequestFailed: {
				request: number;
				error: { scope: string; code: string; message: string };
			};
		};

		expect(frame.RequestFailed).toBeDefined();
		expect(frame.RequestFailed.request).toBe(602);
		expect(frame.RequestFailed.error.scope).toBe("Transcript");
		expect(frame.RequestFailed.error.code).toBe("PAGING_UNSUPPORTED");

		client.destroy();
	});
});
