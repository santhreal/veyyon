import type { ImageContent } from "@veyyon/ai";
import { BEL, ST } from "@veyyon/tui/ansi";

export const OSC5522_PREFIX = "\x1b]5522;";
export const PASTE_EVENT_NAME_BASE64 = Buffer.from("Paste event", "utf8").toString("base64");

export const IMAGE_MIME_PRIORITY = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const TEXT_MIME_TYPE = "text/plain";
export const MIME_LISTING_TARGET = ".";

export type PasteReadKind = "image" | "text";

export interface Osc5522Packet {
	metadata: Map<string, string>;
	payload: string;
}

export interface PasteListingState {
	phase: "listing";
	mimes: string[];
	kittyDotPayload?: true;
	pw?: string;
	loc?: string;
}

export interface PasteReadState {
	phase: "reading";
	kind: PasteReadKind;
	mimeType: string;
	chunks: string[];
}

export type PasteState = PasteListingState | PasteReadState;

export interface EnhancedPasteHandlers {
	write(data: string): void;
	requestMode(): void;
	pasteText(text: string): void;
	pasteImage(image: ImageContent): void | Promise<void>;
	showStatus(message: string): void;
}

export function isOsc5522Packet(data: string): boolean {
	return data.startsWith(OSC5522_PREFIX) && (data.endsWith(ST) || data.endsWith(BEL));
}

export function decodeBase64Utf8(value: string): string | undefined {
	try {
		return Buffer.from(value, "base64").toString("utf8");
	} catch {
		return undefined;
	}
}

export function parseMetadata(raw: string): Map<string, string> {
	const metadata = new Map<string, string>();
	for (const part of raw.split(":")) {
		const eq = part.indexOf("=");
		if (eq <= 0) continue;
		metadata.set(part.slice(0, eq), part.slice(eq + 1));
	}
	return metadata;
}

export function parseOsc5522Packet(data: string): Osc5522Packet | undefined {
	if (!isOsc5522Packet(data)) return undefined;
	const bodyEnd = data.endsWith(BEL) ? data.length - 1 : data.length - ST.length;
	const body = data.slice(OSC5522_PREFIX.length, bodyEnd);
	const separator = body.indexOf(";");
	const metadataRaw = separator === -1 ? body : body.slice(0, separator);
	const payload = separator === -1 ? "" : body.slice(separator + 1);
	return { metadata: parseMetadata(metadataRaw), payload };
}

export function choosePasteMime(mimes: readonly string[]): { kind: PasteReadKind; mimeType: string } | undefined {
	for (const mimeType of IMAGE_MIME_PRIORITY) {
		if (mimes.includes(mimeType)) return { kind: "image", mimeType };
	}
	return mimes.includes(TEXT_MIME_TYPE) ? { kind: "text", mimeType: TEXT_MIME_TYPE } : undefined;
}
