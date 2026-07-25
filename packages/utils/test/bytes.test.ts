/**
 * `asStrictBytes`: the coercion every WebCrypto call site in the tree needs.
 *
 * WHY THIS SUITE EXISTS. `crypto.subtle` reads the WHOLE backing buffer of the
 * array it is handed. A `Uint8Array` that is a view into part of a larger buffer,
 * a decrypted frame's IV taken with `subarray`, say, therefore cannot be passed
 * through: doing so signs, hashes or decrypts the neighbouring bytes as well. The
 * strict DOM typings are what surface this, and the fix is a copy, not a cast.
 *
 * Four packages hit it (collab frame sealing on both the host and the browser
 * side, AWS SigV4 signing, and the auth-broker snapshot cache) and each had a
 * private copy of the coercion. A copy that "tidied" the condition into a bare
 * cast would compile everywhere and quietly sign the wrong bytes, so the two
 * halves are asserted separately here: that a full-buffer view is returned
 * untouched, and that a partial view is copied, with the WebCrypto consequence
 * spelled out as a digest comparison rather than left as a claim.
 */

import { describe, expect, it } from "bun:test";
import { asStrictBytes } from "../src/bytes";

describe("an array that already owns its whole buffer", () => {
	/**
	 * The no-copy case is the common one, and it matters: sealing runs per collab
	 * frame and signing per request, so an unconditional copy would allocate on every
	 * one. Identity is asserted, not just equality.
	 */
	it("is returned as is, with no copy", () => {
		const bytes = new Uint8Array([1, 2, 3]);

		expect(asStrictBytes(bytes)).toBe(bytes as Uint8Array<ArrayBuffer>);
	});

	it("is returned as is even when empty", () => {
		const empty = new Uint8Array(0);

		expect(asStrictBytes(empty)).toBe(empty as Uint8Array<ArrayBuffer>);
	});

	/** A view that happens to span the whole buffer is already strict, offset zero and all. */
	it("is returned as is when a subarray happens to span the entire buffer", () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const spanning = bytes.subarray(0, 3);

		expect(asStrictBytes(spanning)).toBe(spanning as Uint8Array<ArrayBuffer>);
	});
});

describe("a view into part of a larger buffer", () => {
	/** THE case the coercion exists for: a slice of a frame, which must not share the frame's buffer. */
	it("is copied into a buffer of its own", () => {
		const frame = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
		const view = frame.subarray(2, 5);

		const strict = asStrictBytes(view);

		expect(strict).not.toBe(view as Uint8Array<ArrayBuffer>);
		expect(strict.buffer).not.toBe(frame.buffer);
		expect(strict.byteOffset).toBe(0);
		expect(strict.byteLength).toBe(strict.buffer.byteLength);
	});

	it("copies exactly the viewed bytes, not the bytes around them", () => {
		const frame = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);

		expect(Array.from(asStrictBytes(frame.subarray(2, 5)))).toEqual([1, 2, 3]);
	});

	/** The copy is detached: later writes through the frame must not reach it. */
	it("does not track later writes through the original buffer", () => {
		const frame = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
		const strict = asStrictBytes(frame.subarray(2, 5));

		frame[2] = 77;

		expect(strict[0]).toBe(1);
	});

	it("copies a view that starts at zero but stops short of the buffer's end", () => {
		const frame = new Uint8Array([1, 2, 3, 9, 9]);
		const head = frame.subarray(0, 3);

		const strict = asStrictBytes(head);

		expect(strict.buffer).not.toBe(frame.buffer);
		expect(Array.from(strict)).toEqual([1, 2, 3]);
	});

	it("copies an empty view taken from the middle of a buffer", () => {
		const frame = new Uint8Array([1, 2, 3]);

		const strict = asStrictBytes(frame.subarray(1, 1));

		expect(strict.buffer).not.toBe(frame.buffer);
		expect(strict).toHaveLength(0);
	});

	/**
	 * WHY the copy is required rather than cosmetic, stated as an observation instead
	 * of a comment. `crypto.subtle.digest` hashes the whole backing buffer of a
	 * full-buffer view, so handing it the raw partial view would hash all seven bytes
	 * of the frame; through the coercion it hashes the three that were asked for, and
	 * agrees with an independently allocated copy of them.
	 */
	it("makes WebCrypto see only the viewed bytes", async () => {
		const frame = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
		const view = frame.subarray(2, 5);

		const throughCoercion = new Uint8Array(await crypto.subtle.digest("SHA-256", asStrictBytes(view)));
		const standalone = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([1, 2, 3])));
		const wholeFrame = new Uint8Array(await crypto.subtle.digest("SHA-256", asStrictBytes(frame)));

		expect(Array.from(throughCoercion)).toEqual(Array.from(standalone));
		expect(Array.from(throughCoercion)).not.toEqual(Array.from(wholeFrame));
	});
});

describe("an array backed by a SharedArrayBuffer", () => {
	/**
	 * `SharedArrayBuffer` is not an `ArrayBuffer`, and `crypto.subtle` rejects it: a
	 * key or a plaintext that arrived over a worker boundary has to be copied even
	 * when it spans its whole buffer. The `instanceof ArrayBuffer` half of the
	 * condition is what covers this, and it reads like a redundant check next to the
	 * offset arithmetic, which is exactly how it would get deleted.
	 */
	it("is copied even though it spans its whole buffer", () => {
		const shared = new Uint8Array(new SharedArrayBuffer(3));
		shared.set([1, 2, 3]);

		const strict = asStrictBytes(shared);

		expect(strict.buffer).toBeInstanceOf(ArrayBuffer);
		expect(strict.buffer).not.toBe(shared.buffer);
		expect(Array.from(strict)).toEqual([1, 2, 3]);
	});
});
