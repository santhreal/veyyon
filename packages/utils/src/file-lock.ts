import { randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import { isEnoent } from "./fs-error";
import { tryParseJson } from "./json";
import * as logger from "./logger";
import { isProcessAlive } from "./process-liveness";
import { sleepSync } from "./sleep";

export interface FileLockOptions {
	staleMs?: number;
	retries?: number;
	retryDelayMs?: number;
}

const DEFAULT_OPTIONS: Required<FileLockOptions> = {
	staleMs: 10_000,
	retries: 50,
	retryDelayMs: 100,
};

/** Maximum time a live creator may need to publish its tiny owner record. */
const OWNER_INFO_GRACE_MS = 1_000;

interface LockInfo {
	pid: number;
	timestamp: number;
	token: string;
}

function isLockInfo(value: unknown): value is LockInfo {
	if (value === null || typeof value !== "object") return false;
	const info = value as Record<string, unknown>;
	return (
		typeof info.pid === "number" &&
		Number.isSafeInteger(info.pid) &&
		info.pid > 0 &&
		typeof info.timestamp === "number" &&
		Number.isSafeInteger(info.timestamp) &&
		typeof info.token === "string" &&
		info.token.length > 0
	);
}

// A lock is a directory at `${filePath}.lock`. mkdir elects its owner, whose
// identity is then written to `${lockPath}/info`. An ownerless directory is
// left alone for a short publication grace and recovered after that grace,
// including when ordinary timestamp-based stale expiry is disabled.
function getLockPath(filePath: string): string {
	return `${filePath}.lock`;
}

function buildLockInfo(token: string): LockInfo {
	return { pid: process.pid, timestamp: Date.now(), token };
}

async function writeLockInfo(lockPath: string, token: string): Promise<void> {
	await fs.writeFile(`${lockPath}/info`, JSON.stringify(buildLockInfo(token)), { flag: "wx", mode: 0o600 });
}

function writeLockInfoSync(lockPath: string, token: string): void {
	fsSync.writeFileSync(`${lockPath}/info`, JSON.stringify(buildLockInfo(token)), { flag: "wx", mode: 0o600 });
}

/**
 * Read a lock's `info` file, or `null` when there is nothing readable there.
 *
 * `null` means the lock is absent, is still in the short mkdir-to-info
 * publication window, is an ownerless artifact from an interrupted acquisition,
 * or contains corrupt metadata. Callers use the directory age to distinguish
 * the live publication window from an orphan.
 *
 * The sync twin below exists for exit-path teardown, which cannot await, and
 * answers identically.
 */
async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
	try {
		const content = await fs.readFile(`${lockPath}/info`, "utf-8");
		const parsed = tryParseJson<unknown>(content);
		return isLockInfo(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** Sync {@link readLockInfo}, for teardown paths that cannot await. Same `null` contract. */
function readLockInfoSync(lockPath: string): LockInfo | null {
	try {
		const content = fsSync.readFileSync(`${lockPath}/info`, "utf-8");
		const parsed = tryParseJson<unknown>(content);
		return isLockInfo(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

// Decide whether a held lock is abandoned. Shared reaping policy for both the
// sync and async paths: a lock is stale if its owner pid is dead, or its info
// timestamp is older than staleMs. The directory-mtime branch handles the
// bounded owner-info publication window and interrupted acquisitions.
function decideStale(info: LockInfo | null, dirMtimeMs: number | null, staleMs: number, now: number): boolean {
	if (info) {
		if (!isProcessAlive(info.pid)) return true;
		return now - info.timestamp > staleMs;
	}
	if (dirMtimeMs === null) return false;
	return now - dirMtimeMs > staleMs;
}

async function isLockStale(lockPath: string, staleMs: number): Promise<boolean> {
	const info = await readLockInfo(lockPath);
	if (info) return decideStale(info, null, staleMs, Date.now());
	try {
		const stat = await fs.stat(lockPath);
		return decideStale(null, stat.mtimeMs, staleMs, Date.now());
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

function isLockStaleSync(lockPath: string, staleMs: number): boolean {
	const info = readLockInfoSync(lockPath);
	if (info) return decideStale(info, null, staleMs, Date.now());
	try {
		const stat = fsSync.statSync(lockPath);
		return decideStale(null, stat.mtimeMs, staleMs, Date.now());
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

async function tryAcquireLock(lockPath: string): Promise<string | null> {
	let created = false;
	try {
		await fs.mkdir(lockPath, { mode: 0o700 });
		created = true;
		const token = randomUUID();
		await writeLockInfo(lockPath, token);
		return token;
	} catch (error) {
		if (!created && (error as NodeJS.ErrnoException).code === "EEXIST") return null;
		if (created) await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
}

function tryAcquireLockSync(lockPath: string): string | null {
	let created = false;
	try {
		fsSync.mkdirSync(lockPath, { mode: 0o700 });
		created = true;
		const token = randomUUID();
		writeLockInfoSync(lockPath, token);
		return token;
	} catch (error) {
		if (!created && (error as NodeJS.ErrnoException).code === "EEXIST") return null;
		if (created) {
			try {
				fsSync.rmSync(lockPath, { recursive: true, force: true });
			} catch {
				// The acquisition error is the useful one.
			}
		}
		throw error;
	}
}

/**
 * Report that this process no longer owned the lock it was releasing.
 *
 * Not releasing is the only safe thing to do here: the lock expired and was
 * reaped, or another process reclaimed it, and removing it now would wipe the
 * rightful owner's lock. But the reason this cannot be a debug line is what the
 * situation means rather than what the code does next. This process ran its
 * critical section to completion believing it held the lock, while another
 * process held it for some part of that. Whatever the lock protects was not
 * protected, and the corruption that follows shows up later, somewhere else,
 * with nothing connecting it back.
 *
 * The timeout is the tunable that fixes it, so the message names it.
 */
function reportLostLockOwnership(lockPath: string, expectedToken: string, actualToken: string | undefined): void {
	logger.warn(
		"file-lock: the lock was taken by another process before this one finished with it, so the work it guards was not actually exclusive; consider a longer lock timeout",
		{ lockPath, expectedToken, actualToken: actualToken ?? "(lock is gone)" },
	);
}

/**
 * Report a release that failed outright.
 *
 * A lock directory left on disk blocks every other process that wants this
 * resource until the stale-lock reaper gets to it, which on a long timeout is
 * a long wait for an operation that looks hung and has no cause to point at.
 */
function reportFailedRelease(lockPath: string, error: unknown): void {
	// The lock already being gone is not a failed release, it is a release with
	// nothing left to do. Reporting it would fire on the ordinary path where a
	// reaper got there first.
	if (isEnoent(error)) return;
	logger.warn("file-lock: could not remove the lock, so other processes will wait for it to go stale", {
		lockPath,
		error: String(error),
	});
}

async function releaseLock(lockPath: string, expectedToken?: string): Promise<void> {
	try {
		const info = await readLockInfo(lockPath);
		if (expectedToken !== undefined) {
			if (!info || info.token !== expectedToken) {
				reportLostLockOwnership(lockPath, expectedToken, info?.token);
				return;
			}
		} else if (info !== null) {
			// Tokenless removal is reserved for an ownerless legacy lock. A stale
			// owner record must always be removed with the token that was observed,
			// or a delayed reaper can erase a freshly-acquired lock.
			return;
		}
		await fs.rm(lockPath, { recursive: true });
	} catch (error) {
		// Release never throws at the caller: it runs in finally blocks and on
		// shutdown paths, where an exception would mask the real error. It is
		// reported instead of ignored.
		reportFailedRelease(lockPath, error);
	}
}

function releaseLockSync(lockPath: string, expectedToken?: string): void {
	try {
		const info = readLockInfoSync(lockPath);
		if (expectedToken !== undefined) {
			if (!info || info.token !== expectedToken) {
				reportLostLockOwnership(lockPath, expectedToken, info?.token);
				return;
			}
		} else if (info !== null) {
			return;
		}
		fsSync.rmSync(lockPath, { recursive: true });
	} catch (error) {
		// See releaseLock: reported, never thrown at the caller.
		reportFailedRelease(lockPath, error);
	}
}

async function lockExists(lockPath: string): Promise<boolean> {
	try {
		await fs.stat(lockPath);
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

function lockExistsSync(lockPath: string): boolean {
	try {
		fsSync.statSync(lockPath);
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

async function acquireLock(filePath: string, options: FileLockOptions = {}): Promise<() => Promise<void>> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const lockPath = getLockPath(filePath);

	for (let attempt = 0; attempt < opts.retries; attempt++) {
		const token = await tryAcquireLock(lockPath);
		if (token !== null) {
			return () => releaseLock(lockPath, token);
		}

		const info = await readLockInfo(lockPath);
		if (info === null) {
			if (await isLockStale(lockPath, OWNER_INFO_GRACE_MS)) {
				await releaseLock(lockPath);
				continue;
			}
			await Bun.sleep(opts.retryDelayMs);
			continue;
		}
		if (decideStale(info, null, opts.staleMs, Date.now())) {
			await releaseLock(lockPath, info.token);
			continue;
		}

		await Bun.sleep(opts.retryDelayMs);
	}

	throw new Error(`Failed to acquire lock for ${filePath} after ${opts.retries} attempts`);
}

function acquireLockSync(filePath: string, options: FileLockOptions = {}): () => void {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const lockPath = getLockPath(filePath);

	for (let attempt = 0; attempt < opts.retries; attempt++) {
		const token = tryAcquireLockSync(lockPath);
		if (token !== null) {
			return () => releaseLockSync(lockPath, token);
		}

		const info = readLockInfoSync(lockPath);
		if (info === null) {
			if (isLockStaleSync(lockPath, OWNER_INFO_GRACE_MS)) {
				releaseLockSync(lockPath);
				continue;
			}
			sleepSync(opts.retryDelayMs);
			continue;
		}
		if (decideStale(info, null, opts.staleMs, Date.now())) {
			releaseLockSync(lockPath, info.token);
			continue;
		}

		sleepSync(opts.retryDelayMs);
	}

	throw new Error(`Failed to acquire lock for ${filePath} after ${opts.retries} attempts`);
}

/**
 * Run `fn` while holding a cross-process advisory lock on `filePath`.
 *
 * The lock is a directory next to the file, so it works across processes and
 * survives crashes (a dead owner's lock is reaped by pid liveness + a staleness
 * timeout). Use this to serialize read-modify-write cycles on a shared config
 * or state file so a concurrent writer cannot clobber your update.
 */
export async function withFileLock<T>(
	filePath: string,
	fn: () => Promise<T>,
	options: FileLockOptions = {},
): Promise<T> {
	const release = await acquireLock(filePath, options);
	try {
		return await fn();
	} finally {
		await release();
	}
}

/**
 * What {@link tryWithFileLock} returns: either the lock was taken and `value`
 * holds the result of `fn`, or another live process holds it and `fn` never ran.
 */
export type TryFileLockResult<T> = { acquired: true; value: T } | { acquired: false };

/**
 * Run `fn` under the lock if it is free right now, otherwise return without
 * running it.
 *
 * {@link withFileLock} waits for the holder and eventually throws, which is what
 * you want for a read-modify-write that must happen. This is for the other
 * shape: work that only needs to happen once across concurrent processes, where
 * a second process should get out of the way rather than queue up to redo it.
 * Launching the same program in three terminals should not run its background
 * update three times in a row.
 *
 * A lock whose owner is dead, or whose info is older than `staleMs`, is reaped
 * and then taken, so a crashed holder does not block the work forever. Set
 * `staleMs` to longer than `fn` can plausibly take: too short and a second
 * process reaps a lock that is still legitimately held.
 *
 * ```ts
 * const result = await tryWithFileLock(statePath, () => install(), { staleMs: 600_000 });
 * if (!result.acquired) logger.debug("another process is already installing");
 * ```
 */
export async function tryWithFileLock<T>(
	filePath: string,
	fn: () => Promise<T>,
	options: FileLockOptions = {},
): Promise<TryFileLockResult<T>> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const lockPath = getLockPath(filePath);

	// Two attempts at most: the second exists only so a stale lock reaped on the
	// first attempt can be taken. Anything beyond that is waiting, which is what
	// this function exists not to do.
	for (let attempt = 0; attempt < 2; attempt++) {
		const token = await tryAcquireLock(lockPath);
		if (token !== null) {
			try {
				return { acquired: true, value: await fn() };
			} finally {
				await releaseLock(lockPath, token);
			}
		}
		const info = await readLockInfo(lockPath);
		if (info === null) {
			if (!(await isLockStale(lockPath, OWNER_INFO_GRACE_MS))) break;
			await releaseLock(lockPath);
			continue;
		}
		if (!decideStale(info, null, opts.staleMs, Date.now())) break;
		await releaseLock(lockPath, info.token);
	}
	return { acquired: false };
}

/**
 * Synchronous twin of {@link withFileLock}.
 *
 * Contends on the same on-disk lock directory, so a `withFileLockSync` holder
 * and a `withFileLock` holder mutually exclude on `${filePath}.lock`. Use this
 * only for a genuinely synchronous read-modify-write (a sync config writer that
 * cannot be made async); it blocks the event loop while it waits, so prefer the
 * async form everywhere else.
 */
export function withFileLockSync<T>(filePath: string, fn: () => T, options: FileLockOptions = {}): T {
	const release = acquireLockSync(filePath, options);
	try {
		return fn();
	} finally {
		release();
	}
}

/**
 * Test-only handles for the internal lock primitives. These are NOT part of
 * the public API — they exist so the contract tests can validate token-keyed
 * release semantics and the mkdir-race window without re-implementing them.
 */
export const __internalsForTesting = {
	tryAcquireLock,
	releaseLock,
	readLockInfo,
	isLockStale,
	getLockPath,
	tryAcquireLockSync,
	releaseLockSync,
	readLockInfoSync,
	isLockStaleSync,
};
