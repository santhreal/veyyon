import type { AgentMessage } from "@veyyon/agent-core";
import { getBlobsDir } from "@veyyon/utils/dirs";
import { isEnoent } from "@veyyon/utils/fs-error";
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

/** Re-link entries whose parent is not in the file, and say how many were re-linked. Entries form a tree keyed by `parentId`, and the branch walk climbs from a leaf to */
function stitchOrphanedEntries(entries: readonly FileEntry[]): number {
	if (entries.length < 2) return 0;
	const ids = new Set<string>();
	for (const entry of entries) ids.add(entry.id);
	let stitched = 0;
	for (let i = 1; i < entries.length; i++) {
		const entry = entries[i];
		if (!("parentId" in entry)) continue;
		if (entry.parentId === null || entry.parentId === undefined) continue;
		if (ids.has(entry.parentId)) continue;
		entry.parentId = entries[i - 1].id;
		stitched += 1;
	}
	return stitched;
}

function emitStitchedRecordNotice(options: SessionLoadOptions, stitched: number): void {
	if (!options.operatorNotices || stitched === 0) return;
	options.operatorNotices.warn(
		"session",
		`Re-linked ${stitched} record${stitched === 1 ? "" : "s"} whose place in ${
			options.source ?? "(unknown session)"
		} was lost, so the turns on the far side of the gap are still part of this conversation.`,
	);
}

/** The record loop both load paths feed, so a rule written once reaches both. There are two paths because a session under 8 MiB is read as one string and a larger */
class SessionRecordLoop {
	readonly entries: FileEntry[] = [];
	readonly #issues: SessionRecordIssue[] = [];
	readonly #streaming: boolean;
	readonly #logSource: string | undefined;
	readonly #notices: SessionLoadOptions;
	#line: number;
	#byteOffset: number;

	constructor(options: {
		streaming: boolean;
		logSource: string | undefined;
		notices: SessionLoadOptions;
		startLine?: number;
		startByteOffset?: number;
	}) {
		this.#streaming = options.streaming;
		this.#logSource = options.logSource;
		this.#notices = options.notices;
		this.#line = options.startLine ?? 1;
		this.#byteOffset = options.startByteOffset ?? 1;
	}

	/** Advance past a line the caller consumed itself, such as the physical title slot. */
	skip(byteLength: number): void {
		this.#line += 1;
		this.#byteOffset += byteLength + 1;
	}

	/** Feed one physical line and its byte length. A blank line only moves the cursor. */
	push(text: string, byteLength: number): void {
		if (text.trim().length === 0) {
			this.skip(byteLength);
			return;
		}
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			this.#issues.push({ line: this.#line, byteOffset: this.#byteOffset, problem: "invalid JSON" });
			logger.warn(
				this.#streaming
					? "Skipped a malformed session record on streaming load (data lost)"
					: "Skipped a malformed session record on load (data lost)",
				{ source: this.#logSource, offset: this.#byteOffset },
			);
			this.skip(byteLength);
			return;
		}

		const shape = checkSessionEntryShape(value);
		if (shape.ok) {
			this.entries.push(value as FileEntry);
		} else {
			this.#issues.push({ line: this.#line, byteOffset: this.#byteOffset, problem: shape.problem });
			logger.warn("Dropped a session record that decoded to the wrong shape (data lost)", {
				source: this.#logSource,
				offset: this.#byteOffset,
				problem: shape.problem,
			});
		}
		this.skip(byteLength);
	}

