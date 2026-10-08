/**
 * The log file every process of a profile appends to.
 *
 * One file per local calendar day, named by {@link logFileName}. Each line is one `write(2)` on a
 * descriptor opened for append, so lines from concurrent processes land whole. At most once per
 * {@link CHECK_INTERVAL_MS} a writer compares its descriptor with the path:
 *
 * - The day changed, or the path names another file (another process moved it): reopen the path.
 * - The file reached the size limit: move it to the next free generation
 *   (`veyyon.YYYY-MM-DD.log.<n>`) and reopen. The live file is always the unnumbered generation, so
 *   a reader of today's path reads the newest lines.
 *
 * On every open the directory is maintained: a generation no writer has touched for
 * {@link SETTLED_MS} is gzipped, and only the newest `keep` log files are kept.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type * as StreamPromises from "node:stream/promises";
import type * as Zlib from "node:zlib";
import { APP_DIRECTORY_SLUG } from "./app-identity";
import { atomicWriteFileWith } from "./atomic-write";
import { isEexist, isEnoent } from "./fs-error";
import { localCalendarDate } from "./local-time";

/**
 * Name of the log file for the local calendar day of `date` (`veyyon.YYYY-MM-DD.log`). The logger,
 * the stderr redirect and the debug report all name the day's file through this function.
 *
 * Defined here rather than in `dirs.ts`: `dirs.ts` reaches this module through `file-lock.ts` and
 * the logger, so an import back into `dirs.ts` is a cycle that leaves its constants uninitialized
 * whenever `dirs.ts` is the first of the two to load.
 */
export function logFileName(date = new Date()): string {
	return `${APP_DIRECTORY_SLUG}.${localCalendarDate(date.getTime())}.log`;
}

/** Size at which the live file is moved to a numbered generation. */
export const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** Log files a directory keeps, the live file included. */
export const LOG_FILE_KEEP = 5;

/** Longest time a writer goes without comparing its descriptor with the path. */
export const CHECK_INTERVAL_MS = 1_000;

/**
 * Age after which no writer appends to a moved generation: every writer checks its descriptor
 * within {@link CHECK_INTERVAL_MS}, so a generation this old is complete and safe to compress.
 */
export const SETTLED_MS = 3 * CHECK_INTERVAL_MS;

const LOG_ENTRY = new RegExp(`^${APP_DIRECTORY_SLUG}\\.\\d{4}-\\d{2}-\\d{2}\\.log(?:\\.(\\d+))?(\\.gz)?$`);

/** Bookkeeping files an earlier log writer (`winston-daily-rotate-file`) left in the directory. */
const STALE_AUDIT = /^\.[0-9a-f]{40}-audit\.json$/;

/**
 * A compression's private output: the staging name {@link atomicWriteFileWith} gives `<file>.gz`
 * (`.<file>.gz.<pid>.<counter>.tmp`), renamed over `<file>.gz` when the copy finishes.
 */
const COMPRESS_TEMPORARY = new RegExp(
	`^\\.${APP_DIRECTORY_SLUG}\\.\\d{4}-\\d{2}-\\d{2}\\.log(?:\\.\\d+)?\\.gz\\.\\d+\\.\\d+\\.tmp$`,
);

/** Age at which a compression temporary belongs to a process that exited mid-copy. */
const ABANDONED_TEMPORARY_MS = 60_000;

/** Attempts to claim a generation number before a rotation is abandoned to the next check. */
const MAX_ROTATE_ATTEMPTS = 8;

/** Generations this process is compressing, so a second open during the copy does not start another. */
const compressing = new Set<string>();

export interface LogFileOptions {
	/** Size at which the live file rotates. Defaults to {@link LOG_FILE_MAX_BYTES}. */
	maxBytes?: number;
	/** Log files kept in the directory. Defaults to {@link LOG_FILE_KEEP}. */
	keep?: number;
	/** Receives every failure to open, rotate or write; the line that failed is dropped. */
	onError: (error: Error) => void;
}

function asError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

