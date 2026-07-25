/**
 * `parseJsonlIncremental` is the one owner of chunked (carry-forward) JSONL
 * decoding.
 *
 * It exists because collab-web had a second tolerant JSONL reader of its own
 * (`src/lib/jsonl.ts`), while `parseJsonlLenient` in `@veyyon/utils/stream` was
 * documented as the repo's JSONL owner. The two answered different questions —
 * one decodes a stream where a trailing partial line is normal, the other a
 * complete buffer where it is malformed — so the duplicate was not simply
 * deletable, and it drifted where it mattered most: the collab copy dropped
 * unparseable lines silently with a bare `catch {}`, which renders a transcript
 * with a hole in it that looks exactly like the agent having said nothing.
 *
 * These tests pin the behavior the collab copy had (so the move is a refactor,
 * not a rewrite), the reporting it lacked, and the exact offsets — an offset is
 * only useful if it points at the record rather than at wherever the stream
 * happened to be cut.
 */
import { describe, expect, it } from "bun:test";
import { type JsonlSkip, parseJsonlIncremental } from "@veyyon/utils/jsonl-incremental";
import { parseJsonlLenient } from "@veyyon/utils/stream";
import { collectPackageSources } from "./support/package-sources";

/** Collects every reported skip, in report order. */
function withSkips(text: string, carry = ""): { items: unknown[]; carry: string; skips: JsonlSkip[] } {
	const skips: JsonlSkip[] = [];
	const result = parseJsonlIncremental(text, carry, { onSkip: skip => skips.push(skip) });
	return { ...result, skips };
}

describe("parseJsonlIncremental — chunk boundaries", () => {
	/** The whole reason this reader exists: the tail of a chunk is usually half a
	 *  record, and treating it as malformed would drop a row on every chunk. */
	it("returns the trailing partial line as carry and parses only complete lines", () => {
		const result = parseJsonlIncremental('{"a":1}\n{"b":2}\n{"c":', "");

		expect(result.items).toEqual([{ a: 1 }, { b: 2 }]);
		expect(result.carry).toBe('{"c":');
	});

	/** A chunk ending exactly on a newline has nothing pending. An empty string,
	 *  not undefined — the caller prepends it to the next chunk unconditionally. */
	it("returns an empty carry when the chunk ends on a newline", () => {
		expect(parseJsonlIncremental('{"a":1}\n', "").carry).toBe("");
	});

	/** The carry is prepended, so a record split anywhere across two chunks is
	 *  recovered whole. Split at every byte to prove no position is special. */
	it("reassembles a record split at every possible position", () => {
		const line = '{"role":"user","content":"hi"}\n';
		for (let cut = 0; cut <= line.length; cut++) {
			const first = parseJsonlIncremental(line.slice(0, cut), "");
			const second = parseJsonlIncremental(line.slice(cut), first.carry);
			const items = [...first.items, ...second.items];

			expect({ cut, items }).toEqual({ cut, items: [{ role: "user", content: "hi" }] });
		}
	});

	/** A record spanning three chunks — the carry has to survive a chunk that
	 *  contains no newline at all and completes nothing. */
	it("carries a record across three chunks with no newline in the middle one", () => {
		const a = parseJsonlIncremental('{"id":', "");
		const b = parseJsonlIncremental('"m1","n":', a.carry);
		const c = parseJsonlIncremental("42}\n", b.carry);

		expect([a.items, b.items, c.items]).toEqual([[], [], [{ id: "m1", n: 42 }]]);
		expect(c.carry).toBe("");
	});

	/** An empty chunk must not consume or corrupt a pending carry: a stream can
	 *  legitimately deliver zero bytes (a poll that found nothing new). */
	it("preserves the carry across an empty chunk", () => {
		const result = parseJsonlIncremental("", '{"partial":');

		expect(result.items).toEqual([]);
		expect(result.carry).toBe('{"partial":');
	});
});

