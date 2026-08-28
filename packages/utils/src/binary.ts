import { peekFile, peekFileSync } from "./peek-file";

const BINARY_SNIFF_BYTES = 8192;

export function isProbablyBinaryHeader(header: Uint8Array): boolean {
	if (header.indexOf(0) !== -1) return true;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(header, { stream: true });
		return false;
	} catch {
		return true;
	}
}

export function isProbablyBinary(filePath: string, maxBytes = BINARY_SNIFF_BYTES): Promise<boolean> {
	return peekFile(filePath, maxBytes, isProbablyBinaryHeader);
}

export function isProbablyBinarySync(filePath: string, maxBytes = BINARY_SNIFF_BYTES): boolean {
	return peekFileSync(filePath, maxBytes, isProbablyBinaryHeader);
}
