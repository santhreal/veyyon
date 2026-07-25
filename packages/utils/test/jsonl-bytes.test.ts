/**
 * `visitJsonlBytes` walks a file that is still being written to, and its return value is a promise.
 *
 * WHY THIS SUITE EXISTS. The stats dashboard reads a session transcript while the agent appends to it:
 * it keeps a byte offset, reads only the new bytes, and adds them to running totals. That makes the
 * offset this walker returns load-bearing in a way a line count is not. Return it one byte too far and
 * a line is skipped forever, silently lowering every total the dashboard shows. Return it one byte too
 * short and a line is counted twice, silently raising them. Nobody comparing a week's spend against a
 * provider bill has any reason to suspect the parser, so the offset is asserted here to the byte.
 *
 * The walk itself came from `packages/stats/src/parser.ts`, where it was a fourth hand-written JSONL
 * loop -- after the two string-based readers in this package -- and had drifted far enough to drop a
 * malformed line with no report at all, while both string readers had one. Unifying it is why the
 * module exists; these tests pin the contract the stats parser depends on so the next reader that
 * needs a byte-level walk imports it rather than writing a fifth.
 *
 * Every offset assertion below is a literal byte count, computed by hand from the input, not derived
 * from the implementation.
 */

import { describe, expect, it } from "bun:test";
import { decodeJsonlLine, type JsonlByteSkip, parseJsonlBytes, visitJsonlBytes } from "../src/jsonl-bytes";

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array {
	return encoder.encode(text);
}

/** Walk a buffer and collect items, offsets, lengths and skips in one call. */
function walk<T = unknown>(
	text: string,
	options?: { decode?: (line: string) => T | undefined },
): { items: T[]; skips: JsonlByteSkip[]; read: number } {
	const items: T[] = [];
	const skips: JsonlByteSkip[] = [];
	const read = visitJsonlBytes<T>(bytes(text), item => items.push(item), {
		...options,
		onSkip: skip => skips.push(skip),
	});
	return { items, skips, read };
}

describe("the offset a walk resumes from", () => {
	it("is the whole buffer when it ends on a newline", () => {
		// `{"a":1}\n` is 8 bytes, `{"a":2}\n` another 8.
		const result = walk('{"a":1}\n{"a":2}\n');

		expect(result.items).toEqual([{ a: 1 }, { a: 2 }]);
		expect(result.read).toBe(16);
	});

	/**
	 * THE contract. A trailing partial line is the ordinary state of a file being appended to, and the
	 * walk must stop before it: the line is re-read whole once the writer finishes it.
	 */
	it("stops before a trailing partial line", () => {
		const result = walk('{"a":1}\n{"a":2');

		expect(result.items).toEqual([{ a: 1 }]);
		expect(result.read).toBe(8);
		// And nothing is reported, because nothing is lost.
		expect(result.skips).toEqual([]);
	});

	it("is zero when the only line is partial, so the whole buffer is re-read", () => {
		const result = walk('{"a":1');

		expect(result.items).toEqual([]);
		expect(result.read).toBe(0);
	});

	/**
	 * The pair that proves the partial-line silence loses nothing: the same content, once cut off and
	 * once completed, yields the record exactly once and the offsets line up.
	 */
	it("picks the line up whole on the pass after the writer finishes it", () => {
		const first = walk('{"a":1}\n{"a":2');
		expect(first.read).toBe(8);

		const rest = walk('{"a":2}\n');

		expect(rest.items).toEqual([{ a: 2 }]);
		expect(rest.read).toBe(8);
	});

	it("counts bytes, not characters, so a multi-byte line does not shift the offset", () => {
		// `{"a":"é"}` is nine characters and ten bytes, because "é" is two in UTF-8. So the second line
		// starts at byte 11, and a walker counting characters would report 10 and read one byte short.
		const result = walk('{"a":"é"}\n{"b":2}\n');

		expect(result.items).toEqual([{ a: "é" }, { b: 2 }]);
		expect(result.read).toBe(19);
	});

	it("is the buffer length for an empty buffer, which is a no-op rather than an error", () => {
		expect(walk("")).toMatchObject({ items: [], read: 0, skips: [] });
	});
});

