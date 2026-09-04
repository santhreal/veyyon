import { describe, expect, it } from "bun:test";
import {
	hashlineParseText,
	stripHashlinePrefixes,
	stripNewLinePrefixes,
	stripOneLeadingHashlinePrefix,
} from "../src/prefixes";
import { streamHashLines } from "../src/stream";

async function collect(
	source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
	options = {},
): Promise<string[]> {
	const out: string[] = [];
	for await (const chunk of streamHashLines(source, options)) out.push(chunk);
	return out;
}

async function* bytes(...parts: string[]): AsyncGenerator<Uint8Array> {
	for (const part of parts) yield new TextEncoder().encode(part);
}

describe("streamHashLines", () => {
	it("numbers lines starting at startLine and joins them per chunk", async () => {
		const chunks = await collect(bytes("alpha\nbeta\ngamma"), { startLine: 5 });
		expect(chunks).toEqual(["5:alpha\n6:beta\n7:gamma"]);
	});

	it("splits chunks at maxChunkLines", async () => {
		const chunks = await collect(bytes("a\nb\nc\nd\ne"), { maxChunkLines: 2 });
		expect(chunks).toEqual(["1:a\n2:b", "3:c\n4:d", "5:e"]);
	});

	it("splits chunks when maxChunkBytes would overflow", async () => {
		const chunks = await collect(bytes("aaaaaaaa\nbbbbbbbb\ncc"), { maxChunkBytes: 12 });
		expect(chunks).toEqual(["1:aaaaaaaa", "2:bbbbbbbb", "3:cc"]);
	});

	it("reassembles lines split across byte chunks, including multi-byte UTF-8", async () => {
		const snowman = "☃";
		const encoded = new TextEncoder().encode(`he${snowman}llo\nworld`);
		async function* split(): AsyncGenerator<Uint8Array> {
			// Cut inside the 3-byte snowman sequence.
			yield encoded.slice(0, 3);
			yield encoded.slice(3);
		}
		expect(await collect(split())).toEqual([`1:he${snowman}llo\n2:world`]);
	});

	it("strips CR from CRLF endings and from a CR-terminated tail", async () => {
		expect(await collect(bytes("a\r\nb\r"))).toEqual(["1:a\n2:b"]);
	});

	it("yields a single numbered empty line for empty input", async () => {
		expect(await collect(bytes())).toEqual(["1:"]);
		expect(await collect(bytes(""))).toEqual(["1:"]);
	});

	it("accepts a ReadableStream source", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("x\ny"));
				controller.close();
			},
		});
		expect(await collect(stream)).toEqual(["1:x\n2:y"]);
	});

	it("does not emit an extra line for a trailing newline", async () => {
		expect(await collect(bytes("a\nb\n"))).toEqual(["1:a\n2:b"]);
	});
});

describe("stripOneLeadingHashlinePrefix", () => {
	it("strips exactly one prefix and never recurses into content", () => {
		expect(stripOneLeadingHashlinePrefix("12:hello")).toBe("hello");
		expect(stripOneLeadingHashlinePrefix(">>> 12:hello")).toBe("hello");
		expect(stripOneLeadingHashlinePrefix("12:34:56")).toBe("34:56");
		expect(stripOneLeadingHashlinePrefix("plain")).toBe("plain");
	});
});

describe("stripNewLinePrefixes", () => {
	it("strips hashline number prefixes when every content line has one", () => {
		expect(stripNewLinePrefixes(["1:a", "2:b", ""])).toEqual(["a", "b", ""]);
	});

	it("leaves lines alone when only some carry hashline prefixes", () => {
		expect(stripNewLinePrefixes(["1:a", "plain"])).toEqual(["1:a", "plain"]);
	});

	it("strips diff-style leading + when at least half the lines have one", () => {
		expect(stripNewLinePrefixes(["+a", "+b", "c"])).toEqual(["a", "b", "c"]);
		expect(stripNewLinePrefixes(["+a", "b", "c"])).toEqual(["+a", "b", "c"]);
	});

	it("does not treat ++ as a diff prefix", () => {
		expect(stripNewLinePrefixes(["++a", "++b"])).toEqual(["++a", "++b"]);
	});

	it("strips only the +N: form when the mixed diff-hashline shape is present", () => {
		expect(stripNewLinePrefixes(["+1:a", "plain"])).toEqual(["a", "plain"]);
	});

	it("drops section headers and read-truncation notices while stripping", () => {
		const lines = ["[src/foo.ts#1A2B]", "1:a", "[Showing lines 1-2 of 9] Use :L3 to continue", "2:b"];
		expect(stripNewLinePrefixes(lines)).toEqual(["a", "b"]);
	});

	it("returns empty and all-empty input untouched", () => {
		expect(stripNewLinePrefixes([])).toEqual([]);
		expect(stripNewLinePrefixes(["", ""])).toEqual(["", ""]);
	});
});

describe("stripHashlinePrefixes (strict)", () => {
	it("strips only when every content line is prefixed", () => {
		expect(stripHashlinePrefixes(["1:a", "2:b"])).toEqual(["a", "b"]);
		expect(stripHashlinePrefixes(["1:a", "plain"])).toEqual(["1:a", "plain"]);
		expect(stripHashlinePrefixes(["+a", "+b"])).toEqual(["+a", "+b"]);
	});

	it("ignores headers when deciding and removes them when stripping", () => {
		expect(stripHashlinePrefixes(["[src/foo.ts#1A2B]", "1:a"])).toEqual(["a"]);
		expect(stripHashlinePrefixes(["[src/foo.ts#1A2B]"])).toEqual(["[src/foo.ts#1A2B]"]);
	});
});

describe("hashlineParseText", () => {
	it("returns [] for null/undefined and splits strings on newlines", () => {
		expect(hashlineParseText(null)).toEqual([]);
		expect(hashlineParseText(undefined)).toEqual([]);
		expect(hashlineParseText("1:a\n2:b\n")).toEqual(["a", "b"]);
		expect(hashlineParseText("1:a\r\n2:b")).toEqual(["a", "b"]);
	});

	it("passes arrays through the opportunistic stripper", () => {
		expect(hashlineParseText(["+x", "+y"])).toEqual(["x", "y"]);
		expect(hashlineParseText(["plain", "text"])).toEqual(["plain", "text"]);
	});
});
