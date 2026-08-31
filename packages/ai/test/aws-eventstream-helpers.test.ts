import { describe, expect, it } from "bun:test";
import { crc32, decodeMessage } from "../src/providers/aws-eventstream";

describe("crc32", () => {
	it("returns 0 for empty input", () => {
		expect(crc32(new Uint8Array(0))).toBe(0);
	});

	it("returns known value for single byte", () => {
		// CRC32 of byte 0x00
		const result = crc32(new Uint8Array([0]));
		expect(typeof result).toBe("number");
		expect(result).toBeGreaterThan(0);
	});

	it("returns known value for 'hello'", () => {
		const result = crc32(new TextEncoder().encode("hello"));
		expect(result).toBe(0x3610a686);
	});

	it("returns unsigned 32-bit value", () => {
		const result = crc32(new TextEncoder().encode("test data for crc"));
		expect(result).toBeGreaterThanOrEqual(0);
		expect(result).toBeLessThanOrEqual(0xffffffff);
	});

	it("is deterministic for same input", () => {
		const a = crc32(new TextEncoder().encode("deterministic"));
		const b = crc32(new TextEncoder().encode("deterministic"));
		expect(a).toBe(b);
	});

	it("returns different values for different inputs", () => {
		const a = crc32(new TextEncoder().encode("input1"));
		const b = crc32(new TextEncoder().encode("input2"));
		expect(a).not.toBe(b);
	});
});

describe("decodeMessage", () => {
	function encodeHeaderValue(name: string, type: number, value: Uint8Array): Uint8Array {
		const nameBytes = new TextEncoder().encode(name);
		const parts = [new Uint8Array([nameBytes.length]), nameBytes, new Uint8Array([type]), value];
		let total = 0;
		for (const p of parts) total += p.length;
		const out = new Uint8Array(total);
		let off = 0;
		for (const p of parts) {
			out.set(p, off);
			off += p.length;
		}
		return out;
	}

	function buildFrame(headers: Uint8Array, payload: Uint8Array): Uint8Array {
		const headersLen = headers.length;
		const totalLen = 8 + 4 + headersLen + payload.length + 4; // prelude(8) + preludeCRC(4) + headers + payload + msgCRC(4)
		const frame = new Uint8Array(totalLen);
		const view = new DataView(frame.buffer);
		view.setUint32(0, totalLen, false); // total length
		view.setUint32(4, headersLen, false); // headers length
		const preludeCrc = crc32(frame.subarray(0, 8));
		view.setUint32(8, preludeCrc, false); // prelude CRC
		frame.set(headers, 12);
		frame.set(payload, 12 + headersLen);
		const msgCrc = crc32(frame.subarray(0, totalLen - 4));
		view.setUint32(totalLen - 4, msgCrc, false);
		return frame;
	}

	it("decodes a frame with no headers and no payload", () => {
		const frame = buildFrame(new Uint8Array(0), new Uint8Array(0));
		const msg = decodeMessage(frame);
		expect(msg.headers).toEqual({});
		expect(msg.payload.length).toBe(0);
	});

	it("decodes a frame with string header", () => {
		const strBytes = new TextEncoder().encode("hello");
		const headerVal = new Uint8Array(2 + strBytes.length);
		new DataView(headerVal.buffer).setUint16(0, strBytes.length, false);
		headerVal.set(strBytes, 2);
		const headers = encodeHeaderValue(":event-type", 7, headerVal);
		const frame = buildFrame(headers, new Uint8Array(0));
		const msg = decodeMessage(frame);
		expect(msg.headers[":event-type"]).toBe("hello");
	});

	it("decodes a frame with payload", () => {
		const payload = new TextEncoder().encode("payload data");
		const frame = buildFrame(new Uint8Array(0), payload);
		const msg = decodeMessage(frame);
		expect(new TextDecoder().decode(msg.payload)).toBe("payload data");
	});

	it("decodes a frame with bool true header (type 0)", () => {
		const headers = encodeHeaderValue(":bool-true", 0, new Uint8Array(0));
		const frame = buildFrame(headers, new Uint8Array(0));
		const msg = decodeMessage(frame);
		expect(msg.headers[":bool-true"]).toBe("true");
	});

	it("decodes a frame with bool false header (type 1)", () => {
		const headers = encodeHeaderValue(":bool-false", 1, new Uint8Array(0));
		const frame = buildFrame(headers, new Uint8Array(0));
		const msg = decodeMessage(frame);
		expect(msg.headers[":bool-false"]).toBe("false");
	});

	it("decodes a frame with byte header (type 2)", () => {
		const headers = encodeHeaderValue(":byte-val", 2, new Uint8Array([42]));
		const frame = buildFrame(headers, new Uint8Array(0));
		const msg = decodeMessage(frame);
		expect(msg.headers[":byte-val"]).toBe("42");
	});

	it("decodes a frame with short header (type 3)", () => {
		const val = new Uint8Array(2);
		new DataView(val.buffer).setInt16(0, 1234, false);
		const headers = encodeHeaderValue(":short-val", 3, val);
		const frame = buildFrame(headers, new Uint8Array(0));
		const msg = decodeMessage(frame);
		expect(msg.headers[":short-val"]).toBe("1234");
	});

	it("decodes a frame with integer header (type 4)", () => {
		const val = new Uint8Array(4);
		new DataView(val.buffer).setInt32(0, 100000, false);
		const headers = encodeHeaderValue(":int-val", 4, val);
		const frame = buildFrame(headers, new Uint8Array(0));
		const msg = decodeMessage(frame);
		expect(msg.headers[":int-val"]).toBe("100000");
	});

	it("throws on frame too short", () => {
		expect(() => decodeMessage(new Uint8Array(4))).toThrow();
	});

	it("throws on total length mismatch", () => {
		const frame = new Uint8Array(20);
		const view = new DataView(frame.buffer);
		view.setUint32(0, 100, false); // wrong total length
		expect(() => decodeMessage(frame)).toThrow();
	});

	it("throws on prelude CRC mismatch", () => {
		const frame = buildFrame(new Uint8Array(0), new Uint8Array(0));
		const view = new DataView(frame.buffer);
		view.setUint32(8, 0, false); // corrupt prelude CRC
		expect(() => decodeMessage(frame)).toThrow();
	});

	it("throws on message CRC mismatch", () => {
		const frame = buildFrame(new Uint8Array(0), new Uint8Array(0));
		const view = new DataView(frame.buffer);
		view.setUint32(frame.length - 4, 0, false); // corrupt message CRC
		expect(() => decodeMessage(frame)).toThrow();
	});
});