describe("parseJsonlIncremental — whitespace and blank lines", () => {
	/** Blank and whitespace-only lines are structure, not data: JSONL writers emit
	 *  them around appends, and reporting them as skips would cry wolf. */
	it("ignores blank and whitespace-only lines without reporting a skip", () => {
		const { items, skips } = withSkips('\n{"a":1}\n   \n\t\n{"b":2}\n');

		expect(items).toEqual([{ a: 1 }, { b: 2 }]);
		expect(skips).toEqual([]);
	});

	/** Trailing \r from a CRLF writer must not make an otherwise valid record
	 *  unparseable — the line is trimmed before parsing. */
	it("parses CRLF-terminated records", () => {
		const { items, skips } = withSkips('{"a":1}\r\n{"b":2}\r\n');

		expect(items).toEqual([{ a: 1 }, { b: 2 }]);
		expect(skips).toEqual([]);
	});
});

describe("parseJsonlIncremental — reporting dropped records", () => {
	/** THE contract this move exists for. A malformed complete line is skipped so
	 *  the readable rows still arrive, and reported so the loss is visible. */
	it("reports a malformed line and still returns the good ones", () => {
		const { items, skips } = withSkips('{"a":1}\nnot json\n{"b":2}\n');

		expect(items).toEqual([{ a: 1 }, { b: 2 }]);
		expect(skips).toEqual([{ offset: 8, snippet: "not json" }]);
	});

	/** One report per bad record, in order, each at its own offset. A single
	 *  report for a whole chunk would hide how much was lost. */
	it("reports every malformed line in order with its own offset", () => {
		const { skips } = withSkips('bad one\n{"ok":true}\n{bad two\n');

		expect(skips).toEqual([
			{ offset: 0, snippet: "bad one" },
			{ offset: 20, snippet: "{bad two" },
		]);
	});

	/** Offsets are relative to `carry + text`, so a record completed from the
	 *  carry is reported where the RECORD starts, not where this chunk starts.
	 *  A chunk-relative offset would be a negative number or a lie. */
	it("reports a carried record at the record's own offset", () => {
		const { skips } = withSkips("s json\n", "thi");

		expect(skips).toEqual([{ offset: 0, snippet: "this json" }]);
	});

	/** The snippet is the trimmed line, so a CRLF file does not report an
	 *  invisible trailing \r as part of the bad text. */
	it("reports the trimmed line as the snippet", () => {
		const { skips } = withSkips("  bad  \r\n");

		expect(skips).toEqual([{ offset: 0, snippet: "bad" }]);
	});

	/** A single corrupt line can be megabytes (a truncated base64 image). The
	 *  snippet is capped at 200 characters so a report cannot flood a log or a
	 *  UI notice, and the cap matches `parseJsonlLenient`'s. */
	it("caps the reported snippet at 200 characters", () => {
		const { skips } = withSkips(`{${"x".repeat(5_000)}\n`);

		expect(skips).toHaveLength(1);
		expect(skips[0].snippet).toHaveLength(200);
		expect(skips[0].snippet).toBe(`{${"x".repeat(199)}`);
	});

	/** Omitting `onSkip` must not throw: a caller that genuinely does not care is
	 *  allowed, and the parser must not require a reporter to function. */
	it("skips without a reporter when onSkip is omitted", () => {
		const result = parseJsonlIncremental('bad\n{"a":1}\n', "");

		expect(result.items).toEqual([{ a: 1 }]);
	});

	/** A partial tail is NOT a skip. It is the normal state of a stream, and
	 *  reporting it would produce a false loss report on every chunk. */
	it("never reports the trailing partial line as a skip", () => {
		const { skips, carry } = withSkips('{"a":1}\n{"unfinished":');

		expect(skips).toEqual([]);
		expect(carry).toBe('{"unfinished":');
	});
});

