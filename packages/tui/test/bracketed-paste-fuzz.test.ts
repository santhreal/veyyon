/**
 * Conservation + property fuzz for the BracketedPasteHandler state machine.
 *
 * A pasted stream is `segment (START payload END segment)*` where every segment
 * is ordinary keyboard input and every payload is paste content. The markers may
 * fall anywhere across chunk boundaries, and a segment may share a chunk with the
 * start marker that follows it (the pre-marker `prefix` case). Driven the way the
 * real input/editor components drive it, the handler must conserve every byte:
 * the ordered normal-input bytes must reassemble to exactly the segments, and the
 * delivered payloads must equal exactly the paste contents, with nothing dropped,
 * duplicated, or misattributed between the two channels.
 *
 * The handler detects `PASTE_START` within a single `process()` call's data, so
 * (like the shipped StdinBuffer, which reassembles complete escape sequences
 * before emitting) a marker is never split across chunks here. Payloads and
 * segments still split at every offset.
 *
 * Deterministic LCG so a failing stream reproduces from the printed seed.
 */
import { describe, expect, it } from "bun:test";
import { BracketedPasteHandler, type PasteResult } from "@veyyon/tui/bracketed-paste";
import { lcg } from "./helpers/adversarial-strings";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

// ESC-free, marker-free alphabet: no fragment can accidentally form a marker.
const SEGMENT_POOL = ["a", "Z", "9", " ", "\n", "\t", "一", "\u{1f600}", "[", "]", ";", "~", "0", "2", "1"];

type MarkerRange = readonly [start: number, end: number];

type BuiltStream = {
	stream: string;
	markers: MarkerRange[];
	segments: string; // all normal-input bytes, in order
	payloads: string[]; // all paste contents, in order
};

function randomRun(rand: () => number, maxLen: number): string {
	const n = Math.floor(rand() * (maxLen + 1));
	let out = "";
	for (let i = 0; i < n; i++) out += SEGMENT_POOL[Math.floor(rand() * SEGMENT_POOL.length)];
	return out;
}

// Build `seg (START payload END seg)*`, recording exact marker byte ranges so the
// chunker can avoid splitting a marker in half.
function buildPasteStream(rand: () => number, maxPastes: number): BuiltStream {
	const markers: MarkerRange[] = [];
	let stream = "";
	let segments = "";
	const payloads: string[] = [];

	const leading = randomRun(rand, 6);
	stream += leading;
	segments += leading;

	const pasteCount = Math.floor(rand() * (maxPastes + 1));
	for (let p = 0; p < pasteCount; p++) {
		markers.push([stream.length, stream.length + PASTE_START.length]);
		stream += PASTE_START;

		const payload = randomRun(rand, 8);
		payloads.push(payload);
		stream += payload;

		markers.push([stream.length, stream.length + PASTE_END.length]);
		stream += PASTE_END;

		const between = randomRun(rand, 6);
		stream += between;
		segments += between;
	}

	return { stream, markers, segments, payloads };
}

// Split into chunks of 1..5 chars, snapping any boundary that lands strictly
// inside a marker forward to the marker's end so markers stay whole.
function chunkifyAvoidingMarkers(s: string, markers: readonly MarkerRange[], rand: () => number): string[] {
	const chunks: string[] = [];
	let i = 0;
	while (i < s.length) {
		let end = Math.min(s.length, i + 1 + Math.floor(rand() * 5));
		for (const [ms, me] of markers) {
			if (end > ms && end < me) {
				end = me;
				break;
			}
		}
		chunks.push(s.slice(i, end));
		i = end;
	}
	return chunks;
}

// Mirror how components/input.ts and components/editor.ts consume process():
// prefix and fall-through data and post-paste remaining are normal input;
// pasteContent is a payload; remaining re-enters the full gate.
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

describe("BracketedPasteHandler conservation fuzz", () => {
	it("conserves segments and payloads across every chunk boundary", () => {
		const rand = lcg(0x9e37_79b9);
		for (let iter = 0; iter < 8000; iter++) {
			const built = buildPasteStream(rand, 4);
			const chunks = chunkifyAvoidingMarkers(built.stream, built.markers, rand);
			// Fresh handler per stream: no completed paste ever leaks across streams.
			const { normal, pastes } = drive(new BracketedPasteHandler(), chunks);

			if (normal !== built.segments) {
				throw new Error(
					`normal-input mismatch on stream ${JSON.stringify(built.stream)}: got ${JSON.stringify(
						normal,
					)} want ${JSON.stringify(built.segments)}`,
				);
			}
			expect(pastes).toEqual(built.payloads);
		}
	});

	it("never throws on adversarially chunked streams", () => {
		const rand = lcg(0x1357_2468);
		for (let iter = 0; iter < 4000; iter++) {
			const built = buildPasteStream(rand, 5);
			const chunks = chunkifyAvoidingMarkers(built.stream, built.markers, rand);
			const handler = new BracketedPasteHandler();
			for (const chunk of chunks) {
				expect(() => handler.process(chunk)).not.toThrow();
			}
		}
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
});
