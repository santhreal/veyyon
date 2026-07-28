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

/** Maximum time an interrupted legacy creator gets to publish its owner record. */
const OWNER_INFO_GRACE_MS = 1_000;
const MAX_OWNER_INFO_BYTES = 4_096;
const RESTORE_ATTEMPTS = 200;
const LOCK_INFO_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface FileIdentity {
	dev: number;
	ino: number;
	birthtimeMs: number;
}

interface LockInfo {
	version: typeof LOCK_INFO_VERSION;
	pid: number;
	timestamp: number;
	token: string;
	processIdentity: string | null;
}

interface LockObservation {
	kind: "valid" | "invalid" | "ownerless" | "unsafe";
	directoryIdentity: FileIdentity;
	directoryMtimeMs: number;
	directoryCtimeMs: number;
	infoIdentity?: FileIdentity;
	info?: LockInfo;
}

interface LockLease {
	token: string;
	directoryIdentity: FileIdentity;
	infoIdentity: FileIdentity;
}

type ProcessInstanceVerifier = (pid: number, expectedIdentity: string | null) => boolean;

type RemovalAuthorization =
	| { kind: "owner"; lease: LockLease }
	| { kind: "stale"; staleMs: number; isOwnerAlive?: ProcessInstanceVerifier };

type RetireResult = "removed" | "changed" | "busy" | "not-authorized";

function identityOf(stat: fsSync.Stats): FileIdentity {
	return { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

function sameObservationIdentity(left: LockObservation, right: LockObservation): boolean {
	if (!sameIdentity(left.directoryIdentity, right.directoryIdentity)) return false;
	if (left.infoIdentity === undefined || right.infoIdentity === undefined) {
		return left.infoIdentity === right.infoIdentity;
	}
	return sameIdentity(left.infoIdentity, right.infoIdentity);
}

function isLockInfo(value: unknown): value is LockInfo {
	if (!isRecord(value)) return false;
	const info = value as Record<string, unknown>;
	const keys = Object.keys(info).sort();
	if (keys.join("\0") !== "pid\0processIdentity\0timestamp\0token\0version") return false;
	return (
		info.version === LOCK_INFO_VERSION &&
		typeof info.pid === "number" &&
		Number.isSafeInteger(info.pid) &&
		info.pid > 0 &&
		info.pid <= 0x7fffffff &&
		typeof info.timestamp === "number" &&
		Number.isSafeInteger(info.timestamp) &&
		info.timestamp >= 0 &&
		typeof info.token === "string" &&
		UUID_PATTERN.test(info.token) &&
		(info.processIdentity === null ||
			(typeof info.processIdentity === "string" &&
				info.processIdentity.length > 0 &&
				info.processIdentity.length <= 512 &&
				!/[\u0000-\u001f\u007f-\u009f]/u.test(info.processIdentity)))
	);
}

function getLockPath(filePath: string): string {
	return `${filePath}.lock`;
}

function getTransitionPath(lockPath: string): string {
	return `${lockPath}.transition`;
}

function buildLockInfo(token: string): LockInfo {
	return {
		version: LOCK_INFO_VERSION,
		pid: process.pid,
		timestamp: Date.now(),
		token,
		processIdentity: getProcessStartIdentity(process.pid),
	};
}

function validateOptions(options: FileLockOptions): Required<FileLockOptions> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	if (!(opts.staleMs >= 0) || Number.isNaN(opts.staleMs)) {
		throw new TypeError("file-lock: staleMs must be a non-negative number");
	}
	if (!Number.isSafeInteger(opts.retries) || opts.retries < 1) {
		throw new TypeError("file-lock: retries must be a positive safe integer");
	}
	if (!Number.isFinite(opts.retryDelayMs) || opts.retryDelayMs < 0) {
		throw new TypeError("file-lock: retryDelayMs must be a finite non-negative number");
	}
	return opts;
}

async function inspectParent(filePath: string): Promise<FileIdentity> {
	const stat = await fs.lstat(path.dirname(filePath));
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error(`file-lock: unsafe parent directory for ${escapeTerminalText(filePath)}`);
	}
	return identityOf(stat);
}

function inspectParentSync(filePath: string): FileIdentity {
	const stat = fsSync.lstatSync(path.dirname(filePath));
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error(`file-lock: unsafe parent directory for ${escapeTerminalText(filePath)}`);
	}
	return identityOf(stat);
}

async function assertParentIdentity(filePath: string, expected: FileIdentity): Promise<void> {
	if (!sameIdentity(await inspectParent(filePath), expected)) {
		throw new Error(`file-lock: parent directory changed while locking ${escapeTerminalText(filePath)}`);
	}
}

