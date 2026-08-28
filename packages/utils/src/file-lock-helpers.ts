import { randomUUID } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "./fs-error";
import { tryParseJson } from "./json";
import * as logger from "./logger";
import { getProcessStartIdentity, isProcessInstanceAlive } from "./process-liveness";
import { sleepSync } from "./sleep";
import { escapeTerminalText } from "./terminal-safe";
import { isRecord } from "./type-guards";

import type {
	FileIdentity,
	FileLockOptions,
	LockLease,
	LockObservation,
	RemovalAuthorization,
	RetireResult,
} from "./file-lock";
import {
	OWNER_INFO_GRACE_MS,
	RESTORE_ATTEMPTS,
	assertParentIdentity,
	assertParentIdentitySync,
	buildLockInfo,
	getLockPath,
	getTransitionPath,
	inspectLockDirectory,
	inspectLockDirectorySync,
	inspectParent,
	inspectParentSync,
	isLockStale,
	isLockStaleSync,
	observationIsStale,
	readLockInfo,
	readLockInfoSync,
	removeObservedDirectory,
	removeObservedDirectorySync,
	restoreTransition,
	sameIdentity,
	sameObservationIdentity,
	validateOptions,
} from "./file-lock";

function restoreTransitionSync(lockPath: string, expected: LockObservation): boolean {
	const transitionPath = getTransitionPath(lockPath);
	const parentIdentity = inspectParentSync(lockPath);
	for (let attempt = 0; attempt < RESTORE_ATTEMPTS; attempt++) {
		const transition = inspectLockDirectorySync(transitionPath);
		if (transition === null || !sameObservationIdentity(transition, expected)) return false;
		try {
			assertParentIdentitySync(lockPath, parentIdentity);
			fsSync.renameSync(transitionPath, lockPath);
			assertParentIdentitySync(lockPath, parentIdentity);
			const restored = inspectLockDirectorySync(lockPath);
			return restored !== null && sameObservationIdentity(restored, expected);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return false;
			if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
			sleepSync(1);
		}
	}
	return false;
}

function removalIsAuthorized(observation: LockObservation, authorization: RemovalAuthorization): boolean {
	if (authorization.kind === "stale") {
		return observationIsStale(observation, authorization.staleMs, Date.now(), authorization.isOwnerAlive);
	}
	return (
		observation.kind === "valid" &&
		observation.info !== undefined &&
		observation.infoIdentity !== undefined &&
		observation.info.token === authorization.lease.token &&
		sameIdentity(observation.directoryIdentity, authorization.lease.directoryIdentity) &&
		sameIdentity(observation.infoIdentity, authorization.lease.infoIdentity)
	);
}

