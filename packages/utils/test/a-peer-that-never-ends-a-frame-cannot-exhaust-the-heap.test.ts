/**
 * A peer that never ends a frame cannot exhaust the heap.
 *
 * WHY THIS SUITE EXISTS. Every streaming reader in `stream.ts` assembles bytes until the
 * delimiter its protocol promises arrives: a line feed for `readLines`, a line feed for a
 * JSONL record, a blank line for an SSE event. None of them used to give up. A provider,
 * a proxy in front of one, or an MCP subprocess could hold the connection open and send
 * an undelimited frame forever — or, more quietly, repeat `data: x` and `: keepalive`
 * without ever dispatching — and the buffer grew until the process died. Nothing in the
 * existing malformed-SSE coverage sees this: those suites prove what happens to a frame
 * that PARSES badly, and the exhaustion happens before there is a frame at all.
 *
 * THE CLASS, not the incident. The reader list is read off the module's exports at run
 * time and every stream reader must appear in the case table below, so adding a reader
 * with no bound turns this red instead of shipping. The opt-out list is pinned by exact
 * equality. Each reader is driven through the real generator over a real
 * `ReadableStream`, and the assertions are three: the failure is classified (protocol,
 * observed bytes, allowed bytes), the source is cancelled rather than left producing, and
 * the bytes taken off the wire stay within the bound plus the chunk in flight — a value
 * assertion alone cannot tell a bounded read from a read that happened to answer.
 *
 * Both directions are proved: a frame that sits exactly on the bound still arrives whole,
 * and a stream whose TOTAL far exceeds the bound streams fine as long as its frames end,
 * because the bound is per frame and not per stream.
 *
 * WHAT THIS DOES NOT CATCH. The default 64 MiB ceiling is asserted as a number, not by
 * pushing 64 MiB through a reader. A single delivered chunk larger than the ceiling that
 * contains complete records is parsed in place by `readJsonl` and not refused; the
 * allocation there belongs to the transport, and only the undelimited carry-forward is
 * bounded. Nothing here bounds `readPipeText`, which drains a whole pipe by contract.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as streamModule from "@veyyon/utils/stream";
import {
	DEFAULT_MAX_STREAM_FRAME_BYTES,
	isStreamFrameLimitError,
	readJsonl,
	readLines,
	readSseEvents,
	readSseJson,
	STREAM_FRAME_MAX_BYTES_ENV,
	type StreamFrameKind,
	StreamFrameLimitError,
	type StreamFrameLimits,
	streamEventCeiling,
	streamFrameCeiling,
} from "@veyyon/utils/stream";

const encoder = new TextEncoder();
const LIMIT = 4096;

interface CountingSource {
	stream: ReadableStream<Uint8Array>;
	/** Bytes the reader actually pulled off the wire. */
	produced(): number;
	/** Whether the reader cancelled the source instead of leaving it producing. */
	cancelled(): boolean;
}

/**
 * A source that sends `chunk` over and over without ever delimiting the frame, counting
 * what the reader takes. `opener` is sent once first, for a protocol where the frame has
 * to be opened before it can be left undelimited (a JSON string, say).
 *
 * It stops after `stopAfter` bytes even though a real hostile peer would not, because a
 * reader with no bound must FAIL here rather than hang: a test that can only run forever
 * cannot report the defect it exists to catch. A bounded reader never reaches the stop.
 */
function endless(chunk: string, opener?: string, stopAfter = LIMIT * 64): CountingSource {
	const bytes = encoder.encode(chunk);
	const first = opener === undefined ? undefined : encoder.encode(opener);
	let produced = 0;
	let sentOpener = false;
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (produced >= stopAfter) {
				controller.close();
				return;
			}
			if (first !== undefined && !sentOpener) {
				sentOpener = true;
				produced += first.length;
				controller.enqueue(first.slice());
				return;
			}
			produced += bytes.length;
			controller.enqueue(bytes.slice());
		},
		cancel() {
			cancelled = true;
		},
	});
	return { stream, produced: () => produced, cancelled: () => cancelled };
}

