import { describe, expect, it } from "bun:test";
import { encodeWav } from "@veyyon/coding-agent/tts/wav";

/**
 * encodeWav turns transformers.js Float32 PCM into a self-contained mono PCM16 WAV byte buffer, with
 * no external encoder. Every byte of the 44-byte RIFF/WAVE header is a fixed contract that a media
 * player parses literally, and the sample quantization must clamp and round exactly, so this suite
 * asserts the concrete bytes rather than just "produces output". A regression here yields silently
 * corrupt audio: a wrong chunk size or byte rate makes players refuse or mis-speed the clip, and a
 * wrong quantization wraps loud samples into noise.
 */
describe("encodeWav", () => {
	function view(bytes: Uint8Array): DataView {
		return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}
	function ascii(bytes: Uint8Array, offset: number, length: number): string {
		return String.fromCharCode(...bytes.slice(offset, offset + length));
	}

	it("writes the canonical 44-byte header for a 16 kHz mono clip", () => {
		// Six samples -> 12 data bytes -> 56 total.
		const wav = encodeWav(new Float32Array([0, 1, -1, 2, -2, 0.5]), 16_000);
		const dv = view(wav);

		expect(wav.length).toBe(56);

		// RIFF chunk descriptor: "RIFF", (fileSize - 8) = 36 + dataBytes, "WAVE".
		expect(ascii(wav, 0, 4)).toBe("RIFF");
		expect(dv.getUint32(4, true)).toBe(48); // 36 + 12
		expect(ascii(wav, 8, 4)).toBe("WAVE");

		// fmt sub-chunk: "fmt ", size 16, PCM format 1, 1 channel, rate, byteRate, blockAlign, 16 bits.
		expect(ascii(wav, 12, 4)).toBe("fmt ");
		expect(dv.getUint32(16, true)).toBe(16);
		expect(dv.getUint16(20, true)).toBe(1); // PCM
		expect(dv.getUint16(22, true)).toBe(1); // mono
		expect(dv.getUint32(24, true)).toBe(16_000); // sample rate
		expect(dv.getUint32(28, true)).toBe(32_000); // byteRate = rate * channels * 2
		expect(dv.getUint16(32, true)).toBe(2); // blockAlign = channels * 2
		expect(dv.getUint16(34, true)).toBe(16); // bits per sample

		// data sub-chunk: "data", dataBytes.
		expect(ascii(wav, 36, 4)).toBe("data");
		expect(dv.getUint32(40, true)).toBe(12);
	});

	it("clamps and quantizes samples to little-endian signed 16-bit, full-scale asymmetric", () => {
		const wav = encodeWav(new Float32Array([0, 1, -1, 2, -2, 0.5]), 16_000);
		const dv = view(wav);
		const samples = Array.from({ length: 6 }, (_, i) => dv.getInt16(44 + i * 2, true));

		// 0 -> 0; +1 -> INT16_MAX (32767); -1 -> INT16_MIN (-32768); out-of-range clamps, not wraps;
		// 0.5 -> round(0.5 * 32767) = 16384.
		expect(samples).toEqual([0, 32_767, -32_768, 32_767, -32_768, 16_384]);
	});

	it("emits a header-only buffer for an empty sample array", () => {
		const wav = encodeWav(new Float32Array([]), 22_050);
		const dv = view(wav);
		expect(wav.length).toBe(44);
		expect(dv.getUint32(4, true)).toBe(36); // 36 + 0 data bytes
		expect(dv.getUint32(40, true)).toBe(0); // no data
		expect(dv.getUint32(24, true)).toBe(22_050); // the rate still round-trips
	});
});
