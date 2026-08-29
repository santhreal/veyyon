export { Ellipsis, truncateToWidth } from "@veyyon/tui";

export const hashBuf = new ArrayBuffer(8);
export const hashView = new DataView(hashBuf);
export const hashBytes1 = new Uint8Array(hashBuf, 0, 1);
export const hashBytes4 = new Uint8Array(hashBuf, 0, 4);
export const hashBytes8 = new Uint8Array(hashBuf, 0, 8);
