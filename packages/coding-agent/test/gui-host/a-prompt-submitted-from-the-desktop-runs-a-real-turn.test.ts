/**
 * WHY: the host can answer `RequestSucceeded` for a prompt without a turn ever
 * running, and the desktop cannot tell the difference: it draws whatever frames
 * arrive. This suite drives a real `AgentSession` turn through the wire with the
 * provider stubbed at the provider boundary, so every frame the desktop needs to
 * draw a streamed reply is observed, and the reply is read back off disk.
 *
 * CLASS CLOSED: a turn action whose reply is not backed by session state. The
 * observable members are the appended user and assistant entries, the streaming
 * entry the desktop replaces in place, the clear that ends it, the abort of a
 * turn in flight, and the transcript the session wrote.
 *
 * NOT CAUGHT: a real provider request (`streamSimple` is stubbed), the GPU front
 * end's own rendering, and the refusal paths — an unknown session, an empty
 * prompt, an abort with nothing running — which
 * `a-prompt-settles-when-the-session-accepts-it.test.ts` owns.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@veyyon/ai";
import * as ai from "@veyyon/ai/stream";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { computeDefaultSessionDir } from "@veyyon/kernel/session/session-paths";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import {
	type GuiHostServer,
	type HostEvent,
	type StreamingMessageState,
	startGuiHostServer,
	type TranscriptEntry,
} from "../../src/gui-host";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { TestSocketClient } from "./test-client";

/** The assistant message every stubbed stream reports, apart from its text. */
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

/** A stream that delivers `text` as one delta and finishes. */
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

/** A stream that delivers one delta and then waits for the abort signal. */
function abortableStream(text: string, signal: AbortSignal | undefined): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message = assistantMessage(text);
	signal?.addEventListener("abort", () => {
		stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted" } });
	});
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...message, content: [] } });
		stream.push({
			type: "text_start",
			contentIndex: 0,
			partial: { ...message, content: [{ type: "text", text: "" }] },
		});
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
	});
	return stream;
}