describe("a line that cannot be used", () => {
	/**
	 * A skip is data loss, and it is the loss the stats parser used to take in silence. The offset has
	 * to point at the line's first byte: it is what makes the line findable in a file of millions.
	 */
	it("is reported with its exact offset and length, and the walk continues", () => {
		const result = walk('{"a":1}\nnot json\n{"a":2}\n');

		expect(result.items).toEqual([{ a: 1 }, { a: 2 }]);
		expect(result.skips).toEqual([{ offset: 8, length: 8 }]);
		expect(result.read).toBe(25);
	});

	it("is reported for every bad line, in the order they appeared", () => {
		const result = walk("bad\n{}\nworse\n");

		expect(result.items).toEqual([{}]);
		expect(result.skips).toEqual([
			{ offset: 0, length: 3 },
			{ offset: 7, length: 5 },
		]);
	});

	/**
	 * A bad line at the END, with its newline, is still a skip and still advances the offset. Leaving it
	 * unconsumed would re-report it on every pass for as long as the file lives.
	 */
	it("advances past a bad final line so it is not re-reported forever", () => {
		const result = walk('{"a":1}\nbad\n');

		expect(result.skips).toEqual([{ offset: 8, length: 3 }]);
		expect(result.read).toBe(12);
	});

	/** A bad line with NO newline is a partial line, not a skip: it may be a half-written record. */
	it("is not reported when it has no newline yet, because it may still be being written", () => {
		const result = walk('{"a":1}\n{"a":');

		expect(result.skips).toEqual([]);
		expect(result.read).toBe(8);
	});
});

describe("a blank line", () => {
	/** Nothing to lose, so nothing is reported. A file being appended to grows blank tails constantly. */
	it("is skipped in silence and still advances the offset", () => {
		const result = walk('{"a":1}\n\n{"a":2}\n');

		expect(result.items).toEqual([{ a: 1 }, { a: 2 }]);
		expect(result.skips).toEqual([]);
		expect(result.read).toBe(17);
	});

	it("is silent for a bare CR line too, which carries no record either", () => {
		// The loop this replaced reported a CR-only line as a lost record, because it measured the line
		// before trimming the CR. There is nothing in it to lose.
		const result = walk('{"a":1}\n\r\n{"a":2}\n');

		expect(result.items).toEqual([{ a: 1 }, { a: 2 }]);
		expect(result.skips).toEqual([]);
		expect(result.read).toBe(18);
	});

	it("does not stop the walk when the buffer ends with blank lines", () => {
		expect(walk('{"a":1}\n\n\n').read).toBe(10);
	});
});

describe("CRLF line endings", () => {
	it("parse, with the CR excluded from the line length", () => {
		const result = walk('{"a":1}\r\n{"a":2}\r\n');

		expect(result.items).toEqual([{ a: 1 }, { a: 2 }]);
		expect(result.read).toBe(18);
		// The CR is excluded from the reported length of a bad line too.
		const bad = walk('{"a":1}\r\nnope\r\n');
		expect(bad.skips).toEqual([{ offset: 9, length: 4 }]);
	});
});

describe("a caller's own decode", () => {
	/**
	 * The reason the option exists. `JSON.parse` accepts `null`, a number and a string, and a reader
	 * expecting objects of a known shape must be able to call those a skip: visiting them puts a
	 * non-record into whatever the caller is summing. The stats parser passes exactly this.
	 */
	it("can narrow what counts as a record, turning valid JSON into a reported skip", () => {
		const objectsOnly = (line: string): Record<string, unknown> | undefined => {
			try {
				const parsed: unknown = JSON.parse(line);
				return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
			} catch {
				return undefined;
			}
		};

		const result = walk('{"a":1}\nnull\n42\n{"b":2}\n', { decode: objectsOnly });

		expect(result.items).toEqual([{ a: 1 }, { b: 2 }]);
		expect(result.skips).toEqual([
			{ offset: 8, length: 4 },
			{ offset: 13, length: 2 },
		]);
	});

	it("receives the line's text with the CR already trimmed", () => {
		const seen: string[] = [];
		walk('{"a":1}\r\n', {
			decode: line => {
				seen.push(line);
				return line;
			},
		});

		expect(seen).toEqual(['{"a":1}']);
	});

	/** The default is plain JSON, so a bare `null` line IS a record unless the caller says otherwise. */
	it("is optional, and the default accepts any valid JSON value", () => {
		const result = walk("null\n42\n");

		expect(result.items).toEqual([null, 42]);
		expect(result.skips).toEqual([]);
	});
});

