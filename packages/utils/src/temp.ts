import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as logger from "./logger";
import { sleepSync } from "./sleep";
import { errorMessage } from "./type-guards";

/**
 * Remove a temporary file or directory on a path that must not fail because of the removal.
 *
 * This is the shape that appears wherever code writes to a temp path and then either renames it into place
 * or throws: a failed clone is deleted before the clone error is raised, a rename that failed deletes its
 * temp file before recording the reason, a finished playback deletes its wav in a `finally`. In all of them
 * the operation's own error or result is what the caller needs, and a removal that threw would replace it
 * with something about the cleanup instead.
 *
 * What it must NOT do is stay quiet. These paths live in the system temp directory or a cache directory, and
 * one that cannot be removed stays there for good, accumulating an entry per failed attempt until a disk
 * fills with nothing to explain it. So the removal never throws and always reports, naming path and reason.
 *
 * `force: true` means a path that does not exist is not a failure, which is what every caller wants: cleanup
 * may run after a partial failure where the temp path was never created.
 *
 * @param target Absolute path to remove.
 * @param context Short label for the call site, e.g. `"completion-write-failed"`, so a log line is traceable.
 */
export async function removeTempPath(target: string, context: string): Promise<void> {
	try {
		await fsPromises.rm(target, { recursive: true, force: true });
	} catch (error) {
		logger.warn("temp path could not be removed; it is left behind", {
			path: target,
			context,
			error: errorMessage(error),
		});
	}
}

export class TempDir {
	#path: string;
	private constructor(path: string) {
		this.#path = path;
	}

	static createSync(prefix?: string): TempDir {
		return new TempDir(fs.mkdtempSync(normalizePrefix(prefix)));
	}

	static async create(prefix?: string): Promise<TempDir> {
		return new TempDir(await fsPromises.mkdtemp(normalizePrefix(prefix)));
	}

	#removePromise: Promise<void> | null = null;

	path(): string {
		return this.#path;
	}

	absolute(): string {
		return path.resolve(this.#path);
	}

	remove(): Promise<void> {
		if (this.#removePromise) {
			return this.#removePromise;
		}
		const removePromise = removeWithRetries(this.#path);
		this.#removePromise = removePromise;
		return removePromise;
	}

	removeSync(): void {
		removeSyncWithRetries(this.#path);
		this.#removePromise = Promise.resolve();
	}

	toString(): string {
		return this.#path;
	}

	join(...paths: string[]): string {
		return path.join(this.#path, ...paths);
	}

	// Dispose must not throw: it runs as a scope exits, often while an error is already
	// propagating, and a removal failure would replace that error with one about cleanup.
	// It must not be SILENT either, which is what it used to be. A `using` block whose
	// removal fails leaves a directory in the system temp directory for good, and an
	// empty catch means nothing anywhere says so: the only symptom is a disk filling up
	// with directories nobody can account for. So the failure is reported the same way
	// `removeTempPath` reports its own, naming the path and the reason (Law 10).
	async [Symbol.asyncDispose](): Promise<void> {
		try {
			await this.remove();
		} catch (error) {
			logger.warn("temp directory could not be removed on dispose; it is left behind", {
				path: this.#path,
				error: errorMessage(error),
			});
		}
	}

	[Symbol.dispose](): void {
		try {
			this.removeSync();
		} catch (error) {
			logger.warn("temp directory could not be removed on dispose; it is left behind", {
				path: this.#path,
				error: errorMessage(error),
			});
		}
	}
}

const kTempDir = os.tmpdir();

/**
 * Turn a caller's prefix into the absolute path `mkdtemp` gets.
 *
 * A BARE NAME MEANS THE SYSTEM TEMP DIRECTORY, which is what every caller has always meant and
 * what this function used not to do. `mkdtemp` resolves a relative path against `process.cwd()`,
 * so `TempDir.createSync("secret-runtime-lifecycle-")` created its directory INSIDE THE REPOSITORY,
 * silently, and left it there when a test crashed before cleanup. Forty-six of them had accumulated
 * across the tree, thirty-six from one suite, and sixteen call sites were written this way. The
 * escape hatch was a leading `@`, which is undiscoverable: the safe spelling looked like a typo and
 * the dangerous one looked normal, so the trap was set for whoever wrote the next test.
 *
 * An ABSOLUTE path is still honoured exactly as given, because that is a caller stating where it
 * wants the directory rather than naming one. That is the only way to opt out now, and no caller in
 * this repository uses it, so nothing that was working changes.
 *
 * The leading `@` is still accepted and still means the same thing, since it is written at fifty-odd
 * call sites and they are all correct. It is redundant now rather than load-bearing.
 */
function normalizePrefix(prefix?: string): string {
	if (!prefix) {
		return `${kTempDir}${path.sep}pi-temp-`;
	} else if (prefix.startsWith("@")) {
		return path.join(kTempDir, prefix.slice(1));
	} else if (path.isAbsolute(prefix)) {
		return prefix;
	}
	return path.join(kTempDir, prefix);
}

const kRemoveOptions = { recursive: true, force: true } as const;
const kRemoveRetries = 40;
// 50ms × 40 retries = 2s total retry window. Windows holds file locks on
// SQLite DBs for up to ~1.5s after close(); the previous 25ms (1s total)
// was too short for some test cleanup scenarios.
const kRemoveRetryDelayMs = 50;
const kRetryableRemoveErrorCodes = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

/** Removes a path recursively, retrying transient Windows deletion failures. */
export async function removeWithRetries(target: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await fsPromises.rm(target, kRemoveOptions);
			return;
		} catch (err) {
			if (!shouldRetryRemove(err, attempt)) throw err;
			await Bun.sleep(kRemoveRetryDelayMs);
		}
	}
}

export function removeSyncWithRetries(target: string): void {
	for (let attempt = 0; ; attempt++) {
		try {
			fs.rmSync(target, kRemoveOptions);
			return;
		} catch (err) {
			if (!shouldRetryRemove(err, attempt)) throw err;
			sleepSync(kRemoveRetryDelayMs);
		}
	}
}

function shouldRetryRemove(err: unknown, attempt: number): boolean {
	return attempt < kRemoveRetries && process.platform === "win32" && isRetryableRemoveError(err);
}

function isRetryableRemoveError(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		typeof err.code === "string" &&
		kRetryableRemoveErrorCodes.has(err.code)
	);
}
