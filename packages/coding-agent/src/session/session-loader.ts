import type { AgentMessage } from "@veyyon/agent-core";
import { getBlobsDir } from "@veyyon/utils/dirs";
import { isEnoent } from "@veyyon/utils/fs-error";
// Owners, not the `@veyyon/utils` barrel: 4 modules against 74.
import * as logger from "@veyyon/utils/logger";
import { readLines } from "@veyyon/utils/stream";
import {
	BlobStore,
	isBlobRef,
	isTextBlobRef,
	resolveImageData,
	resolveImageDataUrl,
	resolveTextBlobRef,
} from "./blob-store";
import type { OperatorNotices } from "./operator-notices";
import { buildSessionContext } from "./session-context";
import {
	type FileEntry,
	SESSION_TITLE_SLOT_BYTES,
	type SessionEntry,
	type SessionHeader,
	type SessionTitleSlotEntry,
} from "./session-entries";
import { checkSessionEntryShape } from "./session-entry-shape";
import { migrateToCurrentVersion } from "./session-migrations";
import { isImageBlock, isImageDataPayload } from "./session-persistence";
import { FileSessionStorage, type SessionStorage } from "./session-storage";
import {
	parseTitleSlotFromContent,
	parseTitleSlotLine,
	type SessionTitleUpdate,
	titleUpdateFromSlot,
} from "./session-title-slot";

const STREAM_LOAD_THRESHOLD_BYTES = 8 * 1024 * 1024;

export interface SessionLoadOptions {
	source?: string;
	operatorNotices?: OperatorNotices;
}

interface SessionRecordIssue {
	line: number;
	byteOffset: number;
	problem: string;
}

export class CorruptSessionFileError extends Error {
	readonly path: string;

	constructor(filePath: string, problem: string) {
		super(`Cannot load corrupt session ${filePath}: ${problem}`);
		this.name = "CorruptSessionFileError";
		this.path = filePath;
	}
}

function splitTitleSlot(content: string): {
	body: string;
	slot: SessionTitleUpdate | undefined;
	startLine: number;
	startByteOffset: number;
} {
	const slot = titleUpdateFromSlot(parseTitleSlotFromContent(content));
	if (!slot) return { body: content, slot: undefined, startLine: 1, startByteOffset: 1 };
	const newlineIndex = content.indexOf("\n");
	return {
		body: content.slice(newlineIndex + 1),
		slot,
		startLine: 2,
		startByteOffset: Buffer.byteLength(content.slice(0, newlineIndex + 1), "utf-8") + 1,
	};
}

function foldTitleSlot(entries: FileEntry[], slot: SessionTitleUpdate | undefined): FileEntry[] {
	if (!slot || entries.length === 0) return entries;
	const header = entries[0] as SessionHeader;
	if (header.type !== "session" || typeof header.id !== "string") return entries;
	if (slot.title && slot.title.length > 0) {
		header.title = slot.title;
	} else {
		delete header.title;
	}
	if (slot.source) {
		header.titleSource = slot.source;
	} else {
		delete header.titleSource;
	}
	return entries;
}

function emitDroppedRecordNotice(options: SessionLoadOptions, issues: readonly SessionRecordIssue[]): void {
	if (!options.operatorNotices || issues.length === 0) return;
	const shown = issues.slice(0, 5);
	const details = shown.map(issue => `line ${issue.line}, byte ${issue.byteOffset}: ${issue.problem}`).join("; ");
	const remainder = issues.length - shown.length;
	options.operatorNotices.warn(
		"session",
		`Skipped ${issues.length} malformed record${issues.length === 1 ? "" : "s"} while loading ${
			options.source ?? "(unknown session)"
		}: ${details}${remainder > 0 ? `; and ${remainder} more` : ""}.`,
	);
}

/**
 * Parse session JSONL while stripping and folding the optional fixed title slot.
 *
 * A malformed record is skipped so one corrupt line cannot make a whole session
 * unopenable, but the skip is NEVER silent: each dropped record is logged loudly
 * with its offset so a lost entry is visible when studying the session later,
 * rather than vanishing without a trace.
 */
