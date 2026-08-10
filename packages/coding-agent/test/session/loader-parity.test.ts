import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { type OperatorNotice, OperatorNotices } from "@veyyon/coding-agent/session/operator-notices";
import type { FileEntry } from "@veyyon/coding-agent/session/session-entries";
import { loadEntriesFromFileStream, parseSessionContent } from "@veyyon/coding-agent/session/session-loader";
import { serializeTitleSlot } from "@veyyon/coding-agent/session/session-title-slot";
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

async function throughStream(content: string, source: string): Promise<Loaded> {
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