/** A log file in the directory, live or rotated, with the facts pruning and compression read. */
interface LogGeneration {
	name: string;
	mtimeMs: number;
	compressed: boolean;
}

/**
 * `fs.statSync(file)`, or undefined when another writer moved or removed it (`ENOENT`); any other
 * failure throws. A `try` rather than `throwIfNoEntry: false`: in Bun 1.4 the option costs about
 * 60 ns on every call, and the file is there on almost every call.
 */
function statUnlessMissing(file: string): fs.Stats | undefined {
	try {
		return fs.statSync(file);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

/**
 * Log files in `dir` other than `live`, unsorted. Deletes on the way the audit files an earlier writer
 * left and the compression temporaries abandoned for {@link ABANDONED_TEMPORARY_MS}. A file another
 * writer removes during the scan is left out.
 */
function scanGenerations(dir: string, live: string, ms: number): LogGeneration[] {
	// One normalization for the whole listing: `path.join` per entry costs about 150 ns, and these
	// paths reach only the filesystem, which reads `./x` and `x` as one file.
	const prefix = path.join(dir, path.sep);
	const files: LogGeneration[] = [];
	for (const name of fs.readdirSync(dir)) {
		if (name === live) continue;
		if (STALE_AUDIT.test(name)) {
			fs.rmSync(prefix + name, { force: true });
			continue;
		}
		const match = LOG_ENTRY.exec(name);
		if (match === null && !COMPRESS_TEMPORARY.test(name)) continue;
		const stat = statUnlessMissing(prefix + name);
		if (stat === undefined) continue;
		if (match !== null) {
			files.push({ name, mtimeMs: stat.mtimeMs, compressed: match[2] !== undefined });
		} else if (ms - stat.mtimeMs >= ABANDONED_TEMPORARY_MS) {
			fs.rmSync(prefix + name, { force: true });
		}
	}
	return files;
}

/** Highest generation number of the log file `base` in `dir`, 0 when it has none. */
function highestGeneration(dir: string, base: string): number {
	const prefix = `${base}.`;
	let generation = 0;
	for (const name of fs.readdirSync(dir)) {
		if (!name.startsWith(prefix)) continue;
		const match = LOG_ENTRY.exec(name);
		if (match?.[1] !== undefined) generation = Math.max(generation, Number(match[1]));
	}
	return generation;
}

/**
 * Completes a rotation once `moved` is a hard link claimed for the live file `target` (inode `ino`).
 * Undoes the claim when `moved` names another inode, because another writer already moved `ino`;
 * otherwise unlinks `target` while it still names `ino`.
 */
function finishRotation(target: string, moved: string, ino: number): void {
	if (fs.statSync(moved).ino !== ino) {
		fs.unlinkSync(moved);
		return;
	}
	try {
		if (fs.statSync(target).ino === ino) fs.unlinkSync(target);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}

export class RotatingLogFile {
	readonly dir: string;
	readonly #maxBytes: number;
	readonly #keep: number;
	readonly #onError: (error: Error) => void;
	#fd = -1;
	#path = "";
	#ino = -1;
	#nextCheck = 0;

	/** Creates `dir`, so a destination that cannot hold a log fails here rather than on a later line. */
	constructor(dir: string, options: LogFileOptions) {
		fs.mkdirSync(dir, { recursive: true });
		this.dir = dir;
		this.#maxBytes = options.maxBytes ?? LOG_FILE_MAX_BYTES;
		this.#keep = Math.max(1, options.keep ?? LOG_FILE_KEEP);
		this.#onError = options.onError;
	}

	/** Appends `line`, which ends in a newline. Never throws; a failure goes to `onError`. */
	write(line: string, now: Date): void {
		const ms = now.getTime();
		if (ms >= this.#nextCheck) this.#check(now, ms);
		if (this.#fd < 0) return;
		try {
			fs.writeSync(this.#fd, line);
		} catch (error) {
			// Reopened on the next check rather than on the next line, so a full disk costs one
			// failed write per interval instead of one per line.
			this.#closeFd();
			this.#onError(asError(error));
		}
	}

	close(): void {
		this.#closeFd();
		this.#path = "";
		this.#nextCheck = 0;
	}

	#closeFd(): void {
		if (this.#fd < 0) return;
		try {
			fs.closeSync(this.#fd);
		} catch {}
		this.#fd = -1;
	}

	#check(now: Date, ms: number): void {
		this.#nextCheck = ms + CHECK_INTERVAL_MS;
		const target = path.join(this.dir, logFileName(now));
		try {
			if (this.#fd >= 0 && target === this.#path) {
				const stat = statUnlessMissing(target);
				if (stat?.ino === this.#ino) {
					if (stat.size < this.#maxBytes) return;
					this.#rotate(target, stat.ino);
				}
			}
			this.#open(target, ms);
		} catch (error) {
			this.#closeFd();
			this.#onError(asError(error));
		}
	}

	#open(target: string, ms: number): void {
		this.#closeFd();
		// Recreated when missing: a live process keeps logging after its directory is cleared.
		fs.mkdirSync(this.dir, { recursive: true });
		const fd = fs.openSync(target, "a");
		this.#fd = fd;
		this.#path = target;
		this.#ino = fs.fstatSync(fd).ino;
		try {
			this.#maintain(ms);
		} catch (error) {
			// A directory that cannot be pruned still takes lines.
			this.#onError(asError(error));
		}
	}

	/**
	 * Moves the full live file (inode `ino`) to the next free generation.
	 *
	 * `link` claims a generation name atomically (`EEXIST` when another writer took it), and the
	 * inode check undoes the claim when another writer already moved `ino` and the path now names a
	 * fresh file. `rename` could not do either: it replaces an existing name.
	 */
	#rotate(target: string, ino: number): void {
		let generation = highestGeneration(this.dir, path.basename(target));
		for (let attempt = 0; attempt < MAX_ROTATE_ATTEMPTS; attempt++) {
			generation += 1;
			const moved = `${target}.${generation}`;
			try {
				fs.linkSync(target, moved);
			} catch (error) {
				if (isEexist(error)) continue;
				if (isEnoent(error)) return;
				throw error;
			}
			finishRotation(target, moved, ino);
			return;
		}
	}

	/** Compresses settled generations and deletes all but the newest {@link LogFileOptions.keep} files. */
	#maintain(ms: number): void {
		const files = scanGenerations(this.dir, path.basename(this.#path), ms);
		files.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
		let kept = 0;
		for (const file of files) {
			// The live file counts toward `keep` whatever its mtime says.
			if (kept + 1 >= this.#keep) {
				fs.rmSync(path.join(this.dir, file.name), { force: true });
				continue;
			}
			kept += 1;
			if (!file.compressed && ms - file.mtimeMs >= SETTLED_MS) this.#compress(path.join(this.dir, file.name));
		}
	}

	/**
	 * Gzips `file` to `file.gz` off the main thread, then deletes `file`. Two writers compressing the
	 * same generation each stage a private temporary and publish the same bytes. The archive and its
	 * directory entry are not flushed to disk: a log generation does not justify an fsync per rotation.
	 *
	 * `node:zlib` is resolved here rather than at module scope: it costs about 5 ms and 0.8 MiB to
	 * load, every process reaches this module through the logger, and most never compress anything.
	 */
	#compress(file: string): void {
		if (compressing.has(file)) return;
		compressing.add(file);
		const zlib = require("node:zlib") as typeof Zlib;
		const { pipeline } = require("node:stream/promises") as typeof StreamPromises;
		atomicWriteFileWith(
			`${file}.gz`,
			temporary => pipeline(fs.createReadStream(file), zlib.createGzip(), fs.createWriteStream(temporary)),
			// The archive keeps the permissions the live file was created with.
			{ fsync: false, mode: 0o666 },
		)
			.then(() => fs.promises.rm(file, { force: true }))
			.catch(error => {
				// A generation another writer compressed or pruned first is not a failure.
				if (!isEnoent(error)) this.#onError(asError(error));
			})
			.finally(() => compressing.delete(file));
	}
}