export function parseSessionContent(
	content: string,
	context: SessionLoadOptions = {},
): {
	entries: FileEntry[];
	titleSlot: SessionTitleUpdate | undefined;
} {
	const { body, slot, startLine, startByteOffset } = splitTitleSlot(content);
	const entries: FileEntry[] = [];
	const issues: SessionRecordIssue[] = [];
	let line = startLine;
	let byteOffset = startByteOffset;

	for (const rawLine of body.split("\n")) {
		const lineBytes = Buffer.byteLength(rawLine, "utf-8");
		if (rawLine.trim().length > 0) {
			let value: unknown;
			try {
				value = JSON.parse(rawLine);
			} catch {
				issues.push({ line, byteOffset, problem: "invalid JSON" });
				logger.warn("Skipped a malformed session record on load (data lost)", {
					source: context.source,
					offset: byteOffset,
				});
				line += 1;
				byteOffset += lineBytes + 1;
				continue;
			}

			const shape = checkSessionEntryShape(value);
			if (!shape.ok) {
				issues.push({ line, byteOffset, problem: shape.problem });
				logger.warn("Dropped a session record that decoded to the wrong shape (data lost)", {
					source: context.source,
					offset: byteOffset,
					problem: shape.problem,
				});
			} else {
				entries.push(value as FileEntry);
			}
		}
		line += 1;
		byteOffset += lineBytes + 1;
	}

	if (issues.length > 0) {
		logger.warn("Session load dropped malformed records", { source: context.source, skipped: issues.length });
		emitDroppedRecordNotice(context, issues);
	}
	return { entries: foldTitleSlot(entries, slot), titleSlot: slot };
}

/** Exported for testing — the ≥8MiB streaming path (works on any file size). */
export async function loadEntriesFromFileStream(
	filePath: string,
	options: SessionLoadOptions = {},
): Promise<{
	entries: FileEntry[];
	titleSlot: SessionTitleUpdate | undefined;
}> {
	const entries: FileEntry[] = [];
	const issues: SessionRecordIssue[] = [];
	let titleSlot: SessionTitleUpdate | undefined;
	let line = 1;
	let byteOffset = 1;
	const decoder = new TextDecoder();

	try {
		for await (const lineBytes of readLines(Bun.file(filePath).stream())) {
			const text = decoder.decode(lineBytes);
			if (line === 1) {
				const slot = parseTitleSlotLine(text.trim());
				if (slot) {
					titleSlot = titleUpdateFromSlot(slot);
					line += 1;
					byteOffset += lineBytes.byteLength + 1;
					continue;
				}
			}

			if (text.trim().length > 0) {
				let value: unknown;
				try {
					value = JSON.parse(text);
				} catch {
					issues.push({ line, byteOffset, problem: "invalid JSON" });
					logger.warn("Skipped a malformed session record on streaming load (data lost)", {
						source: filePath,
						offset: byteOffset,
					});
					line += 1;
					byteOffset += lineBytes.byteLength + 1;
					continue;
				}

				const shape = checkSessionEntryShape(value);
				if (!shape.ok) {
					issues.push({ line, byteOffset, problem: shape.problem });
					logger.warn("Dropped a session record that decoded to the wrong shape (data lost)", {
						source: filePath,
						offset: byteOffset,
						problem: shape.problem,
					});
				} else {
					entries.push(value as FileEntry);
				}
			}
			line += 1;
			byteOffset += lineBytes.byteLength + 1;
		}
	} catch (err) {
		if (isEnoent(err)) return { entries: [], titleSlot: undefined };
		throw err;
	}

	if (issues.length > 0) {
		logger.warn("Session streaming load dropped malformed records", { source: filePath, skipped: issues.length });
		emitDroppedRecordNotice({ ...options, source: options.source ?? filePath }, issues);
	}
	return { entries: foldTitleSlot(entries, titleSlot), titleSlot };
}

