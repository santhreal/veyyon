import { openFrame, sealFrame, type WireFrame } from "@veyyon/wire";

export { generateRoomKey, importRoomKey } from "@veyyon/wire";

export function seal(key: CryptoKey, frame: WireFrame): Promise<Uint8Array> {
	return sealFrame(key, frame);
}

export function open(key: CryptoKey, data: Uint8Array): Promise<WireFrame> {
	return openFrame<WireFrame>(key, data);
}