describe("parseJsonlIncremental — agreement with parseJsonlLenient", () => {
	/**
	 * The two readers must not disagree about a COMPLETE buffer, which is the
	 * only input where both are defined. Divergence here is what makes a second
	 * implementation dangerous: the same transcript would decode differently
	 * depending on which reader loaded it.
	 */
	const complete = ['{"a":1}\n{"b":2}\n', '{"only":"one"}\n', '{"a":1}\n\n{"b":2}\n', '{"a":1}\nbad line\n{"b":2}\n'];

	it.each(complete)("decodes %j to the same records as parseJsonlLenient", buffer => {
		expect(parseJsonlIncremental(buffer, "").items).toEqual(parseJsonlLenient(buffer));
	});

	/** Both report the same loss for the same corrupt buffer. The offsets are the
	 *  interesting part: they must name the same record. */
	it("reports the same skipped record as parseJsonlLenient", () => {
		const buffer = '{"a":1}\nbad line\n{"b":2}\n';
		const lenientSkips: JsonlSkip[] = [];
		parseJsonlLenient(buffer, { onSkip: skip => lenientSkips.push(skip) });

		expect(withSkips(buffer).skips).toEqual(lenientSkips);
	});
});

describe("the repository", () => {
	/**
	 * The lock that keeps the migration from being undone.
	 *
	 * Deleting collab-web's copy fixed the duplicate; nothing stopped the next one. A second
	 * tolerant JSONL reader is easy to write by accident — split on newlines, `JSON.parse` each
	 * line, swallow the failures — and every such copy re-earns the bug this suite documents,
	 * because the silent `catch` is the obvious way to write it. Behavioural tests cannot catch
	 * that: a fresh copy in another package passes all of them while agreeing with nothing.
	 *
	 * So the assertion is on the SOURCE. THREE owners are allowed, all in `@veyyon/utils` and each
	 * documented as answering a different question: `parseJsonlIncremental` here (a stream arriving
	 * in chunks), `parseJsonlLenient` in `stream.ts` (a complete buffer; its
	 * `parseJsonlChunkCompat` is the Bun shim they share), and `parseJsonlBytes` /
	 * `visitJsonlBytes` in `jsonl-bytes.ts` (a `Uint8Array` whose tail may be a partial line, for a
	 * file being appended to while it is read). The third owner arrived by unifying the stats
	 * dashboard's own byte-level loop, which had drifted far enough to drop a malformed line with no
	 * report at all. Anything outside these three that defines a JSONL parse function is a fourth.
	 */
	it("defines a JSONL parser in no package other than the three utils owners", async () => {
		const owners = new Set(["utils/src/jsonl-incremental.ts", "utils/src/stream.ts", "utils/src/jsonl-bytes.ts"]);
		// `parseJsonl…` in any declaration form. The `(?![a-z])` matters: without it this also
		// matched `parseJsonLine`, a byte-level single-line helper that is not a JSONL reader at
		// all, and a lock that reports the wrong file gets an exemption instead of a fix.
		const definition = /(?:function|const|let|var)\s+parse(?:Jsonl|JSONL)(?![a-z])\w*\s*[(<=]/;

		const offenders = (await collectPackageSources())
			.filter(({ rel }) => !owners.has(rel))
			.filter(({ text }) => definition.test(text))
			.map(({ rel }) => rel);

		expect(
			offenders,
			"import parseJsonlIncremental (streamed, carry) or parseJsonlLenient (complete buffer) from @veyyon/utils",
		).toEqual([]);
	});

	it("has no package reaching for the deleted collab-web module", async () => {
		// The specific regression: `src/lib/jsonl.ts` is gone, and an import of it would mean
		// the file came back. Cheaper to state than to rediscover.
		const offenders = (await collectPackageSources())
			.filter(({ text }) => text.includes('lib/jsonl"') || text.includes("lib/jsonl'"))
			.map(({ rel }) => rel);

		expect(offenders, "collab-web/src/lib/jsonl.ts was replaced by @veyyon/utils/jsonl-incremental").toEqual([]);
	});
});
