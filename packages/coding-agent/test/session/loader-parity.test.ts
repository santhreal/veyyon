import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { type OperatorNotice, OperatorNotices } from "@veyyon/kernel/session/operator-notices";
import type { FileEntry } from "@veyyon/kernel/session/session-entries";
import { loadEntriesFromFileStream, parseSessionContent } from "@veyyon/kernel/session/session-loader";
import { serializeTitleSlot } from "@veyyon/kernel/session/session-title-slot";
import { TempDir } from "@veyyon/utils";

/**
 * WHY: a session under 8 MiB is read as one string and a larger one is streamed line by
 * line, and that is the only difference between the two load paths. Everything after a
 * line arrives used to be written twice, once per path, which is how a rule reaches one
 * copy and not the other: the orphan re-link had to be added to both, and its mutation
 * matrix showed the streaming copy sitting unrepaired while every other row stayed green.
 *
 * The class this closes: the two paths agree on what they load and on what they say. The
 * rows drive one byte-identical fixture through both and compare the entries, the title
 * slot and the operator notices verbatim, including the line and byte offsets a notice
 * quotes, which is the part no reading of the two functions can confirm (one path skips
 * the title slot by starting its cursor past it, the other by stepping over it). Any rule
 * added to one path alone turns this red.
 *
 * What it does NOT catch: how the lines arrive, which is what genuinely differs. A
 * streaming read of a file that does not exist returns empty where the string parse has
 * no file to miss, and that asymmetry is asserted rather than compared.
 */

const HEADER_ID = "019f0000-0000-7000-8000-000000000000";

function line(value: Record<string, unknown>): string {
	return JSON.stringify(value);
}

function messageEntry(id: string, parentId: string | null, text: string): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			timestamp: 1_767_225_600_000,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	};
}

/**
 * One fixture that reaches every shared rule: a physical title slot the header must
 * absorb, good records, a line that is not JSON, a line that is JSON of a refused shape,
 * a blank line, an orphan whose parent was never written, and a genuine sibling pair.
 *
 * The place a notice quotes is derived from these bytes rather than written down, so the
 * expectation cannot drift when a record in the fixture changes length.
 */
