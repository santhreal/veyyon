/**
 * Conservation + property fuzz for the BracketedPasteHandler state machine.
 *
 * A pasted stream is `segment (START payload END segment)*` where every segment is ordinary
 * keyboard input and every payload is paste content. The markers may fall anywhere across chunk
 * boundaries, and a segment may share a chunk with the start marker that follows it (the pre-marker
 * `prefix` case). Driven the way the real input/editor components drive it, the handler must
 * conserve every byte: the ordered normal-input bytes must reassemble to exactly the segments, and
 * the delivered payloads must equal exactly the paste contents, with nothing dropped, duplicated, or
 * misattributed between the two channels.
 *
 * The handler detects `PASTE_START` within a single `process()` call's data, so (like the shipped
 * StdinBuffer, which reassembles complete escape sequences before emitting) a marker is never split
 * across chunks here. Payloads and segments still split at every offset.
 *
 * WHY A SPEC AND NOT A STRING. This suite used to own a hand-written loop, because the unit under
 * test takes a structure: the stream, the marker offsets inside it, and the chunking. Shrinking the
 * stream text alone would leave the offsets pointing at the wrong bytes, and a reader would chase
 * that instead of the bug. The case here is therefore the GENERATIVE spec -- a leading run, then a
 * payload and a following run per paste, plus the chunk sizes -- and the stream is derived from it.
 * Every simplification is then structural and cannot produce an inconsistent case: drop a paste,
 * shorten a run, coarsen the chunking. `fuzzCases` does the rest, which is how this suite finally
 * got the two things the hand-written loop never had, a shrinker and a corpus.
 */
import { describe, expect, it } from "bun:test";
import { BracketedPasteHandler, type PasteResult } from "@veyyon/tui/bracketed-paste";
import { fuzzCases } from "@veyyon/utils/adversarial-strings";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

// ESC-free, marker-free alphabet: no fragment can accidentally form a marker.
const SEGMENT_POOL = ["a", "Z", "9", " ", "\n", "\t", "一", "\u{1f600}", "[", "]", ";", "~", "0", "2", "1"];

type MarkerRange = readonly [start: number, end: number];

/** One paste and the ordinary input that follows it. */
type PasteSpec = {
	readonly payload: string;
	readonly between: string;
};

/**
 * A whole case, in the terms the generator thinks in.
 *
 * `chunkSizes` is consumed in order and cycled if the stream outlasts it, so shortening the stream
 * never invalidates it. Every field can be shrunk independently and the result is still a case the
 * builder could have produced, which is the property that makes minimisation trustworthy here.
 */
type PasteCase = {
	readonly leading: string;
	readonly pastes: readonly PasteSpec[];
	readonly chunkSizes: readonly number[];
};

type BuiltStream = {
	readonly stream: string;
	readonly markers: readonly MarkerRange[];
	/** All normal-input bytes, in order. */
	readonly segments: string;
	/** All paste contents, in order. */
	readonly payloads: readonly string[];
};

function randomRun(rand: () => number, maxLen: number): string {
	const n = Math.floor(rand() * (maxLen + 1));
	let out = "";
	for (let i = 0; i < n; i++) out += SEGMENT_POOL[Math.floor(rand() * SEGMENT_POOL.length)];
	return out;
}

function buildCase(rand: () => number, maxPastes: number): PasteCase {
	const pasteCount = Math.floor(rand() * (maxPastes + 1));
	const pastes: PasteSpec[] = [];
	for (let p = 0; p < pasteCount; p++) {
		pastes.push({ payload: randomRun(rand, 8), between: randomRun(rand, 6) });
	}
	const chunkSizes: number[] = [];
	for (let i = 0; i < 12; i++) chunkSizes.push(1 + Math.floor(rand() * 5));
	return { leading: randomRun(rand, 6), pastes, chunkSizes };
}

/** Derive `seg (START payload END seg)*`, recording exact marker byte ranges. */
function materialize(spec: PasteCase): BuiltStream {
	const markers: MarkerRange[] = [];
	let stream = spec.leading;
	let segments = spec.leading;
	const payloads: string[] = [];

	for (const paste of spec.pastes) {
		markers.push([stream.length, stream.length + PASTE_START.length]);
		stream += PASTE_START;
		payloads.push(paste.payload);
		stream += paste.payload;
		markers.push([stream.length, stream.length + PASTE_END.length]);
		stream += PASTE_END;
		stream += paste.between;
		segments += paste.between;
	}

	return { stream, markers, segments, payloads };
}

