/**
 * The plaintext collab envelope: `[4B uint32 BE peerId][sealed payload]`.
 *
 * WHY THIS SUITE EXISTS. The envelope is the only part of a collab frame the relay
 * can read, and it is what routes the frame: peer 0 means broadcast, peer N means
 * that guest. Three implementations touch it (the TUI host, the browser guest, the
 * relay), and the codec was duplicated between
 * `coding-agent/src/collab/protocol.ts` and `collab-web/src/lib/link.ts`, so the
 * host and the guest each had their own copy of the byte order and the header
 * length. That drift fails SILENTLY in the worst way available: the payload still
 * decrypts, because the room key is untouched, so a frame simply arrives at the
 * wrong peer or is broadcast to a room that should not have seen it. Nothing
 * throws and nothing logs.
 *
 * So the wire format is pinned here, on the one owner, byte by byte: the width
 * and endianness of the header, the refusal to read a frame too short to hold
 * one, the fact that the payload is a view rather than a copy, and the offset
 * handling that decides WHERE in a shared read buffer the relay stamps its id.
 */

import { describe, expect, it } from "bun:test";
import { ENVELOPE_HEADER_LENGTH, packEnvelope, rewriteEnvelopePeer, unpackEnvelope } from "../src/index";

const SEALED = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01]);

describe("the envelope header", () => {
	/** Four bytes, and the payload starts immediately after them. */
	it("is four bytes wide", () => {
		expect(ENVELOPE_HEADER_LENGTH).toBe(4);
		expect(packEnvelope(0, SEALED)).toHaveLength(4 + SEALED.byteLength);
	});

	/**
	 * BIG-endian, asserted as bytes rather than through a round trip. A round trip
	 * passes under either byte order as long as both ends agree, which is exactly
	 * what stopped being true while there were two copies: only the literal bytes
	 * distinguish a host that writes BE from a guest that reads LE.
	 */
	it("carries the peer id big-endian", () => {
		const framed = packEnvelope(0x01020304, new Uint8Array());

		expect(Array.from(framed)).toEqual([0x01, 0x02, 0x03, 0x04]);
	});

	it("writes a zero peer id as four zero bytes, which is the broadcast address", () => {
		const framed = packEnvelope(0, SEALED);

		expect(Array.from(framed.subarray(0, 4))).toEqual([0, 0, 0, 0]);
		expect(unpackEnvelope(framed)?.peerId).toBe(0);
	});

	/** Peer ids are unsigned. A high id must not come back negative. */
	it("round-trips the full unsigned 32-bit range", () => {
		for (const peerId of [0, 1, 255, 256, 65_535, 0x7fff_ffff, 0xffff_ffff]) {
			expect(unpackEnvelope(packEnvelope(peerId, SEALED))?.peerId).toBe(peerId);
		}
	});
});

describe("packing a frame", () => {
	it("places the sealed payload after the header, byte for byte", () => {
		const framed = packEnvelope(7, SEALED);

		expect(Array.from(framed.subarray(ENVELOPE_HEADER_LENGTH))).toEqual(Array.from(SEALED));
	});

	/** An empty payload is a legal frame: control-shaped frames carry nothing but a peer id. */
	it("accepts an empty payload", () => {
		const framed = packEnvelope(3, new Uint8Array());

		expect(framed).toHaveLength(ENVELOPE_HEADER_LENGTH);
		expect(unpackEnvelope(framed)).toEqual({ peerId: 3, payload: new Uint8Array() });
	});

	/**
	 * The frame is a fresh buffer of its own, so the caller can hand it straight to
	 * `crypto.subtle` and to `WebSocket.send` without a further copy.
	 */
	it("returns a Uint8Array over its own whole buffer", () => {
		const framed = packEnvelope(1, SEALED);

		expect(framed.byteOffset).toBe(0);
		expect(framed.byteLength).toBe(framed.buffer.byteLength);
	});

	it("copies the payload, so a reused seal buffer cannot mutate a queued frame", () => {
		const sealed = new Uint8Array([1, 2, 3]);
		const framed = packEnvelope(1, sealed);

		sealed[0] = 99;

		expect(framed[ENVELOPE_HEADER_LENGTH]).toBe(1);
	});
});

