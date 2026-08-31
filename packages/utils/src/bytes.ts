/**
 * Byte-array coercions shared by the WebCrypto call sites.
 *
 * `crypto.subtle.{digest,sign,encrypt,decrypt,importKey}` are typed as taking a
 * buffer source backed by a real `ArrayBuffer`, so a `Uint8Array` that is a view
 * into part of a larger buffer, or one backed by a `SharedArrayBuffer`, does not
 * type-check against them. Every place in the tree that seals or signs bytes hit
 * this and each grew its own private coercion.
 */

/**
 * Narrow `bytes` to a `Uint8Array` over its own whole `ArrayBuffer`, copying only
 * when it is not one already.
 *
 * @example
 * // A subarray is a view into a larger buffer, so it is copied.
 * const iv = asStrictBytes(frame.subarray(0, 12));
 * await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, body);
 *
 * The no-copy case is the common one and matters: sealing and opening run per
 * collab frame and per signed request, so an unconditional copy would allocate
 * on every frame. A view that already spans its whole buffer is returned as is,
 * and only a partial view, or one over a `SharedArrayBuffer`, pays for a copy.
 *
 * The copy is required rather than cosmetic. WebCrypto reads the WHOLE backing
 * buffer of a full-buffer view, so handing it a partial view without copying
 * would sign or decrypt neighbouring bytes: an assertion alone would be wrong,
 * not merely untyped.
 */
export function asStrictBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
		return bytes as Uint8Array<ArrayBuffer>;
	}
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}