/** A source that sends exactly these chunks and closes. */
function finite(chunks: string[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

/**
 * Collect a reader's output, refusing to run forever. A reader that neither ends nor
 * throws is the failure this suite exists to catch, and a test that can only hang cannot
 * report it.
 */
async function drain(iter: AsyncIterable<unknown>, maxFrames = 1000): Promise<unknown[]> {
	const out: unknown[] = [];
	for await (const item of iter) {
		out.push(item);
		if (out.length > maxFrames) throw new Error(`the reader yielded more than ${maxFrames} frames without ending`);
	}
	return out;
}

function frameLimitError(err: unknown): StreamFrameLimitError {
	if (!(err instanceof StreamFrameLimitError)) throw new Error(`not a frame-limit error: ${String(err)}`);
	return err;
}

interface ReaderCase {
	/** The exported reader this case drives. */
	reader: string;
	/** One chunk the peer repeats forever, never delimiting the frame. */
	undelimited: string;
	/** Sent once before the repeats, when the frame has to be opened first. */
	opener?: string;
	/** The protocol delimiter the peer withheld. */
	frame: StreamFrameKind;
	run: (source: ReadableStream<Uint8Array>, limits: StreamFrameLimits) => AsyncIterable<unknown>;
}

const CASES: ReaderCase[] = [
	{
		reader: "readLines",
		undelimited: "a".repeat(512),
		frame: "line",
		run: (source, limits) => readLines(source, undefined, limits),
	},
	{
		reader: "readJsonl",
		// The record is opened as a JSON string and never closed, so every repeat is
		// content inside it: an incomplete record, not a malformed one. A bare token
		// (`111…`) is no good here — the lenient parser treats it as a complete value and
		// the frame the bound protects never forms.
		opener: '{"padding":"',
		undelimited: "a".repeat(512),
		frame: "jsonl-record",
		run: (source, limits) => readJsonl(source, undefined, limits),
	},
	{
		reader: "readSseEvents",
		undelimited: `data: ${"a".repeat(505)}\n`,
		frame: "sse-event",
		run: (source, limits) => readSseEvents(source, undefined, limits),
	},
	{
		reader: "readSseJson",
		undelimited: `data: ${"a".repeat(505)}\n`,
		frame: "sse-event",
		run: (source, limits) => readSseJson(source, undefined, undefined, limits),
	},
];

// `readPipeText` drains a whole pipe into one string by contract — the caller asked for
// the entire output of a process it started. Pinned by exact equality so a second reader
// cannot join the exemption quietly.
const UNBOUNDED_BY_CONTRACT = ["readPipeText"];

describe("every stream reader bounds the frame it is assembling", () => {
	it("covers every reader the module exports", () => {
		const exported = Object.entries(streamModule)
			.filter(([name, value]) => typeof value === "function" && name.startsWith("read"))
			.map(([name]) => name)
			.sort();
		const covered = CASES.map(entry => entry.reader);
		const uncovered = exported.filter(name => !covered.includes(name) && !UNBOUNDED_BY_CONTRACT.includes(name));

		expect(uncovered).toEqual([]);
		expect(exported.filter(name => UNBOUNDED_BY_CONTRACT.includes(name))).toEqual(UNBOUNDED_BY_CONTRACT);
	});

	it.each(CASES)("stops $reader at the bound and cancels the source", async testCase => {
		const source = endless(testCase.undelimited, testCase.opener);

		const err = await drain(testCase.run(source.stream, { maxFrameBytes: LIMIT })).then(
			() => {
				throw new Error("the reader consumed an unbounded frame");
			},
			(caught: unknown) => caught,
		);

		const limit = frameLimitError(err);
		expect({ frame: limit.frame, allowed: limit.allowedBytes }).toEqual({ frame: testCase.frame, allowed: LIMIT });
		expect(limit.observedBytes).toBeGreaterThan(LIMIT);
		// Bounded memory, not merely a bounded answer: the reader holds the frame it was
		// assembling plus the chunk that crossed the line, and the source's own read-ahead
		// keeps one more queued behind it. Nothing beyond that reached the process.
		expect(source.produced()).toBeLessThanOrEqual(LIMIT + 2 * testCase.undelimited.length);
		expect(source.cancelled()).toBe(true);
	});

	it.each(CASES)("names both sides of the bound in the message for $reader", async testCase => {
		const source = endless(testCase.undelimited, testCase.opener);

		const err = await drain(testCase.run(source.stream, { maxFrameBytes: LIMIT })).then(
			() => null,
			(caught: unknown) => frameLimitError(caught),
		);

		expect(err?.message).toContain(String(LIMIT));
		expect(err?.message).toContain(String(err?.observedBytes));
		expect(isStreamFrameLimitError(err)).toBe(true);
	});

	it("refuses an oversized line even when it arrives complete in one chunk", async () => {
		// A complete line skips the accumulation buffer entirely, so it skips the guard on
		// the buffer with it. One chunk is as large as the transport chose to make it.
		const source = finite([`${"a".repeat(LIMIT + 1)}\n`]);

		const err = await drain(readLines(source, undefined, { maxFrameBytes: LIMIT })).then(
			() => null,
			(caught: unknown) => frameLimitError(caught),
		);

		expect({ frame: err?.frame, observed: err?.observedBytes }).toEqual({ frame: "line", observed: LIMIT + 1 });
	});

	it("refuses an oversized JSONL record carried forward from a single chunk", async () => {
		// The first chunk lands with the buffer empty, which is the one path that reaches
		// `reset` rather than the accumulating copy: the remainder it keeps is bounded too.
		const source = finite([`{"padding":"${"a".repeat(LIMIT)}`]);

		const err = await drain(readJsonl(source, undefined, { maxFrameBytes: LIMIT })).then(
			() => null,
			(caught: unknown) => frameLimitError(caught),
		);

		expect({ frame: err?.frame, allowed: err?.allowedBytes }).toEqual({ frame: "jsonl-record", allowed: LIMIT });
	});
});

describe("the bound is per frame, not per stream", () => {
	it("passes a line that sits exactly on the bound", async () => {
		const line = "a".repeat(LIMIT);
		const source = finite([line.slice(0, 100), line.slice(100), "\n"]);

		const lines = await drain(readLines(source, undefined, { maxFrameBytes: LIMIT }));

		expect(lines.map(bytes => (bytes as Uint8Array).length)).toEqual([LIMIT]);
	});

	it("passes a stream whose total dwarfs the bound", async () => {
		const record = `{"padding":"${"a".repeat(200)}"}\n`;
		const source = finite(Array.from({ length: 200 }, () => record));

		const records = await drain(readJsonl(source, undefined, { maxFrameBytes: LIMIT }));

		expect(records.length).toBe(200);
	});

	it("dispatches an SSE event that sits inside the event bound", async () => {
		const source = finite([`event: chunk\ndata: ${"a".repeat(200)}\n\n`]);

		const events = await drain(readSseEvents(source, undefined, { maxEventBytes: LIMIT }));

		expect(events.length).toBe(1);
	});
});

describe("an SSE event is bounded even when every line is small", () => {
	it("refuses an event whose data: lines never reach a blank line", async () => {
		const source = endless("data: x\n");

		const err = await drain(readSseEvents(source.stream, undefined, { maxEventBytes: 1024 })).then(
			() => null,
			(caught: unknown) => frameLimitError(caught),
		);

		expect({ frame: err?.frame, allowed: err?.allowedBytes }).toEqual({ frame: "sse-event", allowed: 1024 });
		expect(source.cancelled()).toBe(true);
	});

	it("refuses an event built only from comment keepalives", async () => {
		// Comments carry no field, so nothing accumulates in `data` — but every one is
		// retained in `raw` for diagnostics, and a peer sending them forever with no
		// dispatch grows that array without limit.
		const source = endless(": keepalive\n");

		const err = await drain(readSseEvents(source.stream, undefined, { maxEventBytes: 1024 })).then(
			() => null,
			(caught: unknown) => frameLimitError(caught),
		);

		expect(err?.frame).toBe("sse-event");
		expect(source.cancelled()).toBe(true);
	});

	it("counts each event separately, so a long polite stream is unaffected", async () => {
		const event = `data: ${"a".repeat(400)}\n\n`;
		const source = finite(Array.from({ length: 50 }, () => event));

		const events = await drain(readSseEvents(source, undefined, { maxEventBytes: 1024 }));

		expect(events.length).toBe(50);
	});
});

describe("the declared bound", () => {
	it("defaults to 64 MiB", () => {
		expect(DEFAULT_MAX_STREAM_FRAME_BYTES).toBe(64 * 1024 * 1024);
	});

	it("treats a non-positive limit as absent rather than as zero bytes allowed", async () => {
		const source = finite([`${"a".repeat(8192)}\n`]);

		const lines = await drain(readLines(source, undefined, { maxFrameBytes: 0 }));

		expect(lines.map(bytes => (bytes as Uint8Array).length)).toEqual([8192]);
	});

	it("falls back to the frame bound when only maxFrameBytes is declared", async () => {
		const source = endless("data: x\n");

		const err = await drain(readSseEvents(source.stream, undefined, { maxFrameBytes: 1024 })).then(
			() => null,
			(caught: unknown) => frameLimitError(caught),
		);

		expect({ frame: err?.frame, allowed: err?.allowedBytes }).toEqual({ frame: "sse-event", allowed: 1024 });
	});

	it("recognises the violation through a wrapper that only carries it as a cause", () => {
		const wrapped = new Error("provider stream failed", {
			cause: new StreamFrameLimitError("sse-event", 2048, 1024),
		});

		expect(isStreamFrameLimitError(wrapped)).toBe(true);
		expect(isStreamFrameLimitError(new Error("provider stream failed"))).toBe(false);
	});
});

describe("the ceiling the environment declares", () => {
	let previous: string | undefined;

	beforeEach(() => {
		previous = process.env[STREAM_FRAME_MAX_BYTES_ENV];
	});

	afterEach(() => {
		if (previous === undefined) delete process.env[STREAM_FRAME_MAX_BYTES_ENV];
		else process.env[STREAM_FRAME_MAX_BYTES_ENV] = previous;
	});

	it("is honoured when it is a positive integer", () => {
		process.env[STREAM_FRAME_MAX_BYTES_ENV] = " 8192 ";

		expect(streamFrameCeiling()).toBe(8192);
		expect(streamEventCeiling()).toBe(8192);
	});

	// A typo in the knob is a typo, never a request for no bound: every one of these falls
	// back to the compiled default, which is the difference between a tuned protection and
	// a disabled one.
	it.each(["0", "-1", "abc", "1.5", "  ", "1e400", "9007199254740993"])(
		"falls back to the compiled default for %p",
		value => {
			process.env[STREAM_FRAME_MAX_BYTES_ENV] = value;

			expect(streamFrameCeiling()).toBe(DEFAULT_MAX_STREAM_FRAME_BYTES);
		},
	);

	it("is overridden by a limit the caller declared", () => {
		process.env[STREAM_FRAME_MAX_BYTES_ENV] = "8192";

		expect(streamFrameCeiling({ maxFrameBytes: 1024 })).toBe(1024);
		expect(streamEventCeiling({ maxFrameBytes: 1024 })).toBe(1024);
		expect(streamEventCeiling({ maxFrameBytes: 1024, maxEventBytes: 2048 })).toBe(2048);
	});
});
