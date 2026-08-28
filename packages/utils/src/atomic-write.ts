import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, isFsError } from "./fs-error";

export interface AtomicWriteOptions {
	mode?: number;
	fsync?: boolean;
}

let tempCounter = 0;

function nextTempPath(dir: string, targetBasename: string): string {
	tempCounter = (tempCounter + 1) >>> 0;
	return path.join(dir, `.${targetBasename}.${process.pid}.${tempCounter}.tmp`);
}

function removeTempSync(tmpPath: string): void {
	fs.rmSync(tmpPath, { force: true, recursive: true });
}

async function reserveTempFile(
	dir: string,
	targetBasename: string,
	mode: number,
	target: string,
): Promise<{ handle: fsp.FileHandle; tmpPath: string }> {
	for (;;) {
		const tmpPath = nextTempPath(dir, targetBasename);
		try {
			return { handle: await fsp.open(tmpPath, "wx", mode), tmpPath };
		} catch (error) {
			if (isFsError(error) && error.code === "EEXIST") continue;
			throw withTargetInMessage(error, target, tmpPath);
		}
	}
}

function reserveTempFileSync(
	dir: string,
	targetBasename: string,
	mode: number,
	target: string,
): { fd: number; tmpPath: string } {
	for (;;) {
		const tmpPath = nextTempPath(dir, targetBasename);
		try {
			return { fd: fs.openSync(tmpPath, "wx", mode), tmpPath };
		} catch (error) {
			if (isFsError(error) && error.code === "EEXIST") continue;
			throw withTargetInMessage(error, target, tmpPath);
		}
	}
}

function isRenameClobberError(error: unknown): boolean {
	return (
		process.platform === "win32" &&
		isFsError(error) &&
		(error.code === "EPERM" || error.code === "EEXIST" || error.code === "EACCES")
	);
}

async function resolveWriteTarget(filePath: string): Promise<{ target: string; viaSymlink: boolean }> {
	let target = filePath;
	let viaSymlink = false;
	const seen = new Set<string>();

	for (;;) {
		let stats: fs.Stats;
		try {
			stats = await fsp.lstat(target);
		} catch (error) {
			if (!isEnoent(error)) throw error;
			return { target, viaSymlink };
		}
		if (!stats.isSymbolicLink()) {
			assertRegularFileTarget(stats, target);
			return { target, viaSymlink };
		}

		viaSymlink = true;
		const absoluteTarget = path.resolve(target);
		if (seen.has(absoluteTarget)) {
			const error = new Error(`Too many symbolic links while resolving ${filePath}`) as NodeJS.ErrnoException;
			error.code = "ELOOP";
			throw error;
		}
		seen.add(absoluteTarget);
		target = path.resolve(path.dirname(target), await fsp.readlink(target));
	}
}

function assertRegularFileTarget(stats: fs.Stats, target: string): void {
	if (stats.isFile()) return;
	const kind = stats.isDirectory()
		? "a directory"
		: stats.isSymbolicLink()
			? "a symbolic link"
			: stats.isFIFO()
				? "a named pipe (FIFO)"
				: stats.isSocket()
					? "a socket"
					: stats.isBlockDevice() || stats.isCharacterDevice()
						? "a device node"
						: "not a regular file";
	throw new Error(
		`Refusing to write ${target}: it is ${kind}, and an atomic write would replace it with a regular file. ` +
			`Point the write at a regular file path instead.`,
	);
}

function resolveWriteTargetSync(filePath: string): { target: string; viaSymlink: boolean } {
	let target = filePath;
	let viaSymlink = false;
	const seen = new Set<string>();

	for (;;) {
		let stats: fs.Stats;
		try {
			stats = fs.lstatSync(target);
		} catch (error) {
			if (!isEnoent(error)) throw error;
			return { target, viaSymlink };
		}
		if (!stats.isSymbolicLink()) {
			assertRegularFileTarget(stats, target);
			return { target, viaSymlink };
		}

		viaSymlink = true;
		const absoluteTarget = path.resolve(target);
		if (seen.has(absoluteTarget)) {
			const error = new Error(`Too many symbolic links while resolving ${filePath}`) as NodeJS.ErrnoException;
			error.code = "ELOOP";
			throw error;
		}
		seen.add(absoluteTarget);
		target = path.resolve(path.dirname(target), fs.readlinkSync(target));
	}
}

function withTargetInMessage(error: unknown, target: string, tmpPath: string): unknown {
	if (!(error instanceof Error) || !error.message.includes(tmpPath)) return error;
	const restated = new Error(
		`${error.message.replaceAll(tmpPath, target)} (the write is staged in a temporary file beside the target, ` +
			`so it can replace it atomically; the temporary file is what the operating system named)`,
		{ cause: error },
	);
	const code = (error as NodeJS.ErrnoException).code;
	if (code !== undefined) (restated as NodeJS.ErrnoException).code = code;
	return restated;
}

