/**
 * WHY: `StreamingChanged` carries the whole accumulating entry, not the delta.
 * The host was converting and serialising one per provider delta, so a reply
 * cost the square of its own length on the host, the socket and the window's
 * decoder, and a window that redraws at the display's rate never saw most of
 * the frames it paid for.
 *
 * CLASS CLOSED: a streaming change that reaches the socket at the provider's
 * rate instead of the window's. The members are every change a streaming reply
 * can carry — a text delta, a call starting, a partial result, a final result
 * — and the suite pins the rate bound, that the newest state always arrives,
 * that nothing is written after the reply is cleared, and that the hold ends.
 * The last test drives a real turn over the wire, so an event kind added to
 * the session that writes its own streaming frame breaks the bound rather than
 * passing unnoticed.
 *
 * NOT CAUGHT: what the window does with a frame once it has it, and the cost
 * of the conversion itself, which `bench/gui-streaming-frames.bench.ts`
 * measures.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@veyyon/ai";
import * as ai from "@veyyon/ai/stream";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { type GuiHostServer, type HostEvent, startGuiHostServer } from "../../src/gui-host";
import { PresentationLedger } from "../../src/gui-host/presentation";
import {
	cancelStreamingFrame,
	flushStreamingFrame,
	pushStreamingFrame,
	STREAM_FRAME_INTERVAL_MS,
	type StreamingFrame,
	type StreamingFrameSession,
} from "../../src/gui-host/streaming-frames";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { TestSocketClient } from "./test-client";

function session(): StreamingFrameSession {
	return { revision: 1, presentationLedger: new PresentationLedger(), streamingEntry: "stream-1" };
}

/** The assistant message the stubbed stream reports, apart from its text. */
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

/** The text of the first block of the frame's accumulating entry. */
function textOf(frame: StreamingFrame): string {
	const block = frame.StreamingChanged.accumulating.content[0];
	return block && "Text" in block ? block.Text.text : "";
}

describe("a streamed reply reaches the window once a frame", () => {
	// The coalescer's whole contract is when it writes, so the clock it
	// schedules against is driven rather than waited on.
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test("the first delta of a reply is written with no delay", () => {
		const state = session();
		const frames: StreamingFrame[] = [];
		pushStreamingFrame(state, { message: assistantMessage("Hel") }, frame => frames.push(frame));
		expect(frames.map(textOf)).toEqual(["Hel"]);
	});

	test("a burst inside one frame interval writes once and holds the newest state", () => {
		const state = session();
		const frames: StreamingFrame[] = [];
		const write = (frame: StreamingFrame): void => {
			frames.push(frame);
		};
		for (let delta = 1; delta <= 64; delta++) {
			pushStreamingFrame(state, { message: assistantMessage("x".repeat(delta)) }, write);
		}
		expect(frames.map(textOf)).toEqual(["x"]);

		vi.advanceTimersByTime(STREAM_FRAME_INTERVAL_MS);
		// The trailing frame carries the last delta of the burst, and the 62
		// intermediate ones cost the socket nothing.
		expect(frames.map(textOf)).toEqual(["x", "x".repeat(64)]);
		expect(state.streamFrame?.timer).toBeUndefined();
	});

	test("a reply that keeps streaming arrives one frame per interval", () => {
		const state = session();
		const frames: StreamingFrame[] = [];
		const write = (frame: StreamingFrame): void => {
			frames.push(frame);
		};
		// Four deltas per frame interval, over eight intervals: the window is
		// sent the newest state once per interval and never once per delta.
		for (let delta = 0; delta < 32; delta++) {
			pushStreamingFrame(state, { message: assistantMessage(`d${delta}`) }, write);
			vi.advanceTimersByTime(4);
		}
		vi.advanceTimersByTime(STREAM_FRAME_INTERVAL_MS);
		expect(frames.length).toBeLessThanOrEqual(10);
		expect(frames.length).toBeGreaterThanOrEqual(8);
		expect(textOf(frames[frames.length - 1] as StreamingFrame)).toBe("d31");
	});

	test("a call that starts between two deltas is a frame of its own", () => {
		const state = session();
		const frames: StreamingFrame[] = [];
		const write = (frame: StreamingFrame): void => {
			frames.push(frame);
		};
		pushStreamingFrame(state, { message: assistantMessage("reading") }, write);
		vi.advanceTimersByTime(STREAM_FRAME_INTERVAL_MS);
		state.streamingTool = "read";
		pushStreamingFrame(state, { tool: true }, write);
		expect(frames.map(frame => frame.StreamingChanged.tool)).toEqual([null, "read"]);
	});

	test("a result that finished is not regenerated against a partial one", () => {
		const state = session();
		const frames: StreamingFrame[] = [];
		const write = (frame: StreamingFrame): void => {
			frames.push(frame);
		};
		pushStreamingFrame(state, { message: assistantMessage("running two calls") }, write);
		const regenerate = vi.spyOn(state.presentationLedger, "regenerateCallEntryPresentation");
		// Calls run beside each other: one finishes while the next is still
		// producing output, and both land in the same frame.
		pushStreamingFrame(state, { regenerate: "final", tool: true }, write);
		pushStreamingFrame(state, { regenerate: "partial" }, write);
		vi.advanceTimersByTime(STREAM_FRAME_INTERVAL_MS);
		// The frame regenerates every call it holds at once, so a partial pass
		// would redraw the finished call's result without its tail.
		expect(regenerate.mock.calls.map(call => call[2])).toEqual([undefined]);
		regenerate.mockRestore();
	});

	test("a call reported before the reply has any content writes nothing", () => {
		const state = session();
		const frames: StreamingFrame[] = [];
		// There is no entry to draw the call on yet, so the frame is not
		// written -- an entry of nothing would blank the reply in the window.
		state.streamingTool = "read";
		pushStreamingFrame(state, { tool: true }, frame => frames.push(frame));
		expect(frames).toEqual([]);
		vi.advanceTimersByTime(STREAM_FRAME_INTERVAL_MS * 3);
		expect(frames).toEqual([]);
	});

	test("the text a reply ended on reaches the window before the stream is cleared", () => {
		const state = session();
		const frames: StreamingFrame[] = [];
		const write = (frame: StreamingFrame): void => {
			frames.push(frame);
		};
		pushStreamingFrame(state, { message: assistantMessage("one") }, write);
		pushStreamingFrame(state, { message: assistantMessage("one two") }, write);
		// A reply ends inside the frame its last delta landed in, so the end
		// writes what is held rather than dropping it.
		flushStreamingFrame(state, write);
		expect(frames.map(textOf)).toEqual(["one", "one two"]);
		expect(state.streamFrame?.timer).toBeUndefined();
	});

	test("a window that is gone is sent nothing and left waiting for nothing", () => {
		const state = session();
		const frames: StreamingFrame[] = [];
		const write = (frame: StreamingFrame): void => {
			frames.push(frame);
		};
		pushStreamingFrame(state, { message: assistantMessage("one") }, write);
		pushStreamingFrame(state, { message: assistantMessage("one two") }, write);
		cancelStreamingFrame(state);
		// Disarmed at once: teardown returns before the interval elapses, and
		// a frame left armed would fire against a socket that is gone.
		expect(state.streamFrame?.timer).toBeUndefined();
		vi.advanceTimersByTime(STREAM_FRAME_INTERVAL_MS * 3);
		expect(frames.map(textOf)).toEqual(["one"]);
	});

	test("a session no longer streaming holds nothing", () => {
		const state = session();
		const frames: StreamingFrame[] = [];
		state.streamingEntry = undefined;
		pushStreamingFrame(state, { message: assistantMessage("orphan") }, frame => frames.push(frame));
		expect(frames).toEqual([]);
		expect(state.streamFrame?.timer).toBeUndefined();
	});
});

