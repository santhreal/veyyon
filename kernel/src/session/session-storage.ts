import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { reportFault } from "@veyyon/utils/fault-sink";
import { hasFsCode, isEnoent } from "@veyyon/utils/fs-error";
import { type PathState, pathStateSync } from "@veyyon/utils/fs-optional";
// Owners, not the `@veyyon/utils` barrel: 5 modules against 74.
import * as logger from "@veyyon/utils/logger";
import { clampLow } from "@veyyon/utils/math";
import { peekFileEnds } from "@veyyon/utils/peek-file";
import { sessionBackupName, sessionFileStem } from "@veyyon/utils/session-file";
import { Snowflake } from "@veyyon/utils/snowflake";
import { isRecord, toError } from "@veyyon/utils/type-guards";
import { overlayTitleSlotContent, type SessionTitleUpdate, serializeTitleSlot } from "./session-title-slot";

const utf8Decoder = new TextDecoder("utf-8");

export interface SessionStorageStat {
	size: number;
	mtimeMs: number;
	mtime: Date;
	/**
	 * What the path names RIGHT NOW, for a backend where a path can start naming
	 * a different object: `dev:ino` on a real filesystem, where a whole rewrite is
	 * a temp write plus a rename and every open handle on the old inode keeps
	 * writing into a file nothing can reach. Left undefined by backends that
	 * address by path (memory, sql, redis), which cannot have that problem.
	 */
	identity?: string;
}

export interface SessionStorageWriter {
	/**
	 * Append one newline-terminated line. File and memory storage perform the
	 * write synchronously in-body; indexed backends queue in call order.
	 *
	 * `line` MUST include the trailing newline.
	 */
	append(line: string): Promise<void>;
	/** Resolve once all queued appends complete. No fsync. */
	flush(): Promise<void>;
	/** False once close() has begun/finished. */
	isOpen(): boolean;
	close(): Promise<void>;
	getError(): Error | undefined;
}

/**
 * A read handle on the object a session path named when it was opened. Reads keep answering from
 * that object after the path is republished over, renamed or unlinked, so byte offsets recorded
 * against it stay valid for as long as the handle is open. A tail rewrite in place
 * ({@link SessionStorage.rewriteTailAtomic}) changes the object's bytes after the lines it keeps;
 * a line that was among them has to be found again by its id.
 */
export interface PinnedSessionReader {
	/** {@link SessionStorageStat.identity} of the object the handle reads. */
	readonly identity: string;
	/** The UTF-8 text of `length` bytes starting at byte `offset`. Throws on a short read. */
	read(offset: number, length: number): string;
	/**
	 * Visit each newline-terminated line from byte `from` on, in order: the first `headBytes` bytes of
	 * the line decoded as UTF-8, its byte offset, and its length including the newline. A last line
	 * with no newline yet is not visited. Returns the offset just past the last line visited, where a
	 * scan for lines written later resumes. Reads in fixed-size chunks, so a scan of the whole object
	 * holds one chunk and the heads, never the object.
	 */
	scanLines(from: number, headBytes: number, visit: (head: string, offset: number, length: number) => void): number;
	/** Release the handle. Later reads throw. */
	close(): void;
}

/** {@link SessionStorageStat.identity} of a file object, from its `stat` or `fstat`. */
export function fileObjectIdentity(stats: { readonly dev: number; readonly ino: number }): string {
	return `${stats.dev}:${stats.ino}`;
}

/**
 * Optional guard applied by {@link SessionStorage.writeTextAtomic}. The
 * backend MUST call `commitGuard()` synchronously immediately before it makes
 * the staged content visible at `path`. If it returns `false`, the staged
 * write is discarded and the target is left untouched. Backends MUST NOT
 * yield between calling the guard and publishing the write, so a concurrent
 * synchronous rewrite that took over cannot be overwritten by a stale body.
 */
export interface WriteTextAtomicOptions {
	commitGuard?: () => boolean;
}

/**
 * What a whole-file write is handed: either the text, or a factory that produces
 * it in chunks.
 *
 * A session rewrite publishes the entire transcript, and building that as one
 * string costs a copy of the whole file on top of the lines it is made of: a
 * 253MiB transcript rewrote at a peak of 684MiB above baseline and held the loop
 * for 554ms in one stretch. A factory lets a backend write chunk by chunk and
 * keep only the chunk in hand.
 *
 * It is a factory and not an iterable because a write can be attempted more than
 * once — the EPERM fallback re-writes the same body at the target path — and a
 * generator is spent after one pass. Every call MUST produce the same bytes.
 */
export type SessionFileBody = string | (() => Iterable<string>);

/** Iterate a body's chunks, whichever form it took. */
export function sessionBodyChunks(body: SessionFileBody): Iterable<string> {
	return typeof body === "string" ? [body] : body();
}

/** Materialize a body, for a backend that has to hold the whole text anyway. */
export function sessionBodyToString(body: SessionFileBody): string {
	if (typeof body === "string") return body;
	let text = "";
	for (const chunk of body()) text += chunk;
	return text;
}

/**
 * Write a whole file from a body's chunks, without ever holding the joined text.
 *
 * Truncates on open, so a shorter body cannot leave a tail of the previous file
 * behind. The fd is closed on every path, including a throwing chunk.
 */
function writeChunksSync(fpath: string, body: SessionFileBody): void {
	const fd = fs.openSync(fpath, "w");
	try {
		for (const chunk of sessionBodyChunks(body)) {
			if (chunk.length > 0) fs.writeSync(fd, chunk);
		}
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * The async twin of {@link writeChunksSync}, for a file a rename publishes.
 *
 * Each chunk is awaited, so a large rewrite yields to the loop between chunks
 * instead of holding it for the whole file. That is the point of the async path:
 * one 253MiB body used to stall the loop for 554ms in a single stretch. The
 * file is flushed before it closes, see {@link flushStaged}.
 */
async function writeChunks(fpath: string, body: SessionFileBody): Promise<void> {
	const handle = await fs.promises.open(fpath, "w");
	try {
		for (const chunk of sessionBodyChunks(body)) {
			if (chunk.length > 0) await handle.write(chunk);
		}
		await flushStaged(handle);
	} finally {
		await handle.close();
	}
}

/**
 * Write a staged file's data to disk on the thread pool, before the rename that publishes it. ext4
 * writes back a file renamed over another inside `rename(2)` (`auto_da_alloc`), so a sync rename of
 * an unflushed 420MB session held the event loop for 38-92ms; flushed first, it took 0.1ms. The
 * flush also makes the replacement survive a power cut.
 */
async function flushStaged(handle: fs.promises.FileHandle): Promise<void> {
	await handle.datasync();
}

/**
 * Bytes a shifted tail rewrite moves per read. Copying 321MB of a session through a 1MiB buffer
 * took 58-65ms against 53-61ms for an in-kernel copy of the whole file, and an 8MiB buffer
 * 107-496ms.
 */
const COPY_CHUNK_BYTES = 1 << 20;

function keptBytesMissing(size: number, keepBytes: number): Error {
	return new Error(`Session file holds ${size} bytes, fewer than the ${keepBytes} a tail rewrite keeps`);
}

/** Write `text` at byte `position` of `handle`, and return how many bytes that took. */
async function writeTextAt(
	handle: fs.promises.FileHandle,
	tempPath: string,
	text: string,
	position: number,
): Promise<number> {
	if (text.length === 0) return 0;
	const { bytesWritten } = await handle.write(text, position, "utf-8");
	const bytes = Buffer.byteLength(text, "utf-8");
	if (bytesWritten !== bytes) throw new Error(`Short write to ${tempPath}: ${bytesWritten} of ${bytes} bytes`);
	return bytes;
}

/** Copy bytes `from` up to `to` of the file at `source` to byte `at` of `target`. */
async function copyRange(
	source: string,
	target: fs.promises.FileHandle,
	from: number,
	to: number,
	at: number,
): Promise<void> {
	const input = await fs.promises.open(source, "r");
	try {
		const { size } = await input.stat();
		if (size < to) throw keptBytesMissing(size, to);
		const buffer = Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES, to - from));
		for (let position = from; position < to; ) {
			const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, to - position), position);
			if (bytesRead === 0) throw keptBytesMissing(position, to);
			const { bytesWritten } = await target.write(buffer, 0, bytesRead, at + position - from);
			if (bytesWritten !== bytesRead) throw new Error(`Short write: ${bytesWritten} of ${bytesRead} bytes`);
			position += bytesRead;
		}
	} finally {
		await input.close();
	}
}