async function assertReplaceableTarget(target: string): Promise<void> {
	try {
		assertRegularFileTarget(await fsp.lstat(target), target);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}

function assertReplaceableTargetSync(target: string): void {
	try {
		assertRegularFileTarget(fs.lstatSync(target), target);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}

async function renameTempOverTarget(tmpPath: string, target: string): Promise<void> {
	try {
		await fsp.rename(tmpPath, target);
		return;
	} catch (error) {
		if (!isRenameClobberError(error)) throw error;
	}

	await assertReplaceableTarget(target);
	const backupPath = nextTempPath(path.dirname(target), `${path.basename(target)}.previous`);
	try {
		await fsp.rename(target, backupPath);
	} catch (error) {
		if (!isEnoent(error)) throw error;
		await fsp.rename(tmpPath, target);
		return;
	}
	try {
		await fsp.rename(tmpPath, target);
	} catch (replacementError) {
		try {
			await fsp.rename(backupPath, target);
		} catch (restoreError) {
			throw new AggregateError(
				[replacementError, restoreError],
				`Failed to replace ${target}, then failed to restore its previous contents`,
			);
		}
		throw replacementError;
	}
	await fsp.rm(backupPath, { force: true, recursive: true });
}

const DIRECTORY_FSYNC_UNSUPPORTED: Readonly<Record<string, true>> = {
	EINVAL: true,
	EISDIR: true,
	ENOSYS: true,
	ENOTSUP: true,
};

function isDirectoryFsyncUnsupported(error: unknown): boolean {
	if (!isFsError(error) || error.code === undefined) return false;
	if (DIRECTORY_FSYNC_UNSUPPORTED[error.code]) return true;
	return process.platform === "win32" && (error.code === "EACCES" || error.code === "EPERM");
}

async function fsyncDirEntry(dir: string): Promise<void> {
	let dirHandle: fsp.FileHandle;
	try {
		dirHandle = await fsp.open(dir, "r");
	} catch (error) {
		if (isDirectoryFsyncUnsupported(error)) return;
		throw error;
	}

	let syncError: unknown;
	try {
		await dirHandle.sync();
	} catch (error) {
		if (!isDirectoryFsyncUnsupported(error)) syncError = error;
	}
	try {
		await dirHandle.close();
	} catch (error) {
		if (syncError === undefined) syncError = error;
	}
	if (syncError !== undefined) throw syncError;
}

export async function atomicWriteFile(
	filePath: string,
	data: string | NodeJS.ArrayBufferView,
	options: AtomicWriteOptions = {},
): Promise<void> {
	const { mode = 0o600, fsync = true } = options;
	await atomicWriteBytes(filePath, data, mode, fsync, false);
}

async function atomicWriteBytes(
	filePath: string,
	data: string | NodeJS.ArrayBufferView,
	mode: number,
	fsync: boolean,
	preserveModeExactly: boolean,
): Promise<void> {
	await atomicWriteFileWithImpl(
		filePath,
		{
			kind: "handle",
			write: async handle => {
				await handle.writeFile(data);
				if (preserveModeExactly) await handle.chmod(mode);
				if (fsync) await handle.sync();
			},
		},
		{ fsync, mode },
	);
}

export async function atomicWriteFilePreservingMode(
	filePath: string,
	data: string | NodeJS.ArrayBufferView,
	options: { fsync?: boolean; defaultMode?: number } = {},
): Promise<void> {
	const { fsync = true, defaultMode = 0o644 } = options;
	let mode = defaultMode;
	let existed = true;
	try {
		mode = (await fsp.stat(filePath)).mode & 0o7777;
	} catch (error) {
		if (!isEnoent(error)) throw error;
		existed = false;
	}
	await atomicWriteBytes(filePath, data, mode, fsync, existed);
}

export async function atomicWriteJson(
	filePath: string,
	data: unknown,
	options: AtomicWriteOptions = {},
): Promise<void> {
	await atomicWriteFile(filePath, `${JSON.stringify(data, null, 2)}\n`, options);
}

export async function atomicWriteFileWith(
	filePath: string,
	write: (tempPath: string) => Promise<void>,
	options: AtomicWriteOptions & {
		fsyncTempFile?: boolean;
	} = {},
): Promise<void> {
	await atomicWriteFileWithImpl(filePath, { kind: "path", write }, options);
}

type AtomicTempWriter =
	| { kind: "handle"; write: (handle: fsp.FileHandle) => Promise<void> }
	| { kind: "path"; write: (tempPath: string) => Promise<void> };

interface AtomicWriteInternalOptions extends AtomicWriteOptions {
	fsyncTempFile?: boolean;
}

async function atomicWriteFileWithImpl(
	filePath: string,
	writer: AtomicTempWriter,
	options: AtomicWriteInternalOptions,
): Promise<void> {
	const { fsync = true, fsyncTempFile = true, mode = 0o600 } = options;
	const { target, viaSymlink } = await resolveWriteTarget(filePath);
	const dir = path.dirname(target);
	if (!viaSymlink) await fsp.mkdir(dir, { recursive: true });

	const reserved = await reserveTempFile(dir, path.basename(target), mode, target);
	const { tmpPath } = reserved;
	try {
		if (writer.kind === "handle") {
			let operationError: unknown;
			try {
				await writer.write(reserved.handle);
			} catch (error) {
				operationError = error;
			}
			try {
				await reserved.handle.close();
			} catch (error) {
				if (operationError === undefined) operationError = error;
			}
			if (operationError !== undefined) throw operationError;
		} else {
			await reserved.handle.close();
			await writer.write(tmpPath);

			assertRegularFileTarget(await fsp.lstat(tmpPath), tmpPath);
			const handle = await fsp.open(tmpPath, "r+");
			let operationError: unknown;
			try {
				const finalMode = process.platform === "win32" ? mode : mode & ~process.umask();
				await handle.chmod(finalMode);
				if (fsync && fsyncTempFile) await handle.sync();
			} catch (error) {
				operationError = error;
			}
			try {
				await handle.close();
			} catch (error) {
				if (operationError === undefined) operationError = error;
			}
			if (operationError !== undefined) throw operationError;
		}

		assertRegularFileTarget(await fsp.lstat(tmpPath), tmpPath);
		await assertReplaceableTarget(target);
		await renameTempOverTarget(tmpPath, target);
	} catch (error) {
		await fsp.rm(tmpPath, { force: true, recursive: true }).catch(() => {});
		throw withTargetInMessage(error, target, tmpPath);
	}
	if (fsync) await fsyncDirEntry(dir);
}

export function atomicWriteFileSync(
	filePath: string,
	data: string | NodeJS.ArrayBufferView,
	options: AtomicWriteOptions = {},
): void {
	const { mode = 0o600, fsync = true } = options;
	const { target, viaSymlink } = resolveWriteTargetSync(filePath);
	const dir = path.dirname(target);
	if (!viaSymlink) fs.mkdirSync(dir, { recursive: true });

	const { fd, tmpPath } = reserveTempFileSync(dir, path.basename(target), mode, target);
	let operationError: unknown;
	try {
		fs.writeFileSync(fd, data);
		if (fsync) fs.fsyncSync(fd);
	} catch (error) {
		operationError = error;
	}
	try {
		fs.closeSync(fd);
	} catch (error) {
		if (operationError === undefined) operationError = error;
	}
	if (operationError !== undefined) {
		try {
			removeTempSync(tmpPath);
		} catch {}
		throw withTargetInMessage(operationError, target, tmpPath);
	}

	try {
		assertRegularFileTarget(fs.lstatSync(tmpPath), tmpPath);
		assertReplaceableTargetSync(target);
		fs.renameSync(tmpPath, target);
	} catch (error) {
		if (isRenameClobberError(error)) {
			assertReplaceableTargetSync(target);
			const backupPath = nextTempPath(dir, `${path.basename(target)}.previous`);
			try {
				fs.renameSync(target, backupPath);
			} catch (backupError) {
				if (!isEnoent(backupError)) throw withTargetInMessage(backupError, target, tmpPath);
				fs.renameSync(tmpPath, target);
				if (fsync) fsyncDirEntrySync(dir);
				return;
			}
			try {
				fs.renameSync(tmpPath, target);
			} catch (renameError) {
				try {
					fs.renameSync(backupPath, target);
				} catch (restoreError) {
					throw new AggregateError(
						[renameError, restoreError],
						`Failed to replace ${target}, then failed to restore its previous contents`,
					);
				}
				try {
					removeTempSync(tmpPath);
				} catch {}
				throw withTargetInMessage(renameError, target, tmpPath);
			}
			try {
				removeTempSync(backupPath);
			} catch (cleanupError) {
				throw withTargetInMessage(cleanupError, target, backupPath);
			}
		} else {
			try {
				removeTempSync(tmpPath);
			} catch {}
			throw withTargetInMessage(error, target, tmpPath);
		}
	}

	if (fsync) fsyncDirEntrySync(dir);
}

function fsyncDirEntrySync(dir: string): void {
	let dirFd: number;
	try {
		dirFd = fs.openSync(dir, "r");
	} catch (error) {
		if (isDirectoryFsyncUnsupported(error)) return;
		throw error;
	}

	let syncError: unknown;
	try {
		fs.fsyncSync(dirFd);
	} catch (error) {
		if (!isDirectoryFsyncUnsupported(error)) syncError = error;
	}
	try {
		fs.closeSync(dirFd);
	} catch (error) {
		if (syncError === undefined) syncError = error;
	}
	if (syncError !== undefined) throw syncError;
}
