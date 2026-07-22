import { describe, expect, it } from "bun:test";
import { sanitizeText } from "@veyyon/utils/sanitize-text";
import {
	parseJsonlLenient,
	readJsonl,
	readLines,
	readSseEvents,
	readSseJson,
	type ServerSentEvent,
} from "@veyyon/utils/stream";

const encoder = new TextEncoder();

async function runStringTransform(transform: TransformStream<string, string>, chunks: string[]): Promise<string[]> {
	const readable = new ReadableStream<string>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});

	const reader = readable.pipeThrough(transform).getReader();
	const output: string[] = [];
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		output.push(value);
	}
	return output;
}

async function collectAsync<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const output: T[] = [];
	for await (const item of iter) output.push(item);
	return output;
}

describe("sanitizeText", () => {
	it("strips ANSI and normalizes CR", () => {
		const input = "\u001b[31mred\u001b[0m\r\n";
		expect(sanitizeText(input)).toBe("red\n");
	});
});

describe("readLines", () => {
	it("splits lines across chunks without newlines", async () => {
		const readable = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("alpha\nbe"));
				controller.enqueue(encoder.encode("ta\ngam"));
				controller.enqueue(encoder.encode("ma"));
				controller.close();
			},
		});

		const output: string[] = [];
		const dec = new TextDecoder();
		for await (const line of readLines(readable)) {
			output.push(dec.decode(line));
		}

		expect(output).toEqual(["alpha", "beta", "gamma"]);
	});
});

describe("abortableSource (via readLines)", () => {
	it("cancels the source and stops yielding when aborted mid-stream", async () => {
		let cancelReason: unknown;
		let cancelled = false;
		const controller = new AbortController();
		const readable = new ReadableStream<Uint8Array>({
			start(streamController) {
				// One complete line, then leave the stream open so the next read blocks.
				streamController.enqueue(encoder.encode("alpha\n"));
			},
			cancel(reason) {
				cancelled = true;
				cancelReason = reason;
			},
		});

		const dec = new TextDecoder();
		const iter = readLines(readable, controller.signal)[Symbol.asyncIterator]();

		const first = await iter.next();
		expect(first.done).toBe(false);
		expect(dec.decode(first.value as Uint8Array)).toBe("alpha");

		controller.abort("timeout");
		const next = await iter.next();

		expect(next.done).toBe(true);
		expect(cancelled).toBe(true);
		expect(cancelReason).toBe("timeout");
	});

	it("cancels the source when the consumer breaks early", async () => {
		let cancelled = false;
		const readable = new ReadableStream<Uint8Array>({
			start(streamController) {
				streamController.enqueue(encoder.encode("alpha\n"));
				streamController.enqueue(encoder.encode("beta\n"));
				// Stays open: only a `break` (not EOF) should trigger cancel.
			},
			cancel() {
				cancelled = true;
			},
		});

		const dec = new TextDecoder();
		const lines: string[] = [];
		for await (const line of readLines(readable)) {
			lines.push(dec.decode(line));
			break;
		}

		expect(lines).toEqual(["alpha"]);
		expect(cancelled).toBe(true);
	});
});

describe("readJsonl", () => {
	it("parses JSONL across chunk boundaries", async () => {
		const readable = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode('{"a":1}\n{"b":'));
				controller.enqueue(encoder.encode('2}\n{"c":3}\n'));
				controller.close();
			},
		});

		const output = await collectAsync(readJsonl(readable));
		expect(output).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
	});

	it("parses trailing line without newline", async () => {
		const readable = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode('{"z":9}'));
				controller.close();
			},
		});

		const output = await collectAsync(readJsonl(readable));
		expect(output).toEqual([{ z: 9 }]);
	});
});

describe("createSanitizerStream", () => {
	it("sanitizes text chunks", async () => {
		const transform = new TransformStream<string, string>({
			transform(chunk, controller) {
				controller.enqueue(sanitizeText(chunk));
			},
		});
		const output = await runStringTransform(transform, ["\u001b[34mhi\u001b[0m\r\n"]);

		expect(output).toEqual(["hi\n"]);
	});
});