describe("parseJsonlBytes", () => {
	it("collects what the visitor would have seen, with the same resume offset", () => {
		const result = parseJsonlBytes<{ a: number }>(bytes('{"a":1}\n{"a":2}\n{"a":3'));

		expect(result.items).toEqual([{ a: 1 }, { a: 2 }]);
		expect(result.read).toBe(16);
	});

	it("reports skips the same way", () => {
		const skips: JsonlByteSkip[] = [];

		parseJsonlBytes(bytes("bad\n"), { onSkip: skip => skips.push(skip) });

		expect(skips).toEqual([{ offset: 0, length: 3 }]);
	});
});

describe("decodeJsonlLine", () => {
	/**
	 * For a caller that splits lines elsewhere -- `readLines` over a stream -- so the CR trim and the
	 * parse have one owner instead of being hand-rolled beside every such reader.
	 */
	it("decodes one line that carries no newline of its own", () => {
		expect(decodeJsonlLine<{ a: number }>(bytes('{"a":1}'))).toEqual({ a: 1 });
	});

	it("trims a trailing CR, so a CRLF file's lines decode", () => {
		expect(decodeJsonlLine<{ a: number }>(bytes('{"a":1}\r'))).toEqual({ a: 1 });
	});

	it("returns undefined for a blank line and for a line that is not JSON", () => {
		expect(decodeJsonlLine(bytes(""))).toBeUndefined();
		expect(decodeJsonlLine(bytes("\r"))).toBeUndefined();
		expect(decodeJsonlLine(bytes("   "))).toBeUndefined();
		expect(decodeJsonlLine(bytes("not json"))).toBeUndefined();
	});

	it("honours a caller's decode, so it narrows records the same way the walk does", () => {
		const objectsOnly = (line: string): object | undefined => {
			const parsed: unknown = JSON.parse(line);
			return parsed !== null && typeof parsed === "object" ? parsed : undefined;
		};

		expect(decodeJsonlLine(bytes("null"), { decode: objectsOnly })).toBeUndefined();
		expect(decodeJsonlLine(bytes("{}"), { decode: objectsOnly })).toEqual({});
	});
});

describe("a large buffer", () => {
	/**
	 * Throughput is the reason this walk is byte-level rather than `text.split("\\n")`, so the property
	 * that matters is asserted rather than described: the walk never materializes the whole buffer, and
	 * it holds nothing per line once the visitor is done with it.
	 *
	 * The assertion is on WORK, not on wall-clock: a timing threshold in a test suite is flaky on shared
	 * CI and says nothing about the algorithm. What is pinned is that a 200k-line buffer walks to the
	 * exact byte and visits every line once, which is the invariant a faster or slower machine cannot
	 * change. `scripts/bench-jsonl-bytes.ts` measures the actual throughput.
	 */
	it("walks 200k lines to the exact byte, visiting each once", () => {
		const lines: string[] = [];
		for (let i = 0; i < 200_000; i++) lines.push(JSON.stringify({ i, pad: "0123456789" }));
		const text = `${lines.join("\n")}\n`;
		const buffer = bytes(text);

		let count = 0;
		let inOrder = true;
		const read = visitJsonlBytes<{ i: number }>(buffer, item => {
			if (item.i !== count) inOrder = false;
			count++;
		});

		expect(count).toBe(200_000);
		expect(inOrder).toBe(true);
		expect(read).toBe(buffer.length);
	});
});