describe("unpacking a frame", () => {
	it("splits the peer id from the payload", () => {
		expect(unpackEnvelope(packEnvelope(42, SEALED))).toEqual({ peerId: 42, payload: SEALED });
	});

	/**
	 * A frame shorter than the header carries no routable id, and guessing one would
	 * deliver a payload to an arbitrary peer. Null is the answer for every short
	 * length, including the empty frame a closing socket can deliver.
	 */
	it("answers null for every frame too short to hold a header", () => {
		for (let length = 0; length < ENVELOPE_HEADER_LENGTH; length++) {
			expect(unpackEnvelope(new Uint8Array(length))).toBeNull();
		}
	});

	it("accepts a frame that is exactly a header and no payload", () => {
		expect(unpackEnvelope(new Uint8Array(ENVELOPE_HEADER_LENGTH))).toEqual({
			peerId: 0,
			payload: new Uint8Array(),
		});
	});

	/**
	 * The payload is a VIEW over the frame, not a copy: sealed bytes go straight to
	 * `crypto.subtle.decrypt`, and copying each one would double the per-frame
	 * allocation on a transcript stream. Asserted by mutating through the frame and
	 * seeing it in the payload, because a well-meaning `slice()` would read the same
	 * in every other test here.
	 */
	it("returns the payload as a view over the frame rather than a copy", () => {
		const framed = packEnvelope(1, SEALED);
		const unpacked = unpackEnvelope(framed);

		framed[ENVELOPE_HEADER_LENGTH] = 0x55;

		expect(unpacked?.payload[0]).toBe(0x55);
		expect(unpacked?.payload.buffer).toBe(framed.buffer);
	});

	/**
	 * A frame that arrived as a view into a larger read buffer must be read at its
	 * OWN start. Dropping `byteOffset` from the `DataView` here reads four bytes of
	 * whatever preceded the frame, and the id it yields is a valid peer id, so the
	 * frame is delivered to the wrong guest without any error.
	 */
	it("reads the header at the frame's own offset inside a larger buffer", () => {
		const backing = new Uint8Array(16).fill(0xaa);
		backing.set(packEnvelope(9, SEALED), 6);
		const frame = backing.subarray(6, 6 + ENVELOPE_HEADER_LENGTH + SEALED.byteLength);

		const unpacked = unpackEnvelope(frame);

		expect(unpacked?.peerId).toBe(9);
		expect(Array.from(unpacked?.payload ?? [])).toEqual(Array.from(SEALED));
	});
});

describe("rewriting the peer id", () => {
	/** The relay's hot path: stamp the sender's id onto a frame it forwards untouched. */
	it("replaces the id and leaves the sealed payload alone", () => {
		const framed = packEnvelope(0, SEALED);

		rewriteEnvelopePeer(framed, 5);

		expect(unpackEnvelope(framed)).toEqual({ peerId: 5, payload: SEALED });
	});

	it("mutates in place rather than returning a new frame", () => {
		const framed = packEnvelope(0, SEALED);
		const buffer = framed.buffer;

		rewriteEnvelopePeer(framed, 5);

		expect(framed.buffer).toBe(buffer);
	});

	/**
	 * The offset half of the same bug as above, and the more damaging one: stamping
	 * at the buffer's start instead of the frame's start corrupts four bytes of a
	 * NEIGHBOURING frame in the read buffer while leaving this frame's id at 0. The
	 * neighbour then fails to decrypt and this frame broadcasts.
	 */
	it("stamps the id at the frame's own offset inside a larger buffer", () => {
		const backing = new Uint8Array(16).fill(0xaa);
		backing.set(packEnvelope(0, SEALED), 6);
		const frame = backing.subarray(6, 6 + ENVELOPE_HEADER_LENGTH + SEALED.byteLength);

		rewriteEnvelopePeer(frame, 0x0102_0304);

		expect(Array.from(backing.subarray(0, 6))).toEqual([0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa]);
		expect(Array.from(backing.subarray(6, 10))).toEqual([0x01, 0x02, 0x03, 0x04]);
		expect(unpackEnvelope(frame)?.peerId).toBe(0x0102_0304);
	});

	it("writes the same bytes packEnvelope would have written", () => {
		const rewritten = packEnvelope(0, SEALED);
		rewriteEnvelopePeer(rewritten, 0xdead_beef);

		expect(Array.from(rewritten)).toEqual(Array.from(packEnvelope(0xdead_beef, SEALED)));
	});
});