/**
 * Split into chunks, snapping any boundary that lands strictly inside a marker forward to the
 * marker's end so markers stay whole.
 *
 * Sizes come from the case rather than from a generator, so a shrunk case chunks the same way the
 * original did wherever the two streams still agree.
 */
function chunkify(built: BuiltStream, sizes: readonly number[]): string[] {
	const chunks: string[] = [];
	let i = 0;
	let step = 0;
	while (i < built.stream.length) {
		const size = sizes.length > 0 ? (sizes[step % sizes.length] as number) : 1;
		step += 1;
		let end = Math.min(built.stream.length, i + size);
		for (const [ms, me] of built.markers) {
			if (end > ms && end < me) {
				end = me;
				break;
			}
		}
		chunks.push(built.stream.slice(i, end));
		i = end;
	}
	return chunks;
}

/**
 * Every simpler case, biggest reduction first.
 *
 * Order matters for how fast this converges: dropping a whole paste removes the most, emptying a
 * run next, coarsening the chunking last, because chunk size is usually the detail that matters and
 * should be the last thing given up.
 */
function simplify(spec: PasteCase): PasteCase[] {
	const candidates: PasteCase[] = [];

	for (let i = 0; i < spec.pastes.length; i++) {
		candidates.push({ ...spec, pastes: [...spec.pastes.slice(0, i), ...spec.pastes.slice(i + 1)] });
	}
	if (spec.leading.length > 0) candidates.push({ ...spec, leading: "" });
	for (let i = 0; i < spec.pastes.length; i++) {
		const paste = spec.pastes[i] as PasteSpec;
		if (paste.payload.length > 0) {
			const halved = paste.payload.slice(0, Math.floor(paste.payload.length / 2));
			candidates.push({ ...spec, pastes: spec.pastes.map((p, j) => (j === i ? { ...p, payload: halved } : p)) });
		}
		if (paste.between.length > 0) {
			candidates.push({ ...spec, pastes: spec.pastes.map((p, j) => (j === i ? { ...p, between: "" } : p)) });
		}
	}
	if (spec.chunkSizes.length > 1) candidates.push({ ...spec, chunkSizes: spec.chunkSizes.slice(0, 1) });

	return candidates;
}

/**
 * Mirror how components/input.ts and components/editor.ts consume process(): prefix and
 * fall-through data and post-paste remaining are normal input; pasteContent is a payload;
 * remaining re-enters the full gate.
 */
function drive(handler: BracketedPasteHandler, chunks: readonly string[]): { normal: string; pastes: string[] } {
	let normal = "";
	const pastes: string[] = [];

	const feed = (data: string): void => {
		const r: PasteResult = handler.process(data);
		if (!r.handled) {
			normal += data;
			return;
		}
		if (r.prefix !== undefined) normal += r.prefix;
		if (r.pasteContent !== undefined) {
			pastes.push(r.pasteContent);
			if (r.remaining.length > 0) feed(r.remaining);
		}
	};

	for (const chunk of chunks) feed(chunk);
	return { normal, pastes };
}

/**
 * Cases this fuzzer found, replayed before any generated one.
 *
 * Empty is the honest state: the hand-written loop it replaced persisted nothing, so there is
 * nothing to seed it with. Paste the `corpus entry:` line from the next failure here.
 */
const PASTE_CORPUS: readonly PasteCase[] = [];