function assertParentIdentitySync(filePath: string, expected: FileIdentity): void {
	if (!sameIdentity(inspectParentSync(filePath), expected)) {
		throw new Error(`file-lock: parent directory changed while locking ${escapeTerminalText(filePath)}`);
	}
}

function parseOwnerBytes(bytes: Buffer): LockInfo | null {
	// Two failure modes, kept apart. The decoder is `fatal`, so a lock file holding
	// bytes that are not UTF-8 THROWS and only the decode needs guarding; the JSON
	// half goes through `tryParseJson`, which is this package's one owner of
	// "parse it or give me null". Writing that try/catch out again here is how a
	// second, slightly different answer to the same question gets into the tree.
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
	const parsed = tryParseJson(text);
	return isLockInfo(parsed) ? parsed : null;
}

async function inspectLockDirectory(lockPath: string): Promise<LockObservation | null> {
	let directoryStat: fsSync.Stats;
	try {
		directoryStat = await fs.lstat(lockPath);
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
	const directoryIdentity = identityOf(directoryStat);
	if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
		return {
			kind: "unsafe",
			directoryIdentity,
			directoryMtimeMs: directoryStat.mtimeMs,
			directoryCtimeMs: directoryStat.ctimeMs,
		};
	}

	const infoPath = path.join(lockPath, "info");
	let infoStat: fsSync.Stats;
	try {
		infoStat = await fs.lstat(infoPath);
	} catch (error) {
		if (isEnoent(error)) {
			return {
				kind: "ownerless",
				directoryIdentity,
				directoryMtimeMs: directoryStat.mtimeMs,
				directoryCtimeMs: directoryStat.ctimeMs,
			};
		}
		throw error;
	}
	const infoIdentity = identityOf(infoStat);
	if (!infoStat.isFile() || infoStat.isSymbolicLink() || infoStat.nlink !== 1) {
		return {
			kind: "unsafe",
			directoryIdentity,
			directoryMtimeMs: directoryStat.mtimeMs,
			directoryCtimeMs: directoryStat.ctimeMs,
			infoIdentity,
		};
	}
	if (infoStat.size < 1 || infoStat.size > MAX_OWNER_INFO_BYTES) {
		return {
			kind: "invalid",
			directoryIdentity,
			directoryMtimeMs: directoryStat.mtimeMs,
			directoryCtimeMs: directoryStat.ctimeMs,
			infoIdentity,
		};
	}

	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(infoPath, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0));
		const openedStat = await handle.stat();
		if (
			!openedStat.isFile() ||
			openedStat.nlink !== 1 ||
			openedStat.size !== infoStat.size ||
			!sameIdentity(identityOf(openedStat), infoIdentity)
		) {
			return {
				kind: "unsafe",
				directoryIdentity,
				directoryMtimeMs: directoryStat.mtimeMs,
				directoryCtimeMs: directoryStat.ctimeMs,
				infoIdentity,
			};
		}
		const bytes = Buffer.allocUnsafe(infoStat.size + 1);
		const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
		const finalStat = await handle.stat();
		if (
			bytesRead !== infoStat.size ||
			finalStat.size !== infoStat.size ||
			!sameIdentity(identityOf(finalStat), infoIdentity)
		) {
			return {
				kind: "unsafe",
				directoryIdentity,
				directoryMtimeMs: directoryStat.mtimeMs,
				directoryCtimeMs: directoryStat.ctimeMs,
				infoIdentity,
			};
		}
		const info = parseOwnerBytes(bytes.subarray(0, bytesRead));
		return info
			? {
					kind: "valid",
					directoryIdentity,
					directoryMtimeMs: directoryStat.mtimeMs,
					directoryCtimeMs: directoryStat.ctimeMs,
					infoIdentity,
					info,
				}
			: {
					kind: "invalid",
					directoryIdentity,
					directoryMtimeMs: directoryStat.mtimeMs,
					directoryCtimeMs: directoryStat.ctimeMs,
					infoIdentity,
				};
	} catch {
		return {
			kind: "unsafe",
			directoryIdentity,
			directoryMtimeMs: directoryStat.mtimeMs,
			directoryCtimeMs: directoryStat.ctimeMs,
			infoIdentity,
		};
	} finally {
		await handle?.close().catch(() => {});
	}
}

