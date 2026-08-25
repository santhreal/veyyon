/**
 * decodeWavToMono16k already pins 16-bit, 8-bit, stereo mix, and "not RIFF".
 * The decoder also claims IEEE float32, PCM int32, WAVE_FORMAT_EXTENSIBLE
 * (ffmpeg's wrapper around those), odd-sized chunks that pad to even, and a
 * hard throw on any other width. None of that was tested. A 24-bit capture
 * from a USB mic, or a float WAV from sox, would then either throw a generic
 * "missing fmt/data" (wrong) or silently decode the wrong width as int16.
 *
 * Chunk layout: after the 12-byte RIFF/WAVE header each chunk is id(4) +
 * size(4 LE) + body, and an odd size is followed by a pad byte. The parser
 * advances `body + size + (size % 2)`. If it forgets the pad, a 1-byte JUNK
 * chunk shifts fmt/data so channels/rate are garbage. If it requires fmt
 * size === 16, extensible files (fmt size 40) never set the real codec.
 *
 * Extensible: format tag 0xFFFE, real codec in the first two bytes of the
 * SubFormat GUID at fmt body offset 24. ffmpeg writes PCM as
 * 0x01 0x00 ... in that GUID.
 */
import { describe, expect, it } from "bun:test";
import { decodeWavToMono16k } from "@veyyon/coding-agent/stt/wav";