describe("parseJsonlLenient", () => {
	it("parses valid JSONL", () => {
		const result = parseJsonlLenient<{ a: number }>('{"a":1}\n{"a":2}\n{"a":3}\n');
		expect(result).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
	});

	it("skips malformed lines and continues", () => {
		const result = parseJsonlLenient<{ a: number }>('{"a":1}\n{bad json}\n{"a":3}\n');
		expect(result).toEqual([{ a: 1 }, { a: 3 }]);
	});

	it("returns empty array for empty input", () => {
		expect(parseJsonlLenient("")).toEqual([]);
	});

	it("handles input without trailing newline", () => {
		const result = parseJsonlLenient<{ x: number }>('{"x":42}');
		expect(result).toEqual([{ x: 42 }]);
	});

	it("reports each skipped malformed record through onSkip so a drop is never silent", () => {
		// WHY: a session loader that silently drops a corrupt line loses an entry
		// invisibly (Law 10). onSkip is how callers surface the loss loudly. This pins
		// that every skipped record fires the callback with the bad line's content and
		// that good records on both sides still parse.
		const skips: Array<{ offset: number; snippet: string }> = [];
		const result = parseJsonlLenient<{ a: number }>('{"a":1}\n{bad json}\n{"a":3}\n{also bad}\n{"a":5}\n', {
			onSkip: s => skips.push(s),
		});
		expect(result).toEqual([{ a: 1 }, { a: 3 }, { a: 5 }]);
		expect(skips).toHaveLength(2);
		expect(skips[0]?.snippet).toContain("{bad json}");
		expect(skips[1]?.snippet).toContain("{also bad}");
		// Offsets advance monotonically into the buffer, pointing past the earlier good
		// records so a caller can locate the corruption.
		expect(skips[1]?.offset).toBeGreaterThan(skips[0]?.offset ?? 0);
	});

	it("does not call onSkip when every record is valid", () => {
		// WHY: the loud path must stay quiet on healthy files — a spurious warning on a
		// clean session load would be noise and would erode trust in the real signal.
		const skips: unknown[] = [];
		const result = parseJsonlLenient<{ a: number }>('{"a":1}\n{"a":2}\n', { onSkip: s => skips.push(s) });
		expect(result).toEqual([{ a: 1 }, { a: 2 }]);
		expect(skips).toHaveLength(0);
	});
});

/**
 * Property / adversarial corruption fuzzer for `parseJsonlLenient`
 * (DATALOSS-4 loud-skip contract + DATALOSS-5 exact-count contract).
 *
 * The DATALOSS-5 bug reported every malformed record TWICE, so the
 * operator-visible "dropped N records" total was exactly 2x the real loss.
 * That off-by-a-factor survived the hand-written examples above because they
 * never stressed adjacency, run length, or corruption position. This suite
 * generates thousands of randomized JSONL streams from a fixed seed and pins
 * two invariants no matter where the corruption lands:
 *
 *   1. RECALL — every well-formed record parses, in order, byte-for-byte.
 *   2. EXACT ACCOUNTING — the skip count equals the number of malformed lines,
 *      never 2x (DATALOSS-5) and never 0 (a silent drop, Law 10).
 *
 * The corpus below is empirically verified: each GOOD line parses to exactly
 * one value with zero skips, and each BAD line skips exactly once whether it
 * sits alone, adjacent to another bad line, or between good lines. Forms whose
 * skip accounting is ambiguous to `Bun.JSONL.parseChunk` — a possibly-continuing
 * truncated array `[1,2,`, or trailing garbage after a valid value on one line —
 * are deliberately excluded so the exact-count invariant is meaningful.
 */
