import {
	type BlobStore,
	externalizeImageDataSync,
	externalizeImageDataUrlSync,
	externalizeTextSync,
	isBlobRef,
	isImageDataUrl,
	isTextBlobRef,
} from "./blob-store";
import type { FileEntry } from "./session-entries";

/** Strings longer than this are externalized to the blob store on persist. */
const MAX_PERSIST_CHARS = 500_000;
/** Minimum base64 length to externalize to blob store (skip tiny inline images) */
const BLOB_EXTERNALIZE_THRESHOLD = 1024;
const TEXT_CONTENT_KEY = "content";

export function isImageBlock(value: unknown): value is { type: "image"; data: string; mimeType?: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		(value as { type?: string }).type === "image" &&
		"data" in value &&
		typeof (value as { data?: string }).data === "string"
	);
}

function isImageMimeType(value: unknown): value is string {
	return typeof value === "string" && value.toLowerCase().startsWith("image/");
}

export function isImageDataPayload(value: unknown): value is { data: string; mimeType?: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"data" in value &&
		typeof (value as { data?: string }).data === "string" &&
		(isImageBlock(value) || ("mimeType" in value && isImageMimeType((value as { mimeType?: unknown }).mimeType)))
	);
}

function shouldExternalizeImagePayload(
	value: unknown,
	key: string | undefined,
): value is { data: string; mimeType?: string } {
	if (!isImageDataPayload(value)) return false;
	if (isBlobRef(value.data) || value.data.length < BLOB_EXTERNALIZE_THRESHOLD) return false;
	return (key === TEXT_CONTENT_KEY && isImageBlock(value)) || key === "images";
}

/** True for a non-empty string — marks signature/encrypted fields whose block must persist verbatim. */
function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/** Recursively truncate/externalize large strings in an object for session persistence. */
function truncateForPersistence(obj: unknown, blobStore: BlobStore, key?: string): unknown {
	if (obj === null || obj === undefined) return obj;
	if (shouldExternalizeImagePayload(obj, key)) {
		return { ...obj, data: externalizeImageDataSync(blobStore, obj.data, obj.mimeType) };
	}
	// Signed blocks must persist verbatim for replay validity.
	if (typeof obj === "object" && "type" in obj) {
		const signed =
			(obj.type === "thinking" && "thinkingSignature" in obj && isNonEmptyString(obj.thinkingSignature)) ||
			(obj.type === "text" && "textSignature" in obj && isNonEmptyString(obj.textSignature)) ||
			(obj.type === "toolCall" && "thoughtSignature" in obj && isNonEmptyString(obj.thoughtSignature));
		const redacted = obj.type === "redactedThinking" && "data" in obj && isNonEmptyString(obj.data);
		// OpenAI Responses reasoning items carry encrypted_content server-validated on replay.
		const encryptedReasoning =
			obj.type === "reasoning" && "encrypted_content" in obj && isNonEmptyString(obj.encrypted_content);
		if (signed || redacted || encryptedReasoning) return obj;
	}

	if (typeof obj === "string") {
		if (key === "image_url" && isImageDataUrl(obj)) {
			return externalizeImageDataUrlSync(blobStore, obj);
		}
		if (obj.length > MAX_PERSIST_CHARS && !isTextBlobRef(obj)) {
			if (key === "thinkingSignature" || key === "thoughtSignature" || key === "textSignature") {
				return obj;
			}
			return externalizeTextSync(blobStore, obj);
		}
		return obj;
	}

	if (Array.isArray(obj)) {
		let changed = false;
		const result: unknown[] = new Array(obj.length);
		for (let i = 0; i < obj.length; i++) {
			const item = obj[i];
			const newItem = truncateForPersistence(item, blobStore, key);
			if (newItem !== item) changed = true;
			result[i] = newItem;
		}
		return changed ? result : obj;
	}

	if (typeof obj === "object") {
		let changed = false;
		const entries: Array<readonly [string, unknown]> = [];
		for (const [childKey, value] of Object.entries(obj)) {
			// Drop transient jsonlEvents field if present.
			if (childKey === "jsonlEvents") {
				changed = true;
				continue;
			}
			const newValue = truncateForPersistence(value, blobStore, childKey);
			if (newValue !== value) changed = true;
			entries.push([childKey, newValue]);
		}
		if (!changed) return obj;

		const contentEntry = entries.find(([childKey]) => childKey === "content");
		const lineCountEntry = entries.find(([childKey]) => childKey === "lineCount");
		if (
			contentEntry &&
			typeof contentEntry[1] === "string" &&
			!isTextBlobRef(contentEntry[1]) &&
			lineCountEntry &&
			typeof lineCountEntry[1] === "number"
		) {
			const content = contentEntry[1];
			const updatedEntries = entries.map(([childKey, value]) => {
				if (childKey !== "lineCount") return [childKey, value] as const;
				let lc = 1;
				for (let i = 0; i < content.length; i++) {
					if (content.charCodeAt(i) === 0x0a) lc++;
				}
				return [childKey, lc] as const;
			});
			return Object.fromEntries(updatedEntries);
		}
		return Object.fromEntries(entries);
	}

	return obj;
}

