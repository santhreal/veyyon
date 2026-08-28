import { constants as fsConstants, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	applyOwnerOnlyWindowsAcl,
	errorMessage,
	escapeTerminalText,
	isEnoent,
	isRecord,
	verifyOwnerOnlyWindowsAcl,
	withFileLock,
} from "@veyyon/utils";
import type { OperatorNotices } from "../session/operator-notices";

import type { SecretExpansionRecord } from "./audit";
import {
	assertOwnedRegularFile,
	decodeLog,
	encodeRecord,
	MAX_PENDING_BYTES,
	MAX_PENDING_RECORDS,
	ROTATE_AT_BYTES,
	ROTATED_SUFFIX,
} from "./audit";

interface PinnedParent {
	path: string;
	handle: FileHandle;
	stats: Stats;
}

interface OpenedAuditFile {
	handle: FileHandle;
	stats: Stats;
	created: boolean;
}

function sameIdentity(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

async function assertPathIdentity(filePath: string, expected: Stats): Promise<Stats> {
	const actual = await fs.lstat(filePath);
	assertOwnedRegularFile(filePath, actual);
	if (!sameIdentity(actual, expected)) {
		throw new Error(`The secret audit path at ${escapeTerminalText(filePath)} was replaced during the operation.`);
	}
	return actual;
}

async function openPinnedParent(filePath: string): Promise<PinnedParent> {
	const parentPath = path.dirname(filePath);
	const flags = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);
	const handle = await fs.open(parentPath, flags);
	try {
		const stats = await handle.stat();
		if (!stats.isDirectory()) {
			throw new Error(`The secret audit directory at ${escapeTerminalText(parentPath)} is not a directory.`);
		}
		const currentUid = process.getuid?.();
		if (currentUid !== undefined && stats.uid !== currentUid) {
			throw new Error(
				`The secret audit directory at ${escapeTerminalText(parentPath)} is not owned by the current user.`,
			);
		}
		const pinned = { path: parentPath, handle, stats };
		await assertParentIdentity(pinned);
		return pinned;
	} catch (error) {
		await handle.close();
		throw error;
	}
}

async function assertParentIdentity(parent: PinnedParent): Promise<void> {
	const opened = await parent.handle.stat();
	if (!opened.isDirectory() || !sameIdentity(opened, parent.stats)) {
		throw new Error(`The pinned secret audit directory at ${escapeTerminalText(parent.path)} changed identity.`);
	}
	const current = await fs.lstat(parent.path);
	if (!current.isDirectory() || !sameIdentity(current, parent.stats)) {
		throw new Error(`The secret audit directory at ${escapeTerminalText(parent.path)} was replaced.`);
	}
}

async function ensureAuditParent(filePath: string): Promise<void> {
	const target = path.dirname(filePath);
	const parsed = path.parse(target);
	const segments = target
		.slice(parsed.root.length)
		.split(path.sep)
		.filter(segment => segment.length > 0);
	const flags = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);
	let currentPath = parsed.root;
	let currentHandle = await fs.open(currentPath, flags);
	let currentStats = await currentHandle.stat();
	try {
		for (const segment of segments) {
			const parent: PinnedParent = { path: currentPath, handle: currentHandle, stats: currentStats };
			await assertParentIdentity(parent);
			const childPath = path.join(currentPath, segment);
			let childHandle: FileHandle;
			let created = false;
			try {
				childHandle = await fs.open(childPath, flags);
			} catch (error) {
				if (!isEnoent(error)) throw error;
				await fs.mkdir(childPath, { mode: 0o700 });
				created = true;
				childHandle = await fs.open(childPath, flags);
			}
			let childStats: Stats;
			try {
				childStats = await childHandle.stat();
				if (!childStats.isDirectory()) {
					throw new Error(`The secret audit parent at ${escapeTerminalText(childPath)} is not a directory.`);
				}
				const childPathStats = await fs.lstat(childPath);
				if (!childPathStats.isDirectory() || !sameIdentity(childPathStats, childStats)) {
					throw new Error(`The secret audit parent at ${escapeTerminalText(childPath)} was replaced.`);
				}
				if (created) {
					if (process.platform === "win32") {
						await applyOwnerOnlyWindowsAcl(childPath);
						await verifyOwnerOnlyWindowsAcl(childPath);
					} else {
						await childHandle.chmod(0o700);
						childStats = await childHandle.stat();
						if ((childStats.mode & 0o7777) !== 0o700) {
							throw new Error(`The secret audit parent at ${escapeTerminalText(childPath)} is not mode 0700.`);
						}
					}
					const securedPathStats = await fs.lstat(childPath);
					if (!sameIdentity(securedPathStats, childStats)) {
						throw new Error(`The secret audit parent at ${escapeTerminalText(childPath)} was replaced.`);
					}
					await childHandle.sync();
					await currentHandle.sync();
				}
				await assertParentIdentity(parent);
			} catch (error) {
				await childHandle.close();
				throw error;
			}
			await currentHandle.close();
			currentPath = childPath;
			currentHandle = childHandle;
			currentStats = childStats;
		}
	} finally {
		await currentHandle.close();
	}
}