function inspectLockDirectorySync(lockPath: string): LockObservation | null {
	let directoryStat: fsSync.Stats;
	try {
		directoryStat = fsSync.lstatSync(lockPath);
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
	const directoryIdentity = identityOf(directoryStat);
	if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
		return {
			kind: "unsafe",
			directoryIdentity,
			directoryMtimeMs: directoryStat.mtimeMs,
			directoryCtimeMs: directoryStat.ctimeMs,
		};
	}

	const infoPath = path.join(lockPath, "info");
	let infoStat: fsSync.Stats;
	try {
		infoStat = fsSync.lstatSync(infoPath);
	} catch (error) {
		if (isEnoent(error)) {
			return {
				kind: "ownerless",
				directoryIdentity,
				directoryMtimeMs: directoryStat.mtimeMs,
				directoryCtimeMs: directoryStat.ctimeMs,
			};
		}
		throw error;
	}
	const infoIdentity = identityOf(infoStat);
	if (!infoStat.isFile() || infoStat.isSymbolicLink() || infoStat.nlink !== 1) {
		return {
			kind: "unsafe",
			directoryIdentity,
			directoryMtimeMs: directoryStat.mtimeMs,
			directoryCtimeMs: directoryStat.ctimeMs,
			infoIdentity,
		};
	}
	if (infoStat.size < 1 || infoStat.size > MAX_OWNER_INFO_BYTES) {
		return {
			kind: "invalid",
			directoryIdentity,
			directoryMtimeMs: directoryStat.mtimeMs,
			directoryCtimeMs: directoryStat.ctimeMs,
			infoIdentity,
		};
	}

	let fd: number | undefined;
	try {
		fd = fsSync.openSync(infoPath, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0));
		const openedStat = fsSync.fstatSync(fd);
		if (
			!openedStat.isFile() ||
			openedStat.nlink !== 1 ||
			openedStat.size !== infoStat.size ||
			!sameIdentity(identityOf(openedStat), infoIdentity)
		) {
			return {
				kind: "unsafe",
				directoryIdentity,
				directoryMtimeMs: directoryStat.mtimeMs,
				directoryCtimeMs: directoryStat.ctimeMs,
				infoIdentity,
			};
		}
		const bytes = Buffer.allocUnsafe(infoStat.size + 1);
		const bytesRead = fsSync.readSync(fd, bytes, 0, bytes.length, 0);
		const finalStat = fsSync.fstatSync(fd);
		if (
			bytesRead !== infoStat.size ||
			finalStat.size !== infoStat.size ||
			!sameIdentity(identityOf(finalStat), infoIdentity)
		) {
			return {
				kind: "unsafe",
				directoryIdentity,
				directoryMtimeMs: directoryStat.mtimeMs,
				directoryCtimeMs: directoryStat.ctimeMs,
				infoIdentity,
			};
		}
		const info = parseOwnerBytes(bytes.subarray(0, bytesRead));
		return info
			? {
					kind: "valid",
					directoryIdentity,
					directoryMtimeMs: directoryStat.mtimeMs,
					directoryCtimeMs: directoryStat.ctimeMs,
					infoIdentity,
					info,
				}
			: {
					kind: "invalid",
					directoryIdentity,
					directoryMtimeMs: directoryStat.mtimeMs,
					directoryCtimeMs: directoryStat.ctimeMs,
					infoIdentity,
				};
	} catch {
		return {
			kind: "unsafe",
			directoryIdentity,
			directoryMtimeMs: directoryStat.mtimeMs,
			directoryCtimeMs: directoryStat.ctimeMs,
			infoIdentity,
		};
	} finally {
		if (fd !== undefined) {
			try {
				fsSync.closeSync(fd);
			} catch {
				// The observation is already complete; close errors do not authorize mutation.
			}
		}
	}
}

function observationIsStale(
	observation: LockObservation,
	_staleMs: number,
	now: number,
	isOwnerAlive: ProcessInstanceVerifier = isProcessInstanceAlive,
): boolean {
	if (observation.kind === "valid" && observation.info) {
		// Wall age never proves abandonment. A long-running live critical
		// section remains exclusive until its exact process incarnation is
		// proven dead or reused.
		return !isOwnerAlive(observation.info.pid, observation.info.processIdentity);
	}
	if (observation.kind === "ownerless" || observation.kind === "invalid") {
		return now - observation.directoryMtimeMs > OWNER_INFO_GRACE_MS;
	}
	return false;
}

async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
	const observation = await inspectLockDirectory(lockPath);
	return observation?.kind === "valid" ? (observation.info ?? null) : null;
}

