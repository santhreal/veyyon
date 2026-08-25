/**
 * encodeWav clamps finite samples. Non-finite floats and a zero sample-rate
 * still produce a structurally valid RIFF buffer — or they wrap.
 *
 * WHY THIS SUITE EXISTS. The header/quantization suite pins 0 / ±1 / ±2 / 0.5
 * at 16 kHz. It does not pin:
 *
 *   - NaN: every comparison against 1 is false, so NaN is not clamped; 
 *     `Math.round(NaN * 32767)` is NaN; `DataView.setInt16` writes 0.
 *     A silent NaN from an enhancer must not become a wrap to INT16_MIN.
 *   - ±Infinity: the clamp sees Infinity > 1 and should saturate, not wrap.
 *   - -0: must quantize as 0, not as a negative full-scale tick.
 *   - sampleRate 0: byteRate and the rate field become 0. Players refuse
 *     the clip; that is honest. Pin so a later "helpful" default of 16000
 *     cannot hide a 0 Hz model output.
 *   - a rate that does not fit in uint32 (fractional, negative) is truncated
 *     by setUint32. Pin the bytes actually written.
 */
import { describe, expect, it } from "bun:test";
import { encodeWav } from "@veyyon/coding-agent/tts/wav";

function view(bytes: Uint8Array): DataView {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function samplesOf(bytes: Uint8Array): number[] {
	const dv = view(bytes);
	const n = (bytes.length - 44) / 2;
	return Array.from({ length: n }, (_, i) => dv.getInt16(44 + i * 2, true));
}

describe("non-finite samples do not wrap into noise", () => {
	it("quantizes NaN to 0 rather than INT16_MIN wrap", () => {
		const wav = encodeWav(new Float32Array([Number.NaN]), 16_000);
		expect(samplesOf(wav)).toEqual([0]);
	});

	it("clamps +Infinity to INT16_MAX and -Infinity to INT16_MIN", () => {
		const wav = encodeWav(new Float32Array([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]), 16_000);
		expect(samplesOf(wav)).toEqual([32_767, -32_768]);
	});

	it("quantizes -0 as 0, not as a negative tick", () => {
		const wav = encodeWav(new Float32Array([-0, 0]), 16_000);
		expect(samplesOf(wav)).toEqual([0, 0]);
	});

	it("does not wrap a value just above 1 or just below -1", () => {
		const wav = encodeWav(new Float32Array([1.0001, -1.0001, 1e6, -1e6]), 16_000);
		expect(samplesOf(wav)).toEqual([32_767, -32_768, 32_767, -32_768]);
	});

	it("rounds .5 away from zero at the 0.5 * INT16_MAX boundary (already 16384) and 1/3", () => {
		const wav = encodeWav(new Float32Array([1 / 3, -1 / 3]), 16_000);
		const s = samplesOf(wav);
		expect(s[0]).toBe(Math.round((1 / 3) * 32_767));
		expect(s[1]).toBe(Math.max(-32_768, Math.round((-1 / 3) * 32_768)));
	});
});

describe("sample-rate field is the number we were given, even when unplayable", () => {
	it("writes rate 0 and byteRate 0 for a zero-rate clip", () => {
		const wav = encodeWav(new Float32Array([0, 0, 0, 0]), 0);
		const dv = view(wav);
		expect(dv.getUint32(24, true)).toBe(0);
		expect(dv.getUint32(28, true)).toBe(0);
		expect(wav.length).toBe(44 + 8);
	});

	it("truncates a fractional rate the way setUint32 does, rather than rounding", () => {
		const wav = encodeWav(new Float32Array([0]), 44100.9);
		expect(view(wav).getUint32(24, true)).toBe(44_100);
	});

	it("writes a negative rate as the uint32 two's-complement bit pattern, not as 16000", () => {
		const wav = encodeWav(new Float32Array([0]), -1);
		const stored = view(wav).getUint32(24, true);
		expect(stored).not.toBe(16_000);
		expect(stored).toBe(0xffff_ffff);
	});
});
