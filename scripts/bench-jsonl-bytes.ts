/**
 * Measure the byte-level JSONL walk against the loop it replaced.
 *
 * The stats dashboard walks session transcripts of hundreds of megabytes on every sync pass, so moving
 * that loop out of `packages/stats/src/parser.ts` and into `@veyyon/utils` is only correct if it costs
 * nothing. This script is the proof: it runs the SHIPPED `visitJsonlBytes` and a byte-for-byte copy of
 * the loop as the stats parser had it over the same synthetic corpus, and prints MB/s and ns per line
 * for both.
 *
 * The copy is here rather than in the test suite on purpose. A timing assertion in a test is flaky on a
 * shared machine and says nothing about the algorithm, so the suite pins the walk's BEHAVIOUR to the
 * byte and this script answers the throughput question when someone changes the walk.
 *
 * Run it with:
 *
 * ```sh
 * bun scripts/bench-jsonl-bytes.ts            # 200k lines, 5 rounds
 * bun scripts/bench-jsonl-bytes.ts 1000000 3  # lines, rounds
 * ```
 */

import { visitJsonlBytes } from "@veyyon/utils";

const LF = 0x0a;
const CR = 0x0d;

/**
 * The loop as `packages/stats/src/parser.ts` had it, kept verbatim so the comparison is against what
 * actually shipped rather than against a fresh idea of it. Do not "improve" this copy.
 */
function visitLegacy(bytes: Uint8Array, visit: (entry: unknown) => void, parse?: (text: string) => unknown): number {
	const decoder = new TextDecoder();
	const parseLine = (start: number, rawEnd: number): unknown => {
		let end = rawEnd;
		while (end > start && bytes[end - 1] === CR) end--;
		if (end <= start) return null;
		if (parse) return parse(decoder.decode(bytes.subarray(start, end)));
		try {
			return JSON.parse(decoder.decode(bytes.subarray(start, end)));
		} catch {
			return null;
		}
	};

	let cursor = 0;
	let read = 0;
	while (cursor < bytes.length) {
		const newline = bytes.indexOf(LF, cursor);
		const hasNewline = newline !== -1;
		const lineEnd = hasNewline ? newline : bytes.length;
		const entry = parseLine(cursor, lineEnd);
		if (entry) {
			visit(entry);
			read = hasNewline ? newline + 1 : lineEnd;
		} else if (hasNewline) {
			read = newline + 1;
		} else {
			break;
		}
		cursor = hasNewline ? newline + 1 : lineEnd;
	}
	return read;
}

/** A corpus shaped like a session transcript: mixed key counts, some multi-byte text, one bad line. */
function buildCorpus(lines: number): Uint8Array {
	const out: string[] = [];
	for (let i = 0; i < lines; i++) {
		if (i % 5000 === 4999) {
			out.push('{"type":"message","truncated'); // a line a writer cut off, completed later
			continue;
		}
		out.push(
			JSON.stringify({
				id: `entry-${i}`,
				type: i % 3 === 0 ? "message" : "tool_result",
				role: "assistant",
				text: i % 7 === 0 ? "réponse avec des accents et un peu de longueur" : "a plain line of about this width",
				usage: { input: i, output: i * 2, cacheRead: i % 11 },
			}),
		);
	}
	return new TextEncoder().encode(`${out.join("\n")}\n`);
}

function measure(label: string, bytes: Uint8Array, rounds: number, run: (bytes: Uint8Array) => number): void {
	// One untimed round so both paths are JIT-warm before either is measured.
	run(bytes);
	const samples: number[] = [];
	for (let round = 0; round < rounds; round++) {
		const started = Bun.nanoseconds();
		run(bytes);
		samples.push(Bun.nanoseconds() - started);
	}
	samples.sort((a, b) => a - b);
	const median = samples[Math.floor(samples.length / 2)] ?? 0;
	const megabytes = bytes.length / 1_000_000;
	const seconds = median / 1_000_000_000;
	console.log(
		`${label.padEnd(18)} ${(megabytes / seconds).toFixed(1).padStart(7)} MB/s   ` +
			`${(median / 1_000_000).toFixed(1).padStart(7)} ms/pass   best ${(samples[0] ?? 0) / 1_000_000} ms`,
	);
}

const lines = Number(process.argv[2] ?? 200_000);
const rounds = Number(process.argv[3] ?? 5);
const corpus = buildCorpus(lines);

console.log(`corpus: ${lines} lines, ${(corpus.length / 1_000_000).toFixed(1)} MB, ${rounds} timed rounds each\n`);

let shippedCount = 0;
let legacyCount = 0;
const shippedRead = visitJsonlBytes(corpus, () => shippedCount++);
const legacyRead = visitLegacy(corpus, () => legacyCount++);
console.log(`shipped: ${shippedCount} entries, read ${shippedRead} bytes`);
console.log(`legacy:  ${legacyCount} entries, read ${legacyRead} bytes\n`);
if (shippedCount !== legacyCount || shippedRead !== legacyRead) {
	// A throughput number for two walks that disagree about the corpus is meaningless, and a disagreement
	// here is a correctness finding in its own right.
	console.error("the two walks disagree about this corpus; the comparison below would be meaningless");
	process.exit(1);
}

// Both orders, because a single ordering measures JIT warmth as much as the code: whichever walk runs
// second inherits a hotter allocator and a warmer cache, and a 4% gap can be entirely that.
measure("visitJsonlBytes", corpus, rounds, bytes => visitJsonlBytes(bytes, () => {}));
measure("stats' old loop", corpus, rounds, bytes => visitLegacy(bytes, () => {}));
measure("old loop again", corpus, rounds, bytes => visitLegacy(bytes, () => {}));
measure("shipped again", corpus, rounds, bytes => visitJsonlBytes(bytes, () => {}));

// The path the stats parser actually takes: it narrows records to objects, so it goes through the
// caller-decode branch rather than the built-in parse. Worth its own number, because the two branches
// are separate call sites and only one of them is exercised above.
const objectsOnly = (line: string): object | undefined => {
	try {
		const parsed: unknown = JSON.parse(line);
		return parsed !== null && typeof parsed === "object" ? parsed : undefined;
	} catch {
		return undefined;
	}
};
measure("with a decode", corpus, rounds, bytes => visitJsonlBytes(bytes, () => {}, { decode: objectsOnly }));
// And the old loop through its own indirect parse, which is what it really did: it called
// `tryParseJson` from `@veyyon/utils` rather than inlining `JSON.parse`. This is the honest pair.
measure("old loop + parse", corpus, rounds, bytes =>
	visitLegacy(
		bytes,
		() => {},
		line => objectsOnly(line) ?? null,
	),
);