/**
 * Read `length` bytes at `position` of `fd` into the start of `buffer`, or throw naming `source`. A
 * read past the end of the file comes back short.
 */
function readFullySync(fd: number, buffer: Buffer, length: number, position: number, source: string): void {
	for (let filled = 0; filled < length; ) {
		const read = fs.readSync(fd, buffer, filled, length - filled, position + filled);
		if (read === 0) throw new Error(`Short read from ${source}: ${filled} of ${length} bytes at ${position}`);
		filled += read;
	}
}

/** Write the first `length` bytes of `buffer` at `position` of `fd`, or throw. */
function writeFullySync(fd: number, buffer: Buffer, length: number, position: number): void {
	for (let written = 0; written < length; ) {
		const wrote = fs.writeSync(fd, buffer, written, length - written, position + written);
		if (wrote === 0) throw new Error(`Short write: ${written} of ${length} bytes at ${position}`);
		written += wrote;
	}
}

/** Copy `length` bytes from byte `from` of `source` to byte `to` of `target` through `buffer`. */
function copyBytesSync(
	source: number,
	from: number,
	target: number,
	to: number,
	length: number,
	buffer: Buffer,
	sourceName: string,
): void {
	for (let done = 0; done < length; ) {
		const bytes = Math.min(buffer.length, length - done);
		readFullySync(source, buffer, bytes, from + done, sourceName);
		writeFullySync(target, buffer, bytes, to + done);
		done += bytes;
	}
}

/** Whether `length` bytes from byte `aFrom` of `a` equal those from byte `bFrom` of `b`. */
function bytesEqualSync(a: number, aFrom: number, b: number, bFrom: number, length: number, source: string): boolean {
	const size = Math.min(COPY_CHUNK_BYTES, length);
	const left = Buffer.allocUnsafe(size);
	const right = Buffer.allocUnsafe(size);
	for (let done = 0; done < length; ) {
		const bytes = Math.min(size, length - done);
		readFullySync(a, left, bytes, aFrom + done, source);
		readFullySync(b, right, bytes, bFrom + done, source);
		if (left.compare(right, 0, bytes, 0, bytes) !== 0) return false;
		done += bytes;
	}
	return true;
}

/**
 * Longest old tail {@link FileSessionStorage.rewriteTailAtomic} replaces inside the session file
 * itself. The new tail is copied into the file in one synchronous stretch, so that no read in this
 * process meets a file half rewritten: 8 MiB copies in 1.6 ms (median of 9 runs, 2.9 ms the
 * slowest) on ext4 with a warm page cache. A prune, shake or dedupe writes a tail no longer than the
 * one it replaces. A longer old tail goes to a copy of the file that is renamed over it, which
 * writes every kept byte again.
 */
const IN_PLACE_TAIL_BYTES = 8 << 20;

/** Last bytes of a whole tail journal. A journal that does not end with them was never applied. */
const TAIL_JOURNAL_MAGIC = Buffer.from("VYTAIL01", "latin1");

/** Bytes after a tail journal's record: the record's length, then {@link TAIL_JOURNAL_MAGIC}. */
const TAIL_JOURNAL_FOOTER_BYTES = 4 + TAIL_JOURNAL_MAGIC.length;

/** Format of the record a tail journal ends with. */
const TAIL_JOURNAL_VERSION = 1;

/**
 * A whole tail journal in a format this version does not read. The rewrite it records may have
 * stopped part way through the file, so it is neither applied nor dropped.
 */
class TailJournalFormatError extends Error {}

/**
 * The record at the end of a tail journal. The journal holds `head` bytes that go over the start of
 * the session file, then `tail` bytes that go after its first `keep` bytes, then this record as
 * JSON. `identity` is the object the journal was written for, and `size` its size then.
 */
interface TailJournal {
	identity: string;
	size: number;
	keep: number;
	head: number;
	tail: number;
}

function isByteCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** End the journal with `record` after its first `position` bytes, which makes it whole. */
async function sealTailJournal(
	journal: fs.promises.FileHandle,
	journalPath: string,
	record: TailJournal,
	position: number,
): Promise<void> {
	const json = Buffer.from(JSON.stringify({ v: TAIL_JOURNAL_VERSION, ...record }), "utf-8");
	const sealed = Buffer.allocUnsafe(json.length + TAIL_JOURNAL_FOOTER_BYTES);
	json.copy(sealed);
	sealed.writeUInt32LE(json.length, json.length);
	TAIL_JOURNAL_MAGIC.copy(sealed, json.length + 4);
	const { bytesWritten } = await journal.write(sealed, 0, sealed.length, position);
	if (bytesWritten !== sealed.length) {
		throw new Error(`Short write to ${journalPath}: ${bytesWritten} of ${sealed.length} bytes`);
	}
}

/**
 * The record ending the journal open at `journal`, or undefined when the journal is not whole.
 * Throws {@link TailJournalFormatError} for a whole journal in another format.
 */
function readTailJournalSync(journal: number, journalPath: string): TailJournal | undefined {
	const { size } = fs.fstatSync(journal);
	if (size < TAIL_JOURNAL_FOOTER_BYTES) return undefined;
	const footer = Buffer.allocUnsafe(TAIL_JOURNAL_FOOTER_BYTES);
	readFullySync(journal, footer, footer.length, size - footer.length, journalPath);
	if (!footer.subarray(4).equals(TAIL_JOURNAL_MAGIC)) return undefined;
	const recordBytes = footer.readUInt32LE(0);
	const recordAt = size - footer.length - recordBytes;
	if (recordAt < 0) return undefined;
	const json = Buffer.allocUnsafe(recordBytes);
	readFullySync(journal, json, recordBytes, recordAt, journalPath);
	let record: unknown;
	try {
		record = JSON.parse(json.toString("utf-8"));
	} catch {
		return undefined;
	}
	if (!isRecord(record)) return undefined;
	if (record.v !== TAIL_JOURNAL_VERSION) {
		throw new TailJournalFormatError(
			`it is in journal format ${JSON.stringify(record.v)}, and this version reads format ${TAIL_JOURNAL_VERSION}`,
		);
	}
	const { identity, size: fileSize, keep, head, tail } = record;
	if (typeof identity !== "string") return undefined;
	if (!isByteCount(fileSize) || !isByteCount(keep) || !isByteCount(head) || !isByteCount(tail)) return undefined;
	if (head > keep || head + tail !== recordAt) return undefined;
	return { identity, size: fileSize, keep, head, tail };
}

/**
 * Write the journal's head over the start of `target`, cut `target` to its first `keep` bytes, and
 * write the journal's tail after them. Synchronous, so no read in this process lands between the
 * first write and the last.
 */
