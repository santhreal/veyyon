/**
 * streamHashLines chunk boundaries: max lines, max bytes, startLine, CRLF, empty.
 */
import { describe, expect, it } from "bun:test";
import { streamHashLines } from "../src/stream";

async function collect(
	source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
	options: Parameters<typeof streamHashLines>[1] = {},
): Promise<string[]> {
	const out: string[] = [];
	for await (const chunk of streamHashLines(source, options)) out.push(chunk);
	return out;
}

async function* bytes(...parts: string[]): AsyncGenerator<Uint8Array> {
	const enc = new TextEncoder();
	for (const part of parts) yield enc.encode(part);
}

describe("streamHashLines property matrix", () => {
	it("startLine offsets every numbered line", async () => {
		for (const start of [1, 10, 100, 999]) {
			const chunks = await collect(bytes("a\nb"), { startLine: start });
			expect(chunks.join("\n")).toBe(`${start}:a\n${start + 1}:b`);
		}
	});

	it("maxChunkLines splits into exact groups", async () => {
		const body = ["a", "b", "c", "d", "e", "f"].join("\n");
		const chunks = await collect(bytes(body), { maxChunkLines: 3 });
		expect(chunks).toEqual(["1:a\n2:b\n3:c", "4:d\n5:e\n6:f"]);
	});

	it("maxChunkLines=1 yields one numbered line per chunk", async () => {
		const chunks = await collect(bytes("x\ny\nz"), { maxChunkLines: 1 });
		expect(chunks).toEqual(["1:x", "2:y", "3:z"]);
	});

	it("maxChunkBytes forces flush before overflow", async () => {
		// "1:aaaa" is 6 bytes; with tiny budget each line is its own chunk
		const chunks = await collect(bytes("aaaa\nbbbb\ncccc"), { maxChunkBytes: 8 });
		expect(chunks.length).toBeGreaterThanOrEqual(3);
		expect(chunks.join("\n").split("\n")).toEqual(["1:aaaa", "2:bbbb", "3:cccc"]);
	});

	it("reassembles lines split across many tiny byte chunks", async () => {
		const text = "hello\nworld\n!";
		const enc = new TextEncoder().encode(text);
		async function* oneByOne(): AsyncGenerator<Uint8Array> {
			for (let i = 0; i < enc.length; i++) yield enc.subarray(i, i + 1);
		}
		expect(await collect(oneByOne())).toEqual(["1:hello\n2:world\n3:!"]);
	});

	it("CRLF mid-stream yields LF-clean numbered lines", async () => {
		expect(await collect(bytes("a\r\nb\r\nc"))).toEqual(["1:a\n2:b\n3:c"]);
	});

	it("CRLF split across chunk boundary still strips CR", async () => {
		expect(await collect(bytes("a\r", "\nb"))).toEqual(["1:a\n2:b"]);
	});

	it("empty stream yields single empty numbered line at startLine", async () => {
		expect(await collect(bytes(), { startLine: 7 })).toEqual(["7:"]);
	});

	it("trailing newline does not invent a phantom empty content line", async () => {
		// stream path: trailing \n means last line was empty terminator, not a body line
		expect(await collect(bytes("only\n"))).toEqual(["1:only"]);
	});

	it("ReadableStream multi-enqueue equals async iterable of same bytes", async () => {
		const parts = ["line1\n", "line2\n", "line3"];
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				const enc = new TextEncoder();
				for (const p of parts) c.enqueue(enc.encode(p));
				c.close();
			},
		});
		const fromStream = await collect(stream);
		const fromAsync = await collect(bytes(...parts));
		expect(fromStream).toEqual(fromAsync);
		expect(fromStream).toEqual(["1:line1\n2:line2\n3:line3"]);
	});

	it("UTF-8 multi-byte characters survive mid-character chunk cuts", async () => {
		const s = "café ☃ 日本語";
		const enc = new TextEncoder().encode(`${s}\nok`);
		for (const cut of [1, 2, 3, 4, 5, Math.floor(enc.length / 2)]) {
			async function* split(): AsyncGenerator<Uint8Array> {
				yield enc.subarray(0, cut);
				yield enc.subarray(cut);
			}
			expect(await collect(split())).toEqual([`1:${s}\n2:ok`]);
		}
	});
});