function readLockInfoSync(lockPath: string): LockInfo | null {
	const observation = inspectLockDirectorySync(lockPath);
	return observation?.kind === "valid" ? (observation.info ?? null) : null;
}

async function isLockStale(lockPath: string, staleMs: number): Promise<boolean> {
	const observation = await inspectLockDirectory(lockPath);
	return observation !== null && observationIsStale(observation, staleMs, Date.now());
}

function isLockStaleSync(lockPath: string, staleMs: number): boolean {
	const observation = inspectLockDirectorySync(lockPath);
	return observation !== null && observationIsStale(observation, staleMs, Date.now());
}

async function directoryHasOnlyInfo(directoryPath: string, hasInfo: boolean): Promise<boolean> {
	const directory = await fs.opendir(directoryPath);
	let count = 0;
	for await (const entry of directory) {
		count += 1;
		if (count > 1 || entry.name !== "info" || !hasInfo) return false;
	}
	return count === (hasInfo ? 1 : 0);
}

function directoryHasOnlyInfoSync(directoryPath: string, hasInfo: boolean): boolean {
	const directory = fsSync.opendirSync(directoryPath);
	try {
		let count = 0;
		let entry: fsSync.Dirent | null;
		while ((entry = directory.readSync()) !== null) {
			count += 1;
			if (count > 1 || entry.name !== "info" || !hasInfo) return false;
		}
		return count === (hasInfo ? 1 : 0);
	} finally {
		directory.closeSync();
	}
}

async function removeObservedDirectory(directoryPath: string, expected: LockObservation): Promise<void> {
	const parentIdentity = await inspectParent(directoryPath);
	const current = await inspectLockDirectory(directoryPath);
	if (current === null || !sameObservationIdentity(current, expected) || current.kind === "unsafe") {
		throw new Error("file-lock: refusing to remove a directory whose identity changed");
	}
	const hasInfo = expected.infoIdentity !== undefined;
	if (!(await directoryHasOnlyInfo(directoryPath, hasInfo))) {
		throw new Error("file-lock: refusing to remove a lock directory with unexpected entries");
	}
	if (hasInfo) {
		const currentInfo = await fs.lstat(path.join(directoryPath, "info"));
		if (currentInfo.nlink !== 1 || !sameIdentity(identityOf(currentInfo), expected.infoIdentity!)) {
			throw new Error("file-lock: refusing to unlink owner info whose identity changed");
		}
		await assertParentIdentity(directoryPath, parentIdentity);
		await fs.unlink(path.join(directoryPath, "info"));
	}
	await assertParentIdentity(directoryPath, parentIdentity);
	await fs.rmdir(directoryPath);
	await assertParentIdentity(directoryPath, parentIdentity);
}

function removeObservedDirectorySync(directoryPath: string, expected: LockObservation): void {
	const parentIdentity = inspectParentSync(directoryPath);
	const current = inspectLockDirectorySync(directoryPath);
	if (current === null || !sameObservationIdentity(current, expected) || current.kind === "unsafe") {
		throw new Error("file-lock: refusing to remove a directory whose identity changed");
	}
	const hasInfo = expected.infoIdentity !== undefined;
	if (!directoryHasOnlyInfoSync(directoryPath, hasInfo)) {
		throw new Error("file-lock: refusing to remove a lock directory with unexpected entries");
	}
	if (hasInfo) {
		const currentInfo = fsSync.lstatSync(path.join(directoryPath, "info"));
		if (currentInfo.nlink !== 1 || !sameIdentity(identityOf(currentInfo), expected.infoIdentity!)) {
			throw new Error("file-lock: refusing to unlink owner info whose identity changed");
		}
		assertParentIdentitySync(directoryPath, parentIdentity);
		fsSync.unlinkSync(path.join(directoryPath, "info"));
	}
	assertParentIdentitySync(directoryPath, parentIdentity);
	fsSync.rmdirSync(directoryPath);
	assertParentIdentitySync(directoryPath, parentIdentity);
}

async function restoreTransition(lockPath: string, expected: LockObservation): Promise<boolean> {
	const transitionPath = getTransitionPath(lockPath);
	const parentIdentity = await inspectParent(lockPath);
	for (let attempt = 0; attempt < RESTORE_ATTEMPTS; attempt++) {
		const transition = await inspectLockDirectory(transitionPath);
		if (transition === null) return false;
		if (!sameObservationIdentity(transition, expected)) return false;
		try {
			await assertParentIdentity(lockPath, parentIdentity);
			await fs.rename(transitionPath, lockPath);
			await assertParentIdentity(lockPath, parentIdentity);
			const restored = await inspectLockDirectory(lockPath);
			return restored !== null && sameObservationIdentity(restored, expected);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return false;
			if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
			await Bun.sleep(1);
		}
	}
	return false;
}