function applyTailJournalSync(target: number, journal: number, record: TailJournal, journalPath: string): void {
	const buffer = Buffer.allocUnsafe(clampLow(Math.max(record.head, record.tail), 1, COPY_CHUNK_BYTES));
	copyBytesSync(journal, 0, target, 0, record.head, buffer, journalPath);
	fs.ftruncateSync(target, record.keep);
	copyBytesSync(journal, record.head, target, record.keep, record.tail, buffer, journalPath);
}

/**
 * Bring the file at `fpath` to what the journal describes, when a rewrite from it stopped part way:
 * the file is the object the journal was written for, it does not already hold the journal's head
 * and tail, and nothing grew it after the rewrite began.
 */
function finishTailJournalSync(fpath: string, journal: number, record: TailJournal, journalPath: string): void {
	let target: number;
	try {
		target = fs.openSync(fpath, "r+");
	} catch (err) {
		if (isEnoent(err)) return;
		throw err;
	}
	try {
		const stats = fs.fstatSync(target);
		if (fileObjectIdentity(stats) !== record.identity || stats.size < record.keep) return;
		const end = record.keep + record.tail;
		if (
			stats.size >= end &&
			bytesEqualSync(target, 0, journal, 0, record.head, journalPath) &&
			bytesEqualSync(target, record.keep, journal, record.head, record.tail, journalPath)
		) {
			return;
		}
		// Longer than the file the rewrite began on and than the one it writes: lines appended to a
		// file the rewrite never touched.
		if (stats.size !== record.size && stats.size > end) return;
		applyTailJournalSync(target, journal, record, journalPath);
		fs.fdatasyncSync(target);
	} finally {
		fs.closeSync(target);
	}
}

export interface SessionStorage {
	ensureDirSync(dir: string): void;
	existsSync(path: string): boolean;
	/**
	 * Existence as THREE answers, for a caller that destroys something on `false`.
	 *
	 * {@link existsSync} collapses "not there" and "there but I cannot tell" into one `false`, which is the
	 * right shape for a guard and the wrong shape for a decision to delete. `SessionManager`'s
	 * draft-only cleanup is the caller that needs the difference: a draft in the session's ARTIFACTS
	 * directory means "keep this session", and with a boolean an unreachable artifacts directory answered
	 * "no draft" and the session was deleted along with the draft in it.
	 *
	 * Backed by `pathStateSync` for the filesystem. The in-memory and indexed backends answer from their
	 * own index, where `unreadable` cannot occur: an index either holds a path or does not, and inventing a
	 * third state there would be a lie about a data structure that has no such failure mode. That is why
	 * this is a storage METHOD and not a direct call to `pathStateSync` at the call site, which would ask
	 * the filesystem about a path those backends never wrote.
	 */
	existsStateSync(path: string): PathState;
	writeTextSync(path: string, body: SessionFileBody): void;
	/**
	 * Update the current session title through the storage backend.
	 *
	 * File-like backends rewrite the fixed-width JSONL title slot; indexed
	 * backends can store the semantic title fields and synthesize the slot when
	 * reading.
	 */
	updateSessionTitle(path: string, update: SessionTitleUpdate): Promise<void>;
	statSync(path: string): SessionStorageStat;
	listFilesSync(dir: string, pattern: string): string[];
	/** List matching files at any depth below `dir`. Paths are returned in the backend's namespace. */
	listFilesRecursiveSync(dir: string, pattern: string): string[];

	exists(path: string): Promise<boolean>;
	readText(path: string): Promise<string>;
	/**
	 * Read a whole file without yielding, for a caller that cannot await.
	 *
	 * OPTIONAL, and the reason is the point: a backend that reaches a socket or a
	 * database cannot answer without awaiting, so requiring this would either make
	 * those backends lie or make them block. A caller that finds it absent
	 * degrades. Absent path answers `undefined`; a path the backend holds and
	 * cannot read throws, because that is a fault rather than an answer.
	 */
	readTextSync?(path: string): string | undefined;
	/** Read the requested UTF-8 byte windows from the head and tail of the file. */
	readTextSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]>;
	/**
	 * Open a {@link PinnedSessionReader} on what `path` names now.
	 *
	 * OPTIONAL: only a backend whose whole rewrites publish a new object by rename can keep an old
	 * object readable behind a handle. Its tail rewrites may keep the object and change the bytes
	 * after the lines they keep. Absent, or returning `undefined`, means the caller holds every entry
	 * in memory. A path that is gone throws.
	 */
	openPinnedReaderSync?(path: string): PinnedSessionReader | undefined;
	writeText(path: string, content: string): Promise<void>;
	writeTextAtomic(path: string, body: SessionFileBody, options?: WriteTextAtomicOptions): Promise<void>;
	/**
	 * Make `path` hold `head`, then the file's bytes from `headBytes` up to `keepBytes`, then `tail`:
	 * `head` takes the place of the first `headBytes` bytes. `commitGuard` applies as it does to
	 * {@link writeTextAtomic}. A crash at any point leaves the old file, or a rewrite
	 * {@link recoverInterruptedRewriteSync} finishes.
	 *
	 * OPTIONAL: a session rewrite that changed only its header and its last entries uses this to keep
	 * the bytes of every entry before them instead of serializing the whole transcript again. A
	 * backend without it, or one whose paths name no object that can be copied, publishes the whole
	 * body through {@link writeTextAtomic}. Fails when the file holds fewer than `keepBytes` bytes or
	 * `headBytes` exceeds `keepBytes`.
	 */
	rewriteTailAtomic?(
		path: string,
		headBytes: number,
		keepBytes: number,
		head: string,
		tail: SessionFileBody,
		options?: WriteTextAtomicOptions,
	): Promise<void>;
	/**
	 * Finish or drop a {@link rewriteTailAtomic} of `path` that a crash stopped part way, so that a
	 * load reads a whole file. OPTIONAL: only a backend that rewrites a file in place can leave one
	 * half written.
	 */
	recoverInterruptedRewriteSync?(path: string): void;
	rename(path: string, nextPath: string): Promise<void>;
	/**
	 * Relocate a session transcript and every artifact beneath its sibling
	 * artifact directory as one logical operation. Implementations MUST restore
	 * the source if any part of the relocation fails.
	 */
	moveSessionWithArtifacts(path: string, nextPath: string): Promise<void>;
	unlink(path: string): Promise<void>;
	deleteSessionWithArtifacts(sessionPath: string): Promise<void>;
	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter;
	/**
	 * Wait for every backing write scheduled by this storage to become durably
	 * visible. Sync backends (file, memory) return immediately because their
	 * writes complete in-body; async backends (Redis/SQL via
	 * {@link IndexedSessionStorage}) await their per-path queues so a caller
	 * driving a graceful shutdown does not exit while a fire-and-forget
	 * `writeTextSync` publish is still on the wire.
	 */
	drain(): Promise<void>;
}

// FinalizationRegistry to clean up leaked file descriptors
const writerRegistry = new FinalizationRegistry<number>(fd => {
	try {
		fs.closeSync(fd);
	} catch {
		// Ignore - fd may already be closed or invalid
	}
});

/** Closes the descriptor of a pinned reader that was dropped without {@link PinnedSessionReader.close}. */
const pinnedReaderRegistry = new FinalizationRegistry<number>(fd => {
	try {
		fs.closeSync(fd);
	} catch {
		// Already closed.
	}
});

/** Bytes a {@link FilePinnedSessionReader.scanLines} pass reads at a time. */
const SCAN_CHUNK_BYTES = 1 << 20;

class FilePinnedSessionReader implements PinnedSessionReader {
	readonly identity: string;
	#fd: number | undefined;

