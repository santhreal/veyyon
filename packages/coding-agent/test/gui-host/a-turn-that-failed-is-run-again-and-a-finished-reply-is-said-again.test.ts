/**
 * WHY: `/retry` and `/rephrase` are turn-level actions the terminal has and the
 * desktop did not. Both are easy to answer without doing anything: `RetryTurn`
 * can report success while the session declines to re-run, and `RephraseReply`
 * can submit its instruction against a reply that is still streaming or against
 * a turn that produced no text, which asks the model to say again something the
 * operator cannot see.
 *
 * CLASS CLOSED: a turn-level action whose settlement is not backed by session
 * state. The members are the refusal when the last turn did not fail, the
 * re-run that replaces the failed reply instead of appending a second one, the
 * refusal when there is no finished reply to work from, and the rephrase that
 * lands as an ordinary user turn in the conversation.
 *
 * NOT CAUGHT: a real provider request (`streamSimple` is stubbed), and the
 * wording of the rephrase instruction itself, which is the shared prompt row
 * `requests/rephrase` and is asserted by identity rather than by text.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@veyyon/ai";
import * as ai from "@veyyon/ai/stream";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { type GuiHostServer, type HostEvent, startGuiHostServer, type TranscriptEntry } from "../../src/gui-host";
import * as sessionTitle from "../../src/gui-host/session-title";
import { requestsPrompts } from "../../src/prompts/requests/rows";
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

describe("a turn that failed is run again and a finished reply is said again", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-turn-actions-"));
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

	function appendedEntries(frames: HostEvent[]): TranscriptEntry[] {
		return frames
			.filter(
				(f): f is { TranscriptAppended: { revision: number; entries: TranscriptEntry[] } } =>
					"TranscriptAppended" in f,
			)
			.flatMap(f => f.TranscriptAppended.entries);
	}

	/**
	 * Frames from here until the assistant entry carrying `text` is appended.
	 *
	 * The session appends the finished reply after it clears the streaming
	 * entry, so a read that stops at the clear stops one frame early. Bounded so
	 * a reply that never lands fails as the named error rather than as a stall.
	 */
	async function framesUntilReply(text: string): Promise<HostEvent[]> {
		const frames: HostEvent[] = [];
		for (let read = 0; read < 200; read++) {
			frames.push((await client.nextFrame()) as HostEvent);
			const landed = appendedEntries(frames).some(
				entry =>
					entry.role === "Assistant" && JSON.stringify(entry.content) === JSON.stringify([{ Text: { text } }]),
			);
			if (landed) return frames;
		}
		throw new Error(`the reply "${text}" was never appended within 200 frames`);
	}

	/** Read frames until one reply has started streaming. */
	async function waitForStreamStart(): Promise<void> {
		for (let read = 0; read < 200; read++) {
			const frame = (await client.nextFrame()) as HostEvent;
			if ("StreamingChanged" in frame && frame.StreamingChanged !== null) return;
		}
		throw new Error("the reply never started streaming");
	}

	test("a session whose last turn did not fail has nothing to run again", async () => {
		const session = await createSession(1);
		const retried = await client.request(2, { RetryTurn: { session } });
		expect(retried.outcome.RequestFailed?.error).toMatchObject({ scope: "Session", code: "NOTHING_TO_RETRY" });
		expect(retried.frames.filter(f => "StreamingChanged" in f)).toEqual([]);
	});

	test("a turn aborted mid-reply is run again and the abandoned reply is replaced", async () => {
		vi.spyOn(ai, "streamSimple").mockImplementation((_model, _ctx, options) =>
			abortableStream("Half a thou", options?.signal),
		);
		const session = await createSession(1);
		expect((await client.request(2, { SubmitPrompt: { session, text: "Think", attachments: [] } })).outcome).toEqual({
			RequestSucceeded: { request: 2 },
		});
		await waitForStreamStart();
		expect((await client.request(3, { AbortTurn: { session } })).outcome).toEqual({
			RequestSucceeded: { request: 3 },
		});

		vi.spyOn(ai, "streamSimple").mockImplementation(() => completedStream("A whole thought"));
		const retried = await client.request(4, { RetryTurn: { session } });
		expect(retried.outcome).toEqual({ RequestSucceeded: { request: 4 } });

		// The re-run is the same turn, not a second one: it carries no new prompt,
		// and the reply that arrives is the finished one.
		const entries = appendedEntries(await framesUntilReply("A whole thought"));
		expect(entries.filter(entry => entry.role === "User")).toEqual([]);
		expect(entries.filter(entry => entry.role === "Assistant").at(-1)?.content).toEqual([
			{ Text: { text: "A whole thought" } },
		]);
	});

	test("a session with no finished reply has nothing to say again", async () => {
		const session = await createSession(1);
		const rephrased = await client.request(2, { RephraseReply: { session } });
		expect(rephrased.outcome.RequestFailed?.error).toMatchObject({
			scope: "Session",
			code: "NOTHING_TO_REPHRASE",
		});
		expect(rephrased.frames.filter(f => "StreamingChanged" in f)).toEqual([]);
	});

	test("a finished reply is said again as an ordinary user turn carrying the shared instruction", async () => {
		vi.spyOn(ai, "streamSimple").mockImplementation(() => completedStream("A dense first answer"));
		const session = await createSession(1);
		expect(
			(await client.request(2, { SubmitPrompt: { session, text: "Explain", attachments: [] } })).outcome,
		).toEqual({ RequestSucceeded: { request: 2 } });
		await framesUntilReply("A dense first answer");

		vi.spyOn(ai, "streamSimple").mockImplementation(() => completedStream("A plainer second answer"));
		const rephrased = await client.request(3, { RephraseReply: { session } });
		expect(rephrased.outcome).toEqual({ RequestSucceeded: { request: 3 } });

		const entries = appendedEntries([
			...(rephrased.frames as HostEvent[]),
			...(await framesUntilReply("A plainer second answer")),
		]);
		expect(entries.find(entry => entry.role === "User")?.content).toEqual([
			{ Text: { text: requestsPrompts["requests/rephrase"].text.trim() } },
		]);
		expect(entries.filter(entry => entry.role === "Assistant").at(-1)?.content).toEqual([
			{ Text: { text: "A plainer second answer" } },
		]);
	});

	test("the fixed instruction does not become the session's name", async () => {
		const named = vi.spyOn(sessionTitle, "nameSessionFromFirstPrompt").mockResolvedValue();
		vi.spyOn(ai, "streamSimple").mockImplementation(() => completedStream("An answer"));
		const session = await createSession(1);
		await client.request(2, { SubmitPrompt: { session, text: "Explain", attachments: [] } });
		await framesUntilReply("An answer");
		// The control: a prompt the operator wrote is what a session is named
		// from, so a rephrase that skipped titling for another reason would
		// leave this arm at zero too.
		expect(named.mock.calls.map(call => call[2])).toEqual(["Explain"]);

		vi.spyOn(ai, "streamSimple").mockImplementation(() => completedStream("A plainer answer"));
		expect((await client.request(3, { RephraseReply: { session } })).outcome).toEqual({
			RequestSucceeded: { request: 3 },
		});
		await framesUntilReply("A plainer answer");
		expect(named.mock.calls.map(call => call[2])).toEqual(["Explain"]);
	});
});
