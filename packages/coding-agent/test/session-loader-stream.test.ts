import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FileEntry } from "@veyyon/coding-agent/session/session-entries";
import { loadEntriesFromFileStream, parseSessionContent } from "@veyyon/coding-agent/session/session-loader";
import { serializeTitleSlot } from "@veyyon/coding-agent/session/session-title-slot";
import { logger } from "@veyyon/utils";

// Parity contract for the ≥8MiB streaming loader (now Bun.JSONL-based): it must
// produce the SAME entries + titleSlot as the common-path parser
// (parseSessionContent, which uses parseJsonlLenient) on identical content —
// including a first-line title slot, blank lines, and malformed JSON lines that
// must be skipped rather than thrown on. loadEntriesFromFileStream works on any
// file size (the 8MiB threshold is only the routing decision in
// loadEntriesFromFile), so a small fixture exercises the full code path.

const ISO = "2026-06-29T12:00:00.000Z";
const HEADER = { type: "session", version: 3, id: "s1", timestamp: ISO, cwd: "/tmp" };
const msg = (id: string, parentId: string, text: string) => ({
	type: "message",
	id,
	parentId,
	timestamp: ISO,
	message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
});

let dir: string | undefined;
afterEach(() => {
	if (dir) {
		fs.rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	}
});

async function writeTemp(content: string): Promise<string> {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-loader-test-"));
	const file = path.join(dir, "session.jsonl");
	fs.writeFileSync(file, content);
	return file;
}

function entryTypes(entries: FileEntry[]): string[] {
	return entries.map(entry => entry.type);
}

function entryIds(entries: FileEntry[]): string[] {
	return entries.map(entry => entry.id);
}

function messageIds(entries: FileEntry[]): string[] {
	return entries.filter(entry => entry.type === "message").map(entry => entry.id);
}

function messageTexts(entries: FileEntry[]): string[] {
	const texts: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message: unknown = entry.message;
		if (!message || typeof message !== "object" || !("content" in message)) continue;
		const content = message.content;
		if (!Array.isArray(content)) continue;
		const first = content[0];
		if (
			first &&
			typeof first === "object" &&
			"type" in first &&
			first.type === "text" &&
			"text" in first &&
			typeof first.text === "string"
		) {
			texts.push(first.text);
		}
	}
	return texts;
}

describe("loadEntriesFromFileStream (Bun.JSONL parity)", () => {
	it("matches parseSessionContent on title slot + valid + malformed + blank lines", async () => {
		const slotLine = serializeTitleSlot({ title: "Hello world", source: "user", updatedAt: ISO });
		// title slot | header | valid | blank | malformed | valid | malformed-no-newline-at-EOF
		const lines = [
			slotLine,
			JSON.stringify(HEADER),
			JSON.stringify(msg("m1", "s1", "first")),
			"",
			"{ this is not valid json",
			JSON.stringify(msg("m2", "m1", "second after bad line")),
		];
		const content = lines.join("\n"); // no trailing newline on the last line
		const file = await writeTemp(content);

		const stream = await loadEntriesFromFileStream(file);
		const reference = parseSessionContent(content);

		// Parity: the stream path must agree with the common path exactly.
		expect(stream).toEqual(reference);
		// And the concrete contracts that parity implies:
		expect(stream.titleSlot?.title).toBe("Hello world"); // title slot peeled + folded
		expect(entryTypes(stream.entries)).toEqual(["session", "message", "message"]);
		const ids = messageIds(stream.entries);
		expect(ids).toEqual(["m1", "m2"]); // valid entries kept in order, malformed skipped
	});

	it("matches parseSessionContent when there is no title slot (header is the first line)", async () => {
		const lines = [
			JSON.stringify(HEADER),
			JSON.stringify(msg("m1", "s1", "first")),
			"",
			JSON.stringify(msg("m2", "m1", "second")),
		];
		const content = lines.join("\n");
		const file = await writeTemp(content);

		const stream = await loadEntriesFromFileStream(file);
		const reference = parseSessionContent(content);

		expect(stream).toEqual(reference);
		expect(stream.titleSlot).toBeUndefined();
		expect(entryIds(stream.entries)).toEqual(["s1", "m1", "m2"]);
	});

	it("matches parseSessionContent on multibyte UTF-8 spanning many stream chunks", async () => {
		// Fixture larger than Bun's default stream chunk (~64KiB) with multibyte
		// content (✓ is 3 bytes, emoji 4) that must survive chunk-boundary splits
		// without U+FFFD corruption — the regression this path had when the buffer
		// was a decoded string concatenated per chunk.
		const multibyte = "✓ checkmark, 🚀 emoji, こんにちは unicode ✓ ".repeat(20);
		const lines: string[] = [JSON.stringify(HEADER)];
		for (let i = 1; lines.join("\n").length < 128 * 1024; i++) {
			lines.push(JSON.stringify(msg(`m${i}`, i === 1 ? "s1" : `m${i - 1}`, multibyte)));
		}
		const content = lines.join("\n");
		const file = await writeTemp(content);

		const stream = await loadEntriesFromFileStream(file);
		const reference = parseSessionContent(content);

		// Parity (a corrupted multibyte sequence would diverge here) ...
		expect(stream).toEqual(reference);
		// ... and explicitly: every entry's text round-trips intact, no U+FFFD.
		for (const text of messageTexts(stream.entries)) {
			expect(text).toBe(multibyte);
			expect(text.includes("\uFFFD")).toBe(false);
		}
	});

	it("returns empty for a missing file (ENOENT)", async () => {
		const missing = path.join(os.tmpdir(), `does-not-exist-${Date.now()}.jsonl`);
		const stream = await loadEntriesFromFileStream(missing);
		expect(stream.entries).toEqual([]);
		expect(stream.titleSlot).toBeUndefined();
	});
});