	constructor(fd: number, identity: string) {
		this.#fd = fd;
		this.identity = identity;
		pinnedReaderRegistry.register(this, fd, this);
	}

	read(offset: number, length: number): string {
		const fd = this.#fd;
		if (fd === undefined) throw new Error("Pinned session reader is closed");
		const buffer = Buffer.allocUnsafe(length);
		readFullySync(fd, buffer, length, offset, `session object ${this.identity}`);
		return buffer.toString("utf-8");
	}

	scanLines(from: number, headBytes: number, visit: (head: string, offset: number, length: number) => void): number {
		const fd = this.#fd;
		if (fd === undefined) throw new Error("Pinned session reader is closed");
		const chunk = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
		let lineStart = from;
		let position = from;
		for (;;) {
			const read = fs.readSync(fd, chunk, 0, chunk.length, position);
			if (read === 0) return lineStart;
			const view = chunk.subarray(0, read);
			for (let newline = view.indexOf(10); newline !== -1; newline = view.indexOf(10, newline + 1)) {
				const end = position + newline + 1;
				const bytes = Math.min(headBytes, end - lineStart);
				const start = lineStart - position;
				// A line that began in an earlier chunk has its head read on its own.
				const head = start >= 0 ? view.toString("utf-8", start, start + bytes) : this.read(lineStart, bytes);
				visit(head, lineStart, end - lineStart);
				lineStart = end;
			}
			position += read;
		}
	}

	/**
	 * The descriptor is closed on the thread pool. The object a reader is released from is usually
	 * one a republish replaced, and closing its last descriptor frees its blocks: 19-23ms on the
	 * calling thread for a 420MB session on ext4.
	 */
	close(): void {
		const fd = this.#fd;
		if (fd === undefined) return;
		this.#fd = undefined;
		pinnedReaderRegistry.unregister(this);
		fs.close(fd, err => {
			if (err) logger.debug("pinned session reader did not close", { identity: this.identity, error: err.message });
		});
	}
}

export abstract class BaseSessionStorageWriter implements SessionStorageWriter {
	#closed = false;
	#error: Error | undefined;
	readonly #onError: ((err: Error) => void) | undefined;

	constructor(options?: { onError?: (err: Error) => void }) {
		this.#onError = options?.onError;
	}

	get isClosed(): boolean {
		return this.#closed;
	}

	markClosed(): void {
		this.#closed = true;
	}