	/** Report what was dropped, re-link what was orphaned, and hand back the entries. */
	finish(): FileEntry[] {
		if (this.#issues.length > 0) {
			logger.warn(
				this.#streaming
					? "Session streaming load dropped malformed records"
					: "Session load dropped malformed records",
				{ source: this.#logSource, skipped: this.#issues.length },
			);
			emitDroppedRecordNotice(this.#notices, this.#issues);
		}
		const stitched = stitchOrphanedEntries(this.entries);
		if (stitched > 0) {
			logger.warn("Re-linked session records whose parent was lost", { source: this.#logSource, stitched });
			emitStitchedRecordNotice(this.#notices, stitched);
		}
		return this.entries;
	}
}

/** Parse session JSONL while stripping and folding the optional fixed title slot. */
export function parseSessionContent(
	content: string,
	context: SessionLoadOptions = {},
): {
	entries: FileEntry[];
	titleSlot: SessionTitleUpdate | undefined;
} {
	const { body, slot, startLine, startByteOffset } = splitTitleSlot(content);
	const loop = new SessionRecordLoop({
		streaming: false,
		logSource: context.source,
		notices: context,
		startLine,
		startByteOffset,
	});
	for (const rawLine of body.split("\n")) loop.push(rawLine, Buffer.byteLength(rawLine, "utf-8"));
	return { entries: foldTitleSlot(loop.finish(), slot), titleSlot: slot };
}

/** Exported for testing — the ≥8MiB streaming path (works on any file size). */
export async function loadEntriesFromFileStream(
	filePath: string,
	options: SessionLoadOptions = {},
): Promise<{
	entries: FileEntry[];
	titleSlot: SessionTitleUpdate | undefined;
}> {
	let titleSlot: SessionTitleUpdate | undefined;
	const loop = new SessionRecordLoop({
		streaming: true,
		logSource: filePath,
		notices: { ...options, source: options.source ?? filePath },
	});
	const decoder = new TextDecoder();
	let first = true;

	try {
		for await (const lineBytes of readLines(Bun.file(filePath).stream())) {
			const text = decoder.decode(lineBytes);
			if (first) {
				first = false;
				// The slot is a fixed-size first line, not a record, so it never reaches the
				// shape check; the cursor still has to step over its bytes.
				const slot = parseTitleSlotLine(text.trim());
				if (slot) {
					titleSlot = titleUpdateFromSlot(slot);
					loop.skip(lineBytes.byteLength);
					continue;
				}
			}
			loop.push(text, lineBytes.byteLength);
		}
	} catch (err) {
		if (isEnoent(err)) return { entries: [], titleSlot: undefined };
		throw err;
	}

	return { entries: foldTitleSlot(loop.finish(), titleSlot), titleSlot };
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

/** Resolve blob references in loaded entries, restoring both session image blocks and persisted provider image URLs back to the inline data expected by downstream transports. Mutates entries in place. */
function hasImageUrl(value: unknown): value is { image_url: string } {
	return typeof value === "object" && value !== null && "image_url" in value && typeof value.image_url === "string";
}

function shouldResolveImagePayload(value: unknown, key: string | undefined): value is { data: string } {
	if (!isImageDataPayload(value) || !isBlobRef(value.data)) return false;
	return (key === "content" && isImageBlock(value)) || key === "images";
}

/** Running count of references the blob store could not answer, threaded through the walk. */
interface LostPayloads {
	count: number;
}

/** One reference the walk found, and the slot it has to be written back into. The traversal is synchronous and the reads are not, so a site names its own */
type BlobSite =
	| { kind: "image-data"; owner: { data: string } }
	| { kind: "image-url"; owner: { image_url: string } }
	| { kind: "text"; owner: Record<string, unknown>; key: string }
	| { kind: "text-item"; owner: unknown[]; index: number };

/** Walk the transcript once and collect the references, without awaiting anything. The walk used to be `async` and mapped every array element and every object key */
function collectBlobSites(value: unknown, sites: BlobSite[], key?: string): void {
	if (shouldResolveImagePayload(value, key)) {
		sites.push({ kind: "image-data", owner: value });
		return;
	}

	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			const item = value[index];
			// A string child is recorded against the parent, because a resolver receives
			// the string by value and cannot rewrite the slot it lives in.
			if (typeof item === "string") {
				if (isTextBlobRef(item)) sites.push({ kind: "text-item", owner: value, index });
				continue;
			}
			collectBlobSites(item, sites, key);
		}
		return;
	}

	if (typeof value !== "object" || value === null) return;

	if (hasImageUrl(value) && isBlobRef(value.image_url)) sites.push({ kind: "image-url", owner: value });

	const target = value as Record<string, unknown>;
	for (const childKey of Object.keys(target)) {
		const item = target[childKey];
		// Externalized text (large tool results, text blocks) is a plain `blobtext:`
		// string value at an arbitrary key; restore the full content in place.
		if (typeof item === "string") {
			if (isTextBlobRef(item)) sites.push({ kind: "text", owner: target, key: childKey });
			continue;
		}
		collectBlobSites(item, sites, childKey);
	}
}

/** How many blob reads may be in flight at once. A session-wide `Promise.all` over every reference issued all of them at once: a */
const BLOB_READ_CONCURRENCY = 8;

async function resolveBlobSite(site: BlobSite, blobStore: BlobStore, lost: LostPayloads): Promise<void> {
	// Each resolver returns the reference unchanged when the blob is gone, and it is
	// only called on a value that IS a reference, so an unchanged value is a loss.
	switch (site.kind) {
		case "image-data": {
			const resolved = await resolveImageData(blobStore, site.owner.data);
			if (resolved === site.owner.data) lost.count += 1;
			site.owner.data = resolved;
			return;
		}
		case "image-url": {
			const resolved = await resolveImageDataUrl(blobStore, site.owner.image_url);
			if (resolved === site.owner.image_url) lost.count += 1;
			site.owner.image_url = resolved;
			return;
		}
		case "text": {
			const reference = site.owner[site.key];
			if (typeof reference !== "string") return;
			const resolved = await resolveTextBlobRef(blobStore, reference);
			if (resolved === reference) lost.count += 1;
			site.owner[site.key] = resolved;
			return;
		}
		case "text-item": {
			const reference = site.owner[site.index];
			if (typeof reference !== "string") return;
			const resolved = await resolveTextBlobRef(blobStore, reference);
			if (resolved === reference) lost.count += 1;
			site.owner[site.index] = resolved;
			return;
		}
	}
}

async function resolveBlobSites(sites: BlobSite[], blobStore: BlobStore, lost: LostPayloads): Promise<void> {
	if (sites.length === 0) return;
	let next = 0;
	const workers = Math.min(BLOB_READ_CONCURRENCY, sites.length);
	await Promise.all(
		Array.from({ length: workers }, async () => {
			for (let index = next++; index < sites.length; index = next++) {
				const site = sites[index];
				if (site) await resolveBlobSite(site, blobStore, lost);
			}
		}),
	);
}

/** Tell the operator that a payload the transcript points at is not in the blob store. The load keeps the reference, which is what makes the loss recoverable: restoring the */
function emitLostPayloadNotice(options: BlobResolutionOptions, lost: number): void {
	if (!options.operatorNotices || lost === 0) return;
	options.operatorNotices.warn(
		"session",
		`${lost} stored payload${lost === 1 ? "" : "s"} of ${
			options.source ?? "this session"
		} ${lost === 1 ? "is" : "are"} missing from the blob store, so ${
			lost === 1 ? "that text or image is" : "those texts or images are"
		} not part of this conversation until the blob store is restored.`,
	);
}

/** Where a load reports a payload the blob store could not answer. */
export interface BlobResolutionOptions {
	source?: string;
	operatorNotices?: OperatorNotices;
}

/** Restore every externalized payload the blob store still holds, and report the ones it does not. Returns the number of references that stayed references. */
export async function resolveBlobRefsInEntries(
	entries: FileEntry[],
	blobStore: BlobStore,
	options?: BlobResolutionOptions,
): Promise<number> {
	const lost: LostPayloads = { count: 0 };
	const sites: BlobSite[] = [];
	for (const entry of entries) {
		if (entry.type !== "session") collectBlobSites(entry, sites);
	}
	await resolveBlobSites(sites, blobStore, lost);
	if (lost.count > 0) {
		logger.warn("Session payloads missing from the blob store", { source: options?.source, lost: lost.count });
		if (options) emitLostPayloadNotice(options, lost.count);
	}
	return lost.count;
}

/** Read-only message view of a session file: load entries, migrate to the current version, resolve blob refs, and build the context along the */
export async function loadSessionMessagesReadOnly(filePath: string): Promise<AgentMessage[]> {
	const entries = await loadEntriesFromFile(filePath);
	if (entries.length === 0) return [];
	migrateToCurrentVersion(entries);
	await resolveBlobRefsInEntries(entries, new BlobStore(getBlobsDir()));
	const sessionEntries = entries.filter((e): e is SessionEntry => e.type !== "session");
	return buildSessionContext(sessionEntries).messages;
}
