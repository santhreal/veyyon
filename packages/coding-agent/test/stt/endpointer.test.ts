import { describe, expect, it } from "bun:test";
import { DEFAULT_ENDPOINTER_CONFIG, type EndpointerEvent, StreamEndpointer } from "@veyyon/coding-agent/stt/endpointer";

/**
 * StreamEndpointer splits a continuous 16 kHz mono float stream into speech segments
 * at natural pauses so a non-streaming ASR model can transcribe while the user is
 * still speaking. Its own doc comment promises it is "fully deterministic so it can be
 * unit-tested with synthetic signals" -- yet it shipped with no tests at all. These
 * feed constant-amplitude synthetic frames (a flat signal has RMS equal to its
 * amplitude, so energy is exactly predictable) and pin the segmentation contract:
 *
 *  - A speech run followed by `endSilenceMs` of silence commits exactly one `segment`,
 *    and any volatile `partial` previews precede it.
 *  - A run shorter than `minSpeechMs` is discarded as noise: no `segment` is emitted.
 *  - `flush` commits a still-open in-progress segment (there is no trailing silence to
 *    trigger it otherwise).
 *  - Pause-free speech past `maxSegmentMs` commits mid-stream so output keeps flowing,
 *    with the first cut landing at exactly the cap.
 *  - The energy gate `max(minThreshold, noiseFloor * energyRatio)` keeps a near-silent
 *    signal from ever tripping speech detection.
 *  - Onset pre-roll: audio captured before the first voiced frame is prepended so the
 *    first phoneme is never clipped.
 *
 * The exact sample counts asserted below are the deterministic outputs of the default
 * config; they are the real values the pipeline downstream will decode, not shapes.
 */

const SR = DEFAULT_ENDPOINTER_CONFIG.sampleRate;

/** A flat `ms`-long signal at amplitude `amp` (so its RMS energy is exactly `amp`). */
function sig(ms: number, amp: number): Float32Array {
	const a = new Float32Array(Math.round((SR * ms) / 1000));
	a.fill(amp);
	return a;
}

function concat(...arrs: Float32Array[]): Float32Array {
	const total = arrs.reduce((s, a) => s + a.length, 0);
	const out = new Float32Array(total);
	let k = 0;
	for (const a of arrs) {
		out.set(a, k);
		k += a.length;
	}
	return out;
}

const kinds = (evs: EndpointerEvent[]): string[] => evs.map(e => e.kind);
const segmentLengths = (evs: EndpointerEvent[]): number[] =>
	evs.filter(e => e.kind === "segment").map(e => e.audio.length);

describe("StreamEndpointer segmentation", () => {
	it("commits exactly one segment on trailing silence, with partials emitted first", () => {
		const ep = new StreamEndpointer();
		const events = ep.push(concat(sig(500, 0.5), sig(700, 0)));
		// 700 ms of trailing silence crosses the 600 ms end-silence threshold.
		expect(segmentLengths(events)).toEqual([10560]);
		// Every volatile partial preview precedes the finalized segment.
		const firstSegment = kinds(events).indexOf("segment");
		expect(
			kinds(events)
				.slice(0, firstSegment)
				.every(k => k === "partial"),
		).toBe(true);
		expect(kinds(events)).toContain("partial");
		// The segment already flushed, so ending the stream adds nothing.
		expect(ep.flush()).toEqual([]);
	});

	it("discards a speech run shorter than minSpeechMs", () => {
		const ep = new StreamEndpointer();
		// 100 ms of speech is below the 200 ms minimum, so no segment is committed
		// even though the trailing silence would otherwise finalize one.
		const events = ep.push(concat(sig(100, 0.5), sig(700, 0)));
		expect(segmentLengths(events)).toEqual([]);
		expect(segmentLengths(ep.flush())).toEqual([]);
	});

	it("commits a still-open segment on flush when there is no trailing silence", () => {
		const ep = new StreamEndpointer();
		const pushed = ep.push(sig(500, 0.5));
		// Nothing finalizes mid-push: the segment is still open.
		expect(segmentLengths(pushed)).toEqual([]);
		expect(segmentLengths(ep.flush())).toEqual([8480]);
	});

	it("commits mid-stream at the maxSegmentMs cap during pause-free speech", () => {
		const ep = new StreamEndpointer();
		const events = ep.push(sig(13_000, 0.5));
		const segs = segmentLengths(events);
		// The first cut lands at exactly the 12 s cap (12_000 ms * 16 samples/ms).
		expect(segs.length).toBeGreaterThanOrEqual(1);
		expect(segs[0]).toBe((DEFAULT_ENDPOINTER_CONFIG.maxSegmentMs * SR) / 1000);
		// The remainder past the cap is still open and commits on flush.
		expect(segmentLengths(ep.flush())).toEqual([16480]);
	});
});

describe("StreamEndpointer energy gate", () => {
	it("emits nothing for pure silence", () => {
		const ep = new StreamEndpointer();
		expect(ep.push(sig(2000, 0))).toEqual([]);
		expect(ep.flush()).toEqual([]);
	});

	it("commits a signal just above the speech threshold and ignores one just below it", () => {
		// Default gate is max(0.008, 0.008 * 2.5) = 0.02. 0.03 is voiced, 0.015 is not.
		const above = new StreamEndpointer();
		const aboveEvents = [...above.push(concat(sig(500, 0.03), sig(700, 0))), ...above.flush()];
		expect(segmentLengths(aboveEvents)).toEqual([10560]);

		const below = new StreamEndpointer();
		const belowEvents = [...below.push(concat(sig(500, 0.015), sig(700, 0))), ...below.flush()];
		expect(segmentLengths(belowEvents)).toEqual([]);
	});
});

describe("StreamEndpointer pre-roll", () => {
	it("prepends pre-onset audio so the first phoneme is not clipped", () => {
		const withLead = new StreamEndpointer();
		const led = [...withLead.push(concat(sig(300, 0), sig(300, 0.5), sig(700, 0))), ...withLead.flush()];
		const noLead = new StreamEndpointer();
		const bare = [...noLead.push(concat(sig(300, 0.5), sig(700, 0))), ...noLead.flush()];
		// Identical speech, but the leading silence supplies pre-roll, so the committed
		// segment carries extra pre-onset samples.
		expect(segmentLengths(led)).toEqual([10560]);
		expect(segmentLengths(bare)).toEqual([7200]);
		expect(segmentLengths(led)[0]).toBeGreaterThan(segmentLengths(bare)[0]!);
	});
});

describe("StreamEndpointer custom config", () => {
	it("honors overridden thresholds", () => {
		// Shorter end-silence and min-speech, partials effectively disabled.
		const ep = new StreamEndpointer({ endSilenceMs: 90, minSpeechMs: 60, partialIntervalMs: 100_000 });
		const events = ep.push(concat(sig(200, 0.5), sig(150, 0)));
		expect(kinds(events)).toEqual(["segment"]);
		expect(segmentLengths(events)).toEqual([5280]);
		expect(ep.flush()).toEqual([]);
	});
});