	recordError(err: unknown): Error {
		const error = toError(err);
		if (!this.#error) this.#error = error;
		this.#onError?.(error);
		return error;
	}

	ensureOpen(): void {
		if (this.#closed) throw new Error("Writer closed");
		if (this.#error) throw this.#error;
	}

	ensureNoError(): void {
		if (this.#error) throw this.#error;
	}
	abstract append(line: string): Promise<void>;

	async flush(): Promise<void> {
		this.ensureNoError();
	}

	isOpen(): boolean {
		return !this.#closed;
	}

	abstract close(): Promise<void>;

	getError(): Error | undefined {
		return this.#error;
	}
}

class FileSessionStorageWriter extends BaseSessionStorageWriter {
	#fd: number;

	constructor(fpath: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }) {
		super(options);
		const flags = options?.flags ?? "a";
		// Ensure parent directory exists
		const dir = path.dirname(fpath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		// Open file once, keep fd for lifetime
		this.#fd = fs.openSync(fpath, flags === "w" ? "w" : "a");
		// Register for cleanup if abandoned without close()
		writerRegistry.register(this, this.#fd, this);
	}

	async append(line: string): Promise<void> {
		this.ensureOpen();
		try {
			const buf = Buffer.from(line, "utf-8");
			let offset = 0;
			while (offset < buf.length) {
				const written = fs.writeSync(this.#fd, buf, offset, buf.length - offset);
				if (written === 0) {
					throw new Error("Short write");
				}
				offset += written;
			}
		} catch (err) {
			throw this.recordError(err);
		}
	}

	async close(): Promise<void> {
		if (this.isClosed) return;
		this.markClosed();
		// Unregister from finalization - we're closing properly
		writerRegistry.unregister(this);
		try {
			fs.closeSync(this.#fd);
		} catch (err) {
			// A failing close is not cosmetic: on a delayed-allocation or network
			// filesystem it is where a write error surfaces, so the session
			// transcript can be short by whatever did not land. This used to be
			// ignored outright, which made a truncated transcript indistinguishable
			// from a complete one (Law 10). It goes through the same path as a write
			// error, so `getError()` reports it and the `onError` callback fires.
			// Still does not throw: close runs on shutdown and teardown paths where
			// throwing would mask the reason the session is ending.
			const error = this.recordError(err);
			logger.warn("Could not close the session file cleanly; the transcript may be missing its last writes", {
				error: error.message,
				fix: "Check that the session directory is writable and not out of space. The session's earlier messages are unaffected.",
			});
		}
	}
}

export class FileSessionStorage implements SessionStorage {
	/**
	 * Paths already reported as unreachable, so a per-turn probe does not log per turn.
	 *
	 * Keyed by path rather than by a single flag: two different session files can be unreachable for two
	 * different reasons, and collapsing them would report the first and hide the second.
	 */
	readonly #reportedUnreachable = new Set<string>();

	ensureDirSync(dir: string): void {
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
	}

	/**
	 * Whether the path is there, and a REPORT when the honest answer is "cannot tell".
	 *
	 * This one method backs eight probes in `SessionManager`: whether the session file is there before a
	 * rewrite, whether a marker exists, whether an old file existed before a move, whether a draft is
	 * already written. `fs.existsSync` answers `false` for a path that exists and cannot be reached
	 * exactly as it does for one that is absent, so a session directory on a mount that has gone away, or
	 * whose permissions changed, made every one of those probes say "not there" and the session behave as
	 * though it had no history. Nothing failed, so nobody looked (Law 10).
	 *
	 * THE RETURN IS STILL `false`, DELIBERATELY, and that is the whole design of this change. Several
	 * callers WRITE on the false branch, and each needs its own decision about whether a wrong answer
	 * there is worse than failing: that is a per-site contract choice (`pathExistsOrThrow` is the shape
	 * for the ones that overwrite) and it is recorded as its own task rather than guessed at here, in
	 * session persistence, in one sweep. What this method can do safely today is stop the answer being
	 * SILENT. Reach is added; no caller's control flow changes.
	 *
	 * EVERY CALLER PASSES A FILE, which is what makes that last sentence true. `pathStateSync` answers
	 * `present` for any file it can stat, including one it could not open, so the boolean is identical to
	 * `existsSync`'s for a file. It is STRICTER for a directory, which `existsSync` calls present even when
	 * it cannot be traversed; that is the better answer, and no call site passes one today (all nine pass a
	 * session file, a marker, a draft or an old path). A future caller handing this a directory gets the
	 * stricter answer on purpose.
	 */
	existsSync(path: string): boolean {
		const state = pathStateSync(path);
		if (state === "unreadable" && !this.#reportedUnreachable.has(path)) {
			this.#reportedUnreachable.add(path);
			reportFault({
				source: "session",
				text: `${path} exists but could not be reached, so this session is being treated as though it were not there. Check the directory's permissions and whether its filesystem is mounted.`,
				context: { path },
			});
		}
		if (state === "present") this.#reportedUnreachable.delete(path);
		return state === "present";
	}

	/** The filesystem's own three answers, reported the same way as {@link existsSync}. */
	existsStateSync(path: string): PathState {
		const state = pathStateSync(path);
		if (state === "unreadable" && !this.#reportedUnreachable.has(path)) {
			this.#reportedUnreachable.add(path);
			reportFault({
				source: "session",
				text: `${path} exists but could not be reached, so what it holds is unknown. Check the directory's permissions and whether its filesystem is mounted.`,
				context: { path },
			});
		}
		if (state === "present") this.#reportedUnreachable.delete(path);
		return state;
	}

	writeTextSync(fpath: string, body: SessionFileBody): void {
		const dir = path.dirname(fpath);
		this.ensureDirSync(dir);
		const tempPath = path.join(dir, `.${path.basename(fpath)}.${Snowflake.next()}.tmp`);
		try {
			writeChunksSync(tempPath, body);
			fs.renameSync(tempPath, fpath);
		} catch (err) {
			try {
				if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
			} catch (cleanupErr) {
				if (!isEnoent(cleanupErr)) {
					logger.warn("Failed to remove session rewrite temp file", {
						sessionFile: fpath,
						tempPath,
						error: toError(cleanupErr).message,
					});
				}
			}
			if (hasFsCode(err, "EPERM")) {
				writeChunksSync(fpath, body);
				return;
			}
			throw toError(err);
		}
	}

	async updateSessionTitle(fpath: string, update: SessionTitleUpdate): Promise<void> {
		const fd = fs.openSync(fpath, "r+");
		try {
			const buf = Buffer.from(serializeTitleSlot(update), "utf-8");
			let offset = 0;
			while (offset < buf.length) {
				const written = fs.writeSync(fd, buf, offset, buf.length - offset, offset);
				if (written === 0) {
					throw new Error("Short write");
				}
				offset += written;
			}
		} catch (err) {
			throw toError(err);
		} finally {
			fs.closeSync(fd);
		}
	}

	statSync(path: string): SessionStorageStat {
		const stats = fs.statSync(path);
		return {
			size: stats.size,
			mtimeMs: stats.mtimeMs,
			mtime: stats.mtime,
			identity: fileObjectIdentity(stats),
		};
	}

	/**
	 * Files in `dir` matching `pattern`, or an empty list.
	 *
	 * A directory that is not there yet is genuinely empty and stays quiet. Anything else is reported:
	 * callers read this as "these are all the session files", so an unreadable directory otherwise
	 * presents as a project with no sessions in it.
	 */
	listFilesSync(dir: string, pattern: string): string[] {
		try {
			return Array.from(new Bun.Glob(pattern).scanSync(dir)).map(name => path.join(dir, name));
		} catch (err) {
			if (isEnoent(err)) return [];
			logger.warn("Session directory could not be listed; its sessions are invisible to this run", {
				dir,
				pattern,
				error: toError(err).message,
			});
			return [];
		}
	}

	listFilesRecursiveSync(dir: string, pattern: string): string[] {
		try {
			return Array.from(new Bun.Glob(`**/${pattern}`).scanSync(dir)).map(name => path.join(dir, name));
		} catch (err) {
			if (isEnoent(err)) return [];
			logger.warn("Session directory tree could not be listed; some sessions are invisible to this run", {
				dir,
				pattern,
				error: toError(err).message,
			});
			return [];
		}
	}

	async exists(path: string): Promise<boolean> {
		try {
			await fs.promises.access(path);
			return true;
		} catch (err) {
			if (isEnoent(err)) return false;
			throw err;
		}
	}

	readText(path: string): Promise<string> {
		return Bun.file(path).text();
	}

	readTextSync(path: string): string | undefined {
		try {
			return fs.readFileSync(path, "utf-8");
		} catch (err) {
			if (isEnoent(err)) return undefined;
			throw toError(err);
		}
	}

	/**
	 * On Windows a rename over a path fails while another handle holds the file open, unless every
	 * holder shares delete access, which this process cannot promise for the handles antivirus and
	 * indexers open. Holding a read handle there would turn each republish into the EPERM fallback,
	 * so the pin is POSIX only.
	 */
	openPinnedReaderSync(path: string): PinnedSessionReader | undefined {
		if (process.platform === "win32") return undefined;
		const fd = fs.openSync(path, "r");
		try {
			const stats = fs.fstatSync(fd);
			return new FilePinnedSessionReader(fd, fileObjectIdentity(stats));
		} catch (err) {
			fs.closeSync(fd);
			throw toError(err);
		}
	}

	async readTextSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		return peekFileEnds(path, prefixBytes, suffixBytes, (head, tail) => [
			utf8Decoder.decode(head),
			utf8Decoder.decode(tail),
		]);
	}

	async writeText(path: string, content: string): Promise<void> {
		await Bun.write(path, content, { createPath: true });
	}

	async writeTextAtomic(fpath: string, body: SessionFileBody, options?: WriteTextAtomicOptions): Promise<void> {
		const dir = path.resolve(fpath, "..");
		const tempPath = stagingPath(fpath);
		await fs.promises.mkdir(dir, { recursive: true });
		try {
			await writeChunks(tempPath, body);
		} catch (err) {
			discardTemp(tempPath, fpath);
			throw toError(err);
		}
		this.#publishStaged(tempPath, fpath, options);
	}

	/**
	 * A head as long as the bytes it replaces leaves every kept byte where it is, so a short enough
	 * tail is rewritten inside the file itself ({@link #rewriteTailInPlace}) and the kept bytes are
	 * neither read nor written. Otherwise the head and tail go over a copy of the file that is renamed
	 * over it: for a head of the same length a reflink where the filesystem supports one (btrfs, XFS,
	 * APFS) and an in-kernel copy elsewhere, and for a head of another length, which moves every kept
	 * byte and which no reflink can express, the kept bytes copied through one reused buffer.
	 */
	async rewriteTailAtomic(
		fpath: string,
		headBytes: number,
		keepBytes: number,
		head: string,
		tail: SessionFileBody,
		options?: WriteTextAtomicOptions,
	): Promise<void> {
		if (headBytes > keepBytes) {
			throw new Error(`A tail rewrite cannot replace ${headBytes} head bytes when it keeps only ${keepBytes}`);
		}
		const headLength = Buffer.byteLength(head, "utf-8");
		const sameLength = headLength === headBytes;
		if (sameLength && (await this.#rewriteTailInPlace(fpath, keepBytes, head, tail, options))) return;
		const tempPath = stagingPath(fpath);
		try {
			if (sameLength) await fs.promises.copyFile(fpath, tempPath, fs.constants.COPYFILE_FICLONE);
			const handle = await fs.promises.open(tempPath, sameLength ? "r+" : "w");
			try {
				if (sameLength) {
					const { size } = await handle.stat();
					if (size < keepBytes) throw keptBytesMissing(size, keepBytes);
					await handle.truncate(keepBytes);
				} else {
					await copyRange(fpath, handle, headBytes, keepBytes, headLength);
				}
				await writeTextAt(handle, tempPath, head, 0);
				let position = keepBytes - headBytes + headLength;
				for (const chunk of sessionBodyChunks(tail)) {
					position += await writeTextAt(handle, tempPath, chunk, position);
				}
				await flushStaged(handle);
			} finally {
				await handle.close();
			}
		} catch (err) {
			discardTemp(tempPath, fpath);
			throw toError(err);
		}
		this.#publishStaged(tempPath, fpath, options);
	}

	/**
	 * Rewrite the tail of `fpath` inside the file. The head and the tail go to a journal beside the
	 * file, which is flushed and then sealed with a record of where they go, and only then copied into
	 * the file and the file flushed. A crash at any point leaves the old file, or a journal that
	 * {@link recoverInterruptedRewriteSync} finishes the rewrite from.
	 *
	 * Returns false, having written nothing, when the old tail is longer than
	 * {@link IN_PLACE_TAIL_BYTES} or than the kept bytes, or a journal for `fpath` is already there:
	 * another rewrite of the file is under way, or one stopped and the file has not been loaded since.
	 */
	async #rewriteTailInPlace(
		fpath: string,
		keepBytes: number,
		head: string,
		tail: SessionFileBody,
		options?: WriteTextAtomicOptions,
	): Promise<boolean> {
		const target = await fs.promises.open(fpath, "r+");
		const journalPath = tailJournalPath(fpath);
		let journal: fs.promises.FileHandle | undefined;
		// Set while the file is being written: a rewrite that stops then leaves the journal behind.
		let keepJournal = false;
		try {
			const stats = await target.stat();
			if (stats.size - keepBytes > Math.min(IN_PLACE_TAIL_BYTES, keepBytes)) return false;
			try {
				journal = await fs.promises.open(journalPath, "wx+");
			} catch (err) {
				if (hasFsCode(err, "EEXIST")) return false;
				throw err;
			}
			const headLength = await writeTextAt(journal, journalPath, head, 0);
			let position = headLength;
			for (const chunk of sessionBodyChunks(tail)) {
				position += await writeTextAt(journal, journalPath, chunk, position);
			}
			// Flushed before the record goes on, so a sealed journal never holds bytes a crash lost.
			await journal.datasync();
			const record: TailJournal = {
				identity: fileObjectIdentity(stats),
				size: stats.size,
				keep: keepBytes,
				head: headLength,
				tail: position - headLength,
			};
			await sealTailJournal(journal, journalPath, record, position);
			await journal.datasync();
			// Guard-check and the first write MUST NOT be separated by an await, as in #publishStaged.
			if (options?.commitGuard && !options.commitGuard()) return true;
			const { size } = fs.fstatSync(target.fd);
			if (size < keepBytes) throw keptBytesMissing(size, keepBytes);
			keepJournal = true;
			applyTailJournalSync(target.fd, journal.fd, record, journalPath);
			await target.datasync();
			keepJournal = false;
			return true;
		} finally {
			await Promise.all([target.close(), journal?.close()]);
			if (journal !== undefined && !keepJournal) discardTemp(journalPath, fpath);
		}
	}

	/**
	 * Finish a {@link rewriteTailAtomic} of `fpath` that stopped part way, from the journal it left
	 * beside the file, then delete the journal. A journal that is not whole, or that was written for
	 * an object `fpath` no longer names, is deleted and the file left as it is: that rewrite never
	 * began writing the file, or a whole rewrite has replaced the file since.
	 */
	recoverInterruptedRewriteSync(fpath: string): void {
		const journalPath = tailJournalPath(fpath);
		let journal: number;
		try {
			journal = fs.openSync(journalPath, "r");
		} catch (err) {
			if (isEnoent(err)) return;
			throw toError(err);
		}
		try {
			const record = readTailJournalSync(journal, journalPath);
			if (record !== undefined) finishTailJournalSync(fpath, journal, record, journalPath);
		} catch (err) {
			const error = toError(err);
			const action =
				err instanceof TailJournalFormatError
					? "Open the session with the version that wrote the journal."
					: "Make both files readable and writable, then open the session again.";
			throw new Error(
				`${fpath} was left part way through a rewrite, and finishing it from ${journalPath} failed: ${error.message}. ${action}`,
				{ cause: error },
			);
		} finally {
			fs.closeSync(journal);
		}
		discardTemp(journalPath, fpath);
	}

	/** Make a fully written temp file the file at `fpath`, or discard it. */
	#publishStaged(tempPath: string, fpath: string, options?: WriteTextAtomicOptions): void {
		// Guard-check + rename MUST NOT be separated by an await. A concurrent
		// synchronous rewrite (flushSync -> #rewriteSynchronously) can otherwise
		// publish a fresh body between the check and the rename, and this stale
		// staged body would overwrite it. Sync rename closes that window.
		if (options?.commitGuard && !options.commitGuard()) {
			discardTemp(tempPath, fpath);
			return;
		}
		try {
			this.renameSync(tempPath, fpath);
			return;
		} catch (err) {
			if (!hasFsCode(err, "EPERM")) {
				discardTemp(tempPath, fpath);
				throw toError(err);
			}
			try {
				this.#replaceSessionFileAfterEpermSync(tempPath, fpath, err, options?.commitGuard);
			} catch (fallbackErr) {
				discardTemp(tempPath, fpath);
				throw fallbackErr;
			}
		}
	}

	/**
	 * Sync rename hook. Split from `rename` so `writeTextAtomic` can perform its
	 * guard-then-publish step without a yield, and so tests can inject
	 * Windows-style EPERM at the sync layer used by the atomic path.
	 */
	renameSync(source: string, target: string): void {
		fs.renameSync(source, target);
	}

	#replaceSessionFileAfterEpermSync(
		tempPath: string,
		targetPath: string,
		renameError: unknown,
		commitGuard?: () => boolean,
	): void {
		const dir = path.resolve(targetPath, "..");
		const backupPath = path.join(dir, sessionBackupName(path.basename(targetPath), Snowflake.next()));
		try {
			this.renameSync(targetPath, backupPath);
		} catch (moveAsideError) {
			if (isEnoent(moveAsideError)) {
				if (commitGuard && !commitGuard()) {
					discardTemp(tempPath, targetPath);
					return;
				}
				this.renameSync(tempPath, targetPath);
				return;
			}
			throw toError(renameError);
		}
		if (commitGuard && !commitGuard()) {
			// A concurrent synchronous rewrite published a fresh body between the
			// move-aside and this point. Restore the moved-aside file so we do
			// not overwrite it with our staged (stale) body, and drop the temp
			// so `writeTextAtomic`'s "discard on abandon" contract holds.
			try {
				this.renameSync(backupPath, targetPath);
			} catch (restoreErr) {
				logger.warn("Failed to restore backup after commitGuard rejection", {
					sessionFile: targetPath,
					backupPath,
					error: toError(restoreErr).message,
				});
			}
			discardTemp(tempPath, targetPath);
			return;
		}
		try {
			this.renameSync(tempPath, targetPath);
		} catch (replaceError) {
			try {
				this.renameSync(backupPath, targetPath);
			} catch (rollbackErr) {
				const rollbackError = toError(rollbackErr);
				throw new Error(
					`Failed to replace session file after EPERM (original: ${toError(renameError).message}; retry: ${
						toError(replaceError).message
					}; rollback: ${rollbackError.message})`,
					{ cause: toError(renameError) },
				);
			}
			throw toError(replaceError);
		}
		try {
			fs.unlinkSync(backupPath);
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to remove session rewrite backup", {
					sessionFile: targetPath,
					backupPath,
					error: toError(err).message,
				});
			}
		}
	}

	async rename(path: string, nextPath: string): Promise<void> {
		try {
			await fs.promises.rename(path, nextPath);
		} catch (err) {
			throw toError(err);
		}
	}

	async moveSessionWithArtifacts(sourcePath: string, targetPath: string): Promise<void> {
		const sourceArtifacts = sessionFileStem(sourcePath);
		const targetArtifacts = sessionFileStem(targetPath);
		const sessionPathChanged = path.resolve(sourcePath) !== path.resolve(targetPath);
		const artifactPathChanged = path.resolve(sourceArtifacts) !== path.resolve(targetArtifacts);
		this.ensureDirSync(path.dirname(targetPath));

		let sessionMoved = false;
		let artifactsMoved = false;
		try {
			if (sessionPathChanged && this.existsStateSync(sourcePath) !== "absent") {
				await this.rename(sourcePath, targetPath);
				sessionMoved = true;
			}
			if (artifactPathChanged && this.existsStateSync(sourceArtifacts) !== "absent") {
				await this.rename(sourceArtifacts, targetArtifacts);
				artifactsMoved = true;
			}
		} catch (error) {
			const rollbackErrors: Error[] = [];
			if (artifactsMoved) {
				try {
					await this.rename(targetArtifacts, sourceArtifacts);
				} catch (rollbackError) {
					rollbackErrors.push(toError(rollbackError));
				}
			}
			if (sessionMoved) {
				try {
					await this.rename(targetPath, sourcePath);
				} catch (rollbackError) {
					rollbackErrors.push(toError(rollbackError));
				}
			}
			if (rollbackErrors.length > 0) {
				throw new AggregateError([toError(error), ...rollbackErrors], "Session relocation and rollback failed");
			}
			throw error;
		}
	}

	unlink(path: string): Promise<void> {
		return fs.promises.unlink(path);
	}

	drain(): Promise<void> {
		// File writes complete synchronously in-body via fs.writeFileSync /
		// fs.renameSync, so there is no queued work to await.
		return Promise.resolve();
	}

	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		return new FileSessionStorageWriter(path, options);
	}

	/**
	 * Delete a session file and its artifacts directory.
	 * Artifacts are stored in a sibling directory with the same name minus .jsonl extension.
	 */
	async deleteSessionWithArtifacts(sessionPath: string): Promise<void> {
		// Delete the session file itself
		await this.unlink(sessionPath);

		// Compute artifacts directory: /path/to/session.jsonl -> /path/to/session
		const artifactsDir = sessionFileStem(sessionPath);

		// Delete artifacts directory if it exists. Missing directories are fine, but
		// surface real cleanup failures because the session file is already gone.
		try {
			await fsp.rm(artifactsDir, { recursive: true, force: true });
		} catch (err) {
			const error = toError(err);
			throw new Error(
				`Session file deleted but failed to remove artifacts directory ${artifactsDir}: ${error.message}`,
				{
					cause: error,
				},
			);
		}
	}
}

/** A temp path beside `fpath`, so the publish is a rename within one directory. */
function stagingPath(fpath: string): string {
	return path.join(path.resolve(fpath, ".."), `.${path.basename(fpath)}.${Snowflake.next()}.tmp`);
}

/**
 * The journal a tail rewrite of `fpath` writes before it writes the file. One per session file, at a
 * fixed name, so a load finds the journal a crash left and a second rewrite finds one under way.
 */
function tailJournalPath(fpath: string): string {
	return path.join(path.dirname(fpath), `.${path.basename(fpath)}.tail`);
}

function discardTemp(tempPath: string, targetPath: string): void {
	try {
		fs.unlinkSync(tempPath);
	} catch (err) {
		if (!isEnoent(err)) {
			logger.warn("Failed to remove session rewrite temp file", {
				sessionFile: targetPath,
				tempPath,
				error: toError(err).message,
			});
		}
	}
}

export function matchStorageGlob(name: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (pattern.startsWith("*.")) return name.endsWith(pattern.slice(1));
	return name === pattern;
}

export function filterStorageMapKeys(
	keys: Iterable<string>,
	dir: string,
	pattern: string,
	recursive: boolean,
): string[] {
	const prefix = dir.endsWith("/") ? dir : `${dir}/`;
	const matches: string[] = [];
	for (const filePath of keys) {
		if (!filePath.startsWith(prefix)) continue;
		if (recursive) {
			const relative = filePath.slice(prefix.length);
			const name = relative.slice(Math.max(relative.lastIndexOf("/"), relative.lastIndexOf("\\")) + 1);
			if (matchStorageGlob(name, pattern)) matches.push(filePath);
		} else {
			const name = filePath.slice(prefix.length);
			if (name.includes("/") || name.includes("\\")) continue;
			if (matchStorageGlob(name, pattern)) matches.push(filePath);
		}
	}
	return matches;
}

class MemorySessionStorageWriter extends BaseSessionStorageWriter {
	#storage: MemorySessionStorage;
	#path: string;

