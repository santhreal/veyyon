/**
 * AES-256-GCM sealing for collab frames.
 *
 * The layout and the primitives live in `@veyyon/wire` alongside the frame grammar, because the
 * host seals what this client opens: the sealed layout is a wire format, and both sides had a copy
 * of it. This module only binds the frame type, so a caller here gets a `WireFrame` back rather
 * than an unconstrained generic.
 *
 * The room key lives only in the link fragment; the relay sees opaque bytes.
 */
import { openFrame, sealFrame, type WireFrame } from "@veyyon/wire";

export { generateRoomKey, importRoomKey } from "@veyyon/wire";

/** Seal a frame for the relay. Layout: `[12B IV][ciphertext+tag]`. */
export function seal(key: CryptoKey, frame: WireFrame): Promise<Uint8Array> {
	return sealFrame(key, frame);
}

/** Inverse of {@link seal}. Throws on auth failure or malformed input. */
export function open(key: CryptoKey, data: Uint8Array): Promise<WireFrame> {
	return openFrame<WireFrame>(key, data);
}
