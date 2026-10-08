/**
 * A Connect byte stream yields the same frames, with the same flags and payload bytes, however the
 * transport cuts it into reads: one read for the whole stream, one byte per read, empty reads, a
 * header split across reads, a payload spanning many reads, and reads that are `Uint8Array` views
 * at a nonzero offset into a larger buffer rather than `Buffer`s. A payload stays intact after
 * later reads arrive and later frames are taken. A header that declares more than
 * `MAX_CONNECT_FRAME_PAYLOAD` bytes is reported at the header, whole or split, before any payload
 * arrives, and reading it consumes nothing.
 *
 * The class this closes: a reader that mis-reads a header split across reads, drops or repeats
 * the bytes at a read boundary, reads a `Uint8Array` view from the start of its backing buffer,
 * hands out a payload that a later read overwrites, or buffers an oversized frame until memory or
 * an idle timeout ends the stream. Cursor and Devin both read their response bodies through this
 * reader, so the sweep covers both providers' framing.
 *
 * Not covered: gzip handling and end-stream trailer parsing, which belong to each provider; a
 * payload of exactly `MAX_CONNECT_FRAME_PAYLOAD` bytes delivered in full (the boundary is asserted
 * at the header).
 */
import { describe, expect, it } from "bun:test";
import {
	CONNECT_COMPRESSED_FLAG,
	CONNECT_END_STREAM_FLAG,
	ConnectFrameReader,
	type ConnectRead,
	frameConnectMessage,
	MAX_CONNECT_FRAME_PAYLOAD,
} from "@veyyon/ai/utils/connect-frames";

interface Frame {
	flags: number;
	payload: number[];
}

function prng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const FLAG_CHOICES = [0, CONNECT_COMPRESSED_FLAG, CONNECT_END_STREAM_FLAG, 0xff];
/** Payload lengths that put the next header at every alignment, plus empty and multi-read ones. */
const LENGTH_CHOICES = [0, 1, 2, 3, 4, 5, 6, 7, 31, 255, 256, 4099];

function randomFrames(next: () => number): Frame[] {
	const count = 1 + Math.floor(next() * 8);
	const frames: Frame[] = [];
	for (let i = 0; i < count; i++) {
		const length = LENGTH_CHOICES[Math.floor(next() * LENGTH_CHOICES.length)] as number;
		const payload = Array.from({ length }, () => Math.floor(next() * 256));
		frames.push({ flags: FLAG_CHOICES[Math.floor(next() * FLAG_CHOICES.length)] as number, payload });
	}
	return frames;
}

function encode(frames: Frame[]): Buffer {
	return Buffer.concat(frames.map(frame => frameConnectMessage(Uint8Array.from(frame.payload), frame.flags)));
}

/** A read of `bytes`: a `Buffer`, or a `Uint8Array` view at a nonzero offset into a larger buffer. */
function asRead(bytes: Buffer, asView: boolean): Uint8Array {
	if (!asView) return Buffer.from(bytes);
	const backing = new Uint8Array(bytes.length + 7).fill(0xee);
	backing.set(bytes, 3);
	return new Uint8Array(backing.buffer, 3, bytes.length);
}

/** Cuts `stream` into reads, some empty, ending at its last byte. */
function cut(stream: Buffer, next: () => number, maxRead: number): Uint8Array[] {
	const reads: Uint8Array[] = [];
	let at = 0;
	while (at < stream.length) {
		if (next() < 0.1) reads.push(new Uint8Array(0));
		const size = Math.min(stream.length - at, 1 + Math.floor(next() * maxRead));
		reads.push(asRead(stream.subarray(at, at + size), next() < 0.5));
		at += size;
	}
	return reads;
}

/** Pushes each read and takes every frame it completes; payloads are kept as handed out. */
function readAll(reads: Uint8Array[]): { flags: number; payload: Buffer }[] {
	const reader = new ConnectFrameReader();
	const taken: { flags: number; payload: Buffer }[] = [];
	for (const read of reads) {
		reader.push(read);
		for (let frame = reader.next(); frame; frame = reader.next()) {
			if (frame.kind !== "frame") throw new Error(`unexpected ${frame.kind} read`);
			taken.push({ flags: frame.flags, payload: frame.payload });
		}
	}
	expect(reader.next()).toBeUndefined();
	return taken;
}

function plain(taken: { flags: number; payload: Buffer }[]): Frame[] {
	return taken.map(frame => ({ flags: frame.flags, payload: [...frame.payload] }));
}

describe("ConnectFrameReader", () => {
	it("yields the same frames for every cut of the stream", () => {
		for (let seed = 1; seed <= 400; seed++) {
			const next = prng(seed);
			const frames = randomFrames(next);
			const stream = encode(frames);
			for (const maxRead of [1, 3, 6, 64, stream.length]) {
				const taken = readAll(cut(stream, next, maxRead));
				expect({ seed, maxRead, frames: plain(taken) }).toEqual({ seed, maxRead, frames });
			}
		}
	});

	it("yields every frame once a single read completes it, and none before", () => {
		const frames: Frame[] = [
			{ flags: 0, payload: [1, 2, 3] },
			{ flags: CONNECT_END_STREAM_FLAG, payload: [] },
		];
		const stream = encode(frames);
		const reader = new ConnectFrameReader();
		const completedAt: number[] = [];
		for (let i = 0; i < stream.length; i++) {
			reader.push(stream.subarray(i, i + 1));
			for (let frame = reader.next(); frame; frame = reader.next()) completedAt.push(i);
		}
		// The first frame's last byte is index 7 (5-byte header + 3); the second is a bare header.
		expect(completedAt).toEqual([7, 12]);
	});

	it("reports an oversized header whole or split, and consumes nothing reading it", () => {
		const header = Buffer.alloc(5);
		header[0] = CONNECT_COMPRESSED_FLAG;
		header.writeUInt32BE(MAX_CONNECT_FRAME_PAYLOAD + 1, 1);
		for (let split = 0; split <= header.length; split++) {
			const reader = new ConnectFrameReader();
			reader.push(header.subarray(0, split));
			if (split < header.length) expect(reader.next()).toBeUndefined();
			reader.push(header.subarray(split));
			const oversized: ConnectRead = { kind: "oversized", length: MAX_CONNECT_FRAME_PAYLOAD + 1 };
			expect(reader.next()).toEqual(oversized);
			expect(reader.next()).toEqual(oversized);
		}
	});

	it("waits for a header that declares exactly the cap", () => {
		const header = Buffer.alloc(5);
		header.writeUInt32BE(MAX_CONNECT_FRAME_PAYLOAD, 1);
		const reader = new ConnectFrameReader();
		reader.push(header);
		reader.push(Buffer.alloc(1024));
		expect(reader.next()).toBeUndefined();
	});

	it("frames a message as one flag byte, a big-endian length, and the payload", () => {
		const frame = frameConnectMessage(Uint8Array.from([9, 8, 7]), CONNECT_COMPRESSED_FLAG);
		expect([...frame]).toEqual([CONNECT_COMPRESSED_FLAG, 0, 0, 0, 3, 9, 8, 7]);
		expect([...frameConnectMessage(new Uint8Array(0x0102))].slice(0, 5)).toEqual([0, 0, 0, 1, 2]);
	});
});