function four(view: DataView, offset: number, s: string): void {
	for (let i = 0; i < 4; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

function pcm16Fmt(view: DataView, body: number, channels: number, rate: number, bits: number): void {
	view.setUint16(body, 1, true);
	view.setUint16(body + 2, channels, true);
	view.setUint32(body + 4, rate, true);
	view.setUint32(body + 8, (rate * channels * bits) / 8, true);
	view.setUint16(body + 12, (channels * bits) / 8, true);
	view.setUint16(body + 14, bits, true);
}

describe("decodeWavToMono16k IEEE float32", () => {
	it("reads format tag 3, 32-bit samples, as the floats themselves at 16 kHz", () => {
		const data = new Float32Array([0, 0.5, -1, 0.25]);
		const bytes = new Uint8Array(44 + data.byteLength);
		const view = new DataView(bytes.buffer);
		four(view, 0, "RIFF");
		view.setUint32(4, 36 + data.byteLength, true);
		four(view, 8, "WAVE");
		four(view, 12, "fmt ");
		view.setUint32(16, 16, true);
		view.setUint16(20, 3, true);
		view.setUint16(22, 1, true);
		view.setUint32(24, 16_000, true);
		view.setUint32(28, 16_000 * 4, true);
		view.setUint16(32, 4, true);
		view.setUint16(34, 32, true);
		four(view, 36, "data");
		view.setUint32(40, data.byteLength, true);
		new Uint8Array(bytes.buffer, 44).set(new Uint8Array(data.buffer));
		expect(Array.from(decodeWavToMono16k(bytes.buffer))).toEqual([0, 0.5, -1, 0.25]);
	});
});

describe("decodeWavToMono16k PCM int32", () => {
	it("normalizes 32-bit PCM by 2^31", () => {
		const samples = [0, 1073741824, -2147483648];
		const data = new ArrayBuffer(samples.length * 4);
		const dv = new DataView(data);
		samples.forEach((s, i) => dv.setInt32(i * 4, s, true));
		const bytes = new Uint8Array(44 + data.byteLength);
		const view = new DataView(bytes.buffer);
		four(view, 0, "RIFF");
		view.setUint32(4, 36 + data.byteLength, true);
		four(view, 8, "WAVE");
		four(view, 12, "fmt ");
		view.setUint32(16, 16, true);
		pcm16Fmt(view, 20, 1, 16_000, 32);
		four(view, 36, "data");
		view.setUint32(40, data.byteLength, true);
		new Uint8Array(bytes.buffer, 44).set(new Uint8Array(data));
		const out = Array.from(decodeWavToMono16k(bytes.buffer));
		expect(out[0]).toBe(0);
		expect(out[1]).toBeCloseTo(0.5, 6);
		expect(out[2]).toBe(-1);
	});
});

describe("decodeWavToMono16k WAVE_FORMAT_EXTENSIBLE", () => {
	it("reads the real PCM codec from the SubFormat GUID, not the 0xFFFE wrapper", () => {
		const sample = new Uint8Array([0x00, 0x40]); // int16 16384 -> 0.5
		// 12 RIFF + 8 fmt hdr + 40 fmt body + 8 data hdr + 2 data = 70
		const bytes = new Uint8Array(70);
		const view = new DataView(bytes.buffer);
		four(view, 0, "RIFF");
		view.setUint32(4, 62, true);
		four(view, 8, "WAVE");
		four(view, 12, "fmt ");
		view.setUint32(16, 40, true);
		view.setUint16(20, 0xfffe, true); // extensible
		view.setUint16(22, 1, true);
		view.setUint32(24, 16_000, true);
		view.setUint32(28, 32_000, true);
		view.setUint16(32, 2, true);
		view.setUint16(34, 16, true);
		view.setUint16(36, 22, true); // cbSize
		view.setUint16(38, 16, true); // valid bits
		view.setUint32(40, 0, true); // channel mask
		view.setUint16(44, 1, true); // SubFormat: PCM
		for (let i = 46; i < 60; i++) view.setUint8(i, 0);
		four(view, 60, "data");
		view.setUint32(64, 2, true);
		bytes[68] = 0x00;
		bytes[69] = 0x40;
		expect(Array.from(decodeWavToMono16k(bytes.buffer))).toEqual([0.5]);
	});
});

describe("decodeWavToMono16k odd-sized chunks", () => {
	it("skips a 1-byte JUNK chunk plus its pad so fmt/data still decode", () => {
		const sample = new Uint8Array([0x00, 0x40]);
		// 12 + (8+1+1 junk) + (8+16 fmt) + (8+2 data) = 56
		const bytes = new Uint8Array(56);
		const view = new DataView(bytes.buffer);
		four(view, 0, "RIFF");
		view.setUint32(4, 48, true);
		four(view, 8, "WAVE");
		four(view, 12, "JUNK");
		view.setUint32(16, 1, true);
		view.setUint8(20, 0x7f);
		view.setUint8(21, 0x00); // pad
		four(view, 22, "fmt ");
		view.setUint32(26, 16, true);
		pcm16Fmt(view, 30, 1, 16_000, 16);
		four(view, 46, "data");
		view.setUint32(50, 2, true);
		bytes[54] = 0x00;
		bytes[55] = 0x40;
		expect(Array.from(decodeWavToMono16k(bytes.buffer))).toEqual([0.5]);
	});
});

describe("decodeWavToMono16k refuses widths it cannot decode", () => {
	it("throws on 24-bit PCM rather than reading three-byte samples as int16", () => {
		const bytes = new Uint8Array(44 + 3);
		const view = new DataView(bytes.buffer);
		four(view, 0, "RIFF");
		view.setUint32(4, 39, true);
		four(view, 8, "WAVE");
		four(view, 12, "fmt ");
		view.setUint32(16, 16, true);
		pcm16Fmt(view, 20, 1, 16_000, 24);
		four(view, 36, "data");
		view.setUint32(40, 3, true);
		expect(() => decodeWavToMono16k(bytes.buffer)).toThrow("Unsupported PCM sample width: 24 bits");
	});

	it("throws when fmt is present and data is not", () => {
		const bytes = new Uint8Array(36);
		const view = new DataView(bytes.buffer);
		four(view, 0, "RIFF");
		view.setUint32(4, 28, true);
		four(view, 8, "WAVE");
		four(view, 12, "fmt ");
		view.setUint32(16, 16, true);
		pcm16Fmt(view, 20, 1, 16_000, 16);
		expect(() => decodeWavToMono16k(bytes.buffer)).toThrow("WAV file missing fmt/data chunks");
	});

	it("throws on a PCM format tag it does not implement, rather than walking the bytes as int16", () => {
		const bytes = new Uint8Array(46);
		const view = new DataView(bytes.buffer);
		four(view, 0, "RIFF");
		view.setUint32(4, 38, true);
		four(view, 8, "WAVE");
		four(view, 12, "fmt ");
		view.setUint32(16, 16, true);
		view.setUint16(20, 6, true); // A-law
		view.setUint16(22, 1, true);
		view.setUint32(24, 16_000, true);
		view.setUint32(28, 16_000, true);
		view.setUint16(32, 1, true);
		view.setUint16(34, 8, true);
		four(view, 36, "data");
		view.setUint32(40, 2, true);
		bytes[44] = 0;
		bytes[45] = 0;
		expect(() => decodeWavToMono16k(bytes.buffer)).toThrow("Unsupported WAV format tag: 6");
	});
});
