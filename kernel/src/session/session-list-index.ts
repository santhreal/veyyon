/**
 * A disk cache for the session picker's per-file scan.
 *
 * Listing a session directory reads a window from the head and tail of every
 * file and parses it. That work is bounded per file and unbounded in the number
 * of files, and it is repeated in full every time the picker opens even though
 * a file that has not been written cannot produce a different row.
 *
 * The head window is the expensive part. It is sized for a prefix that holds
 * the first user message, and when it does not the scan escalates to a wide
 * read — on a real profile the first user message sits about 100 KB in, so the
 * escalation is not the exception the small window assumes, it is nearly every
 * file, and the directory is read by the megabyte to render a list of titles.
 *
 * An entry is reused only when the file's size AND mtime both match what was
 * recorded, so a rewritten session is rescanned. Every other outcome — no index,
 * unreadable index, a version this build does not recognize, a key that is not
 * in it — falls back to scanning, which is the behavior without this file at
 * all.
 */

import * as path from "node:path";
import * as logger from "@veyyon/utils/logger";
import { toError } from "@veyyon/utils/type-guards";
import type { SessionInfo, SessionStatus } from "./session-listing";
import type { SessionStorage } from "./session-storage";

/**
 * Bumped whenever a recorded row's SHAPE or derivation changes.
 *
 * An index written by another build is discarded rather than read, because a
 * row is a cached answer to "what does the scanner say about this file", and a
 * scanner that has changed gives a different answer to the same bytes. Serving a
 * stale row would resurrect the previous build's rendering of a session and no
 * file change would ever correct it.
 */
const SESSION_LIST_INDEX_VERSION = 2;

/** File name of the index, inside the directory whose listing it caches. */
export const SESSION_LIST_INDEX_FILE = ".session-list-index.json";

/** One file's scan result, plus what makes it stale. */
interface IndexRow {
	size: number;
	mtimeMs: number;
	id: string;
	cwd: string;
	title?: string;
	parentSessionPath?: string;
	/**
	 * Epoch ms, or null for a session whose header timestamp is absent or
	 * unparseable. That case yields an Invalid Date, which JSON renders as null
	 * and would otherwise read back as the epoch — dating a broken session to
	 * 1970 and sorting it to the bottom of the picker forever.
	 */
	created: number | null;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
	/**
	 * Whether the tail window was read when this row was scanned. A row scanned
	 * without it has no status to serve, so it cannot answer a listing that wants
	 * one; a row scanned with it answers both.
	 */
	withStatus: boolean;
	status?: SessionStatus;
}

interface IndexFile {
	version: number;
	rows: Record<string, IndexRow>;
}

/**
 * A directory's index, and the accounting for whether it is worth rewriting.
 *
 * `hits` and `rows` are what the caller reports back through {@link save}: an
 * open that reused every row and added none writes nothing, which is the common
 * case once a profile has settled.
 */
export class SessionListIndex {
	#rows: Map<string, IndexRow>;
	#dirty = false;
	readonly #file: string;
	readonly #storage: SessionStorage;

	private constructor(file: string, storage: SessionStorage, rows: Map<string, IndexRow>) {
		this.#file = file;
		this.#storage = storage;
		this.#rows = rows;
	}

	/**
	 * Read the index for `dir`, or an empty one.
	 *
	 * Never throws: an index that cannot be read or parsed is one the caller must
	 * proceed without, and the fallback is a full scan rather than an error the
	 * picker would have to render.
	 */
	static async open(dir: string, storage: SessionStorage): Promise<SessionListIndex> {
		const file = path.join(dir, SESSION_LIST_INDEX_FILE);
		try {
			const text = await storage.readText(file);
			const parsed = JSON.parse(text) as IndexFile;
			if (parsed?.version !== SESSION_LIST_INDEX_VERSION || typeof parsed.rows !== "object" || !parsed.rows) {
				return new SessionListIndex(file, storage, new Map());
			}
			return new SessionListIndex(file, storage, new Map(Object.entries(parsed.rows)));
		} catch {
			return new SessionListIndex(file, storage, new Map());
		}
	}

	/**
	 * The recorded row for `file` when the file on disk still matches it.
	 *
	 * Both size and mtime must agree. Size alone misses an in-place rewrite of
	 * equal length; mtime alone misses a filesystem whose timestamps are coarse
	 * enough for an append within the same tick.
	 */
	get(file: string, size: number, mtimeMs: number, withStatus: boolean): SessionInfo | undefined {
		const row = this.#rows.get(file);
		if (!row || row.size !== size || row.mtimeMs !== mtimeMs) return undefined;
		if (withStatus && !row.withStatus) return undefined;
		return {
			path: file,
			id: row.id,
			cwd: row.cwd,
			title: row.title,
			parentSessionPath: row.parentSessionPath,
			created: new Date(row.created ?? Number.NaN),
			modified: new Date(mtimeMs),
			messageCount: row.messageCount,
			size,
			firstMessage: row.firstMessage,
			allMessagesText: row.allMessagesText,
			status: withStatus ? row.status : undefined,
		};
	}

	/** Record a freshly scanned file. */
	set(info: SessionInfo, mtimeMs: number, withStatus: boolean): void {
		const created = info.created.getTime();
		this.#rows.set(info.path, {
			size: info.size,
			mtimeMs,
			id: info.id,
			cwd: info.cwd,
			title: info.title,
			parentSessionPath: info.parentSessionPath,
			created: Number.isFinite(created) ? created : null,
			messageCount: info.messageCount,
			firstMessage: info.firstMessage,
			allMessagesText: info.allMessagesText,
			withStatus,
			status: info.status,
		});
		this.#dirty = true;
	}

	/**
	 * Drop rows for files the scan did not see, so a deleted session does not keep
	 * its row forever and the index cannot outgrow the directory it describes.
	 */
	retain(files: Iterable<string>): void {
		const live = files instanceof Set ? files : new Set(files);
		for (const key of this.#rows.keys()) {
			if (!live.has(key)) {
				this.#rows.delete(key);
				this.#dirty = true;
			}
		}
	}

	/**
	 * Persist when something changed.
	 *
	 * Never throws, for the same reason {@link open} does not: a directory that
	 * cannot hold the index still lists correctly, one full scan at a time, and a
	 * picker that refused to open because its cache could not be written would be
	 * strictly worse than no cache.
	 */
	async save(): Promise<void> {
		if (!this.#dirty) return;
		const body: IndexFile = { version: SESSION_LIST_INDEX_VERSION, rows: Object.fromEntries(this.#rows) };
		try {
			await this.#storage.writeTextAtomic(this.#file, JSON.stringify(body));
			this.#dirty = false;
		} catch (err) {
			logger.debug("Session list index could not be written", { path: this.#file, error: toError(err).message });
		}
	}
}
