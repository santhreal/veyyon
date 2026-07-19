import { randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import { isEnoent } from "./fs-error";
import { tryParseJson } from "./json";
import * as logger from "./logger";
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

interface LockInfo {
	pid: number;
	timestamp: number;
	token: string;
}

// A lock is a directory at `${filePath}.lock`. mkdir is atomic on every
// filesystem, so the process that creates the directory owns the lock. The
// owner's identity lives in `${lockPath}/info` (pid + timestamp + token). The
// sync and async paths below share this on-disk layout, so a `withFileLock`
// holder and a `withFileLockSync` holder contend correctly on the same lock.
function getLockPath(filePath: string): string {
	return `${filePath}.lock`;
}

function buildLockInfo(token: string): LockInfo {
	return { pid: process.pid, timestamp: Date.now(), token };
}

async function writeLockInfo(lockPath: string, token: string): Promise<void> {
	await Bun.write(`${lockPath}/info`, JSON.stringify(buildLockInfo(token)));
}

function writeLockInfoSync(lockPath: string, token: string): void {
	fsSync.writeFileSync(`${lockPath}/info`, JSON.stringify(buildLockInfo(token)));
}

async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
	try {
		const content = await fs.readFile(`${lockPath}/info`, "utf-8");
		return tryParseJson<LockInfo>(content);
	} catch {
		// Missing/unreadable lock file (readFile throws) — no lock held.
		return null;
	}
}

function readLockInfoSync(lockPath: string): LockInfo | null {
	try {
		const content = fsSync.readFileSync(`${lockPath}/info`, "utf-8");
		return tryParseJson<LockInfo>(content);
	} catch {
		return null;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// Decide whether a held lock is abandoned. Shared reaping policy for both the
// sync and async paths: a lock is stale if its owner pid is dead, or its info
// timestamp is older than staleMs. When there is no info file the lock is
// either mid-acquire (fresh dir, do not reap) or already gone (nothing to
// reap) — reap only when the bare dir's mtime is itself older than staleMs.
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
	try {
		await fs.mkdir(lockPath);
		const token = randomUUID();
		await writeLockInfo(lockPath, token);
		return token;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			return null;
		}
		throw error;
	}
}

function tryAcquireLockSync(lockPath: string): string | null {
	try {
		fsSync.mkdirSync(lockPath);
		const token = randomUUID();
		writeLockInfoSync(lockPath, token);
		return token;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			return null;
		}
		throw error;
	}
}

function skipReleaseLog(lockPath: string, expectedToken: string, actualToken: string | undefined): void {
	// We are not the owner. The lock either expired and was reaped or another
	// process reclaimed it. Do nothing — releasing here would wipe the rightful
	// owner's lock.
	logger.debug("file-lock: skipping release for non-owned lock", {
		lockPath,
		expectedToken,
		actualToken,
	});
}

async function releaseLock(lockPath: string, expectedToken?: string): Promise<void> {
	try {
		if (expectedToken !== undefined) {
			const info = await readLockInfo(lockPath);
			if (!info || info.token !== expectedToken) {
				skipReleaseLog(lockPath, expectedToken, info?.token);
				return;
			}
		}
		await fs.rm(lockPath, { recursive: true });
	} catch {
		// Ignore errors on release.
	}
}

function releaseLockSync(lockPath: string, expectedToken?: string): void {
	try {
		if (expectedToken !== undefined) {
			const info = readLockInfoSync(lockPath);
			if (!info || info.token !== expectedToken) {
				skipReleaseLog(lockPath, expectedToken, info?.token);
				return;
			}
		}
		fsSync.rmSync(lockPath, { recursive: true });
	} catch {
		// Ignore errors on release.
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

		if ((await lockExists(lockPath)) && (await isLockStale(lockPath, opts.staleMs))) {
			// Reaping a stale lock — no token because we didn't acquire it. The
			// rightful owner is presumed dead; rm without ownership check.
			await releaseLock(lockPath);
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

		if (lockExistsSync(lockPath) && isLockStaleSync(lockPath, opts.staleMs)) {
			releaseLockSync(lockPath);
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