describe("BracketedPasteHandler conservation fuzz", () => {
	it("conserves segments and payloads across every chunk boundary", () => {
		fuzzCases<PasteCase>(
			{
				seed: 0x9e37_79b9,
				iterations: 8_000,
				corpus: PASTE_CORPUS,
				build: rand => buildCase(rand, 4),
				simplify,
			},
			spec => {
				const built = materialize(spec);
				// Fresh handler per stream: no completed paste ever leaks across streams.
				const { normal, pastes } = drive(new BracketedPasteHandler(), chunkify(built, spec.chunkSizes));

				expect(normal).toBe(built.segments);
				expect(pastes).toEqual([...built.payloads]);
			},
		);
	});

	it("never throws on adversarially chunked streams", () => {
		fuzzCases<PasteCase>(
			{
				seed: 0x1357_2468,
				iterations: 4_000,
				corpus: PASTE_CORPUS,
				build: rand => buildCase(rand, 5),
				simplify,
			},
			spec => {
				const built = materialize(spec);
				const handler = new BracketedPasteHandler();
				for (const chunk of chunkify(built, spec.chunkSizes)) {
					expect(() => handler.process(chunk)).not.toThrow();
				}
			},
		);
	});

	it("delivers a payload split into single-character chunks as one payload", () => {
		// The one-char-per-chunk extreme for the payload: it is buffered across
		// many process() calls and emitted exactly once when the end marker
		// completes. Markers are fed whole, as the shipped StdinBuffer guarantees
		// (process() detects the start marker only within a single call's data).
		const payload = "the quick brown fox";
		const chunks = ["p", "r", "e", PASTE_START, ...payload, PASTE_END, "p", "o", "s", "t"];
		const handler = new BracketedPasteHandler();
		const { normal, pastes } = drive(handler, chunks);
		expect(normal).toBe("prepost");
		expect(pastes).toEqual([payload]);
	});

	it("keeps two back-to-back pastes in one chunk as two distinct payloads", () => {
		const handler = new BracketedPasteHandler();
		const stream = `a${PASTE_START}one${PASTE_END}b${PASTE_START}two${PASTE_END}c`;
		const { normal, pastes } = drive(handler, [stream]);
		expect(normal).toBe("abc");
		expect(pastes).toEqual(["one", "two"]);
	});

	/**
	 * The spec-to-stream derivation is the thing every generated case trusts, so it gets a case of
	 * its own with hand-checked values. If `materialize` mis-recorded a marker range, `chunkify`
	 * would happily split a marker in half and the conservation cases would fail with a message
	 * about the handler rather than about the harness.
	 */
	it("derives a stream whose recorded markers hold exactly the markers", () => {
		const built = materialize({
			leading: "ab",
			pastes: [{ payload: "one", between: "cd" }],
			chunkSizes: [1],
		});

		expect(built.stream).toBe(`ab${PASTE_START}one${PASTE_END}cd`);
		expect(built.segments).toBe("abcd");
		expect(built.payloads).toEqual(["one"]);
		expect(built.markers.map(([s, e]) => built.stream.slice(s, e))).toEqual([PASTE_START, PASTE_END]);
	});

	/**
	 * And the chunker's own contract: whatever the requested size, no chunk boundary ever falls
	 * inside a marker. A size of one is the worst case, and the one the handler cannot survive,
	 * since it detects a start marker only within a single call's data.
	 */
	it("never splits a marker even at a chunk size of one", () => {
		const built = materialize({
			leading: "ab",
			pastes: [{ payload: "one", between: "cd" }],
			chunkSizes: [1],
		});

		const chunks = chunkify(built, [1]);

		expect(chunks.join("")).toBe(built.stream);
		expect(chunks).toEqual(["a", "b", PASTE_START, "o", "n", "e", PASTE_END, "c", "d"]);
	});

	/**
	 * Every simplification stays a case the generator could have produced. This is what makes a
	 * minimised failure worth reading: a candidate that dropped a payload without dropping its
	 * markers would report a stream the handler is right to reject.
	 */
	it("only simplifies to cases that still materialize consistently", () => {
		const spec: PasteCase = {
			leading: "ab",
			pastes: [
				{ payload: "one", between: "cd" },
				{ payload: "two", between: "ef" },
			],
			chunkSizes: [1, 3],
		};

		const candidates = simplify(spec);
		expect(candidates.length).toBeGreaterThan(0);
		// Dropping a whole paste comes first, because it removes the most.
		expect(candidates[0]?.pastes.map(paste => paste.payload)).toEqual(["two"]);

		for (const candidate of candidates) {
			const built = materialize(candidate);
			expect(built.payloads).toEqual(candidate.pastes.map(paste => paste.payload));
			expect(built.markers.map(([s, e]) => built.stream.slice(s, e))).toEqual(
				candidate.pastes.flatMap(() => [PASTE_START, PASTE_END]),
			);
			expect(chunkify(built, candidate.chunkSizes).join("")).toBe(built.stream);
		}
	});

	/** Terminates on the smallest case there is, rather than proposing itself forever. */
	it("proposes nothing to simplify for an already-minimal case", () => {
		expect(simplify({ leading: "", pastes: [], chunkSizes: [1] })).toEqual([]);
	});
});