async function secureHandle(filePath: string, handle: FileHandle, applyAcl: boolean): Promise<Stats> {
	let stats = await handle.stat();
	assertOwnedRegularFile(filePath, stats);
	await assertPathIdentity(filePath, stats);
	if (process.platform === "win32") {
		if (applyAcl) await applyOwnerOnlyWindowsAcl(filePath);
		await verifyOwnerOnlyWindowsAcl(filePath);
		await assertPathIdentity(filePath, stats);
	} else if ((stats.mode & 0o7777) !== 0o600) {
		await handle.chmod(0o600);
		stats = await handle.stat();
		assertOwnedRegularFile(filePath, stats);
		if ((stats.mode & 0o7777) !== 0o600) {
			throw new Error(`The secret audit file at ${escapeTerminalText(filePath)} could not be secured to mode 0600.`);
		}
		await assertPathIdentity(filePath, stats);
	}
	return stats;
}

async function throwClassifiedOpenError(filePath: string, error: unknown): Promise<never> {
	let stats: Stats;
	try {
		stats = await fs.lstat(filePath);
	} catch {
		throw error;
	}
	assertOwnedRegularFile(filePath, stats);
	throw error;
}

async function openExistingAuditFile(filePath: string, flags: number): Promise<OpenedAuditFile | null> {
	let handle: FileHandle;
	try {
		handle = await fs.open(filePath, flags | (fsConstants.O_NOFOLLOW ?? 0));
	} catch (error) {
		if (isEnoent(error)) return null;
		return await throwClassifiedOpenError(filePath, error);
	}
	try {
		const stats = await secureHandle(filePath, handle, true);
		return { handle, stats, created: false };
	} catch (error) {
		await handle.close();
		throw error;
	}
}

async function openOrCreateAuditFile(filePath: string, flags: number, parent: PinnedParent): Promise<OpenedAuditFile> {
	await assertParentIdentity(parent);
	let handle: FileHandle;
	let created = false;
	try {
		handle = await fs.open(
			filePath,
			flags | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
			0o600,
		);
		created = true;
	} catch (error) {
		if (!isAlreadyExists(error)) return await throwClassifiedOpenError(filePath, error);
		try {
			handle = await fs.open(filePath, flags | (fsConstants.O_NOFOLLOW ?? 0));
		} catch (openError) {
			return await throwClassifiedOpenError(filePath, openError);
		}
	}
	try {
		await assertParentIdentity(parent);
		const stats = await secureHandle(filePath, handle, true);
		return { handle, stats, created };
	} catch (error) {
		await handle.close();
		throw error;
	}
}

function isAlreadyExists(error: unknown): boolean {
	return isRecord(error) && error.code === "EEXIST";
}

async function handleNeedsLineSeparator(handle: FileHandle, stats: Stats): Promise<boolean> {
	if (stats.size === 0) return false;
	const lastByte = Buffer.allocUnsafe(1);
	const { bytesRead } = await handle.read(lastByte, 0, 1, stats.size - 1);
	if (bytesRead !== 1) throw new Error("The secret audit log's final byte could not be read.");
	return lastByte[0] !== 0x0a;
}

async function writeAll(handle: FileHandle, bytes: Buffer, position: number | null): Promise<void> {
	let offset = 0;
	while (offset < bytes.length) {
		const { bytesWritten } = await handle.write(
			bytes,
			offset,
			bytes.length - offset,
			position === null ? null : position + offset,
		);
		if (bytesWritten === 0) throw new Error("The secret audit write made no forward progress.");
		offset += bytesWritten;
	}
}

async function readBounded(handle: FileHandle, cap: number): Promise<Buffer> {
	const bytes = Buffer.allocUnsafe(cap + 1);
	let offset = 0;
	while (offset < bytes.length) {
		const read = await handle.read(bytes, offset, bytes.length - offset, offset);
		if (read.bytesRead === 0) break;
		offset += read.bytesRead;
	}
	if (offset > cap) throw new Error(`The secret audit generation is above the ${cap}-byte read limit.`);
	return bytes.subarray(0, offset);
}

