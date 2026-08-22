/**
 * WHY: the tool card built its streaming tail with
 * `stripAnsi(replaceTabs(partial))` over the whole accumulated buffer on every
 * arrival, then sliced the last 2048 characters. A 1MiB stream delivered as 256
 * arrivals scanned 128MiB and the last arrival cost nine times the first.
 * `PartialTail` keeps the stripper's state, so an arrival costs what arrived.
 *
 * The class this closes is a tail that drifts from the whole-buffer answer:
 * a sequence, a tab, or a C1 introducer split across arrivals; a window that
 * elides without saying so; a source that restarts or rewinds its buffer. The
 * variant space is the shared strip corpus (swept at every split point), plus
 * chunk sizes from one character up, plus the boundary the corpus has no case
 * for — the 2048-character window itself, asserted at 2047, 2048 and 2049.
 *
 * What it does not catch: an unterminated sequence longer than the stripper's
 * open-fragment limit, which is settled as text on purpose and is asserted as a
 * disagreement in `packages/utils/test/a-chunked-strip-shows-what-a-whole-string-strip-shows.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import { PartialTail, VISIBLE_CHARS } from "../src/partial-tail";
import { replaceTabs } from "../src/util";

interface Corpus {
	cases: { name: string; input: string }[];
}

const corpus: Corpus = await Bun.file(`${import.meta.dirname}/../../../fixtures/ansi-strip-corpus.json`).json();

/** What the card displayed before this change, for the whole raw buffer. */
function wholeBuffer(raw: string): string {
	const shown = stripAnsi(replaceTabs(raw));
	return shown.length > VISIBLE_CHARS ? `…${shown.slice(-VISIBLE_CHARS)}` : shown;
}

/** Feed `raw` in fixed-size arrivals, collecting what the card shows after each. */
function arrivals(raw: string, size: number): string[] {
	const tail = new PartialTail();
	const shown: string[] = [];
	for (let at = 0; at < raw.length; at += size) {
		tail.push(raw.slice(0, Math.min(at + size, raw.length)));
		shown.push(tail.text);
	}
	return shown;
}

/** Every sequence kind the grammar knows, interleaved with tabs and plain text. */
function makeStream(rows: number): string {
	const parts: string[] = [];
	for (let index = 0; index < rows; index++) {
		parts.push(
			`\x1b[32m${index}\x1b[0m\tplain\t`,
			`\x1b]8;;https://example.com/${index}\x07link ${index}\x1b]8;;\x07`,
			// A tab inside a payload: the expansion and the strip meet here, and
			// an arrival cutting the payload leaves the tab in the held fragment.
			"\x1bP tmux;pay\tload\x1b\\",
			`\x1b[38:2:255:0:0mtrue color ${index}\x1b[m\n`,
		);
	}
	return parts.join("");
}

describe("a streamed tail", () => {
	it("shows at every arrival what the whole buffer showed for the same prefix", () => {
		// Small arrivals cut inside every sequence kind; large ones cross the
		// window boundary. Comparing against the whole-buffer answer at every
		// arrival is quadratic in the stream, so each size gets the shortest
		// stream that exercises it.
		for (const [size, rows] of [
			[1, 12],
			[2, 12],
			[3, 12],
			[7, 20],
			[13, 20],
			[512, 400],
			[4096, 400],
		] as const) {
			const stream = makeStream(rows);
			const shown = arrivals(stream, size);
			for (const [index, text] of shown.entries()) {
				expect(text).toBe(wholeBuffer(stream.slice(0, Math.min((index + 1) * size, stream.length))));
			}
		}
	});

	it("ends at the whole-buffer answer for every corpus case at every split point", () => {
		expect(corpus.cases.length).toBeGreaterThan(30);
		for (const testCase of corpus.cases) {
			const whole = wholeBuffer(testCase.input);
			for (let split = 0; split <= testCase.input.length; split++) {
				const tail = new PartialTail();
				tail.push(testCase.input.slice(0, split));
				tail.push(testCase.input);
				expect(tail.text).toBe(whole);
			}
		}
	});

	it("elides from the left exactly at the window boundary", () => {
		for (const [length, elided] of [
			[VISIBLE_CHARS - 1, false],
			[VISIBLE_CHARS, false],
			[VISIBLE_CHARS + 1, true],
		] as const) {
			const raw = "x".repeat(length);
			for (const size of [1, 97, length]) {
				const shown = arrivals(raw, size).at(-1);
				expect(shown).toBe(wholeBuffer(raw));
				expect(shown?.startsWith("…")).toBe(elided);
			}
		}
	});

	it("keeps the window bounded across a megabyte of output", () => {
		const tail = new PartialTail();
		// 4KiB per arrival, 256 arrivals: the workload the backlog row measured.
		const chunk = `\x1b[32m${"y".repeat(4085)}\x1b[0m\t\n`;
		let raw = "";
		for (let arrival = 0; arrival < 256; arrival++) {
			raw += chunk;
			tail.push(raw);
		}
		expect(raw.length).toBe(1024 * 1024);
		// Nothing beyond the visible window is retained: the held state does not
		// grow with the stream, and one character of budget pays for the ellipsis.
		expect(tail.retained).toBe(VISIBLE_CHARS);
		expect(tail.text.length).toBe(VISIBLE_CHARS + 1);
		expect(tail.text).toBe(wholeBuffer(raw));
	});

	it("restarts when the source rewinds instead of extending", () => {
		const tail = new PartialTail();
		tail.push("\x1b[32mfirst run\x1b[0m");
		expect(tail.text).toBe("first run");
		// A host that sends a sliding window, or a second tool call reusing the
		// card, sends bytes that are not an extension of what was shown.
		tail.push("\x1b[31msecond\x1b[0m");
		expect(tail.text).toBe("second");
		tail.push("\x1b[31msecond\x1b[0m run\t.");
		expect(tail.text).toBe("second run   .");
	});

	it("shows the same text when the same buffer arrives twice", () => {
		const tail = new PartialTail();
		tail.push("\x1b[32mrow\x1b[0m\tone");
		const once = tail.text;
		tail.push("\x1b[32mrow\x1b[0m\tone");
		expect(tail.text).toBe(once);
		expect(once).toBe("row   one");
	});

	it("holds a sequence that is still arriving and drops it once it closes", () => {
		const tail = new PartialTail();
		const open = "\x1b]8;;https://exam";
		tail.push(`head ${open}`);
		// Provisional: what a whole-buffer strip of the same prefix shows.
		expect(tail.text).toBe(wholeBuffer(`head ${open}`));
		// The settled window plus the sequence still arriving, so a card that
		// asks what it is holding is told about both.
		expect(tail.retained).toBe("head ".length + open.length);
		tail.push("head \x1b]8;;https://example.com\x07link");
		expect(tail.text).toBe("head link");
		expect(tail.retained).toBe("head link".length);
	});
});