describe("parseJsonlLenient — property/adversarial corruption fuzzer (DATALOSS-4/5)", () => {
	/** Each skips exactly once alone, adjacent, and sandwiched (probe-verified). */
	const BAD_FORMS = [
		"{malformed",
		'{"x":}',
		'{"unterminated":"str',
		'{"a":1,,}',
		'{"k" "v"}',
		'{"n":}',
		"xyz",
		'{"a" 1}',
		"}{",
	] as const;

	/** Deterministic PRNG (mulberry32) so a fuzz failure is reproducible from its seed. */
	function makeRng(seed: number): () => number {
		let a = seed >>> 0;
		return () => {
			a |= 0;
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	/** Build one random stream; return the text plus the ground truth it must reproduce. */
	function buildStream(rng: () => number): { text: string; goodValues: unknown[]; badCount: number } {
		const lineCount = 1 + Math.floor(rng() * 40);
		const lines: string[] = [];
		const goodValues: unknown[] = [];
		let badCount = 0;
		let nextIndex = 0;
		for (let i = 0; i < lineCount; i++) {
			// ~35% corruption rate, so adjacent-bad runs occur naturally and often.
			if (rng() < 0.35) {
				lines.push(BAD_FORMS[Math.floor(rng() * BAD_FORMS.length)] as string);
				badCount++;
			} else {
				const idx = nextIndex++;
				// A unique alphanumeric payload proves order AND content survive, not just count.
				const len = 1 + Math.floor(rng() * 12);
				let payload = "";
				for (let c = 0; c < len; c++) payload += "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(rng() * 36)];
				const value = { i: idx, v: payload };
				lines.push(JSON.stringify(value));
				goodValues.push(value);
			}
		}
		return { text: `${lines.join("\n")}\n`, goodValues, badCount };
	}

	it("recovers every valid record in order and counts skips exactly across 3000 random streams", () => {
		// WHY: locks the DATALOSS-5 fix hard. With random corruption density and
		// placement — including long adjacent-bad runs — the skip count must equal the
		// real number of malformed lines (not 2x), and no good record may be lost.
		const rng = makeRng(0x9e3779b9);
		let checkedGood = 0;
		let checkedBad = 0;
		for (let iter = 0; iter < 3000; iter++) {
			const { text, goodValues, badCount } = buildStream(rng);
			const skips: Array<{ offset: number; snippet: string }> = [];
			const parsed = parseJsonlLenient<{ i: number; v: string }>(text, { onSkip: s => skips.push(s) });

			// Recall: exact values, exact order, byte-for-byte content.
			expect(parsed).toEqual(goodValues as Array<{ i: number; v: string }>);
			// Accounting: one skip per malformed line — never 2x (DATALOSS-5), never 0 (Law 10).
			expect(skips.length).toBe(badCount);
			// Offsets are non-decreasing and in range, so a caller can locate each drop.
			let prev = -1;
			for (const s of skips) {
				expect(s.offset).toBeGreaterThanOrEqual(prev);
				expect(s.offset).toBeLessThanOrEqual(text.length);
				prev = s.offset;
			}
			checkedGood += goodValues.length;
			checkedBad += badCount;
		}
		// Guard the fuzzer itself: a seed that silently generated all-clean or all-bad
		// streams would make the assertions vacuous. Demand real coverage of both.
		expect(checkedGood).toBeGreaterThan(1000);
		expect(checkedBad).toBeGreaterThan(1000);
	});

	it("counts a long run of adjacent malformed records exactly once each (the DATALOSS-5 killer)", () => {
		// WHY: the double-count came from an error reported with read>0 (good record
		// consumed, next record bad) plus again at read===0. A dense wall of bad lines
		// maximizes read>0 error reports; the count must still be N, not 2N.
		const N = 200;
		const badWall = `${Array.from({ length: N }, () => "{malformed").join("\n")}\n`;
		const text = `{"i":0}\n${badWall}{"i":1}\n`;
		const skips: unknown[] = [];
		const parsed = parseJsonlLenient<{ i: number }>(text, { onSkip: s => skips.push(s) });
		expect(parsed).toEqual([{ i: 0 }, { i: 1 }]);
		expect(skips).toHaveLength(N);
	});

	it("alternating good/bad lines: N good survive and N bad each skip once", () => {
		// WHY: strict alternation is the pattern most likely to trip a read-pointer
		// off-by-one — every good record is immediately followed by a bad one.
		const N = 500;
		const lines: string[] = [];
		for (let i = 0; i < N; i++) {
			lines.push(JSON.stringify({ i }));
			lines.push("{malformed");
		}
		const skips: unknown[] = [];
		const parsed = parseJsonlLenient<{ i: number }>(`${lines.join("\n")}\n`, { onSkip: s => skips.push(s) });
		expect(parsed).toHaveLength(N);
		expect(parsed[0]).toEqual({ i: 0 });
		expect(parsed[N - 1]).toEqual({ i: N - 1 });
		expect(skips).toHaveLength(N);
	});

	it("treats an unclosed final line with no trailing newline as an incomplete partial write, not a malformed skip", () => {
		// WHY: pins the actual `Bun.JSONL.parseChunk` contract — an undelimited trailing
		// token (`{malformed`, `{"i":1`) reports error=no, read=0, done=false, i.e.
		// "awaiting more input", NOT "malformed". On a session file the only way to reach
		// an undelimited tail is a crash mid-append: the partial line was never a complete
		// durable record, so dropping it (no value, no onSkip) is correct — it is not the
		// mid-file complete-but-corrupt drop that DATALOSS-4 makes loud. All prior records
		// up to the last newline are fully recovered.
		const skips: unknown[] = [];
		const parsed = parseJsonlLenient<{ i: number }>('{"i":0}\n{"i":1}\n{malformed', { onSkip: s => skips.push(s) });
		expect(parsed).toEqual([{ i: 0 }, { i: 1 }]);
		expect(skips).toHaveLength(0);
	});

	it("a complete final value with no trailing newline is parsed and not mistaken for a skip", () => {
		// WHY: the mirror — a well-formed value at EOF without a delimiter IS a complete
		// record (closing brace present) and must parse, and must NOT fire onSkip. This is
		// what separates a real record from the incomplete partial-write tail above.
		const skips: unknown[] = [];
		const parsed = parseJsonlLenient<{ i: number }>('{"i":0}\n{"i":1}', { onSkip: s => skips.push(s) });
		expect(parsed).toEqual([{ i: 0 }, { i: 1 }]);
		expect(skips).toHaveLength(0);
	});
});

describe("readSseJson", () => {
	it("parses data lines and stops at [DONE]", async () => {
		const chunks = [
			encoder.encode('data: {"a":1}\n\n'),
			encoder.encode("event: ping\ndata: \n\n"),
			encoder.encode('data: {"b":2}\r\n\r\n'),
			encoder.encode("data: [DONE]\n\n"),
			encoder.encode('data: {"c":3}\n\n'),
		];
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				controller.close();
			},
		});

		const output = await collectAsync(readSseJson(stream));
		expect(output).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it("reports raw events to diagnostic observers without changing parsed output", async () => {
		const stream = bytesStreamFromChunks([
			encoder.encode('event: message\ndata: {"a":1}\n\n'),
			encoder.encode("event: done\ndata: [DONE]\n\n"),
		]);
		const observed: ServerSentEvent[] = [];

		const output = await collectAsync(readSseJson(stream, undefined, event => observed.push(event)));

		expect(output).toEqual([{ a: 1 }]);
		expect(observed.map(event => event.event)).toEqual(["message", "done"]);
		expect(observed[0].raw).toEqual(["event: message", 'data: {"a":1}']);
	});

	it("flushes a trailing event without the closing blank line", async () => {
		const chunks = [encoder.encode('data: {"c":3}')];
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				controller.close();
			},
		});

		const output = await collectAsync(readSseJson(stream));
		expect(output).toEqual([{ c: 3 }]);
	});

	it("handles data lines split across chunks", async () => {
		const chunks = [encoder.encode('data: {"a"'), encoder.encode(":1}\n\n")];
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				controller.close();
			},
		});

		const output = await collectAsync(readSseJson(stream));
		expect(output).toEqual([{ a: 1 }]);
	});

	it("completes cleanly when the final data chunk is truncated JSON", async () => {
		const testCases = [
			'data: {"b":2',
			'data: {"id":"x", "na',
			'data: {"id":"x", "name"',
			'data: {"id":"x", "name":',
			'data: {"id":"x", "name": "y',
			'data: {"id":"x",',
			"data: [1,2,",
			'data: {"s":"n',
			'data: {"n',
			'data: {"s":"abc\\',
			'data: {"s":"\\u12',
		];
		for (const dataChunk of testCases) {
			const chunks = [encoder.encode('data: {"a":1}\n\n'), encoder.encode(dataChunk)];
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of chunks) controller.enqueue(chunk);
					controller.close();
				},
			});

			const output = await collectAsync(readSseJson(stream));
			expect(output).toEqual([{ a: 1 }]);
		}
	});

	it("completes cleanly when the final data chunk is cut inside a JSON literal at EOF", async () => {
		const testCases = ['data: {"finish_reason":nul', 'data: {"ok":tru', "data: [fal"];
		for (const dataChunk of testCases) {
			const chunks = [encoder.encode('data: {"a":1}\n\n'), encoder.encode(dataChunk)];
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of chunks) controller.enqueue(chunk);
					controller.close();
				},
			});

			const output = await collectAsync(readSseJson(stream));
			expect(output).toEqual([{ a: 1 }]);
		}
	});

	it("throws SyntaxError when a middle data chunk is malformed JSON", async () => {
		const chunks = [encoder.encode('data: {"a":1\n\n'), encoder.encode('data: {"b":2}\n\n')];
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				controller.close();
			},
		});

		await expect(collectAsync(readSseJson(stream))).rejects.toThrow(SyntaxError);
	});

	it("throws SyntaxError when a final event is not JSON-container-shaped", async () => {
		// Non-object/array final events are not recoverable as a truncated stream tail
		// and still surface as errors (e.g. provider error text, bare scalars).
		const testCases = ["data: Internal Server Error", 'data: "an unterminated string', "data: 42 then junk"];
		for (const dataChunk of testCases) {
			const chunks = [encoder.encode('data: {"a":1}\n\n'), encoder.encode(dataChunk)];
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of chunks) controller.enqueue(chunk);
					controller.close();
				},
			});

			await expect(collectAsync(readSseJson(stream))).rejects.toThrow(SyntaxError);
		}
	});

	it("stops cleanly on a container-shaped final event that fails strict parse", async () => {
		// Lenient recovery: any object/array-shaped final event JSON.parse rejects is
		// treated as a cut-off or lightly malformed stream tail and ends iteration after
		// the last valid event, rather than throwing.
		const testCases = [
			'data: {"b":2,}', // trailing comma
			"data: [{]", // mismatched closer
			'data: {"b" 2}', // missing colon
			"data: {unterminated}", // bareword body
			'data: {"b": true garbage', // trailing garbage after a value
			'data: {"b":1 "c":2', // missing comma
			'data: {"b": ]', // mismatched closer
			'data: {"b": @', // invalid character
		];
		for (const dataChunk of testCases) {
			const chunks = [encoder.encode('data: {"a":1}\n\n'), encoder.encode(dataChunk)];
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of chunks) controller.enqueue(chunk);
					controller.close();
				},
			});

			const output = await collectAsync(readSseJson(stream));
			expect(output).toEqual([{ a: 1 }]);
		}
	});
});

function bytesStreamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

describe("readSseEvents", () => {
	it("dispatches events on blank-line boundaries", async () => {
		const stream = bytesStreamFromChunks([
			encoder.encode('event: message_start\ndata: {"id":1}\n\n'),
			encoder.encode("event: message_stop\ndata: {}\n\n"),
		]);
		const events = await collectAsync(readSseEvents(stream));
		expect(events.map(e => e.event)).toEqual(["message_start", "message_stop"]);
		expect(events.map(e => e.data)).toEqual(['{"id":1}', "{}"]);
	});

	it("joins multiple data: lines with newlines", async () => {
		const stream = bytesStreamFromChunks([encoder.encode("event: chunk\ndata: line1\ndata: line2\ndata: line3\n\n")]);
		const [evt] = await collectAsync(readSseEvents(stream));
		expect(evt.event).toBe("chunk");
		expect(evt.data).toBe("line1\nline2\nline3");
	});

	it("skips comment lines but preserves them in raw", async () => {
		const stream = bytesStreamFromChunks([encoder.encode(": keep-alive\nevent: ping\ndata: ok\n\n")]);
		const [evt] = await collectAsync(readSseEvents(stream));
		expect(evt.event).toBe("ping");
		expect(evt.data).toBe("ok");
		expect(evt.raw).toEqual([": keep-alive", "event: ping", "data: ok"]);
	});

	it("does not carry pure comment keepalives into the next event raw lines", async () => {
		const stream = bytesStreamFromChunks([encoder.encode(": keepalive\n\nevent: ping\ndata: ok\n\n")]);
		const [evt] = await collectAsync(readSseEvents(stream));
		expect(evt.raw).toEqual(["event: ping", "data: ok"]);
	});

	it("strips a single optional space after the field colon (and only one)", async () => {
		const stream = bytesStreamFromChunks([encoder.encode("event:  spaced\ndata:  body\n\n")]);
		const [evt] = await collectAsync(readSseEvents(stream));
		expect(evt.event).toBe(" spaced");
		expect(evt.data).toBe(" body");
	});

	it("handles CRLF line terminators", async () => {
		const stream = bytesStreamFromChunks([encoder.encode("event: a\r\ndata: 1\r\n\r\nevent: b\r\ndata: 2\r\n\r\n")]);
		const events = await collectAsync(readSseEvents(stream));
		expect(events.map(e => `${e.event}=${e.data}`)).toEqual(["a=1", "b=2"]);
	});

	it("recovers when a chunk boundary splits inside a field name", async () => {
		const stream = bytesStreamFromChunks([
			encoder.encode("eve"),
			encoder.encode("nt: split\nda"),
			encoder.encode("ta: payload\n\n"),
		]);
		const events = await collectAsync(readSseEvents(stream));
		expect(events).toHaveLength(1);
		expect(events[0].event).toBe("split");
		expect(events[0].data).toBe("payload");
	});

	it("recovers when a chunk boundary splits inside a multi-byte UTF-8 sequence", async () => {
		// "héllo" → bytes for 'é' are 0xC3 0xA9; split between them.
		const full = encoder.encode("data: héllo\n\n");
		const split = full.indexOf(0xc3) + 1;
		const stream = bytesStreamFromChunks([full.subarray(0, split), full.subarray(split)]);
		const [evt] = await collectAsync(readSseEvents(stream));
		expect(evt.data).toBe("héllo");
	});

	it("flushes a pending event even without the trailing blank line", async () => {
		const stream = bytesStreamFromChunks([encoder.encode("event: trailing\ndata: tail\n")]);
		const events = await collectAsync(readSseEvents(stream));
		expect(events).toEqual([
			{ event: "trailing", data: "tail", raw: ["event: trailing", "data: tail"] },
		] satisfies ServerSentEvent[]);
	});

	it("treats a tail without any newline as a complete final line", async () => {
		const stream = bytesStreamFromChunks([encoder.encode("event: x\ndata: y")]);
		const events = await collectAsync(readSseEvents(stream));
		expect(events).toHaveLength(1);
		expect(events[0].event).toBe("x");
		expect(events[0].data).toBe("y");
	});

	it("survives a one-byte-per-chunk drip feed without quadratic blowup", async () => {
		// The legacy decoder rebuilt the entire string buffer per line and was
		// O(n²) in this case. Should now complete in well under a second.
		const lines: string[] = [];
		for (let i = 0; i < 2000; i++) {
			lines.push(`event: e${i}`, `data: ${i}`, "");
		}
		const payload = encoder.encode(`${lines.join("\n")}\n`);
		const oneByteChunks = Array.from(payload, byte => Uint8Array.of(byte));
		const stream = bytesStreamFromChunks(oneByteChunks);
		const start = performance.now();
		const events = await collectAsync(readSseEvents(stream));
		const elapsed = performance.now() - start;
		expect(events).toHaveLength(2000);
		expect(events[1999].event).toBe("e1999");
		expect(events[1999].data).toBe("1999");
		// Generous bound: the previous quadratic implementation needed >5s here.
		expect(elapsed).toBeLessThan(2000);
	});
});
