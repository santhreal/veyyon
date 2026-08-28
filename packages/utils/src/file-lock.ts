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

export const DEFAULT_OPTIONS: Required<FileLockOptions> = {
	staleMs: 10_000,
	retries: 50,
	retryDelayMs: 100,
};

export const OWNER_INFO_GRACE_MS = 1_000;
export const MAX_OWNER_INFO_BYTES = 4_096;
export const RESTORE_ATTEMPTS = 200;
export const LOCK_INFO_VERSION = 1;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface FileIdentity {
	dev: number;
	ino: number;
	birthtimeMs: number;
}

export interface LockInfo {
	version: typeof LOCK_INFO_VERSION;
	pid: number;
	timestamp: number;
	token: string;
	processIdentity: string | null;
}

export interface LockObservation {
	kind: "valid" | "invalid" | "ownerless" | "unsafe";
	directoryIdentity: FileIdentity;
	directoryMtimeMs: number;
	directoryCtimeMs: number;
	infoIdentity?: FileIdentity;
	info?: LockInfo;
}

export interface LockLease {
	token: string;
	directoryIdentity: FileIdentity;
	infoIdentity: FileIdentity;
}

export type ProcessInstanceVerifier = (pid: number, expectedIdentity: string | null) => boolean;

export type RemovalAuthorization =
	| { kind: "owner"; lease: LockLease }
	| { kind: "stale"; staleMs: number; isOwnerAlive?: ProcessInstanceVerifier };

export type RetireResult = "removed" | "changed" | "busy" | "not-authorized";