async function retireObservedLock(
	lockPath: string,
	expected: LockObservation,
	authorization: RemovalAuthorization,
): Promise<RetireResult> {
	if (expected.kind === "unsafe") return "not-authorized";
	const current = await inspectLockDirectory(lockPath);
	if (current === null || !sameObservationIdentity(current, expected)) return "changed";
	const parentIdentity = await inspectParent(lockPath);
	const transitionPath = getTransitionPath(lockPath);
	try {
		await fs.rename(lockPath, transitionPath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return "changed";
		if (code === "EEXIST" || code === "ENOTEMPTY") return "busy";
		throw error;
	}
	await assertParentIdentity(lockPath, parentIdentity);
	const claimed = await inspectLockDirectory(transitionPath);
	if (claimed === null) return "changed";
	if (!sameObservationIdentity(claimed, expected) || !removalIsAuthorized(claimed, authorization)) {
		await restoreTransition(lockPath, claimed);
		return sameObservationIdentity(claimed, expected) ? "not-authorized" : "changed";
	}
	await removeObservedDirectory(transitionPath, claimed);
	await assertParentIdentity(lockPath, parentIdentity);
	return "removed";
}

function retireObservedLockSync(
	lockPath: string,
	expected: LockObservation,
	authorization: RemovalAuthorization,
): RetireResult {
	if (expected.kind === "unsafe") return "not-authorized";
	const current = inspectLockDirectorySync(lockPath);
	if (current === null || !sameObservationIdentity(current, expected)) return "changed";
	const parentIdentity = inspectParentSync(lockPath);
	const transitionPath = getTransitionPath(lockPath);
	try {
		fsSync.renameSync(lockPath, transitionPath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return "changed";
		if (code === "EEXIST" || code === "ENOTEMPTY") return "busy";
		throw error;
	}
	assertParentIdentitySync(lockPath, parentIdentity);
	const claimed = inspectLockDirectorySync(transitionPath);
	if (claimed === null) return "changed";
	if (!sameObservationIdentity(claimed, expected) || !removalIsAuthorized(claimed, authorization)) {
		restoreTransitionSync(lockPath, claimed);
		return sameObservationIdentity(claimed, expected) ? "not-authorized" : "changed";
	}
	removeObservedDirectorySync(transitionPath, claimed);
	assertParentIdentitySync(lockPath, parentIdentity);
	return "removed";
}

async function settleTransition(lockPath: string, staleMs: number): Promise<void> {
	const transitionPath = getTransitionPath(lockPath);
	const transition = await inspectLockDirectory(transitionPath);
	if (transition === null || transition.kind === "unsafe") return;
	if (Date.now() - transition.directoryCtimeMs <= OWNER_INFO_GRACE_MS) return;
	const livePath = await inspectLockDirectory(lockPath);
	if (livePath !== null) return;
	if (observationIsStale(transition, staleMs, Date.now())) {
		await removeObservedDirectory(transitionPath, transition).catch(() => {});
		return;
	}
	await restoreTransition(lockPath, transition);
}

function settleTransitionSync(lockPath: string, staleMs: number): void {
	const transitionPath = getTransitionPath(lockPath);
	const transition = inspectLockDirectorySync(transitionPath);
	if (transition === null || transition.kind === "unsafe") return;
	if (Date.now() - transition.directoryCtimeMs <= OWNER_INFO_GRACE_MS) return;
	const livePath = inspectLockDirectorySync(lockPath);
	if (livePath !== null) return;
	if (observationIsStale(transition, staleMs, Date.now())) {
		try {
			removeObservedDirectorySync(transitionPath, transition);
		} catch {}
		return;
	}
	restoreTransitionSync(lockPath, transition);
}

async function prepareCandidate(lockPath: string): Promise<{
	path: string;
	observation: LockObservation;
	lease: LockLease;
	parentIdentity: FileIdentity;
}> {
	const candidatePath = `${lockPath}.candidate-${process.pid}-${randomUUID()}`;
	const parentIdentity = await inspectParent(lockPath);
	await fs.mkdir(candidatePath, { mode: 0o700 });
	await assertParentIdentity(lockPath, parentIdentity);
	try {
		const token = randomUUID();
		const handle = await fs.open(path.join(candidatePath, "info"), "wx", 0o600);
		try {
			await handle.writeFile(JSON.stringify(buildLockInfo(token)), "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await assertParentIdentity(lockPath, parentIdentity);
		const observation = await inspectLockDirectory(candidatePath);
		if (
			observation?.kind !== "valid" ||
			observation.infoIdentity === undefined ||
			observation.info?.token !== token
		) {
			throw new Error("file-lock: candidate owner record failed validation");
		}
		return {
			path: candidatePath,
			observation,
			lease: { token, directoryIdentity: observation.directoryIdentity, infoIdentity: observation.infoIdentity },
			parentIdentity,
		};
	} catch (error) {
		const observation = await inspectLockDirectory(candidatePath).catch(() => null);
		if (observation && observation.kind !== "unsafe") {
			await removeObservedDirectory(candidatePath, observation).catch(() => {});
		}
		throw error;
	}
}

function prepareCandidateSync(lockPath: string): {
	path: string;
	observation: LockObservation;
	lease: LockLease;
	parentIdentity: FileIdentity;
} {
	const candidatePath = `${lockPath}.candidate-${process.pid}-${randomUUID()}`;
	const parentIdentity = inspectParentSync(lockPath);
	fsSync.mkdirSync(candidatePath, { mode: 0o700 });
	assertParentIdentitySync(lockPath, parentIdentity);
	try {
		const token = randomUUID();
		const fd = fsSync.openSync(path.join(candidatePath, "info"), "wx", 0o600);
		try {
			fsSync.writeFileSync(fd, JSON.stringify(buildLockInfo(token)), "utf8");
			fsSync.fsyncSync(fd);
		} finally {
			fsSync.closeSync(fd);
		}
		assertParentIdentitySync(lockPath, parentIdentity);
		const observation = inspectLockDirectorySync(candidatePath);
		if (
			observation?.kind !== "valid" ||
			observation.infoIdentity === undefined ||
			observation.info?.token !== token
		) {
			throw new Error("file-lock: candidate owner record failed validation");
		}
		return {
			path: candidatePath,
			observation,
			lease: { token, directoryIdentity: observation.directoryIdentity, infoIdentity: observation.infoIdentity },
			parentIdentity,
		};
	} catch (error) {
		try {
			const observation = inspectLockDirectorySync(candidatePath);
			if (observation && observation.kind !== "unsafe") removeObservedDirectorySync(candidatePath, observation);
		} catch {}
		throw error;
	}
}

async function withdrawCandidate(lockPath: string, candidatePath: string, expected: LockObservation): Promise<void> {
	const parentIdentity = await inspectParent(lockPath);
	const current = await inspectLockDirectory(lockPath);
	if (current === null || !sameObservationIdentity(current, expected)) return;
	try {
		await assertParentIdentity(lockPath, parentIdentity);
		await fs.rename(lockPath, candidatePath);
		await assertParentIdentity(lockPath, parentIdentity);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}

function withdrawCandidateSync(lockPath: string, candidatePath: string, expected: LockObservation): void {
	const parentIdentity = inspectParentSync(lockPath);
	const current = inspectLockDirectorySync(lockPath);
	if (current === null || !sameObservationIdentity(current, expected)) return;
	try {
		assertParentIdentitySync(lockPath, parentIdentity);
		fsSync.renameSync(lockPath, candidatePath);
		assertParentIdentitySync(lockPath, parentIdentity);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}

async function tryAcquireLock(lockPath: string): Promise<LockLease | null> {
	const candidate = await prepareCandidate(lockPath);
	let published = false;
	try {
		await assertParentIdentity(lockPath, candidate.parentIdentity);
		if ((await inspectLockDirectory(getTransitionPath(lockPath))) !== null) return null;
		if ((await inspectLockDirectory(lockPath)) !== null) return null;
		try {
			await fs.rename(candidate.path, lockPath);
			published = true;
			await assertParentIdentity(lockPath, candidate.parentIdentity);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EEXIST" || code === "ENOTEMPTY") return null;
			throw error;
		}
		const current = await inspectLockDirectory(lockPath);
		if (current === null || !sameObservationIdentity(current, candidate.observation)) return null;
		if ((await inspectLockDirectory(getTransitionPath(lockPath))) !== null) {
			await withdrawCandidate(lockPath, candidate.path, candidate.observation);
			published = false;
			return null;
		}
		return candidate.lease;
	} finally {
		if (!published) {
			const leftover = await inspectLockDirectory(candidate.path).catch(() => null);
			if (leftover && sameObservationIdentity(leftover, candidate.observation)) {
				await removeObservedDirectory(candidate.path, leftover).catch(() => {});
			}
		}
	}
}

function tryAcquireLockSync(lockPath: string): LockLease | null {
	const candidate = prepareCandidateSync(lockPath);
	let published = false;
	try {
		assertParentIdentitySync(lockPath, candidate.parentIdentity);
		if (inspectLockDirectorySync(getTransitionPath(lockPath)) !== null) return null;
		if (inspectLockDirectorySync(lockPath) !== null) return null;
		try {
			fsSync.renameSync(candidate.path, lockPath);
			published = true;
			assertParentIdentitySync(lockPath, candidate.parentIdentity);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EEXIST" || code === "ENOTEMPTY") return null;
			throw error;
		}
		const current = inspectLockDirectorySync(lockPath);
		if (current === null || !sameObservationIdentity(current, candidate.observation)) return null;
		if (inspectLockDirectorySync(getTransitionPath(lockPath)) !== null) {
			withdrawCandidateSync(lockPath, candidate.path, candidate.observation);
			published = false;
			return null;
		}
		return candidate.lease;
	} finally {
		if (!published) {
			try {
				const leftover = inspectLockDirectorySync(candidate.path);
				if (leftover && sameObservationIdentity(leftover, candidate.observation)) {
					removeObservedDirectorySync(candidate.path, leftover);
				}
			} catch {}
		}
	}
}

function reportLostLockOwnership(lockPath: string, expectedToken: string, actualToken: string | undefined): void {
	logger.warn(
		"file-lock: the lock was taken by another process before this one finished with it, so the work it guards was not actually exclusive; check the guarded resource for conflicting writes",
		{
			lockPath: escapeTerminalText(lockPath),
			expectedToken: escapeTerminalText(expectedToken),
			actualToken: escapeTerminalText(actualToken ?? "(lock is gone)"),
		},
	);
}

function reportFailedRelease(lockPath: string, error: unknown): void {
	if (isEnoent(error)) return;
	logger.warn("file-lock: could not remove the lock, so other processes will wait for it to go stale", {
		lockPath: escapeTerminalText(lockPath),
		error: escapeTerminalText(String(error)),
	});
}

async function releaseLock(lockPath: string, expected: LockLease | string): Promise<void> {
	try {
		const observation = await inspectLockDirectory(lockPath);
		const expectedToken = typeof expected === "string" ? expected : expected.token;
		if (
			observation?.kind !== "valid" ||
			observation.infoIdentity === undefined ||
			observation.info?.token !== expectedToken
		) {
			reportLostLockOwnership(lockPath, expectedToken, observation?.info?.token);
			return;
		}
		const lease: LockLease =
			typeof expected === "string"
				? {
						token: expected,
						directoryIdentity: observation.directoryIdentity,
						infoIdentity: observation.infoIdentity,
					}
				: expected;
		for (let attempt = 0; attempt < 3; attempt++) {
			const result = await retireObservedLock(lockPath, observation, { kind: "owner", lease });
			if (result === "removed") return;
			if (result === "changed" || result === "not-authorized") {
				const actual = await readLockInfo(lockPath);
				reportLostLockOwnership(lockPath, expectedToken, actual?.token);
				return;
			}
			await settleTransition(lockPath, Number.POSITIVE_INFINITY);
		}
		throw new Error("file-lock lifecycle remained busy during release");
	} catch (error) {
		reportFailedRelease(lockPath, error);
	}
}

function releaseLockSync(lockPath: string, expected: LockLease | string): void {
	try {
		const observation = inspectLockDirectorySync(lockPath);
		const expectedToken = typeof expected === "string" ? expected : expected.token;
		if (
			observation?.kind !== "valid" ||
			observation.infoIdentity === undefined ||
			observation.info?.token !== expectedToken
		) {
			reportLostLockOwnership(lockPath, expectedToken, observation?.info?.token);
			return;
		}
		const lease: LockLease =
			typeof expected === "string"
				? {
						token: expected,
						directoryIdentity: observation.directoryIdentity,
						infoIdentity: observation.infoIdentity,
					}
				: expected;
		for (let attempt = 0; attempt < 3; attempt++) {
			const result = retireObservedLockSync(lockPath, observation, { kind: "owner", lease });
			if (result === "removed") return;
			if (result === "changed" || result === "not-authorized") {
				const actual = readLockInfoSync(lockPath);
				reportLostLockOwnership(lockPath, expectedToken, actual?.token);
				return;
			}
			settleTransitionSync(lockPath, Number.POSITIVE_INFINITY);
		}
		throw new Error("file-lock lifecycle remained busy during release");
	} catch (error) {
		reportFailedRelease(lockPath, error);
	}
}

async function reapStaleAndAcquire(lockPath: string, opts: Required<FileLockOptions>): Promise<LockLease | null> {
	const observation = await inspectLockDirectory(lockPath);
	if (!observation || !observationIsStale(observation, opts.staleMs, Date.now())) return null;
	const retired = await retireObservedLock(lockPath, observation, { kind: "stale", staleMs: opts.staleMs });
	if (retired !== "removed") return null;
	return await tryAcquireLock(lockPath);
}

function reapStaleAndAcquireSync(lockPath: string, opts: Required<FileLockOptions>): LockLease | null {
	const observation = inspectLockDirectorySync(lockPath);
	if (!observation || !observationIsStale(observation, opts.staleMs, Date.now())) return null;
	const retired = retireObservedLockSync(lockPath, observation, { kind: "stale", staleMs: opts.staleMs });
	if (retired !== "removed") return null;
	return tryAcquireLockSync(lockPath);
}

async function acquireLock(filePath: string, options: FileLockOptions = {}): Promise<() => Promise<void>> {
	const opts = validateOptions(options);
	const lockPath = getLockPath(filePath);
	for (let attempt = 0; attempt < opts.retries; attempt++) {
		await settleTransition(lockPath, opts.staleMs);
		const lease = (await tryAcquireLock(lockPath)) ?? (await reapStaleAndAcquire(lockPath, opts));
		if (lease !== null) return () => releaseLock(lockPath, lease);
		if (attempt + 1 < opts.retries) await Bun.sleep(opts.retryDelayMs);
	}
	throw new Error(`Failed to acquire lock for ${escapeTerminalText(filePath)} after ${opts.retries} attempts`);
}

function acquireLockSync(filePath: string, options: FileLockOptions = {}): () => void {
	const opts = validateOptions(options);
	const lockPath = getLockPath(filePath);
	for (let attempt = 0; attempt < opts.retries; attempt++) {
		settleTransitionSync(lockPath, opts.staleMs);
		const lease = tryAcquireLockSync(lockPath) ?? reapStaleAndAcquireSync(lockPath, opts);
		if (lease !== null) return () => releaseLockSync(lockPath, lease);
		if (attempt + 1 < opts.retries) sleepSync(opts.retryDelayMs);
	}
	throw new Error(`Failed to acquire lock for ${escapeTerminalText(filePath)} after ${opts.retries} attempts`);
}

/** Run fn while holding a cross-process advisory lock on the pathname. */
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

export type TryFileLockResult<T> = { acquired: true; value: T } | { acquired: false };

/** Run fn under the pathname lock if immediately available. */
export async function tryWithFileLock<T>(
	filePath: string,
	fn: () => Promise<T>,
	options: FileLockOptions = {},
): Promise<TryFileLockResult<T>> {
	const opts = validateOptions(options);
	const lockPath = getLockPath(filePath);
	for (let attempt = 0; attempt < 2; attempt++) {
		await settleTransition(lockPath, opts.staleMs);
		const lease = await tryAcquireLock(lockPath);
		if (lease !== null) {
			try {
				return { acquired: true, value: await fn() };
			} finally {
				await releaseLock(lockPath, lease);
			}
		}
		const observation = await inspectLockDirectory(lockPath);
		if (!observation || !observationIsStale(observation, opts.staleMs, Date.now())) break;
		const result = await retireObservedLock(lockPath, observation, { kind: "stale", staleMs: opts.staleMs });
		if (result !== "removed") break;
	}
	return { acquired: false };
}

/** Synchronous twin of withFileLock. */
export function withFileLockSync<T>(filePath: string, fn: () => T, options: FileLockOptions = {}): T {
	const release = acquireLockSync(filePath, options);
	try {
		return fn();
	} finally {
		release();
	}
}

/** Test-only internals. */
export const __internalsForTesting = {
	tryAcquireLock,
	releaseLock,
	readLockInfo,
	isLockStale,
	getLockPath,
	getTransitionPath,
	inspectLockDirectory,
	retireObservedLock,
	prepareCandidate,
	removeObservedDirectory,
	tryAcquireLockSync,
	releaseLockSync,
	readLockInfoSync,
	isLockStaleSync,
	inspectLockDirectorySync,
	retireObservedLockSync,
	prepareCandidateSync,
	removeObservedDirectorySync,
};