function fixture(): { content: string; badLine: number; badByteOffset: number } {
	const wrongShape = messageEntry("e3", "e2", "unused");
	(wrongShape.message as Record<string, unknown>).content = "a string, not an array of blocks";
	const slot = serializeTitleSlot({
		title: "a slotted title",
		source: "user",
		updatedAt: "2026-01-01T00:00:00.000Z",
	});
	const body = [
		line({ type: "session", version: 7, id: HEADER_ID, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/x" }),
		line(messageEntry("e1", HEADER_ID, "first")),
		"{ not json at all",
		"",
		line(wrongShape),
		line(messageEntry("e4", "e2", "after the gap")),
		line(messageEntry("e5", "never-written", "orphan with no drop")),
		line(messageEntry("e6", "e5", "sibling one")),
		line(messageEntry("e7", "e5", "sibling two")),
	];
	const badIndex = body.indexOf("{ not json at all");
	let badByteOffset = Buffer.byteLength(slot, "utf-8") + 1;
	for (let i = 0; i < badIndex; i++) badByteOffset += Buffer.byteLength(body[i], "utf-8") + 1;
	return {
		content: `${slot}${body.join("\n")}\n`,
		// The slot occupies the first physical line, so the body starts on line 2.
		badLine: 2 + badIndex,
		badByteOffset,
	};
}

interface Loaded {
	entries: FileEntry[];
	titleSlot: unknown;
	notices: OperatorNotice[];
}

function throughParse(content: string, source: string): Loaded {
	const notices: OperatorNotice[] = [];
	const sink = new OperatorNotices(notice => notices.push(notice));
	const { entries, titleSlot } = parseSessionContent(content, { source, operatorNotices: sink });
	return { entries, titleSlot, notices };
}

async function throughStream(content: string | Buffer, source: string): Promise<Loaded> {
	using temp = TempDir.createSync("@pi-loader-parity-");
	const file = temp.join("session.jsonl");
	fs.writeFileSync(file, content);
	const notices: OperatorNotice[] = [];
	const sink = new OperatorNotices(notice => notices.push(notice));
	const { entries, titleSlot } = await loadEntriesFromFileStream(file, { source, operatorNotices: sink });
	return { entries, titleSlot, notices };
}

describe("both session load paths are one algorithm", () => {
	it("loads the same records, the same title and the same tree", async () => {
		const { content } = fixture();
		const parsed = throughParse(content, "parity.jsonl");
		const streamed = await throughStream(content, "parity.jsonl");

		expect(streamed.entries).toEqual(parsed.entries);
		expect(streamed.titleSlot).toEqual(parsed.titleSlot);
		// The fixture is only evidence while it still exercises the rules: three records
		// survive damage, the header absorbs the slot, and the sibling pair is intact.
		expect(parsed.entries.map(entry => entry.id)).toEqual([HEADER_ID, "e1", "e4", "e5", "e6", "e7"]);
		expect((parsed.entries[0] as { title?: string }).title).toBe("a slotted title");
		expect(parsed.entries.map(entry => ("parentId" in entry ? entry.parentId : "header"))).toEqual([
			"header",
			HEADER_ID,
			"e1",
			"e4",
			"e5",
			"e5",
		]);
	});

	it("says the same thing, down to the byte offsets", async () => {
		const { content, badLine, badByteOffset } = fixture();
		const parsed = throughParse(content, "parity.jsonl");
		const streamed = await throughStream(content, "parity.jsonl");

		expect(streamed.notices.map(notice => `${notice.severity}/${notice.source}: ${notice.text}`)).toEqual(
			parsed.notices.map(notice => `${notice.severity}/${notice.source}: ${notice.text}`),
		);
		// Both notices the shared loop can raise are present, so parity is not agreement
		// on silence.
		expect(parsed.notices.some(notice => notice.text.includes("Skipped 2 malformed records"))).toBe(true);
		expect(parsed.notices.some(notice => notice.text.includes("Re-linked 2 records"))).toBe(true);
		// A cursor that forgot the 256-byte slot, or counted lines instead of bytes, reports
		// a different place for the same damaged line in at least one of the two paths.
		expect(badByteOffset).toBeGreaterThan(256);
		expect(parsed.notices.some(notice => notice.text.includes(`line ${badLine}, byte ${badByteOffset}`))).toBe(true);
	});

	it("agrees on a file that holds nothing but a header", async () => {
		const content = `${line({
			type: "session",
			version: 7,
			id: HEADER_ID,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/tmp/x",
		})}\n`;
		const parsed = throughParse(content, "bare.jsonl");
		const streamed = await throughStream(content, "bare.jsonl");

		expect(streamed.entries).toEqual(parsed.entries);
		expect(streamed.titleSlot).toBeUndefined();
		expect(parsed.titleSlot).toBeUndefined();
		expect(streamed.notices).toEqual([]);
		expect(parsed.notices).toEqual([]);
	});

	it("returns nothing for a file that is not there, which the string parse cannot see", async () => {
		using temp = TempDir.createSync("@pi-loader-parity-missing-");
		const loaded = await loadEntriesFromFileStream(temp.join("absent.jsonl"));

		expect(loaded.entries).toEqual([]);
		expect(loaded.titleSlot).toBeUndefined();
	});
});

/**
 * WHY: the streamed path parses each record after the header from the line's UTF-8 bytes rather
 * than from the line decoded to a string, and the string parse is the definition of what a record
 * line means. The class this closes: a byte sequence the two parsers read differently. Each row
 * is one record line placed between a header and a good record, and the streamed load of the
 * bytes has to load the entries, prototypes and notices the string parse loads from the same line
 * decoded the way the streamed path decodes a line (`TextDecoder`: U+FFFD for an invalid
 * sequence, a leading byte order mark dropped).
 *
 * What it does NOT catch: a byte sequence missing from the table. The rows are the inputs where
 * a UTF-8 decode followed by `JSON.parse` and a parser of bytes can disagree: encoding damage,
 * escapes, keys with meaning to an object, number edges, whitespace JSON does and does not
 * admit, a line holding other than one value, and values of a shape no entry has.
 */
describe("a record parsed from its bytes is the record its text parses to", () => {
	const header = line({
		type: "session",
		version: 7,
		id: HEADER_ID,
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: "/x",
	});
	const record = line(messageEntry("e1", HEADER_ID, "@@"));
	const after = line(messageEntry("e2", "e1", "after"));
	const bytes = (text: string) => Buffer.from(text, "utf-8");
	const withText = (inner: number[]) => {
		const at = record.indexOf("@@");
		return Buffer.concat([bytes(record.slice(0, at)), Buffer.from(inner), bytes(record.slice(at + 2))]);
	};
	const withLeadingKeys = (keys: string) => bytes(`{${keys},${record.slice(1)}`);

	const rows: { name: string; bytes: Buffer; outcome: "kept" | "dropped" | "blank" }[] = [
		{ name: "non-ASCII text", bytes: bytes(record.replace("@@", "héllo — 日本 🎉")), outcome: "kept" },
		{
			name: "escaped control and lone surrogate",
			bytes: bytes(record.replace("@@", "\\u0000 \\n \\ud800")),
			outcome: "kept",
		},
		{ name: "invalid UTF-8 inside a string", bytes: withText([0xff, 0xc3, 0x28]), outcome: "kept" },
		{ name: "a UTF-8 sequence cut short inside a string", bytes: withText([0xe6, 0x97]), outcome: "kept" },
		{ name: "an own __proto__ key", bytes: withLeadingKeys('"__proto__":{"polluted":1}'), outcome: "kept" },
		{ name: "a duplicated key", bytes: withLeadingKeys('"id":"stale"'), outcome: "kept" },
		{
			name: "numbers at the edge of a double",
			bytes: withLeadingKeys('"n":[-0,12345678901234567890,0.1,-1.5e-7,1e308]'),
			outcome: "kept",
		},
		{ name: "a carriage return before the line feed", bytes: bytes(`${record}\r`), outcome: "kept" },
		{ name: "whitespace around the record", bytes: bytes(`  ${record} \t`), outcome: "kept" },
		{
			name: "a byte order mark before the record",
			bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes(record)]),
			outcome: "kept",
		},
		{ name: "two records on one line", bytes: bytes(`${record} ${record}`), outcome: "dropped" },
		{ name: "a record followed by garbage", bytes: bytes(`${record}x`), outcome: "dropped" },
		{ name: "a record cut short", bytes: bytes(record.slice(0, 40)), outcome: "dropped" },
		{ name: "a JSON array", bytes: bytes("[1,2]"), outcome: "dropped" },
		{ name: "a JSON string", bytes: bytes('"s"'), outcome: "dropped" },
		{ name: "JSON null", bytes: bytes("null"), outcome: "dropped" },
		{ name: "a line of no-break spaces", bytes: bytes("\u00a0\u00a0"), outcome: "blank" },
		{ name: "an empty line", bytes: bytes(""), outcome: "blank" },
	];

	for (const row of rows) {
		it(`loads ${row.name} the way the string parse does`, async () => {
			const lines = [bytes(header), row.bytes, bytes(after)];
			const decoder = new TextDecoder();
			const parsed = throughParse(lines.map(each => decoder.decode(each)).join("\n"), "bytes.jsonl");
			const streamed = await throughStream(Buffer.concat(lines.flatMap(each => [each, bytes("\n")])), "bytes.jsonl");

			expect(streamed.entries).toEqual(parsed.entries);
			const fingerprint = (entries: FileEntry[]) =>
				entries.map(entry => [JSON.stringify(entry), Object.getPrototypeOf(entry) === Object.prototype]);
			expect(fingerprint(streamed.entries)).toEqual(fingerprint(parsed.entries));
			const said = (notices: OperatorNotice[]) => notices.map(notice => `${notice.severity}: ${notice.text}`);
			expect(said(streamed.notices)).toEqual(said(parsed.notices));
			// The row is evidence only while the string parse still treats it as the row says.
			const outcome = parsed.entries.some(entry => entry.id === "e1")
				? "kept"
				: parsed.notices.some(notice => notice.text.includes("malformed"))
					? "dropped"
					: "blank";
			expect(outcome).toBe(row.outcome);
		});
	}
});