export function identityOf(stat: fsSync.Stats): FileIdentity {
	return { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
}

export function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

export function sameObservationIdentity(left: LockObservation, right: LockObservation): boolean {
	if (!sameIdentity(left.directoryIdentity, right.directoryIdentity)) return false;
	if (left.infoIdentity === undefined || right.infoIdentity === undefined) {
		return left.infoIdentity === right.infoIdentity;
	}
	return sameIdentity(left.infoIdentity, right.infoIdentity);
}

export function isLockInfo(value: unknown): value is LockInfo {
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

export function getLockPath(filePath: string): string {
	return `${filePath}.lock`;
}

export function getTransitionPath(lockPath: string): string {
	return `${lockPath}.transition`;
}

export function buildLockInfo(token: string): LockInfo {
	return {
		version: LOCK_INFO_VERSION,
		pid: process.pid,
		timestamp: Date.now(),
		token,
		processIdentity: getProcessStartIdentity(process.pid),
	};
}

export function validateOptions(options: FileLockOptions): Required<FileLockOptions> {
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

export async function inspectParent(filePath: string): Promise<FileIdentity> {
	const stat = await fs.lstat(path.dirname(filePath));
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error(`file-lock: unsafe parent directory for ${escapeTerminalText(filePath)}`);
	}
	return identityOf(stat);
}

export function inspectParentSync(filePath: string): FileIdentity {
	const stat = fsSync.lstatSync(path.dirname(filePath));
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error(`file-lock: unsafe parent directory for ${escapeTerminalText(filePath)}`);
	}
	return identityOf(stat);
}

export async function assertParentIdentity(filePath: string, expected: FileIdentity): Promise<void> {
	if (!sameIdentity(await inspectParent(filePath), expected)) {
		throw new Error(`file-lock: parent directory changed while locking ${escapeTerminalText(filePath)}`);
	}
}

export function assertParentIdentitySync(filePath: string, expected: FileIdentity): void {
	if (!sameIdentity(inspectParentSync(filePath), expected)) {
		throw new Error(`file-lock: parent directory changed while locking ${escapeTerminalText(filePath)}`);
	}
}

export function parseOwnerBytes(bytes: Buffer): LockInfo | null {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
	const parsed = tryParseJson(text);
	return isLockInfo(parsed) ? parsed : null;
}

export function isInvalidOpenedStat(stat: fsSync.Stats, expectedSize: number, expectedIdentity: FileIdentity): boolean {
	return (
		!stat.isFile() ||
		stat.nlink !== 1 ||
		stat.size !== expectedSize ||
		!sameIdentity(identityOf(stat), expectedIdentity)
	);
}

export async function inspectLockDirectory(lockPath: string): Promise<LockObservation | null> {
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
		if (isInvalidOpenedStat(openedStat, infoStat.size, infoIdentity)) {
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
		if (bytesRead !== infoStat.size || isInvalidOpenedStat(finalStat, infoStat.size, infoIdentity)) {
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

export function inspectLockDirectorySync(lockPath: string): LockObservation | null {
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
		if (isInvalidOpenedStat(openedStat, infoStat.size, infoIdentity)) {
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
		if (bytesRead !== infoStat.size || isInvalidOpenedStat(finalStat, infoStat.size, infoIdentity)) {
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
			} catch {}
		}
	}
}

export function observationIsStale(
	observation: LockObservation,
	_staleMs: number,
	now: number,
	isOwnerAlive: ProcessInstanceVerifier = isProcessInstanceAlive,
): boolean {
	if (observation.kind === "valid" && observation.info) {
		return !isOwnerAlive(observation.info.pid, observation.info.processIdentity);
	}
	if (observation.kind === "ownerless" || observation.kind === "invalid") {
		return now - observation.directoryMtimeMs > OWNER_INFO_GRACE_MS;
	}
	return false;
}

export async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
	const observation = await inspectLockDirectory(lockPath);
	return observation?.kind === "valid" ? (observation.info ?? null) : null;
}

export function readLockInfoSync(lockPath: string): LockInfo | null {
	const observation = inspectLockDirectorySync(lockPath);
	return observation?.kind === "valid" ? (observation.info ?? null) : null;
}

export async function isLockStale(lockPath: string, staleMs: number): Promise<boolean> {
	const observation = await inspectLockDirectory(lockPath);
	return observation !== null && observationIsStale(observation, staleMs, Date.now());
}

export function isLockStaleSync(lockPath: string, staleMs: number): boolean {
	const observation = inspectLockDirectorySync(lockPath);
	return observation !== null && observationIsStale(observation, staleMs, Date.now());
}

export async function directoryHasOnlyInfo(directoryPath: string, hasInfo: boolean): Promise<boolean> {
	const directory = await fs.opendir(directoryPath);
	let count = 0;
	for await (const entry of directory) {
		count += 1;
		if (count > 1 || entry.name !== "info" || !hasInfo) return false;
	}
	return count === (hasInfo ? 1 : 0);
}

export function directoryHasOnlyInfoSync(directoryPath: string, hasInfo: boolean): boolean {
	const directory = fsSync.opendirSync(directoryPath);
	try {
		let count = 0;
		while (true) {
			const entry = directory.readSync();
			if (entry === null) break;
			count += 1;
			if (count > 1 || entry.name !== "info" || !hasInfo) return false;
		}
		return count === (hasInfo ? 1 : 0);
	} finally {
		directory.closeSync();
	}
}

export async function removeObservedDirectory(directoryPath: string, expected: LockObservation): Promise<void> {
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

export function removeObservedDirectorySync(directoryPath: string, expected: LockObservation): void {
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

export async function restoreTransition(lockPath: string, expected: LockObservation): Promise<boolean> {
	const transitionPath = getTransitionPath(lockPath);
	const parentIdentity = await inspectParent(lockPath);
	for (let attempt = 0; attempt < RESTORE_ATTEMPTS; attempt++) {
		const transition = await inspectLockDirectory(transitionPath);
		if (transition === null || !sameObservationIdentity(transition, expected)) return false;
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

// circular import: functions moved to helpers
export { withFileLock, tryWithFileLock, withFileLockSync, __internalsForTesting } from "./file-lock-helpers";
export type { TryFileLockResult } from "./file-lock-helpers";