function readReasoningItem(item: unknown): { encrypted_content?: string; id?: string } | undefined {
	if (item === null || typeof item !== "object") return undefined;
	if (!("type" in item) || item.type !== "reasoning") return undefined;
	const reasoning: { encrypted_content?: string; id?: string } = {};
	if ("encrypted_content" in item && typeof item.encrypted_content === "string" && item.encrypted_content.length > 0) {
		reasoning.encrypted_content = item.encrypted_content;
	}
	if ("id" in item && typeof item.id === "string" && item.id.length > 0) reasoning.id = item.id;
	return reasoning;
}

function signatureCoveredByPayload(
	signature: string,
	encrypted: ReadonlySet<string>,
	ids: ReadonlySet<string>,
): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(signature);
	} catch {
		return false;
	}
	const reasoning = readReasoningItem(parsed);
	if (!reasoning) return false;
	if (reasoning.encrypted_content) return encrypted.has(reasoning.encrypted_content);
	if (reasoning.id) return ids.has(reasoning.id);
	return false;
}

/** Drop duplicate thinkingSignature when already carried in OpenAI Responses providerPayload. */
function stripReplayedReasoningSignatures(entry: FileEntry): FileEntry {
	if (entry.type !== "message" || entry.message.role !== "assistant") return entry;
	const message = entry.message;
	const payload = message.providerPayload;
	if (payload?.type !== "openaiResponsesHistory" || !Array.isArray(payload.items)) return entry;
	const hasSignedThinking = message.content.some(
		block =>
			block.type === "thinking" && typeof block.thinkingSignature === "string" && block.thinkingSignature.length > 0,
	);
	if (!hasSignedThinking) return entry;

	const encrypted = new Set<string>();
	const ids = new Set<string>();
	for (const rawItem of payload.items) {
		const reasoning = readReasoningItem(rawItem);
		if (!reasoning) continue;
		if (reasoning.encrypted_content) encrypted.add(reasoning.encrypted_content);
		if (reasoning.id) ids.add(reasoning.id);
	}
	if (encrypted.size === 0 && ids.size === 0) return entry;

	let changed = false;
	const content = message.content.map(block => {
		if (
			block.type !== "thinking" ||
			typeof block.thinkingSignature !== "string" ||
			block.thinkingSignature.length === 0
		) {
			return block;
		}
		if (!signatureCoveredByPayload(block.thinkingSignature, encrypted, ids)) return block;
		changed = true;
		return { ...block, thinkingSignature: undefined };
	});
	if (!changed) return entry;
	return { ...entry, message: { ...message, content } };
}

export function prepareEntryForPersistence(entry: FileEntry, blobStore: BlobStore): FileEntry {
	return truncateForPersistence(stripReplayedReasoningSignatures(entry), blobStore) as FileEntry;
}
