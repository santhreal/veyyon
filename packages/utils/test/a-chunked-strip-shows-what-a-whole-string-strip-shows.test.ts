/**
 * WHY: a consumer displaying the tail of a live stream re-stripped the whole
 * accumulated output on every arrival, so its cost grew with the stream — 256
 * arrivals of 4KiB scanned 128MiB and the last arrival cost nine times the
 * first. `AnsiStripper` scans each byte once, which is only safe if a chunked
 * pass shows what a whole-string pass shows.
 *
 * The class this closes is a chunked sanitizer that disagrees with the one-shot
 * one at a chunk boundary: a sequence split across arrivals, an escape whose
 * payload is still arriving, a C1 introducer alone at the end of a chunk. The
 * variant space is the shared corpus every strip implementation is held to,
 * swept at every split point, plus the boundaries the corpus has no case for.
 *
 * What it does not catch: an unterminated sequence longer than the open-fragment
 * limit, which is settled as text on purpose and is asserted here as the one
 * documented disagreement rather than left to be discovered.
 */
import { describe, expect, it } from "bun:test";
import { AnsiStripper, stripAnsi } from "@veyyon/utils/strip-ansi";

interface Corpus {
	cases: { name: string; why: string; input: string; expected: string }[];
}

const corpus: Corpus = await Bun.file(`${import.meta.dirname}/../../../fixtures/ansi-strip-corpus.json`).json();

/** What a consumer displays after every chunk: settled text plus the provisional remainder. */
function chunked(input: string, splits: readonly number[]): string[] {
	const stripper = new AnsiStripper();
	const shown: string[] = [];
	let settled = "";
	let previous = 0;
	for (const split of [...splits, input.length]) {
		if (split <= previous) continue;
		settled += stripper.push(input.slice(previous, split));
		shown.push(settled + stripper.pending);
		previous = split;
	}
	return shown;
}

describe("a chunked strip", () => {
	it("ends at the whole-string answer for every corpus case at every split point", () => {
		expect(corpus.cases.length).toBeGreaterThan(30);
		for (const testCase of corpus.cases) {
			const whole = stripAnsi(testCase.input);
			expect(whole).toBe(testCase.expected);
			for (let split = 0; split <= testCase.input.length; split++) {
				const shown = chunked(testCase.input, [split]);
				expect(shown.at(-1)).toBe(whole);
			}
			// Every byte its own chunk: the split sweep above only cuts once.
			const single = chunked(
				testCase.input,
				Array.from({ length: testCase.input.length }, (_, index) => index),
			);
			expect(single.at(-1)).toBe(whole);
		}
	});

	it("shows at each arrival what a whole-string strip of the same prefix shows", () => {
		// The provisional remainder exists for this: a consumer that displays
		// `settled + pending` after each chunk must agree with the one-shot strip
		// of the bytes it has, not only once the stream ends.
		for (const testCase of corpus.cases) {
			for (let split = 1; split < testCase.input.length; split++) {
				const shown = chunked(testCase.input, [split]);
				expect(shown[0]).toBe(stripAnsi(testCase.input.slice(0, split)));
			}
		}
	});

	it("agrees with the whole-string strip on a stream of many sequences", () => {
		const rows: string[] = [];
		for (let index = 0; index < 400; index++) {
			rows.push(
				`\x1b[32m ok \x1b[0m\tstep ${index}\t\x1b[1;38;5;214mvalue\x1b[0m ${"x".repeat(13)}`,
				`\x1b]8;;https://example.com/${index}\x1b\\link ${index}\x1b]8;;\x07`,
				`\x1bP tmux;payload ${index}\x1b\\ plain ${index}`,
			);
		}
		const input = rows.join("\n");
		for (const size of [1, 7, 64, 997, 4096]) {
			const splits = Array.from({ length: Math.ceil(input.length / size) }, (_, index) => index * size);
			expect(chunked(input, splits).at(-1)).toBe(stripAnsi(input));
		}
	});

	it("holds a sequence that is still arriving and drops it once it closes", () => {
		const stripper = new AnsiStripper();
		expect(stripper.push("before \x1b]0;a title")).toBe("before ");
		// Still open: what it shows is what a whole-string strip of those bytes
		// shows, which is the payload with the escape removed.
		expect(stripper.pending).toBe("]0;a title");
		expect(stripper.push(" continues")).toBe("");
		expect(stripper.pending).toBe("]0;a title continues");
		expect(stripper.push("\x07after")).toBe("after");
		expect(stripper.pending).toBe("");
	});

	it("holds a C1 introducer that arrives alone at the end of a chunk", () => {
		const stripper = new AnsiStripper();
		expect(stripper.push("a\x9b")).toBe("a");
		expect(stripper.push("31mred")).toBe("red");
		expect(stripper.pending).toBe("");
	});

	it("keeps a dead escape as text, once, the way one pass does", () => {
		// `ESC` then a tab opens nothing: the escape is dropped and the rest is
		// text. It must not be re-examined as an open sequence forever.
		const input = "a\x1b\tb";
		const stripper = new AnsiStripper();
		let settled = stripper.push(input);
		expect(settled + stripper.pending).toBe(stripAnsi(input));
		settled += stripper.push(" tail");
		expect(settled + stripper.pending).toBe(stripAnsi(`${input} tail`));
	});

	it("settles an unterminated sequence as text once it passes the open-fragment limit", () => {
		const stripper = new AnsiStripper();
		expect(stripper.push("head \x1b]52;c;")).toBe("head ");
		const payload = "Z".repeat(64 * 1024 + 1);
		const settled = stripper.push(payload);
		// The payload is now text, and nothing is held: the buffer cannot grow
		// with the stream.
		expect(settled).toBe(`]52;c;${payload}`);
		expect(stripper.pending).toBe("");
		// A terminator arriving after that point closes nothing — the sequence it
		// would have closed is already displayed as text, so the terminator is
		// text too. This is the documented disagreement with a whole-string strip.
		expect(stripper.push("\x07tail")).toBe("\x07tail");
	});

	it("scans each byte once", () => {
		const chunk = `\x1b[32mrow\x1b[0m\t${"y".repeat(4000)}\n`;
		const stripper = new AnsiStripper();
		let accumulated = "";
		const first = performance.now();
		accumulated += stripper.push(chunk);
		const firstCost = performance.now() - first;
		for (let index = 0; index < 200; index++) accumulated += stripper.push(chunk);
		const last = performance.now();
		accumulated += stripper.push(chunk);
		const lastCost = performance.now() - last;
		expect(accumulated.length).toBeGreaterThan(800_000);
		// A whole-string re-strip at this depth costs several times the first
		// arrival. Chunked, the last arrival is the same work as the first, so
		// the bound is generous and still fails a return to re-stripping.
		expect(lastCost).toBeLessThan(Math.max(firstCost, 0.05) * 8);
	});
});
