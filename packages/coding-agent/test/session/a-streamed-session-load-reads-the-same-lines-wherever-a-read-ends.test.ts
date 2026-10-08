import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { type OperatorNotice, OperatorNotices } from "@veyyon/kernel/session/operator-notices";
import {
	loadEntriesFromFileStream,
	type ParsedSessionContent,
	parseSessionContent,
} from "@veyyon/kernel/session/session-loader";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { serializeTitleSlot } from "@veyyon/kernel/session/session-title-slot";
import { TempDir } from "@veyyon/utils";
import { STREAM_FRAME_MAX_BYTES_ENV, StreamFrameLimitError } from "@veyyon/utils/stream";

/**
 * WHY: a session of 8 MiB or more is read in fixed-size pieces and split into lines as each
 * piece arrives; a smaller one is read whole and split once. A line that straddles two pieces is
 * where the piecewise reader goes wrong: it drops the bytes it carried from the previous piece,
 * misses a line feed that is the first byte of a piece, splits a multi-byte character, loses a
 * last line that ends on the last byte of the file, or miscounts the byte offsets that a notice
 * and the session layout quote.
 *
 * The class this closes: wherever the piece boundary falls, the streamed load produces the same
 * entries, title slot, record layout and operator notices as the whole-file load of the same
 * bytes, and a line longer than the stream frame bound fails the streamed load wherever it sits
 * while a line of the bound loads. The piece size is read at run time from the first read the
 * loader issues, and every fixture is laid out around it: a line feed on each byte from two
 * before the boundary to one after it, a CRLF split between the pieces, an empty line opening the
 * second piece, each interior split of a 2-, 3- and 4-byte UTF-8 character, a damaged line across
 * the boundary, a record longer than two pieces, and a last line with no line feed that ends one
 * byte before, on, or one byte after the boundary.
 *
 * What it does NOT catch: only the first boundary is placed exactly. Later boundaries fall
 * wherever the carried line leaves them and run the same code with other carries. A byte order
 * mark is out of scope: the streamed load drops one at the start of every line and counts its
 * bytes, the whole-file load drops only the one that opens the file and does not count it.
 */

const HEADER_ID = "019f0000-0000-7000-8000-00000000abcd";
const TIMESTAMP = "2026-01-01T00:00:00.000Z";
const SOURCE = "boundary.jsonl";
/** Text length of a record that only moves the cursor toward a boundary. */
const FILLER_TEXT = 16 * 1024;
/** Most bytes {@link SessionBytes.fillBefore} leaves for the record that reaches the target, beyond one filler. */
const FILL_SLACK = 1024;

function headerLine(): string {
	return JSON.stringify({ type: "session", version: 7, id: HEADER_ID, timestamp: TIMESTAMP, cwd: "/repo" });
}

function messageLine(id: string, parentId: string, text: string): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: TIMESTAMP,
		message: { role: "user", content: text, timestamp: 1_767_225_600_000 },
	});
}

/** Session file text built record by record, with the byte offset of the next record known. */
class SessionBytes {
	readonly #parts: string[] = [];
	readonly #filler: number;
	#bytes = 0;
	#count = 0;
	#parent = HEADER_ID;

	constructor(filler = FILLER_TEXT) {
		this.#filler = filler;
		this.raw(serializeTitleSlot({ title: "boundary fixture", source: "user", updatedAt: TIMESTAMP }));
		this.raw(`${headerLine()}\n`);
	}

	get bytes(): number {
		return this.#bytes;
	}

	/** Bytes written as they are, which is how a damaged line or a bare line feed enters the file. */
	raw(text: string): void {
		this.#parts.push(text);
		this.#bytes += Buffer.byteLength(text, "utf-8");
	}

	record(text: string, terminator = "\n"): void {
		const id = `e${++this.#count}`;
		this.raw(`${messageLine(id, this.#parent, text)}${terminator}`);
		this.#parent = id;
	}