/**
 * Regression suite for the load-side silent-skip data loss.
 *
 * Both loaders skip a malformed JSONL record so one corrupt line cannot make a
 * whole session unopenable. That skip used to be SILENT — a dropped entry vanished
 * with no trace, which for a study tool is invisible data loss (Law 10). The
 * contract here: the good entries still load AND every skip is logged loudly, on
 * both the common (`parseSessionContent`) and streaming (`loadEntriesFromFileStream`)
 * paths, with a final count so the operator knows how much was lost.
 */
describe("loud malformed-record skips on session load", () => {
	function corruptSession(): string {
		return [
			JSON.stringify(HEADER),
			JSON.stringify(msg("m1", "s1", "kept before")),
			"{ this line is corrupt and cannot parse",
			JSON.stringify(msg("m2", "m1", "kept after")),
		].join("\n");
	}

	it("logs each skip and a total on the common (non-streaming) path", () => {
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const { entries } = parseSessionContent(corruptSession(), { source: "/sessions/corrupt.jsonl" });
			// The good entries survive, in order — the corrupt line is the only casualty.
			expect(entryIds(entries)).toEqual(["s1", "m1", "m2"]);

			const messages = warn.mock.calls.map(call => String(call[0]));
			// One per-record warning naming the loss, plus a summary count warning.
			expect(messages.some(m => m.includes("Skipped a malformed session record"))).toBe(true);
			const summary = warn.mock.calls.find(call => String(call[0]).includes("dropped malformed records"));
			expect(summary).toBeDefined();
			expect((summary?.[1] as { skipped?: number })?.skipped).toBe(1);
			expect((summary?.[1] as { source?: string })?.source).toBe("/sessions/corrupt.jsonl");
		} finally {
			warn.mockRestore();
		}
	});

	it("logs each skip and a total on the streaming path", async () => {
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const file = await writeTemp(corruptSession());
			const { entries } = await loadEntriesFromFileStream(file);
			expect(entryIds(entries)).toEqual(["s1", "m1", "m2"]);

			const messages = warn.mock.calls.map(call => String(call[0]));
			expect(messages.some(m => m.includes("Skipped a malformed session record on streaming load"))).toBe(true);
			const summary = warn.mock.calls.find(call => String(call[0]).includes("dropped malformed records"));
			expect(summary).toBeDefined();
			expect((summary?.[1] as { skipped?: number })?.skipped).toBe(1);
		} finally {
			warn.mockRestore();
		}
	});

	it("stays silent on a clean session (no spurious warnings)", () => {
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const clean = [JSON.stringify(HEADER), JSON.stringify(msg("m1", "s1", "all good"))].join("\n");
			parseSessionContent(clean, { source: "/sessions/clean.jsonl" });
			const dropWarnings = warn.mock.calls.filter(call => String(call[0]).includes("malformed"));
			expect(dropWarnings).toHaveLength(0);
		} finally {
			warn.mockRestore();
		}
	});

	// A session with FIVE malformed lines, two of them adjacent, so the loader hits
	// the read>0 error report (good record consumed, next record bad) repeatedly.
	// DATALOSS-5 double-counted exactly this: the operator total would read 10, not 5.
	function fiveCorruptSession(): string {
		return [
			JSON.stringify(HEADER),
			JSON.stringify(msg("m1", "s1", "kept 1")),
			"{ corrupt A",
			"{ corrupt B (adjacent to A)",
			JSON.stringify(msg("m2", "m1", "kept 2")),
			"{ corrupt C",
			JSON.stringify(msg("m3", "m2", "kept 3")),
			"{ corrupt D",
			"{ corrupt E (adjacent to D)",
			JSON.stringify(msg("m4", "m3", "kept 4")),
		].join("\n");
	}

	it("reports the EXACT skip count (5, not 10) with adjacent bad lines on the common path (DATALOSS-5)", () => {
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const { entries } = parseSessionContent(fiveCorruptSession(), { source: "/sessions/five.jsonl" });
			// All four good messages survive in order; only the five bad lines are lost.
			expect(messageIds(entries)).toEqual(["m1", "m2", "m3", "m4"]);
			const summary = warn.mock.calls.find(call => String(call[0]).includes("dropped malformed records"));
			// Exactly 5 — the double-count bug would have logged 10.
			expect((summary?.[1] as { skipped?: number })?.skipped).toBe(5);
			// And one per-record warning per real drop, not two.
			const perRecord = warn.mock.calls.filter(call =>
				String(call[0]).includes("Skipped a malformed session record"),
			);
			expect(perRecord).toHaveLength(5);
		} finally {
			warn.mockRestore();
		}
	});

	it("reports the EXACT skip count (5, not 10) with adjacent bad lines on the streaming path (DATALOSS-5)", async () => {
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const file = await writeTemp(fiveCorruptSession());
			const { entries } = await loadEntriesFromFileStream(file);
			expect(messageIds(entries)).toEqual(["m1", "m2", "m3", "m4"]);
			const summary = warn.mock.calls.find(call => String(call[0]).includes("dropped malformed records"));
			expect((summary?.[1] as { skipped?: number })?.skipped).toBe(5);
			const perRecord = warn.mock.calls.filter(call =>
				String(call[0]).includes("Skipped a malformed session record on streaming load"),
			);
			expect(perRecord).toHaveLength(5);
		} finally {
			warn.mockRestore();
		}
	});

	it("common and streaming paths agree on both entries and skip count (cross-path parity)", async () => {
		// WHY: the two loaders are separate implementations of the same lenient-skip
		// contract. They must never diverge — same survivors, same exact loss count — so
		// which path a file takes (its size vs the 8MiB threshold) can't change what is
		// recovered or how much loss is reported.
		const commonWarn = spyOn(logger, "warn").mockImplementation(() => {});
		let commonSkipped: number | undefined;
		let commonEntries: string[] = [];
		try {
			const { entries } = parseSessionContent(fiveCorruptSession(), { source: "/sessions/parity.jsonl" });
			commonEntries = entryIds(entries);
			commonSkipped = commonWarn.mock.calls
				.map(call => (call[1] as { skipped?: number })?.skipped)
				.find(v => typeof v === "number");
		} finally {
			commonWarn.mockRestore();
		}

		const streamWarn = spyOn(logger, "warn").mockImplementation(() => {});
		let streamSkipped: number | undefined;
		let streamEntries: string[] = [];
		try {
			const file = await writeTemp(fiveCorruptSession());
			const { entries } = await loadEntriesFromFileStream(file);
			streamEntries = entryIds(entries);
			streamSkipped = streamWarn.mock.calls
				.map(call => (call[1] as { skipped?: number })?.skipped)
				.find(v => typeof v === "number");
		} finally {
			streamWarn.mockRestore();
		}

		expect(streamEntries).toEqual(commonEntries);
		expect(streamSkipped).toBe(commonSkipped);
		expect(streamSkipped).toBe(5);
	});
});
