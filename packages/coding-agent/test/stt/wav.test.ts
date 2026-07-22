import { describe, expect, it } from "bun:test";
import { decodePcmS16LE, decodeWavToMono16k, resampleLinear, TARGET_SAMPLE_RATE } from "@veyyon/coding-agent/stt/wav";

/**
 * wav.ts is the pure-TypeScript WAV/PCM front end for speech-to-text: it decodes a
 * RIFF/PCM buffer (or a raw s16le stream) into the 16 kHz mono Float32Array the
 * Whisper feature extractor expects. It replaced a Python `wave`+numpy path, so its
 * arithmetic must match that reference exactly: 16-bit normalized by 32768, 8-bit
 * unsigned centered at 128, multi-channel averaged to mono, and linear resampling
 * that mirrors `np.interp` over `linspace(0, n-1, targetLen)`. A regression here
 * silently corrupts every transcription (wrong pitch, clipping, or garbage). These
 * build synthetic RIFF buffers with known samples and assert the exact decoded
 * floats.
 */

/** Build a minimal 44-byte-header PCM/float WAV around the given sample bytes. */
function makeWav(opts: {
	format: number;
	channels: number;
	sampleRate: number;
	bits: number;
	data: ArrayBuffer;
}): ArrayBuffer {
	const { format, channels, sampleRate, bits, data } = opts;
	const dataLen = data.byteLength;
	const buf = new ArrayBuffer(44 + dataLen);
	const v = new DataView(buf);
	const wc = (o: number, s: string) => {
		for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
	};
	wc(0, "RIFF");
	v.setUint32(4, 36 + dataLen, true);
	wc(8, "WAVE");
	wc(12, "fmt ");
	v.setUint32(16, 16, true);
	v.setUint16(20, format, true);
	v.setUint16(22, channels, true);
	v.setUint32(24, sampleRate, true);
	v.setUint32(28, (sampleRate * channels * bits) / 8, true);
	v.setUint16(32, (channels * bits) / 8, true);
	v.setUint16(34, bits, true);
	wc(36, "data");
	v.setUint32(40, dataLen, true);
	new Uint8Array(buf, 44).set(new Uint8Array(data));
	return buf;
}

function s16(samples: number[]): ArrayBuffer {
	const buf = new ArrayBuffer(samples.length * 2);
	const v = new DataView(buf);
	samples.forEach((s, i) => {
		v.setInt16(i * 2, s, true);
	});
	return buf;
}

describe("decodeWavToMono16k", () => {
	it("exposes the 16 kHz Whisper target rate", () => {
		expect(TARGET_SAMPLE_RATE).toBe(16_000);
	});

	it("normalizes 16-bit mono PCM by 32768 with no resample at 16 kHz", () => {
		const wav = makeWav({
			format: 1,
			channels: 1,
			sampleRate: 16_000,
			bits: 16,
			data: s16([0, 16384, -32768, 32767]),
		});
		expect(Array.from(decodeWavToMono16k(wav))).toEqual([0, 0.5, -1, 32767 / 32768]);
	});

	it("averages interleaved stereo frames down to mono", () => {
		// frame0 L=16384 R=-16384 -> 0 ; frame1 L=32767 R=-32768 -> tiny negative.
		const wav = makeWav({
			format: 1,
			channels: 2,
			sampleRate: 16_000,
			bits: 16,
			data: s16([16384, -16384, 32767, -32768]),
		});
		const out = Array.from(decodeWavToMono16k(wav));
		expect(out[0]).toBe(0);
		expect(out[1]).toBeCloseTo((32767 / 32768 - 1) / 2, 6);
		expect(out).toHaveLength(2);
	});

	it("decodes 8-bit unsigned PCM centered at 128", () => {
		const wav = makeWav({
			format: 1,
			channels: 1,
			sampleRate: 16_000,
			bits: 8,
			data: new Uint8Array([0, 128, 255, 64]).buffer,
		});
		expect(Array.from(decodeWavToMono16k(wav))).toEqual([-1, 0, (255 - 128) / 128, -0.5]);
	});

	it("throws when the buffer is not a RIFF/WAVE container", () => {
		expect(() => decodeWavToMono16k(new ArrayBuffer(4))).toThrow("Not a RIFF/WAVE file");
	});
});

describe("decodePcmS16LE", () => {
	it("decodes raw little-endian s16 frames normalized by 32768", () => {
		expect(Array.from(decodePcmS16LE(new Uint8Array(s16([0, 16384, -32768]))))).toEqual([0, 0.5, -1]);
	});

	it("ignores a trailing odd byte that has no complete sample", () => {
		// three bytes: one full sample (0x4000 -> 0.5) then a lone byte dropped.
		expect(Array.from(decodePcmS16LE(new Uint8Array([0, 64, 0])))).toEqual([0.5]);
	});
});

describe("resampleLinear", () => {
	it("returns the same array reference when the rate is unchanged", () => {
		const input = new Float32Array([0.5]);
		expect(resampleLinear(input, 16_000, 16_000)).toBe(input);
	});

	it("returns an empty array for empty input", () => {
		expect(Array.from(resampleLinear(new Float32Array([]), 8_000, 16_000))).toEqual([]);
	});

	it("upsamples 2 -> 4 samples by linear interpolation (np.interp over linspace)", () => {
		const out = Array.from(resampleLinear(new Float32Array([0, 1]), 8_000, 16_000));
		expect(out).toHaveLength(4);
		expect(out[0]).toBeCloseTo(0, 6);
		expect(out[1]).toBeCloseTo(1 / 3, 6);
		expect(out[2]).toBeCloseTo(2 / 3, 6);
		expect(out[3]).toBeCloseTo(1, 6);
	});

	it("downsamples 4 -> 2 samples picking the interpolated endpoints", () => {
		const out = Array.from(resampleLinear(new Float32Array([0, 0.25, 0.5, 0.75]), 32_000, 16_000));
		expect(out).toEqual([0, 0.75]);
	});
});