function restoreTransitionSync(lockPath: string, expected: LockObservation): boolean {
	const transitionPath = getTransitionPath(lockPath);
	const parentIdentity = inspectParentSync(lockPath);
	for (let attempt = 0; attempt < RESTORE_ATTEMPTS; attempt++) {
		const transition = inspectLockDirectorySync(transitionPath);
		if (transition === null) return false;
		if (!sameObservationIdentity(transition, expected)) return false;
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
	// A transition is the brief atomic claim used by a release or stale reaper.
	// Rename updates ctime, so contenders leave an active operation alone. If
	// its process crashes, the same bounded grace turns it into recoverable
	// state without ever chasing the live pathname.
	if (Date.now() - transition.directoryCtimeMs <= OWNER_INFO_GRACE_MS) return;
	const livePath = await inspectLockDirectory(lockPath);
	if (livePath !== null) return;
	if (observationIsStale(transition, staleMs, Date.now())) {
		await removeObservedDirectory(transitionPath, transition).catch(() => {
			// Another lifecycle participant won, or the inode changed. Either
			// way, refusing the stale observation is the safe result.
		});
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
		} catch {
			// The transition was completed or replaced; never chase its pathname.
		}
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
		} catch {
			// Preserve the acquisition error; the unique candidate is never the live lock.
		}
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
			} catch {
				// A unique failed candidate is never removed without its pinned identity.
			}
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

async function acquireLock(filePath: string, options: FileLockOptions = {}): Promise<() => Promise<void>> {
	const opts = validateOptions(options);
	const lockPath = getLockPath(filePath);
	for (let attempt = 0; attempt < opts.retries; attempt++) {
		await settleTransition(lockPath, opts.staleMs);
		const lease = await tryAcquireLock(lockPath);
		if (lease !== null) return () => releaseLock(lockPath, lease);
		const observation = await inspectLockDirectory(lockPath);
		if (observation && observationIsStale(observation, opts.staleMs, Date.now())) {
			await retireObservedLock(lockPath, observation, { kind: "stale", staleMs: opts.staleMs });
		}
		if (attempt + 1 < opts.retries) await Bun.sleep(opts.retryDelayMs);
	}
	throw new Error(`Failed to acquire lock for ${escapeTerminalText(filePath)} after ${opts.retries} attempts`);
}

function acquireLockSync(filePath: string, options: FileLockOptions = {}): () => void {
	const opts = validateOptions(options);
	const lockPath = getLockPath(filePath);
	for (let attempt = 0; attempt < opts.retries; attempt++) {
		settleTransitionSync(lockPath, opts.staleMs);
		const lease = tryAcquireLockSync(lockPath);
		if (lease !== null) return () => releaseLockSync(lockPath, lease);
		const observation = inspectLockDirectorySync(lockPath);
		if (observation && observationIsStale(observation, opts.staleMs, Date.now())) {
			retireObservedLockSync(lockPath, observation, { kind: "stale", staleMs: opts.staleMs });
		}
		if (attempt + 1 < opts.retries) sleepSync(opts.retryDelayMs);
	}
	throw new Error(`Failed to acquire lock for ${escapeTerminalText(filePath)} after ${opts.retries} attempts`);
}

/**
 * Run `fn` while holding a cross-process advisory lock on the pathname.
 *
 * This API deliberately has generic pathname-only alias semantics: two callers
 * contend when they pass the same spelling, not merely when their resource
 * paths happen to resolve to the same inode. Security-sensitive callers must
 * separately canonicalize and pin the identity of the resource being guarded.
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

export type TryFileLockResult<T> = { acquired: true; value: T } | { acquired: false };

/**
 * Run `fn` under the pathname lock if it is immediately available.
 *
 * Like {@link withFileLock}, aliases are not canonicalized. A caller protecting
 * a security-sensitive file must pin/canonicalize that file independently.
 */
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

/**
 * Synchronous twin of {@link withFileLock}; it uses the identical staged
 * publication and inode-authorized transition protocol.
 */
export function withFileLockSync<T>(filePath: string, fn: () => T, options: FileLockOptions = {}): T {
	const release = acquireLockSync(filePath, options);
	try {
		return fn();
	} finally {
		release();
	}
}

/** Test-only handles for lifecycle and bounded-read contract tests. */
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