	constructor(
		storage: MemorySessionStorage,
		path: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
	) {
		super(options);
		this.#storage = storage;
		this.#path = path;
		if ((options?.flags ?? "a") === "w") {
			this.#storage.writeTextSync(path, "");
		}
	}

	async append(line: string): Promise<void> {
		this.ensureOpen();
		try {
			// O(1) append — push onto the path's indexed in-memory entry.
			this.#storage.appendSync(this.#path, line);
		} catch (err) {
			throw this.recordError(err);
		}
	}

	async close(): Promise<void> {
		if (this.isClosed) return;
		this.markClosed();
	}
}

interface MemoryFileEntry {
	chunks: string[];
	cumulativeBytes: number[];
	size: number;
	mtimeMs: number;
}

function createMemoryFileEntry(content: string, mtimeMs: number): MemoryFileEntry {
	const size = Buffer.byteLength(content, "utf-8");
	return {
		chunks: size === 0 ? [] : [content],
		cumulativeBytes: size === 0 ? [] : [size],
		size,
		mtimeMs,
	};
}

function appendMemoryChunk(entry: MemoryFileEntry, chunk: string): void {
	const chunkSize = Buffer.byteLength(chunk, "utf-8");
	if (chunkSize === 0) return;
	entry.size += chunkSize;
	entry.chunks.push(chunk);
	entry.cumulativeBytes.push(entry.size);
}

function normalizeByteLimit(maxBytes: number, size: number): number {
	if (!(maxBytes > 0) || size === 0) return 0;
	return Math.min(Math.trunc(maxBytes), size);
}

function lowerBound(values: readonly number[], target: number): number {
	let lo = 0;
	let hi = values.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (values[mid] < target) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}

function upperBound(values: readonly number[], target: number): number {
	let lo = 0;
	let hi = values.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (values[mid] <= target) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}

function joinChunkRange(chunks: readonly string[], start: number, end: number): string {
	const count = end - start;
	if (count <= 0) return "";
	if (count === 1) return chunks[start] ?? "";

	let content = "";
	for (let i = start; i < end; i++) {
		content += chunks[i];
	}
	return content;
}

function decodeChunkByteRange(chunk: string, startByte: number, endByte: number, chunkSize: number): string {
	if (startByte >= endByte) return "";
	if (startByte === 0 && endByte === chunkSize) return chunk;
	if (chunk.length === chunkSize) return chunk.slice(startByte, endByte);
	const bytes = Buffer.from(chunk, "utf-8");
	return utf8Decoder.decode(bytes.subarray(startByte, endByte));
}

function materializeMemoryEntry(entry: MemoryFileEntry): string {
	const { chunks } = entry;
	if (chunks.length === 0) return "";
	if (chunks.length === 1) return chunks[0];

	const content = chunks.join("");
	entry.chunks = [content];
	entry.cumulativeBytes = [entry.size];
	return content;
}

function sliceChunksHead(entry: MemoryFileEntry, maxBytes: number): string {
	const limit = normalizeByteLimit(maxBytes, entry.size);
	if (limit === 0) return "";
	if (limit >= entry.size) return materializeMemoryEntry(entry);

	const boundaryIndex = lowerBound(entry.cumulativeBytes, limit);
	const chunkStart = boundaryIndex === 0 ? 0 : entry.cumulativeBytes[boundaryIndex - 1];
	const chunkEnd = entry.cumulativeBytes[boundaryIndex];
	if (chunkEnd === limit) return joinChunkRange(entry.chunks, 0, boundaryIndex + 1);

	const chunk = entry.chunks[boundaryIndex];
	const chunkPrefix = decodeChunkByteRange(chunk, 0, limit - chunkStart, chunkEnd - chunkStart);
	return joinChunkRange(entry.chunks, 0, boundaryIndex) + chunkPrefix;
}

function sliceChunksTail(entry: MemoryFileEntry, maxBytes: number): string {
	const limit = normalizeByteLimit(maxBytes, entry.size);
	if (limit === 0) return "";
	if (limit >= entry.size) return materializeMemoryEntry(entry);

	const startByte = entry.size - limit;
	const boundaryIndex = upperBound(entry.cumulativeBytes, startByte);
	const chunkStart = boundaryIndex === 0 ? 0 : entry.cumulativeBytes[boundaryIndex - 1];
	const chunkEnd = entry.cumulativeBytes[boundaryIndex];
	const chunkOffset = startByte - chunkStart;
	if (chunkOffset === 0) return joinChunkRange(entry.chunks, boundaryIndex, entry.chunks.length);

	const chunk = entry.chunks[boundaryIndex];
	const chunkSuffix = decodeChunkByteRange(chunk, chunkOffset, chunkEnd - chunkStart, chunkEnd - chunkStart);
	return chunkSuffix + joinChunkRange(entry.chunks, boundaryIndex + 1, entry.chunks.length);
}

export class MemorySessionStorage implements SessionStorage {
	// Each path keeps appended string chunks plus cumulative UTF-8 byte offsets.
	// Full reads materialize the chunks into one string chunk, so repeated reads
	// do not re-join stale history. Later appends still stay O(1) by pushing
	// after that materialized chunk. Prefix/suffix reads binary-search byte
	// offsets and join only the requested window.
	#files = new Map<string, MemoryFileEntry>();