/** A reply delivered as `deltas` separate text deltas, as a provider streams it. */
function deltaStream(deltas: number): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	let text = "";
	queueMicrotask(() => {
		const opening = assistantMessage("");
		stream.push({ type: "start", partial: { ...opening, content: [] } });
		stream.push({ type: "text_start", contentIndex: 0, partial: { ...opening, content: [{ type: "text", text }] } });
		for (let delta = 0; delta < deltas; delta++) {
			text += `token${delta} `;
			stream.push({
				type: "text_delta",
				contentIndex: 0,
				delta: `token${delta} `,
				partial: assistantMessage(text),
			});
		}
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: assistantMessage(text) });
		stream.push({ type: "done", reason: "stop", message: assistantMessage(text) });
	});
	return stream;
}

describe("a real turn streams at the window's rate and not the provider's", () => {
	const DELTAS = 300;
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-stream-rate-"));
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

	test(`a reply of ${DELTAS} deltas crosses in a handful of frames and keeps every token`, async () => {
		vi.spyOn(ai, "streamSimple").mockImplementation(() => deltaStream(DELTAS));
		const created = await client.request(1, { CreateSession: {} });
		const active = created.frames.find(frame => frame.Snapshot?.ActiveSession) as
			| { Snapshot: { ActiveSession: { value: { id: string } } } }
			| undefined;
		if (!active) throw new Error("CreateSession emitted no ActiveSession");

		const started = Date.now();
		await client.request(2, {
			SubmitPrompt: { session: active.Snapshot.ActiveSession.value.id, text: "stream it", attachments: [] },
		});

		/** The text of every assistant entry the host has appended so far. */
		const committed = (read: HostEvent[]): string =>
			read
				.flatMap(frame => ("TranscriptAppended" in frame ? (frame.TranscriptAppended?.entries ?? []) : []))
				.filter(entry => entry.role === "Assistant")
				.flatMap(entry => entry.content)
				.map(block => ("Text" in block ? block.Text.text : ""))
				.join("");

		const frames: HostEvent[] = [];
		let cleared = false;
		// The reply is read to its committed entry, which arrives after the
		// clear that ends the stream.
		for (let read = 0; read < DELTAS * 2; read++) {
			const frame = (await client.nextFrame()) as HostEvent;
			frames.push(frame);
			if ("StreamingChanged" in frame && frame.StreamingChanged === null) cleared = true;
			if (cleared && committed(frames).includes(`token${DELTAS - 1} `)) break;
		}
		const elapsed = Date.now() - started;
		const streamed = frames.filter(frame => "StreamingChanged" in frame && frame.StreamingChanged !== null);

		// One frame per interval the reply spanned, plus the leading one and
		// the trailing one. A frame per delta would be `DELTAS` of them.
		const bound = Math.ceil(elapsed / STREAM_FRAME_INTERVAL_MS) + 2;
		expect(streamed.length).toBeLessThanOrEqual(bound);
		expect(streamed.length).toBeLessThan(DELTAS / 4);
		expect(streamed.length).toBeGreaterThan(0);

		// Coalescing drops intermediate states, never text: the committed entry
		// carries every token the provider sent.
		const body = committed(frames);
		expect(body).toContain("token0 ");
		expect(body).toContain(`token${DELTAS - 1} `);
	}, 30_000);
});