describe("a prompt submitted from the desktop runs a real turn", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-real-turn-"));
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

	/** Create a session through the wire and answer with the id the host activated. */
	async function createSession(id: number): Promise<string> {
		const created = await client.request(id, { CreateSession: {} });
		const active = created.frames.find(f => f.Snapshot?.ActiveSession) as
			| { Snapshot: { ActiveSession: { value: { id: string } } } }
			| undefined;
		if (!active) throw new Error("CreateSession emitted no ActiveSession");
		return active.Snapshot.ActiveSession.value.id;
	}

	/**
	 * Frames from the accepted prompt up to and including the clear that ends the
	 * reply. `SubmitPrompt` settles when the session ACCEPTS the prompt, so the
	 * streamed reply arrives after the request's own outcome. Bounded so a reply
	 * that never clears fails as a named error rather than as a stalled read.
	 */
	async function framesUntilStreamCleared(): Promise<HostEvent[]> {
		const frames: HostEvent[] = [];
		for (let read = 0; read < 200; read++) {
			const frame = (await client.nextFrame()) as HostEvent;
			frames.push(frame);
			if ("RequestFailed" in frame) {
				throw new Error(`Unexpected RequestFailed: ${JSON.stringify(frame.RequestFailed)}`);
			}
			if ("StreamingChanged" in frame && frame.StreamingChanged === null) return frames;
		}
		throw new Error("the streamed reply never cleared within 200 frames");
	}

	/**
	 * The session file's message entries, once it holds at least `expected` of them.
	 *
	 * The host appends on its own schedule and reports no frame for the write, so
	 * the file's own change events are the signal. Every read is triggered by a
	 * write rather than by elapsed time, and the watcher opens before the first
	 * read so a write between the two still wakes it. A file that keeps changing
	 * without reaching `expected` fails as the named error below; a file that
	 * stops changing short of it ends on the suite's own deadline, since a bound
	 * in elapsed time is the wall-clock delay this suite does without.
	 */
	async function messagesOnDisk(file: string, expected: number): Promise<SessionEntry[]> {
		const changes = fs.watch(path.dirname(file))[Symbol.asyncIterator]();
		try {
			for (let read = 0; read < 200; read++) {
				const reloaded = await SessionManager.open(file);
				const messages = reloaded.getEntries().filter((entry: SessionEntry) => entry.type === "message");
				if (messages.length >= expected) return messages;
				if ((await changes.next()).done) break;
			}
		} finally {
			await changes.return?.();
		}
		throw new Error(`the session file never reached ${expected} message entries`);
	}

	test("an accepted prompt streams one reply, appends the prompt, and clears the reply once", async () => {
		vi.spyOn(ai, "streamSimple").mockImplementation(() => completedStream("Hello from engine!"));
		const session = await createSession(1);

		// Acceptance is the reply: the composer clears while the turn streams, so
		// the request settles before the model has produced anything.
		const submitted = await client.request(2, {
			SubmitPrompt: { session, text: "Hello assistant", attachments: [] },
		});
		expect(submitted.outcome).toEqual({ RequestSucceeded: { request: 2 } });
		expect(submitted.frames.filter(f => "StreamingChanged" in f)).toEqual([]);

		const frames = await framesUntilStreamCleared();
		const appended = frames.filter(
			(f): f is { TranscriptAppended: { revision: number; entries: TranscriptEntry[] } } =>
				"TranscriptAppended" in f,
		);
		const revisions = appended.map(f => f.TranscriptAppended.revision);
		expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
		expect(new Set(revisions).size).toBe(revisions.length);

		const prompt = appended.flatMap(f => f.TranscriptAppended.entries).find(entry => entry.role === "User");
		expect(prompt?.content).toEqual([{ Text: { text: "Hello assistant" } }]);

		// One reply is one accumulating entry. The desktop replaces the entry named
		// here on each frame, so a name minted per frame turns one streamed reply
		// into a column of duplicates, and no name leaves nothing to replace.
		const streamed = frames.filter(
			(f): f is { StreamingChanged: StreamingMessageState } =>
				"StreamingChanged" in f && f.StreamingChanged !== null,
		);
		expect(streamed.length).toBeGreaterThan(0);
		expect(new Set(streamed.map(f => f.StreamingChanged.entry)).size).toBe(1);
		expect(streamed.at(-1)?.StreamingChanged.accumulating.content).toEqual([
			{ Text: { text: "Hello from engine!" } },
		]);
		expect(streamed.at(-1)?.StreamingChanged.accumulating.role).toBe("Assistant");

		// The reply ends by clearing that entry, or the desktop draws a reply that
		// never finished under the one it appended.
		expect(frames.at(-1)).toEqual({ StreamingChanged: null });
	});

	test("an abort during a streamed reply ends the reply", async () => {
		vi.spyOn(ai, "streamSimple").mockImplementation((_model, _ctx, options) =>
			abortableStream("Thinking deeply...", options?.signal),
		);
		const session = await createSession(1);

		const submitted = await client.request(2, {
			SubmitPrompt: { session, text: "Do heavy reasoning", attachments: [] },
		});
		expect(submitted.outcome).toEqual({ RequestSucceeded: { request: 2 } });

		for (let read = 0; read < 200; read++) {
			const frame = (await client.nextFrame()) as HostEvent;
			if ("StreamingChanged" in frame && frame.StreamingChanged !== null) break;
			if (read === 199) throw new Error("the reply never started streaming");
		}

		// The stub holds the stream open until the abort signal fires, so the clear
		// and the partial reply below are the abort's effect and not a turn that
		// finished on its own. The abort settles after both, so its own frames
		// carry them.
		const aborted = await client.request(3, { AbortTurn: { session } });
		expect(aborted.outcome).toEqual({ RequestSucceeded: { request: 3 } });
		expect(aborted.frames.filter(f => "StreamingChanged" in f).at(-1)).toEqual({ StreamingChanged: null });
		const kept = (aborted.frames as HostEvent[])
			.filter(
				(f): f is { TranscriptAppended: { revision: number; entries: TranscriptEntry[] } } =>
					"TranscriptAppended" in f,
			)
			.flatMap(f => f.TranscriptAppended.entries)
			.find(entry => entry.role === "Assistant");
		expect(kept?.content).toEqual([{ Text: { text: "Thinking deeply..." } }]);
	});

	test("a prompt on a session opened from disk continues that transcript", async () => {
		const sessionDir = computeDefaultSessionDir(tempDir, new FileSessionStorage(), path.join(tempDir, "sessions"));
		const existing = SessionManager.create(tempDir, sessionDir);
		existing.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Initial question" }],
			timestamp: Date.now() - 1000,
		});
		existing.appendMessage(assistantMessage("Initial answer"));
		await existing.flush();
		const sessionFile = existing.getSessionFile();
		const session = existing.getSessionId();

		vi.spyOn(ai, "streamSimple").mockImplementation(() => completedStream("Continued response"));

		const opened = await client.request(1, { OpenSession: { session } });
		expect(opened.outcome).toEqual({ RequestSucceeded: { request: 1 } });
		const transcript = opened.frames.find(f => f.Snapshot?.Transcript) as
			| { Snapshot: { Transcript: { value: TranscriptEntry[] } } }
			| undefined;
		expect(transcript?.Snapshot.Transcript.value.length).toBe(2);

		const submitted = await client.request(2, {
			SubmitPrompt: { session, text: "Follow up question", attachments: [] },
		});
		expect(submitted.outcome).toEqual({ RequestSucceeded: { request: 2 } });
		await framesUntilStreamCleared();

		const messages = await messagesOnDisk(sessionFile!, 4);
		expect(messages.length).toBe(4);
		const texts = messages.map(entry => JSON.stringify((entry as { message?: unknown }).message));
		expect(texts.some(text => text.includes("Follow up question"))).toBeTrue();
		expect(texts.some(text => text.includes("Continued response"))).toBeTrue();
	});
});