export class SecretAuditLog {
	readonly #logPath: string;
	readonly #rawRotatedPath: string;
	readonly #notices: OperatorNotices | undefined;
	readonly #pending: Array<{ line: string; bytes: number }> = [];
	#retainedRecords = 0;
	#retainedBytes = 0;
	#drainPromise: Promise<void> | null = null;
	#degraded = false;
	#queueFullNotified = false;

	constructor(logPath: string, notices?: OperatorNotices) {
		if (!path.isAbsolute(logPath)) throw new Error("The secret audit log path must be absolute.");
		this.#logPath = logPath;
		this.#rawRotatedPath = `${logPath}${ROTATED_SUFFIX}`;
		this.#notices = notices;
	}

	get path(): string {
		return escapeTerminalText(this.#logPath);
	}

	get rotatedPath(): string {
		return escapeTerminalText(this.#rawRotatedPath);
	}

	record(record: SecretExpansionRecord): void {
		const line = encodeRecord(record);
		const bytes = Buffer.byteLength(line);
		if (this.#retainedRecords >= MAX_PENDING_RECORDS || this.#retainedBytes + bytes > MAX_PENDING_BYTES) {
			if (!this.#queueFullNotified) {
				this.#notices?.error(
					"secrets",
					`The secret audit queue at ${escapeTerminalText(this.#logPath)} is full; credential expansion was refused before use.`,
				);
				this.#queueFullNotified = true;
			}
			throw new Error("The secret audit queue is full; refusing credential expansion.");
		}
		this.#pending.push({ line, bytes });
		this.#retainedRecords++;
		this.#retainedBytes += bytes;
		this.#startDrain();
	}

	#startDrain(): void {
		if (this.#drainPromise !== null) return;
		let tracked: Promise<void>;
		tracked = Promise.resolve()
			.then(async () => await this.#drainOneBatch())
			.finally(() => {
				if (this.#drainPromise === tracked) this.#drainPromise = null;
				if (this.#pending.length > 0) this.#startDrain();
			});
		this.#drainPromise = tracked;
	}

	async #drainOneBatch(): Promise<void> {
		const batch = this.#pending.splice(0);
		if (batch.length === 0) return;
		try {
			await ensureAuditParent(this.#logPath);
			const parent = await openPinnedParent(this.#logPath);
			try {
				await withFileLock(this.#logPath, async () => {
					await assertParentIdentity(parent);
					for (const entry of batch) {
						await this.#rotateIfFull(entry.bytes, parent);
						await this.#appendLine(entry.line, entry.bytes, parent);
					}
					await assertParentIdentity(parent);
				});
			} finally {
				await parent.handle.close();
			}
			if (this.#degraded) {
				this.#notices?.warn(
					"secrets",
					`The secret audit log at ${escapeTerminalText(this.#logPath)} recovered; recording has resumed.`,
				);
			}
			this.#degraded = false;
		} catch (error) {
			if (!this.#degraded) {
				this.#notices?.error(
					"secrets",
					`The secret audit log at ${escapeTerminalText(this.#logPath)} could not be appended to ` +
						`(${escapeTerminalText(errorMessage(error))}). ${batch.length} bounded queued ` +
						`record${batch.length === 1 ? " was" : "s were"} not written. Credentials remain protected; ` +
						`credential use is no longer being recorded until the next append recovers.`,
				);
			}
			this.#degraded = true;
		} finally {
			this.#retainedRecords -= batch.length;
			this.#retainedBytes -= batch.reduce((total, entry) => total + entry.bytes, 0);
			if (this.#retainedRecords < MAX_PENDING_RECORDS && this.#retainedBytes < MAX_PENDING_BYTES) {
				this.#queueFullNotified = false;
			}
		}
	}

	async #appendLine(line: string, lineBytes: number, parent: PinnedParent): Promise<void> {
		const opened = await openOrCreateAuditFile(this.#logPath, fsConstants.O_APPEND | fsConstants.O_RDWR, parent);
		try {
			const stats = await opened.handle.stat();
			assertOwnedRegularFile(this.#logPath, stats);
			const separator = await handleNeedsLineSeparator(opened.handle, stats);
			if (stats.size + (separator ? 1 : 0) + lineBytes > ROTATE_AT_BYTES) {
				throw new Error("The secret audit append would exceed the generation cap.");
			}
			const bytes = Buffer.from(separator ? `\n${line}` : line);
			await writeAll(opened.handle, bytes, null);
			await opened.handle.datasync();
			const after = await opened.handle.stat();
			if (after.size > ROTATE_AT_BYTES || !sameIdentity(after, stats)) {
				throw new Error("The secret audit file changed during append.");
			}
			await assertPathIdentity(this.#logPath, after);
			await assertParentIdentity(parent);
			if (opened.created) await parent.handle.sync();
		} finally {
			await opened.handle.close();
		}
	}

	async #rotateIfFull(incomingBytes: number, parent: PinnedParent): Promise<void> {
		const current = await openExistingAuditFile(this.#logPath, fsConstants.O_RDWR);
		if (current === null) {
			const old = await openExistingAuditFile(this.#rawRotatedPath, fsConstants.O_RDONLY);
			if (old !== null) await old.handle.close();
			return;
		}
		try {
			const separator = await handleNeedsLineSeparator(current.handle, current.stats);
			if (current.stats.size + (separator ? 1 : 0) + incomingBytes <= ROTATE_AT_BYTES) {
				const old = await openExistingAuditFile(this.#rawRotatedPath, fsConstants.O_RDONLY);
				if (old !== null) await old.handle.close();
				return;
			}
			if (current.stats.size > ROTATE_AT_BYTES) {
				throw new Error("The live secret audit generation is already above its cap.");
			}

			const rotated = await openOrCreateAuditFile(this.#rawRotatedPath, fsConstants.O_RDWR, parent);
			try {
				await assertPathIdentity(this.#logPath, current.stats);
				await assertPathIdentity(this.#rawRotatedPath, rotated.stats);
				await assertParentIdentity(parent);
				const source = await readBounded(current.handle, ROTATE_AT_BYTES);
				await rotated.handle.truncate(0);
				await writeAll(rotated.handle, source, 0);
				await rotated.handle.truncate(source.length);
				await rotated.handle.datasync();
				await assertPathIdentity(this.#rawRotatedPath, rotated.stats);
				await assertPathIdentity(this.#logPath, current.stats);
				await current.handle.truncate(0);
				await current.handle.datasync();
				await assertPathIdentity(this.#logPath, current.stats);
				await assertParentIdentity(parent);
				if (rotated.created) await parent.handle.sync();
			} finally {
				await rotated.handle.close();
			}
		} finally {
			await current.handle.close();
		}
	}

	async flush(): Promise<void> {
		for (;;) {
			const drain = this.#drainPromise;
			if (drain === null) return;
			await drain;
		}
	}

	async read(options?: { limit?: number }): Promise<{ records: SecretExpansionRecord[]; malformed: number }> {
		let parent: PinnedParent;
		try {
			parent = await openPinnedParent(this.#logPath);
		} catch (error) {
			if (isEnoent(error)) return { records: [], malformed: 0 };
			throw error;
		}
		try {
			const generations = await withFileLock(this.#logPath, async () => {
				await assertParentIdentity(parent);
				const rotated = await this.#readOne(this.#rawRotatedPath);
				const current = await this.#readOne(this.#logPath);
				await assertParentIdentity(parent);
				return [rotated, current];
			});
			const records = generations.flatMap(generation => generation.records);
			const malformed = generations.reduce((total, generation) => total + generation.malformed, 0);
			const limit = options?.limit;
			return { records: limit === undefined ? records : records.slice(-limit), malformed };
		} finally {
			await parent.handle.close();
		}
	}

	async #readOne(filePath: string): Promise<{ records: SecretExpansionRecord[]; malformed: number }> {
		try {
			const opened = await openExistingAuditFile(filePath, fsConstants.O_RDONLY);
			if (opened === null) return { records: [], malformed: 0 };
			try {
				const bytes = await readBounded(opened.handle, ROTATE_AT_BYTES);
				const after = await opened.handle.stat();
				if (
					!sameIdentity(after, opened.stats) ||
					after.size !== opened.stats.size ||
					after.size > ROTATE_AT_BYTES
				) {
					throw new Error("The secret audit generation changed or grew beyond its read limit.");
				}
				await assertPathIdentity(filePath, after);
				return decodeLog(bytes.toString("utf8"));
			} finally {
				await opened.handle.close();
			}
		} catch (error) {
			if (isEnoent(error)) return { records: [], malformed: 0 };
			throw new Error(
				`The secret audit log at ${escapeTerminalText(filePath)} could not be read safely ` +
					`(${escapeTerminalText(errorMessage(error))}).`,
			);
		}
	}
}
