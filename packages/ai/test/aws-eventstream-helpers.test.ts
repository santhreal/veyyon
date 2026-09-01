import { describe, expect, it } from "bun:test";
import { crc32, decodeEventStream, decodeMessage, type EventStreamMessage } from "../src/providers/aws-eventstream";

describe("crc32", () => {
	it("returns 0 for empty array", () => {
		expect(crc32(new Uint8Array([]))).toBe(0);
	});
	it("returns a positive number (unsigned)", () => {
		const result = crc32(new TextEncoder().encode("hello"));
		expect(result).toBeGreaterThanOrEqual(0);
		expect(Number.isInteger(result)).toBe(true);
	});
	it("returns consistent result for same input", () => {
		const data = new TextEncoder().encode("test data");
		expect(crc32(data)).toBe(crc32(data));
	});
	it("returns different results for different inputs", () => {
		expect(crc32(new TextEncoder().encode("a"))).not.toBe(crc32(new TextEncoder().encode("b")));
	});
});

describe("decodeMessage", () => {
	it("throws for frame shorter than minimum", () => {
		expect(() => decodeMessage(new Uint8Array(4))).toThrow();
	});
	it("throws for frame with mismatched total length", () => {
		const frame = new Uint8Array(MIN_MESSAGE_LEN);
		const view = new DataView(frame.buffer);
		view.setUint32(0, 999, false); // wrong total
		expect(() => decodeMessage(frame)).toThrow();
	});
	it("decodes a minimal message with no headers and no payload", () => {
		const total = 16; // prelude(8) + preludeCrc(4) + msgCrc(4)
		const frame = new Uint8Array(total);
		const view = new DataView(frame.buffer);
		view.setUint32(0, total, false); // total length
		view.setUint32(4, 0, false); // headers length
		view.setUint32(8, crc32(frame.subarray(0, 8)), false); // prelude CRC
		view.setUint32(total - 4, crc32(frame.subarray(0, total - 4)), false); // message CRC
		const msg = decodeMessage(frame);
		expect(msg.headers).toEqual({});
		expect(msg.payload.length).toBe(0);
	});
	it("decodes a message with a string header", () => {
		// Build header: nameLen(1) + name(":event-type") + type(1=string=7) + strLen(2) + value("chunk")
		const name = ":event-type";
		const value = "chunk";
		const nameBytes = new TextEncoder().encode(name);
		const valueBytes = new TextEncoder().encode(value);
		const headerBytes = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
		const hView = new DataView(headerBytes.buffer);
		headerBytes[0] = nameBytes.length;
		headerBytes.set(nameBytes, 1);
		headerBytes[1 + nameBytes.length] = 7; // string type
		hView.setUint16(2 + nameBytes.length, valueBytes.length, false);
		headerBytes.set(valueBytes, 4 + nameBytes.length);

		const total = 12 + headerBytes.length + 4;
		const frame = new Uint8Array(total);
		const view = new DataView(frame.buffer);
		view.setUint32(0, total, false);
		view.setUint32(4, headerBytes.length, false);
		frame.set(headerBytes, 12);
		view.setUint32(8, crc32(frame.subarray(0, 8)), false);
		view.setUint32(total - 4, crc32(frame.subarray(0, total - 4)), false);
		const msg = decodeMessage(frame);
		expect(msg.headers[":event-type"]).toBe("chunk");
	});
});

describe("decodeEventStream", () => {
	it("decodes a stream with one empty message", async () => {
		const total = 16;
		const frame = new Uint8Array(total);
		const view = new DataView(frame.buffer);
		view.setUint32(0, total, false);
		view.setUint32(4, 0, false);
		view.setUint32(8, crc32(frame.subarray(0, 8)), false);
		view.setUint32(total - 4, crc32(frame.subarray(0, total - 4)), false);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(frame);
				controller.close();
			},
		});
		const messages: EventStreamMessage[] = [];
		for await (const msg of decodeEventStream(stream)) messages.push(msg);
		expect(messages).toHaveLength(1);
		expect(messages[0]!.headers).toEqual({});
	});
	it("decodes multiple messages from stream", async () => {
		function makeEmptyFrame(): Uint8Array {
			const total = 16;
			const frame = new Uint8Array(total);
			const view = new DataView(frame.buffer);
			view.setUint32(0, total, false);
			view.setUint32(4, 0, false);
			view.setUint32(8, crc32(frame.subarray(0, 8)), false);
			view.setUint32(total - 4, crc32(frame.subarray(0, total - 4)), false);
			return frame;
		}
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(makeEmptyFrame());
				controller.enqueue(makeEmptyFrame());
				controller.close();
			},
		});
		const messages: EventStreamMessage[] = [];
		for await (const msg of decodeEventStream(stream)) messages.push(msg);
		expect(messages).toHaveLength(2);
	});
	it("handles empty stream", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.close();
			},
		});
		const messages: EventStreamMessage[] = [];
		for await (const msg of decodeEventStream(stream)) messages.push(msg);
		expect(messages).toHaveLength(0);
	});
});

const MIN_MESSAGE_LEN = 16;
