/** AES-256-GCM sealing for collab frames. The layout and the primitives live in `@veyyon/wire` alongside the frame grammar, because this */
import { openFrame, sealFrame } from "@veyyon/wire";
import type { CollabFrame } from "./protocol";

export { generateRoomKey, generateWriteToken, importRoomKey } from "@veyyon/wire";

/** Seal a frame for the relay. Layout: `[12B IV][ciphertext+tag]`. */
export function seal(key: CryptoKey, frame: CollabFrame): Promise<Uint8Array> {
	return sealFrame(key, frame);
}

/** Inverse of {@link seal}. Throws on auth failure or malformed input. */
export function open(key: CryptoKey, data: Uint8Array): Promise<CollabFrame> {
	return openFrame<CollabFrame>(key, data);
}