	/** Append filler records until one record can reach any offset up to `end`. */
	fillBefore(end: number): void {
		while (end - this.#bytes > this.#filler + FILL_SLACK) this.record("f".repeat(this.#filler));
	}

	/** One record, its terminator included, occupying the bytes from here to `end`. */
	recordUntil(end: number, terminator: string): void {
		const bare = Buffer.byteLength(messageLine(`e${this.#count + 1}`, this.#parent, ""), "utf-8");
		const pad = end - this.#bytes - bare - Buffer.byteLength(terminator, "utf-8");
		if (pad < 0) throw new Error(`no room for a record ending at ${end}: the file is already ${this.#bytes} bytes`);
		this.record("p".repeat(pad), terminator);
	}

	/** One record whose text is `payload`, placed so the payload's first byte sits at `offset`. */
	recordWithTextAt(offset: number, payload: string): void {
		const probe = Buffer.from(messageLine(`e${this.#count + 1}`, this.#parent, "@"), "utf-8").indexOf("@");
		const pad = offset - this.#bytes - probe;
		if (pad < 0) throw new Error(`no room for text at ${offset}: the file is already ${this.#bytes} bytes`);
		this.record(`${"p".repeat(pad)}${payload}`);
	}

	text(): string {
		return this.#parts.join("");
	}
}

interface Loaded {
	result: ParsedSessionContent;
	notices: string[];
}

function noticeSink(): { sink: OperatorNotices; notices: OperatorNotice[] } {
	const notices: OperatorNotice[] = [];
	return { sink: new OperatorNotices(notice => notices.push(notice)), notices };
}

function noticeText(notices: OperatorNotice[]): string[] {
	return notices.map(notice => `${notice.severity}/${notice.source}: ${notice.text}`);
}

let readBytes = 0;
let fileHandlePrototype: FileHandle;

/** Stream `content` from a file, counting the reads the loader issues. */
async function streamed(file: string): Promise<Loaded & { reads: number }> {
	const read = vi.spyOn(fileHandlePrototype, "read");
	const { sink, notices } = noticeSink();
	try {
		const result = await loadEntriesFromFileStream(file, { source: SOURCE, operatorNotices: sink });
		return { result, notices: noticeText(notices), reads: read.mock.calls.length };
	} finally {
		read.mockRestore();
	}
}

/** The same file through the whole-file path a session under 8 MiB takes. */
async function whole(file: string): Promise<Loaded> {
	const { sink, notices } = noticeSink();
	const result = parseSessionContent(await new FileSessionStorage().readText(file), {
		source: SOURCE,
		operatorNotices: sink,
	});
	return { result, notices: noticeText(notices) };
}

async function withFile<T>(content: string, run: (file: string) => Promise<T>): Promise<T> {
	using temp = TempDir.createSync("@pi-stream-boundary-");
	const file = temp.join("session.jsonl");
	fs.writeFileSync(file, content);
	return await run(file);
}

beforeAll(async () => {
	using temp = TempDir.createSync("@pi-stream-boundary-probe-");
	const file = temp.join("probe.jsonl");
	fs.writeFileSync(file, `${headerLine()}\n`);
	const handle = await fs.promises.open(file, "r");
	fileHandlePrototype = Object.getPrototypeOf(handle) as FileHandle;
	await handle.close();
	const read = vi.spyOn(fileHandlePrototype, "read");
	try {
		await loadEntriesFromFileStream(file);
		// `read(buffer, offset, length, position)`: the first read asks for one whole piece.
		const firstCall: readonly unknown[] = read.mock.calls[0] ?? [];
		const length = firstCall[2];
		if (typeof length !== "number" || length <= 0) {
			throw new Error(`the streamed load issued no sized read; argument types: ${firstCall.map(arg => typeof arg)}`);
		}
		readBytes = length;
	} finally {
		read.mockRestore();
	}
});

afterEach(() => {
	vi.restoreAllMocks();
});

interface Layout {
	name: string;
	/** Text that must survive the load, so agreement is not agreement on a dropped record. */
	survives?: string;
	/** Whether the fixture holds a line the load drops, which leaves no layout to compare. */
	damaged?: boolean;
	build(bytes: SessionBytes, boundary: number): void;
}

const UTF8_CHARACTERS = ["é", "€", "😀"];

function layouts(): Layout[] {
	const rows: Layout[] = [];
	for (let k = -2; k <= 1; k++) {
		rows.push({
			name: `a line feed ${k} bytes from the boundary`,
			build(bytes, boundary) {
				bytes.fillBefore(boundary + k + 1);
				bytes.recordUntil(boundary + k + 1, "\n");
				bytes.record("after the boundary");
			},
		});
	}
	rows.push({
		name: "a CRLF with the carriage return ending the first read",
		build(bytes, boundary) {
			bytes.fillBefore(boundary + 1);
			bytes.recordUntil(boundary + 1, "\r\n");
			bytes.record("after the boundary");
		},
	});
	rows.push({
		name: "an empty line whose line feed opens the second read",
		build(bytes, boundary) {
			bytes.fillBefore(boundary);
			bytes.recordUntil(boundary, "\n");
			bytes.raw("\n");
			bytes.record("after the boundary");
		},
	});
	for (const character of UTF8_CHARACTERS) {
		const width = Buffer.byteLength(character, "utf-8");
		for (let before = 1; before < width; before++) {
			rows.push({
				name: `a ${width}-byte character with ${before} of its bytes before the boundary`,
				survives: `${character}tail`,
				build(bytes, boundary) {
					bytes.fillBefore(boundary - before);
					bytes.recordWithTextAt(boundary - before, `${character}tail`);
					bytes.record("after the boundary");
				},
			});
		}
	}
	rows.push({
		name: "a damaged line across the boundary",
		damaged: true,
		build(bytes, boundary) {
			bytes.fillBefore(boundary - 50);
			bytes.recordUntil(boundary - 50, "\n");
			bytes.raw(`{ not json ${"z".repeat(200)}\n`);
			bytes.record("after the damage");
		},
	});
	rows.push({
		name: "a record longer than two reads",
		build(bytes, boundary) {
			bytes.fillBefore(boundary >> 1);
			bytes.record("L".repeat(boundary * 2 + (boundary >> 1)));
			bytes.record("after the long record");
		},
	});
	for (let k = -1; k <= 1; k++) {
		rows.push({
			name: `a last line with no line feed ending ${k} bytes from the boundary`,
			build(bytes, boundary) {
				bytes.fillBefore(boundary + k);
				bytes.recordUntil(boundary + k, "");
			},
		});
	}
	return rows;
}

describe("a streamed session load reads the same lines wherever a read ends", () => {
	it("reads the session in pieces smaller than the fixtures", () => {
		expect(Number.isSafeInteger(readBytes)).toBe(true);
		expect(readBytes).toBeGreaterThanOrEqual(FILLER_TEXT * 4);
	});

	for (const layout of layouts()) {
		it(`loads the same session as the whole-file path: ${layout.name}`, async () => {
			const bytes = new SessionBytes();
			layout.build(bytes, readBytes);
			const content = bytes.text();

			const [stream, parsed] = await withFile(
				content,
				async file => [await streamed(file), await whole(file)] as const,
			);

			// The fixture reaches the boundary it was built around.
			expect(Buffer.byteLength(content, "utf-8")).toBeGreaterThanOrEqual(readBytes - 2);
			expect(stream.reads).toBeGreaterThanOrEqual(2);

			expect(stream.result.entries).toEqual(parsed.result.entries);
			expect(stream.result.titleSlot).toEqual(parsed.result.titleSlot);
			expect(stream.result.layout).toEqual(parsed.result.layout);
			expect(stream.notices).toEqual(parsed.notices);

			// Agreement is only evidence while the whole-file load kept the records and, for an
			// undamaged file, established where each one sits.
			expect(parsed.result.entries.length).toBeGreaterThanOrEqual(3);
			if (layout.damaged) expect(parsed.notices.length).toBeGreaterThan(0);
			else expect(parsed.result.layout?.entryOffsets.length).toBe(parsed.result.entries.length - 1);
			if (layout.survives) expect(JSON.stringify(parsed.result.entries)).toContain(layout.survives);
		});
	}
});

describe("a streamed line longer than the frame bound fails the load wherever it sits", () => {
	const LIMIT = 4096;
	/** Filler that stays under {@link LIMIT}, so only the line under test can cross it. */
	const FILLER = 2048;
	const original = process.env[STREAM_FRAME_MAX_BYTES_ENV];

	afterEach(() => {
		if (original === undefined) delete process.env[STREAM_FRAME_MAX_BYTES_ENV];
		else process.env[STREAM_FRAME_MAX_BYTES_ENV] = original;
	});

	function bounded(): void {
		process.env[STREAM_FRAME_MAX_BYTES_ENV] = String(LIMIT);
	}

	/** Places a line of `length` bytes, line feed excluded, relative to the first boundary. */
	const positions: Array<{ name: string; place(bytes: SessionBytes, boundary: number, length: number): void }> = [
		{
			name: "inside the first read",
			place(bytes, _boundary, length) {
				bytes.recordUntil(bytes.bytes + length + 1, "\n");
				bytes.record("after the line");
			},
		},
		{
			name: "before the boundary with its line feed after it",
			place(bytes, boundary, length) {
				bytes.fillBefore(boundary - length);
				bytes.recordUntil(boundary - length, "\n");
				bytes.recordUntil(boundary + 1, "\n");
				bytes.record("after the line");
			},
		},
		{
			name: "across the boundary",
			place(bytes, boundary, length) {
				bytes.fillBefore(boundary - 10);
				bytes.recordUntil(boundary - 10, "\n");
				bytes.recordUntil(boundary - 10 + length + 1, "\n");
				bytes.record("after the line");
			},
		},
		{
			name: "last, with no line feed, inside the first read",
			place(bytes, _boundary, length) {
				bytes.recordUntil(bytes.bytes + length, "");
			},
		},
		{
			name: "last, with no line feed, across the boundary",
			place(bytes, boundary, length) {
				bytes.fillBefore(boundary - 10);
				bytes.recordUntil(boundary - 10, "\n");
				bytes.recordUntil(boundary - 10 + length, "");
			},
		},
	];

	for (const position of positions) {
		it(`loads a line of the bound ${position.name}`, async () => {
			const bytes = new SessionBytes(FILLER);
			position.place(bytes, readBytes, LIMIT);
			bounded();
			const [stream, parsed] = await withFile(
				bytes.text(),
				async file => [await streamed(file), await whole(file)] as const,
			);

			expect(stream.result.entries).toEqual(parsed.result.entries);
			expect(stream.result.layout).toEqual(parsed.result.layout);
			expect(parsed.result.entries.length).toBeGreaterThanOrEqual(2);
		});

		it(`rejects a line one byte over the bound ${position.name}`, async () => {
			const bytes = new SessionBytes(FILLER);
			position.place(bytes, readBytes, LIMIT + 1);
			bounded();
			await withFile(bytes.text(), async file => {
				await expect(streamed(file)).rejects.toBeInstanceOf(StreamFrameLimitError);
			});
		});
	}

	it("stops reading at the read that carries the line past the bound", async () => {
		const bytes = new SessionBytes(FILLER);
		bytes.raw("x".repeat(readBytes * 4));
		bounded();
		await withFile(bytes.text(), async file => {
			const read = vi.spyOn(fileHandlePrototype, "read");
			await expect(loadEntriesFromFileStream(file)).rejects.toBeInstanceOf(StreamFrameLimitError);
			expect(read.mock.calls.length).toBe(1);
		});
	});
});