/** Read only the fixed-size head window to detect a physical title slot. */
export async function readTitleSlotFromFile(
	filePath: string,
	storage: SessionStorage = new FileSessionStorage(),
): Promise<SessionTitleSlotEntry | undefined> {
	let head: string;
	try {
		[head] = await storage.readTextSlices(filePath, SESSION_TITLE_SLOT_BYTES, 0);
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
	const newlineIndex = head.indexOf("\n");
	if (newlineIndex < 0) return undefined;
	return parseTitleSlotLine(head.slice(0, newlineIndex));
}
/** Exported for compaction.test.ts */
export function parseSessionEntries(content: string): FileEntry[] {
	return parseSessionContent(content).entries;
}

/** Exported for testing */
export async function loadEntriesFromFile(
	filePath: string,
	storage: SessionStorage = new FileSessionStorage(),
	options: SessionLoadOptions = {},
): Promise<FileEntry[]> {
	let loaded: { entries: FileEntry[]; titleSlot: SessionTitleUpdate | undefined };
	let size: number;
	try {
		const stat = storage.statSync(filePath);
		size = stat.size;
		loaded =
			storage instanceof FileSessionStorage && stat.size >= STREAM_LOAD_THRESHOLD_BYTES
				? await loadEntriesFromFileStream(filePath, { ...options, source: options.source ?? filePath })
				: parseSessionContent(await storage.readText(filePath), { ...options, source: options.source ?? filePath });
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
	const { entries } = loaded;

	if (size === 0) return [];
	if (entries.length === 0) {
		throw new CorruptSessionFileError(filePath, "the non-empty file has no readable session header");
	}
	const header = entries[0] as SessionHeader;
	if (header.type !== "session" || typeof header.id !== "string") {
		throw new CorruptSessionFileError(filePath, "the first readable record is not a session header");
	}

	return entries;
}

/**
 * Resolve blob references in loaded entries, restoring both session image blocks and persisted
 * provider image URLs back to the inline data expected by downstream transports. Mutates entries in place.
 */
function hasImageUrl(value: unknown): value is { image_url: string } {
	return typeof value === "object" && value !== null && "image_url" in value && typeof value.image_url === "string";
}

function shouldResolveImagePayload(value: unknown, key: string | undefined): value is { data: string } {
	if (!isImageDataPayload(value) || !isBlobRef(value.data)) return false;
	return (key === "content" && isImageBlock(value)) || key === "images";
}

async function resolvePersistedBlobRefs(value: unknown, blobStore: BlobStore, key?: string): Promise<void> {
	if (shouldResolveImagePayload(value, key)) {
		value.data = await resolveImageData(blobStore, value.data);
		return;
	}

	if (Array.isArray(value)) {
		await Promise.all(
			value.map(async (item, index) => {
				// A string child is resolved here, at the parent, because the recursive call
				// receives the string by value and cannot rewrite the slot it lives in.
				if (typeof item === "string") {
					if (isTextBlobRef(item)) value[index] = await resolveTextBlobRef(blobStore, item);
					return;
				}
				await resolvePersistedBlobRefs(item, blobStore, key);
			}),
		);
		return;
	}

	if (typeof value !== "object" || value === null) return;

	if (hasImageUrl(value) && isBlobRef(value.image_url)) {
		value.image_url = await resolveImageDataUrl(blobStore, value.image_url);
	}

	const target = value as Record<string, unknown>;
	await Promise.all(
		Object.entries(target).map(async ([childKey, item]) => {
			// Externalized text (large tool results, text blocks) is a plain `blobtext:`
			// string value at an arbitrary key; restore the full content in place.
			if (typeof item === "string") {
				if (isTextBlobRef(item)) target[childKey] = await resolveTextBlobRef(blobStore, item);
				return;
			}
			await resolvePersistedBlobRefs(item, blobStore, childKey);
		}),
	);
}

export async function resolveBlobRefsInEntries(entries: FileEntry[], blobStore: BlobStore): Promise<void> {
	await Promise.all(
		entries.filter(entry => entry.type !== "session").map(entry => resolvePersistedBlobRefs(entry, blobStore)),
	);
}

/**
 * Read-only message view of a session file: load entries, migrate to the
 * current version, resolve blob refs, and build the context along the
 * persisted leaf path (last entry). Does NOT create a writer or take the
 * session lock — safe to call against a file another session is writing.
 */
export async function loadSessionMessagesReadOnly(filePath: string): Promise<AgentMessage[]> {
	const entries = await loadEntriesFromFile(filePath);
	if (entries.length === 0) return [];
	migrateToCurrentVersion(entries);
	await resolveBlobRefsInEntries(entries, new BlobStore(getBlobsDir()));
	const sessionEntries = entries.filter((e): e is SessionEntry => e.type !== "session");
	return buildSessionContext(sessionEntries).messages;
}