	#requireEntry(path: string): MemoryFileEntry {
		const entry = this.#files.get(path);
		if (!entry) throw new Error(`File not found: ${path}`);
		return entry;
	}

	ensureDirSync(_dir: string): void {
		// No-op for in-memory storage.
	}

	existsSync(path: string): boolean {
		return this.#files.has(path);
	}

	/**
	 * An index has two answers, not three.
	 *
	 * `unreadable` is a filesystem state: a mount that went away, a directory that cannot be traversed. A
	 * `Map` cannot be in that state, so answering anything but `present`/`absent` here would invent a
	 * failure mode this backend does not have and make every caller handle it.
	 */
	existsStateSync(path: string): PathState {
		return this.#files.has(path) ? "present" : "absent";
	}

	writeTextSync(path: string, body: SessionFileBody): void {
		this.#files.set(path, createMemoryFileEntry(sessionBodyToString(body), Date.now()));
	}

	/**
	 * Stamp an existing file's mtime explicitly. A test/simulation affordance:
	 * `writeTextSync` records `Date.now()`, which collapses several rapid writes
	 * to the same millisecond, so callers that need to model distinct
	 * last-activity times (the signal `getRecentSessions` sorts by) cannot rely
	 * on wall-clock write ordering. Setting mtimes explicitly makes that ordering
	 * deterministic instead of timing-dependent.
	 */
	setMtimeSync(path: string, mtimeMs: number): void {
		this.#requireEntry(path).mtimeMs = mtimeMs;
	}

	async updateSessionTitle(path: string, update: SessionTitleUpdate): Promise<void> {
		const entry = this.#requireEntry(path);
		this.#files.set(
			path,
			createMemoryFileEntry(overlayTitleSlotContent(materializeMemoryEntry(entry), update), Date.now()),
		);
	}

	/**
	 * Internal O(1) append used by {@link MemorySessionStorageWriter}. Lazily
	 * creates the entry. External callers should go through `openWriter()`
	 * rather than touching the mirror directly.
	 */
	appendSync(path: string, chunk: string): void {
		const mtimeMs = Date.now();
		let entry = this.#files.get(path);
		if (!entry) {
			entry = createMemoryFileEntry("", mtimeMs);
			this.#files.set(path, entry);
		}
		appendMemoryChunk(entry, chunk);
		entry.mtimeMs = mtimeMs;
	}

	statSync(path: string): SessionStorageStat {
		const entry = this.#requireEntry(path);
		return {
			size: entry.size,
			mtimeMs: entry.mtimeMs,
			mtime: new Date(entry.mtimeMs),
		};
	}

	listFilesSync(dir: string, pattern: string): string[] {
		return filterStorageMapKeys(this.#files.keys(), dir, pattern, false);
	}

	listFilesRecursiveSync(dir: string, pattern: string): string[] {
		return filterStorageMapKeys(this.#files.keys(), dir, pattern, true);
	}

	exists(path: string): Promise<boolean> {
		return Promise.resolve(this.existsSync(path));
	}

	readText(path: string): Promise<string> {
		const entry = this.#files.get(path);
		if (!entry) return Promise.reject(new Error(`File not found: ${path}`));
		return Promise.resolve(materializeMemoryEntry(entry));
	}

	readTextSync(path: string): string | undefined {
		const entry = this.#files.get(path);
		return entry ? materializeMemoryEntry(entry) : undefined;
	}

	readTextSlices(path: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		const entry = this.#files.get(path);
		if (!entry) return Promise.reject(new Error(`File not found: ${path}`));
		return Promise.resolve([sliceChunksHead(entry, prefixBytes), sliceChunksTail(entry, suffixBytes)]);
	}

	writeText(path: string, content: string): Promise<void> {
		this.writeTextSync(path, content);
		return Promise.resolve();
	}

	writeTextAtomic(path: string, body: SessionFileBody, options?: WriteTextAtomicOptions): Promise<void> {
		if (options?.commitGuard && !options.commitGuard()) return Promise.resolve();
		this.writeTextSync(path, body);
		return Promise.resolve();
	}

	rename(path: string, nextPath: string): Promise<void> {
		const entry = this.#files.get(path);
		if (!entry) return Promise.reject(new Error(`File not found: ${path}`));
		this.#files.set(nextPath, entry);
		this.#files.delete(path);
		return Promise.resolve();
	}

	moveSessionWithArtifacts(sourcePath: string, targetPath: string): Promise<void> {
		const sourceArtifacts = sessionFileStem(sourcePath);
		const targetArtifacts = sessionFileStem(targetPath);
		const artifactPrefix = `${sourceArtifacts}/`;
		const moves: Array<[string, string, MemoryFileEntry]> = [];
		for (const [filePath, entry] of this.#files) {
			if (filePath === sourcePath) {
				moves.push([filePath, targetPath, entry]);
			} else if (filePath.startsWith(artifactPrefix)) {
				moves.push([filePath, `${targetArtifacts}/${filePath.slice(artifactPrefix.length)}`, entry]);
			}
		}
		for (const [source] of moves) this.#files.delete(source);
		for (const [, target, entry] of moves) this.#files.set(target, entry);
		return Promise.resolve();
	}

	unlink(path: string): Promise<void> {
		this.#files.delete(path);
		return Promise.resolve();
	}

	deleteSessionWithArtifacts(sessionPath: string): Promise<void> {
		this.#files.delete(sessionPath);
		const artifactsDir = sessionFileStem(sessionPath);
		const prefix = `${artifactsDir}/`;
		for (const key of Array.from(this.#files.keys())) {
			if (key.startsWith(prefix)) this.#files.delete(key);
		}
		return Promise.resolve();
	}

	drain(): Promise<void> {
		return Promise.resolve();
	}

	openWriter(path: string, options?: { flags?: "a" | "w"; onError?: (err: Error) => void }): SessionStorageWriter {
		return new MemorySessionStorageWriter(this, path, options);
	}
}
